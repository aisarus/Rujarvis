import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { normaliseSettings } from '../setup/settings';
import { finishFromTranscript, parseTranscript } from './finishFromTranscript';
import { finalPrompt, LectureSession, sectionFromReply, sectionPrompt } from './session';
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
    expect(lectureFolder('C:/out', 'ru', () => config, есть)).toEqual({ folder: path.join('C:/Users/x/Brain', 'Лекции'), vault: 'C:/Users/x/Brain' });
  });

  it('без Obsidian — в папку результатов Джарвиса; открытого нет — последнее', () => {
    expect(lectureFolder('C:/out', 'ru', () => null)).toEqual({ folder: path.join('C:/out', 'Лекции'), vault: null });
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
    expect(lectureFolder('C:/out', 'ru', () => config, () => false)).toEqual({ folder: path.join('C:/out', 'Лекции'), vault: null });
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
    const просьбы: string[] = [];
    const сессия = new LectureSession(
      папка,
      'Матанализ',
      {
        // Слово на каждые полсекунды звука.
        transcribe: async (samples) => `מילה `.repeat(samples.length / 8000).trim(),
        summarize: async (prompt) => {
          просьбы.push(prompt);
          return prompt.includes('## Кратко')
            ? 'Предмет: Математический анализ\nТема: Пределы функций\n\n## Кратко\nЛекция о пределах.'
            : '### Пределы\n- предел (גבול) — к чему стремится функция';
        },
        sectionEveryMs: 10_000,
        sectionMinWords: 10,
      },
      new Date(2026, 8, 29, 10, 0),
    );
    await сессия.start();

    // 8 с звука — раздела ещё нет (мало времени); к 16-й секунде — порог и
    // слов, и времени; остаток — последним разделом при завершении.
    сессия.addAudio(new Float32Array(16_000 * 8), 16_000);
    сессия.addAudio(new Float32Array(16_000 * 8), 16_000);
    сессия.addAudio(new Float32Array(16_000 * 4), 16_000);
    const итог = await сессия.finish(['Математический анализ', 'Физика']);

    const расшифровка = await readFile(итог.transcriptFile, 'utf8');
    // Запись сплошная: метка — место куска в звуке, а не время прихода.
    expect(расшифровка).toContain('**[00:00]**');
    expect(расшифровка).toContain('**[00:08]**');
    expect(расшифровка).toContain('**[00:16]**');

    const конспект = await readFile(итог.notesFile, 'utf8');
    // Итог стоит над разделами, разделы — по порядку и со своим временем.
    expect(конспект.indexOf('## Кратко')).toBeGreaterThan(0);
    expect(конспект.indexOf('## Кратко')).toBeLessThan(конспект.indexOf('## Конспект'));
    expect(конспект).toContain('### Пределы (00:00–00:16)');
    expect(конспект).toContain('### Пределы (00:16–00:20)');
    // Строки курса и темы — не в заметку, а в итог сессии.
    expect(конспект).not.toContain('Тема: Пределы функций');
    expect(итог).toMatchObject({ sections: 2, words: 40, durationSec: 20, course: 'Математический анализ', topic: 'Пределы функций' });
    const разделы = просьбы.filter((p) => p.includes('### Тема куска'));
    expect(разделы).toHaveLength(2);
    // Названия прошлых разделов — без времени: модели оно ни к чему.
    expect(разделы[1]).toContain('Уже написанные разделы: Пределы.');
    expect(просьбы.find((p) => p.includes('## Кратко'))).toContain('Курсы студента: Математический анализ; Физика.');

    const wav = await readFile(итог.audioFile);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(16_000 * 20 * 2);
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

  it('очередь распознавания: backlog ждёт, пока в ней не останется лишнего', async () => {
    const папка = await временная();
    // Распознавание отвечает, только когда его отпустят.
    const ждут: Array<() => void> = [];
    let готово = 0;
    const сессия = new LectureSession(папка, '', {
      transcribe: async () => {
        await new Promise<void>((r) => ждут.push(r));
        готово += 1;
        return '';
      },
      summarize: async () => '',
    });
    await сессия.start();
    for (let i = 0; i < 3; i += 1) сессия.addAudio(new Float32Array(16_000 * 10), 16_000);
    let дождались = false;
    const ждём = сессия.backlog(15).then(() => {
      дождались = true;
    });
    const отпустить = async (): Promise<void> => {
      while (ждут.length === 0) await new Promise((r) => setTimeout(r, 5));
      ждут.shift()?.();
    };
    await отпустить();
    await new Promise((r) => setTimeout(r, 250));
    // 30 с в очереди, один кусок распознан — осталось 20, больше 15: ждём дальше.
    expect(дождались).toBe(false);
    await отпустить();
    await ждём;
    expect(готово).toBe(2);
    await отпустить();
    await сессия.backlog(0);
    expect(готово).toBe(3);
    await сессия.finish();
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

describe('языки лекции и конспекта', () => {
  it('лекция на языке конспекта — без терминов в скобках; на другом — термины лектора в скобках', () => {
    const свой = sectionPrompt('кусок', 'Физика', [], { lecture: 'ru', notes: 'ru' });
    expect(свой).not.toMatch(/в скобках/u);
    expect(свой).toMatch(/Сделай ОДИН раздел конспекта на русском/u);

    const чужой = sectionPrompt('кусок', 'Физика', [], { lecture: 'he', notes: 'ru' });
    expect(чужой).toMatch(/лекцию на иврите/u);
    expect(чужой).toMatch(/в скобках на иврите/u);
    expect(finalPrompt('текст', '', { lecture: 'he', notes: 'ru' })).toMatch(/термин лектора на иврите/u);

    // Языка нет в списке названий — код как есть, а не пустое место.
    expect(sectionPrompt('кусок', '', [], { lecture: 'pt', notes: 'ru' })).toMatch(/на языке «pt»/u);
  });

  it('английский конспект — промпт, отказ и заголовки по-английски', () => {
    const свой = sectionPrompt('chunk', 'Physics', [], { lecture: 'en', notes: 'en' });
    expect(свой).toMatch(/Write ONE section of notes in English/u);
    expect(свой).not.toMatch(/parentheses/u);
    expect(sectionPrompt('chunk', '', [], { lecture: 'ru', notes: 'en' })).toMatch(/lecture in Russian[\s\S]*in Russian in parentheses/u);
    expect(finalPrompt('text', '', { lecture: 'en', notes: 'en' })).toMatch(/## Summary[\s\S]*## Concepts[\s\S]*## Exam questions/u);
    expect(sectionFromReply('SKIP', 1, 'en')).toBeNull();
    expect(sectionFromReply('- point', 2, 'en')).toBe('### Section 2\n- point');
  });

  it('английский конспект целиком: имена файлов, папка, итог над разделами', async () => {
    const папка = await временная();
    const сессия = new LectureSession(
      папка,
      '',
      {
        transcribe: async () => 'today we talk about limits of functions',
        summarize: async (prompt) => (prompt.includes('## Summary') ? '## Summary\nLimits.' : '### Limits\n- a limit is where a function tends'),
        lectureLanguage: 'en',
        notesLanguage: 'en',
        sectionEveryMs: 0,
        sectionMinWords: 1,
      },
      new Date(2026, 8, 29, 10, 5),
    );
    await сессия.start();
    сессия.addAudio(new Float32Array(1600), 16_000);
    const итог = await сессия.finish();
    expect(path.basename(итог.notesFile)).toBe('2026-09-29 1005 Lecture.md');
    expect(path.basename(итог.transcriptFile)).toBe('2026-09-29 1005 Lecture — transcript.md');
    const заметка = await readFile(итог.notesFile, 'utf8');
    expect(заметка).toContain('Transcript: [[2026-09-29 1005 Lecture — transcript]]');
    expect(заметка.indexOf('## Summary')).toBeLessThan(заметка.indexOf('## Notes'));
    expect(заметка.indexOf('## Notes')).toBeLessThan(заметка.indexOf('### Limits'));
    expect(lectureFolder('C:/out', 'en', () => null)).toEqual({ folder: path.join('C:/out', 'Lectures'), vault: null });
  });

  it('язык лекции в настройках — только код языка; пусто — язык интерфейса', () => {
    expect(normaliseSettings({ lectureLanguage: 'HE' }).lectureLanguage).toBe('he');
    expect(normaliseSettings({}).lectureLanguage).toBe('');
    for (const плохой of ['иврит', 'he; rm -rf', 'hebrew', 7]) {
      expect(normaliseSettings({ lectureLanguage: плохой }).lectureLanguage, String(плохой)).toBe('');
    }
  });
});

describe('Джарвиса закрыли посреди лекции', () => {
  it('звук остаётся целым: размер в заголовке WAV дописан', async () => {
    const папка = await временная();
    const сессия = new LectureSession(папка, 'Физика', { transcribe: async () => '', summarize: async () => '' });
    await сессия.start();
    сессия.addAudio(new Float32Array(1600), 16_000);
    // Дать очереди дописать звук.
    await new Promise((resolve) => setTimeout(resolve, 50));
    сессия.abandon();
    const wav = await readFile(сессия.audioFile);
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });

  it('конспект дописывается по сохранённой расшифровке: разделы по пять минут, итог сверху', async () => {
    const папка = await временная();
    const заметка = path.join(папка, '2026-09-29 истории.md');
    await writeFile(заметка, '# истории\n\nРасшифровка: [[2026-09-29 истории — расшифровка]]\n\n## Конспект\n\n', 'utf8');
    const строки = Array.from({ length: 14 }, (_, i) => `**[${String(Math.floor((i * 40) / 60)).padStart(2, '0')}:${String((i * 40) % 60).padStart(2, '0')}]** ${'מילה '.repeat(20).trim()}`);
    await writeFile(path.join(папка, '2026-09-29 истории — расшифровка.md'), `# Расшифровка — истории\n\n${строки.join('\n\n')}\n`, 'utf8');

    const просьбы: string[] = [];
    const итог = await finishFromTranscript({
      notesFile: заметка,
      summarize: async (prompt) => {
        просьбы.push(prompt);
        return prompt.includes('## Кратко') ? '## Кратко\nО лекции.' : `### Тема ${просьбы.length}\n- пункт`;
      },
      lectureLanguage: 'he',
      notesLanguage: 'ru',
    });

    // 14 кусков по 40 с = 8:40: раздел на пятой минуте и остаток.
    expect(итог).toEqual({ sections: 2, summary: true });
    const текст = await readFile(заметка, 'utf8');
    expect(текст.indexOf('## Кратко')).toBeLessThan(текст.indexOf('## Конспект'));
    expect(текст.indexOf('## Конспект')).toBeLessThan(текст.indexOf('### Тема 1'));
    expect(просьбы[0]).toMatch(/Предмет: истории/u);
    expect(просьбы[0]).toMatch(/в скобках на иврите/u);
    // Второй раз — не дописывает поверх.
    expect(await finishFromTranscript({ notesFile: заметка, summarize: async () => 'x', lectureLanguage: 'he', notesLanguage: 'ru' })).toMatchObject({ skipped: 'конспект уже дописан' });
  });

  it('разделы, написанные вживую, не повторяются (ревью 29.09.2026)', async () => {
    const папка = await временная();
    const заметка = path.join(папка, '2026-09-29 истории.md');
    await writeFile(заметка, '# истории\n\n## Конспект\n\n### Живой раздел\n- был\n\n', 'utf8');
    const строки = Array.from({ length: 14 }, (_, i) => `**[${String(Math.floor((i * 40) / 60)).padStart(2, '0')}:${String((i * 40) % 60).padStart(2, '0')}]** ${'מילה '.repeat(20).trim()}`);
    await writeFile(path.join(папка, '2026-09-29 истории — расшифровка.md'), строки.join('\n\n'), 'utf8');

    const просьбы: string[] = [];
    const итог = await finishFromTranscript({
      notesFile: заметка,
      summarize: async (prompt) => {
        просьбы.push(prompt);
        return prompt.includes('## Кратко') ? '## Кратко\nО лекции.' : '### Остаток\n- пункт';
      },
      lectureLanguage: 'he',
      notesLanguage: 'ru',
    });
    // Из двух разделов первый уже был — дописан только остаток.
    expect(итог.sections).toBe(1);
    const текст = await readFile(заметка, 'utf8');
    expect(текст.match(/### /gu)).toHaveLength(2);
    expect(просьбы[0]).toMatch(/Уже написанные разделы: Живой раздел/u);
  });

  it('метки расшифровки читаются и с часами', () => {
    expect(parseTranscript('**[00:10]** a\n\nмусор\n**[1:02:03]** b')).toEqual([
      { at: 10, text: 'a' },
      { at: 3723, text: 'b' },
    ]);
  });
});
