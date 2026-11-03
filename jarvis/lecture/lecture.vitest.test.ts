import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { normaliseSettings } from '../setup/settings';
import { finishFromTranscript, parseTranscript } from './finishFromTranscript';
import { finalPrompt, LectureSession, sectionFromReply, sectionPrompt } from './session';
import { claudeSummaryArgs, createClaudeSummarizer, createFinalSummarizer, FINAL_TIMEOUT_MS, withFallback } from './summarize';
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
    const разделы = просьбы.filter((p) => p.includes('Сделай ОДИН раздел'));
    expect(разделы).toHaveLength(2);
    expect(разделы[0]).toContain('Уже написанные разделы: ещё нет.');
    // Каждая строка куска — со своим временем: по нему пометка о числе ведёт в звук.
    expect(разделы[0]).toMatch(/^\[00:00\] מילה/mu);
    expect(разделы[0]).toMatch(/^\[00:08\] מילה/mu);
    // Прошлый раздел — целиком, с числами и временем: следующему по нему сверять.
    expect(разделы[1]).toContain('### Пределы (00:00–00:16)\n- предел (גבול) — к чему стремится функция');
    expect(разделы[1]).toMatch(/^\[00:16\] מילה/mu);
    const итоговая = просьбы.find((p) => p.includes('## Кратко'));
    expect(итоговая).toContain('Курсы студента: Математический анализ; Физика.');
    expect(итоговая).toMatch(/^\[00:00\] מילה[\s\S]*^\[00:16\] מילה/mu);

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

