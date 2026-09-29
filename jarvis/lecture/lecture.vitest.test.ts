import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LectureSession, sectionFromReply } from './session';
import { claudeSummaryArgs, createClaudeSummarizer } from './summarize';
import { lectureFileBase, lectureFolder, obsidianOpenUrl, openObsidianVault } from './vault';

const папки: string[] = [];
afterEach(async () => {
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

async function временная(): Promise<string> {
  const папка = await mkdtemp(path.join(tmpdir(), 'jarvis-lecture-'));
  папки.push(папка);
  return папка;
}

describe('куда класть конспекты', () => {
  it('в открытое хранилище Obsidian, в папку «Лекции»', () => {
    const config = JSON.stringify({
      vaults: {
        a: { path: 'C:/Users/x/Documents/Obsidian Vault', ts: 1 },
        b: { path: 'C:/Users/x/Brain', ts: 2, open: true },
      },
    });
    const есть = (): boolean => true;
    expect(openObsidianVault(config, есть)).toBe('C:/Users/x/Brain');
    expect(lectureFolder('C:/out', () => config, есть)).toEqual({ folder: path.join('C:/Users/x/Brain', 'Лекции'), vault: 'C:/Users/x/Brain' });
  });

  it('без Obsidian — в папку результатов Джарвиса; открытого нет — последнее', () => {
    expect(lectureFolder('C:/out', () => null)).toEqual({ folder: path.join('C:/out', 'Лекции'), vault: null });
    expect(openObsidianVault(JSON.stringify({ vaults: { a: { path: 'A', ts: 1 }, b: { path: 'B', ts: 5 } } }), () => true)).toBe('B');
    expect(openObsidianVault('не json')).toBeNull();
  });

  it('хранилище, которого нет на диске, не берёт — даже «открытое» (журнал 29.09.2026)', () => {
    const config = JSON.stringify({
      vaults: {
        a: { path: 'C:/Users/x/Documents/Obsidian Vault', ts: 1 },
        b: { path: 'C:/Users/x/Downloads/архив/мозг', ts: 2, open: true },
      },
    });
    const есть = (dir: string): boolean => dir.includes('Documents');
    expect(openObsidianVault(config, есть)).toBe('C:/Users/x/Documents/Obsidian Vault');
    expect(lectureFolder('C:/out', () => config, () => false)).toEqual({ folder: path.join('C:/out', 'Лекции'), vault: null });
  });

  it('имя файла — дата и предмет без запрещённых знаков; ссылка открывает заметку', () => {
    const когда = new Date(2026, 8, 29, 10, 5);
    expect(lectureFileBase('Матанализ: пределы?', когда)).toBe('2026-09-29 Матанализ пределы');
    expect(lectureFileBase('', когда)).toBe('2026-09-29 1005 Лекция');
    expect(obsidianOpenUrl('C:/Лекции/a b.md')).toBe(`obsidian://open?path=${encodeURIComponent('C:/Лекции/a b.md')}`);
  });
});

describe('конспект лекции на ходу', () => {
  it('расшифровка сразу, раздел — когда накопилось, итог — над разделами, звук — в WAV', async () => {
    const папка = await временная();
    let часы = 0;
    const просьбы: string[] = [];
    const сессия = new LectureSession(
      папка,
      'Матанализ',
      {
        transcribe: async (samples) => `מילה `.repeat(samples.length / 1600).trim(),
        summarize: async (prompt) => {
          просьбы.push(prompt);
          return prompt.includes('## Кратко')
            ? '## Кратко\nЛекция о пределах.'
            : '### Пределы\n- предел (גבול) — к чему стремится функция';
        },
        now: () => часы,
        sectionEveryMs: 60_000,
        sectionMinWords: 10,
      },
      new Date(2026, 8, 29, 10, 0),
    );
    await сессия.start();

    // 8 слов в минуту первую минуту — раздела ещё нет; затем порог и слов, и времени.
    сессия.addAudio(new Float32Array(1600 * 8), 16_000);
    часы = 30_000;
    сессия.addAudio(new Float32Array(1600 * 8), 16_000);
    часы = 61_000;
    сессия.addAudio(new Float32Array(1600 * 4), 16_000);
    const итог = await сессия.finish();

    const расшифровка = await readFile(итог.transcriptFile, 'utf8');
    // Метка — начало куска: кусок в 0,8 с, пришедший на 30-й секунде, начался на 29-й.
    expect(расшифровка).toContain('**[00:00]**');
    expect(расшифровка).toContain('**[00:29]**');
    expect(расшифровка).toContain('**[01:00]**');

    const конспект = await readFile(итог.notesFile, 'utf8');
    // Итог стоит над разделами, разделы — по порядку.
    expect(конспект.indexOf('## Кратко')).toBeGreaterThan(0);
    expect(конспект.indexOf('## Кратко')).toBeLessThan(конспект.indexOf('## Конспект'));
    expect(конспект.indexOf('## Конспект')).toBeLessThan(конспект.indexOf('### Пределы'));
    // Часы читаются, когда кусок распознан: к третьему куску — 61 с. Раздел
    // собрался по порогу (16 слов), остаток (4 слова) — вторым при завершении:
    // конец лекции не теряется оттого, что до порога не дотянул.
    expect(итог.sections).toBe(2);
    expect(итог.words).toBe(20);
    const разделы = просьбы.filter((p) => p.includes('### Тема куска'));
    expect(разделы).toHaveLength(2);
    expect(разделы[1]).toContain('Уже написанные разделы: Пределы.');

    const wav = await readFile(итог.audioFile);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe((1600 * 8 + 1600 * 8 + 1600 * 4) * 2);
  });

  it('раздел, который не собрался, не теряет лекцию; «ПРОПУСК» — не раздел', async () => {
    const папка = await временная();
    let раз = 0;
    const сессия = new LectureSession(papka(папка), '', {
      transcribe: async () => 'שלום לכולם היום נדבר על גבולות',
      summarize: async () => {
        раз += 1;
        if (раз === 1) throw new Error('лимит подписки');
        return 'ПРОПУСК';
      },
      sectionEveryMs: 0,
      sectionMinWords: 1,
    });
    await сессия.start();
    сессия.addAudio(new Float32Array(1600), 16_000);
    сессия.addAudio(new Float32Array(1600), 16_000);
    const итог = await сессия.finish();
    const конспект = await readFile(итог.notesFile, 'utf8');
    expect(конспект).toContain('Раздел не собрался (лимит подписки)');
    expect(await readFile(итог.transcriptFile, 'utf8')).toContain('נדבר על גבולות');
  });

  it('ответ модели без заголовка получает заголовок', () => {
    expect(sectionFromReply('- пункт', 3)).toBe('### Раздел 3\n- пункт');
    expect(sectionFromReply('ПРОПУСК.', 1)).toBeNull();
    expect(sectionFromReply('### Тема\n- пункт', 1)).toBe('### Тема\n- пункт');
  });
});

function papka(папка: string): string {
  return папка;
}

describe('вызов модели для раздела', () => {
  it('промпт — через stdin, ответ — текстом; без MCP и с подпиской', async () => {
    const summarize = createClaudeSummarizer({
      command: process.execPath,
      args: ['-e', "let t='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>t+=d);process.stdin.on('end',()=>process.stdout.write('### '+t.length))"],
      env: process.env,
    });
    const промпт = 'кусок лекции '.repeat(5000);
    expect(await summarize(промпт)).toBe(`### ${промпт.length}`);
    expect(claudeSummaryArgs()).toEqual(expect.arrayContaining(['-p', '--output-format', 'text', '--strict-mcp-config', '--model', 'sonnet']));
  });

  it('упавший вызов — ошибка с кодом и причиной, а не пустой раздел', async () => {
    const summarize = createClaudeSummarizer({
      command: process.execPath,
      args: ['-e', "process.stderr.write('limit reached');process.exit(2)"],
      env: process.env,
    });
    await expect(summarize('x')).rejects.toThrow(/кодом 2: limit reached/u);
  });
});