describe('итог лекции — сильнейшей моделью', () => {
  it('итог уходит в summarizeFinal, разделы — в summarize', async () => {
    const папка = await временная();
    const разделами: string[] = [];
    const итогом: string[] = [];
    const сессия = new LectureSession(papka(папка), 'Матанализ', {
      transcribe: async (samples) => 'מילה '.repeat(samples.length / 8000).trim(),
      summarize: async (prompt) => {
        разделами.push(prompt);
        return '### Пределы\n- предел (גבול)';
      },
      summarizeFinal: async (prompt) => {
        итогом.push(prompt);
        return 'Предмет: Математический анализ\nТема: Пределы\n\n## Кратко\nО пределах.';
      },
      sectionEveryMs: 10_000,
      sectionMinWords: 10,
    });
    await сессия.start();
    сессия.addAudio(new Float32Array(16_000 * 12), 16_000);
    const итог = await сессия.finish(['Математический анализ']);
    expect(итогом).toHaveLength(1);
    expect(разделами.length).toBeGreaterThan(0);
    expect(разделами.some((p) => p.includes('## Кратко'))).toBe(false);
    expect(итог.topic).toBe('Пределы');
  });

  it('первая модель не ответила — итог пишет запасная, а не пропадает', async () => {
    const журнал: string[] = [];
    const итог = withFallback(
      async () => {
        throw new Error('limit reached');
      },
      async (prompt) => `запасная: ${prompt}`,
      (строка) => журнал.push(строка),
    );
    expect(await итог('итог')).toBe('запасная: итог');
    expect(журнал[0]).toContain('limit reached');
  });

  it('opus — тем же вызовом CLI, только моделью', () => {
    expect(claudeSummaryArgs('opus')).toEqual(expect.arrayContaining(['--model', 'opus', '--strict-mcp-config']));
  });
});

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

  it('итог ждут дольше раздела, и срок — у обеих моделей (03.11.2026: итог 1:55 пропал за 180 с)', async () => {
    expect(FINAL_TIMEOUT_MS).toBeGreaterThan(180_000);
    const журнал: string[] = [];
    const итог = createFinalSummarizer({
      command: process.execPath,
      args: ['-e', "setTimeout(()=>process.stdout.write('поздно'),5000)"],
      env: process.env,
      timeoutMs: 100,
      log: (строка) => журнал.push(строка),
    });
    await expect(итог('x')).rejects.toThrow(/не ответил за 0 с/u);
    expect(журнал[0]).toMatch(/первая модель не ответила \(Claude Code не ответил за 0 с\)/u);
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

  it('числа сверяются с самой лекцией: доказанное — с пометкой, недоказанное — как услышано (03.11.2026)', () => {
    // Живой случай: Whisper на иврите дал «1200» вместо 1250 и «1000, 890»
    // вместо 1890, а конспект молча записал точку A как (1000, 890).
    const раздел = sectionPrompt('[17:24] кусок', 'Микроэкономика', [], { lecture: 'he', notes: 'ru' });
    const итог = finalPrompt('[17:24] текст', '', { lecture: 'he', notes: 'ru' });
    for (const промпт of [раздел, итог]) {
      expect(промпт).toMatch(/сверяй с данными и арифметикой, прозвучавшими в этой же лекции/u);
      expect(промпт).toMatch(/однозначно доказывают другое значение — пиши доказанное[^\n]*«\(⚠ \d\d:\d\d: на слух \d+, по расчёту \d+\)»/u);
      expect(промпт).toMatch(/верное из лекции не вывести — оставь как услышано и пометь сомнение/u);
      expect(промпт).toMatch(/никогда не подставляй число, которого нельзя вывести из самой лекции/u);
      expect(промпт).toMatch(/каждая строка начинается со своего времени \[мм:сс\]/iu);
      // Живой прогон: без этого модель дописывала в раздел рассуждения о проверке.
      expect(промпт).toMatch(/О самой проверке не пиши ничего, кроме этих пометок/u);
    }
    // Раздел сверяет с прежними разделами, итог — со всей расшифровкой.
    expect(раздел).toMatch(/в этом куске и в уже написанных разделах/u);
    expect(итог).toMatch(/во всей расшифровке/u);
    // Смысл слов восстанавливается молча, а числа — нет.
    expect(раздел).toMatch(/восстанавливай смысл, а не буквы, — кроме чисел/u);

    const section = sectionPrompt('[17:24] chunk', 'Micro', [], { lecture: 'he', notes: 'en' });
    const summary = finalPrompt('[17:24] text', '', { lecture: 'he', notes: 'en' });
    for (const prompt of [section, summary]) {
      expect(prompt).toMatch(/against the data and arithmetic stated in this same lecture/u);
      expect(prompt).toMatch(/prove a different value beyond doubt — write the proven value[^\n]*"\(⚠ \d\d:\d\d: heard \d+, by calculation \d+\)"/u);
      expect(prompt).toMatch(/cannot be derived from the lecture — keep it as heard and flag the doubt/u);
      expect(prompt).toMatch(/never put in a number that cannot be derived from the lecture itself/u);
    }
    expect(section).toMatch(/in this chunk and in the sections already written/u);
    expect(summary).toMatch(/anywhere in the transcript/u);
    expect(section).toMatch(/restore the meaning, not the letters — except numbers/u);
    // Правило — среди указаний, до расшифровки, а не после десятков тысяч знаков лекции.
    expect(раздел.indexOf('Числа — отдельно')).toBeLessThan(раздел.indexOf('Расшифровка:'));
    expect(summary.indexOf('Numbers need special care')).toBeLessThan(summary.indexOf('Transcript:'));
  });

  it('формулы — в LaTeX для Obsidian, слова и пометки — вне формулы, деньги — без голого $ (03.11.2026)', () => {
    // Живой случай: статистика писала «L0 + n·(N/2 − F)/f», а Obsidian рисует только $…$.
    const промпты = [
      sectionPrompt('[51:36] кусок', '', [], { lecture: 'he', notes: 'ru' }),
      finalPrompt('[51:36] текст', '', { lecture: 'he', notes: 'ru' }),
    ];
    for (const промпт of промпты) {
      expect(промпт).toMatch(/Формулы — в LaTeX[^\n]*внутри \$…\$[^\n]*внутри \$\$…\$\$; дроби — \\dfrac\{…\}\{…\}; буквы и индексы — курса/u);
      // Живой прогон: формула выходила в $…$, а обозначения в перечне — голым текстом «L0 = 30».
      expect(промпт).toMatch(/в том числе в перечне обозначений и в тексте пункта \(«\$v_0 = 5\$», а не «v0 = 5»\)/u);
      expect(промпт).toMatch(/Слова и термины на любом языке — вне \$…\$, и пометки ⚠ тоже — сразу за формулой: \$x = 5\$ \(⚠/u);
      expect(промпт).toMatch(/Деньги — «5 долларов», «5 USD» или \\\$5\./u);
      // Пример — не из статистики, обратная косая — одна, как её увидит модель.
      expect(промпт).toContain('$v = v_0 + \\dfrac{F}{m}\\,t$');
      expect(промпт).not.toMatch(/\\\\dfrac/u);
      expect(промпт.indexOf('Формулы — в LaTeX')).toBeLessThan(промпт.indexOf('Расшифровка:'));
    }
    // Заголовок и тему видят вне Obsidian: голос, оверлей, имя файла, окно учёбы.
    expect(промпты[0]).toMatch(/заголовок: «### » и тема этого куска своими словами, без формул/u);
    expect(промпты[1]).toMatch(/Тема: <тема этой лекции в 3–6 словах, по-русски, без формул>/u);
    const английские = [
      sectionPrompt('[51:36] chunk', '', [], { lecture: 'he', notes: 'en' }),
      finalPrompt('[51:36] text', '', { lecture: 'he', notes: 'en' }),
    ];
    for (const prompt of английские) {
      expect(prompt).toMatch(/Formulas go in LaTeX[^\n]*inside \$…\$[^\n]*inside \$\$…\$\$; fractions with \\dfrac\{…\}\{…\}; letters and subscripts are the course's/u);
      expect(prompt).toMatch(/including in a list of symbols and in running text \("\$v_0 = 5\$", not "v0 = 5"\)/u);
      expect(prompt).toMatch(/Words and terms in any language stay outside \$…\$, and so do the ⚠ marks — right after the formula/u);
      expect(prompt).toMatch(/Write money as "5 dollars", "5 USD" or \\\$5\./u);
      expect(prompt).not.toMatch(/Формулы/u);
    }
    expect(английские[0]).toMatch(/the topic of this chunk in your own words, with no formulas/u);
    expect(английские[1]).toMatch(/Topic: <the topic of this lecture in 3–6 words, in English, with no formulas>/u);
  });

  it('формулы, обозначения и ответы не переписываются вслепую, обозначения — курса (03.11.2026)', () => {
    // Живой случай, статистика: «n — ширина класса» при n — числе наблюдений,
    // частота названа плотностью, ответ лектора «1 и 3» переписан без пометки.
    const раздел = sectionPrompt('[51:36] кусок', 'Статистика', ['### Медиана (46:24–51:36)\n- L0 — нижняя граница'], { lecture: 'he', notes: 'ru' });
    const итог = finalPrompt('[51:36] текст', '', { lecture: 'he', notes: 'ru' });
    for (const промпт of [раздел, итог]) {
      expect(промпт).toMatch(/Формулы, обозначения, определения, шаги решения и названные ответы — так же строго/u);
      expect(промпт).toMatch(/и со знанием предмета:/u);
      expect(промпт).toMatch(/обозначения — курса[^\n]*маленькая и большая буква — разные обозначения[^\n]*учебниковых обозначений вместо них не ставь/u);
      expect(промпт).toMatch(/противоречит предмету или самой лекции[^\n]*пиши верное, а сразу за ним пометку с меткой строки, где прозвучало услышанное: «\(⚠ \d\d:\d\d: на слух «/u);
      // Живой прогон: «n — 5» в подстановке исправлено молча, «частота (плотность)» — без пометки.
      expect(промпт).toMatch(/не той буквы или не того термина в подстановке или разборе примера/u);
      expect(промпт).toMatch(/одну величину называют двумя терминами, а в предмете это разные понятия, — оставь верный и пометь другой/u);
      expect(промпт).toMatch(/формула прозвучала не целиком[^\n]*сверить со слайдом/u);
      expect(промпт).toMatch(/ответ или вывод лектора не сходится с расчётом — не записывай его как верный[^\n]*«\(⚠ \d\d:\d\d: лектор сказал/u);
      expect(промпт).toMatch(/не уверен, что верно, — оставь как услышано и пометь сомнение/u);
      expect(промпт).toMatch(/молча не правь ничего из этого/u);
      // Живой прогон: итог двухчасовой лекции писал «42:59» вместо 1:42:59.
      expect(промпт).toMatch(/Время в пометке — метка той строки, где это прозвучало, целиком[^\n]*после первого часа — с часами/u);
      // Данные задачи — по-прежнему только из лекции, а итог и ответ — проверяются.
      expect(промпт).toMatch(/Это о данных; итог расчёта и названный ответ проверяй арифметикой/u);
      expect(промпт).toMatch(/сколько значений в условии задачи и какой итог для неё назван дальше/u);
      // Одна строка о молчании про проверку — после обоих правил.
      expect(промпт.match(/О самой проверке не пиши ничего/gu)).toHaveLength(1);
      expect(промпт.indexOf('молча не правь')).toBeLessThan(промпт.indexOf('О самой проверке'));
      expect(промпт.indexOf('О самой проверке')).toBeLessThan(промпт.indexOf('Расшифровка:'));
    }
    expect(раздел).toMatch(/восстанавливай смысл, а не буквы, — кроме чисел, формул и обозначений/u);
    expect(раздел).toMatch(/Уже написанные разделы — не повторяй их, но сверяй с ними числа, формулы и обозначения:\n\n### Медиана/u);
    // Примеры — не из той лекции: иначе живой прогон проверял бы пример.
    expect(раздел).not.toMatch(/ширина класса|медиан[аы] меняют/u);

    const section = sectionPrompt('[51:36] chunk', 'Statistics', ['### Median'], { lecture: 'he', notes: 'en' });
    const summary = finalPrompt('[51:36] text', '', { lecture: 'he', notes: 'en' });
    for (const prompt of [section, summary]) {
      expect(prompt).toMatch(/Formulas, notation, definitions, solution steps and stated answers need the same care/u);
      expect(prompt).toMatch(/and against knowledge of the subject:/u);
      expect(prompt).toMatch(/notation is the course's[^\n]*a small and a capital letter are different symbols[^\n]*do not swap in textbook notation/u);
      expect(prompt).toMatch(/a wrong letter or term heard in a substitution or worked example/u);
      expect(prompt).toMatch(/one quantity is called by two terms that are different things in the subject/u);
      expect(prompt).toMatch(/contradicts the subject or the lecture itself[^\n]*"\(⚠ \d\d:\d\d: heard '/u);
      expect(prompt).toMatch(/the lecturer's answer or conclusion fails by calculation — do not write it down as right/u);
      expect(prompt).toMatch(/correct none of this silently/u);
      expect(prompt).toMatch(/The time in a mark is the label of the line where it was said, in full[^\n]*past the first hour with the hour/u);
      expect(prompt).toMatch(/This is about the givens; a computed result and a stated answer you check by arithmetic/u);
      expect(prompt.match(/Write nothing about the checking itself/gu)).toHaveLength(1);
    }
    expect(section).toMatch(/except numbers, formulas and notation/u);
    expect(section).toMatch(/check numbers, formulas and notation against them:\n\n### Median/u);
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
    // Живой раздел идёт модели целиком, а не одним названием: по нему сверяются числа.
    expect(просьбы[0]).toMatch(/Уже написанные разделы — не повторяй их[\s\S]*### Живой раздел\n- был/u);
    // Куски — с метками времени, и в разделе, и в итоге.
    expect(просьбы[0]).toMatch(/^\[06:00\] מילה/mu);
    expect(просьбы[0]).not.toMatch(/^\[05:20\]/mu);
    expect(просьбы.find((p) => p.includes('## Кратко'))).toMatch(/^\[00:00\] מילה[\s\S]*^\[08:40\] מילה/mu);
  });

  it('метки расшифровки читаются и с часами', () => {
    expect(parseTranscript('**[00:10]** a\n\nмусор\n**[1:02:03]** b')).toEqual([
      { at: 10, text: 'a' },
      { at: 3723, text: 'b' },
    ]);
  });
});
