/**
 * Лекция не должна пропадать — проверки на находки инженерного ревью
 * 10.11.2026: нераспознанный звук, кончившийся лимит подписки, полный диск,
 * оборванная запись заметки, свойства, дописанные человеком.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeFileAtomic } from './atomicWrite';
import { parseFrontmatter, renderFrontmatter, withFrontmatter } from './courses';
import { moveLecture } from './finalize';
import { finishFromTranscript, sectionRange } from './finishFromTranscript';
import { expiredRecordings, listRecordings, recordingOf } from './recordings';
import { completeLecture, findAbandonedLectures, findIncompleteLectures, recoverLecture, type Hearing } from './recover';
import { gapLine, mergeGaps, parseGaps, transcribeRange } from './retranscribe';
import { lectureIncomplete, LectureSession } from './session';

const папки: string[] = [];
afterEach(async () => {
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

async function временная(): Promise<string> {
  const папка = await mkdtemp(path.join(tmpdir(), 'jarvis-loss-'));
  папки.push(папка);
  return папка;
}

const секунда = (n = 1): Float32Array => new Float32Array(16_000 * n).fill(0.1);

const модель = async (prompt: string): Promise<string> =>
  prompt.includes('[!abstract]') ? 'Предмет: Микроэкономика\nТема: Спрос\n\n## Кратко\nО спросе.' : '### Спрос\n- пункт';

function слух(transcribe: Hearing['transcribe']): { hearing: () => Promise<Hearing>; закрыт: () => boolean } {
  let закрыт = false;
  return {
    hearing: async () => ({
      transcribe,
      close: () => {
        закрыт = true;
      },
    }),
    закрыт: () => закрыт,
  };
}

describe('нераспознанный звук не пропадает', () => {
  it('кусок не распознался — в конце лекции он добирается из записи и встаёт на своё место', async () => {
    const папка = await временная();
    let вызов = 0;
    const беды: Array<[string, string | null]> = [];
    const сессия = new LectureSession(папка, 'Физика', {
      transcribe: async () => {
        вызов += 1;
        if (вызов === 2) throw new Error('fetch failed');
        return `слова куска ${вызов}`;
      },
      summarize: модель,
      trouble: (что, причина) => беды.push([что, причина]),
    });
    await сессия.start();
    for (let i = 0; i < 3; i += 1) сессия.addAudio(секунда(2), 16_000);
    const итог = await сессия.finish();

    const расшифровка = await readFile(итог.transcriptFile, 'utf8');
    // Три строки по порядку времени: вторая добрана из записи четвёртым вызовом.
    expect(расшифровка).toMatch(/\*\*\[00:00\]\*\* слова куска 1\n\n\*\*\[00:02\]\*\* слова куска 4\n\n\*\*\[00:04\]\*\* слова куска 3/u);
    expect(parseGaps(расшифровка)).toEqual([]);
    expect(итог).toMatchObject({ untranscribedSec: 0, summary: true, failedSections: 0 });
    expect(lectureIncomplete(итог)).toBe(false);
    // Человеку сказано и о беде, и о том, что она прошла.
    expect(беды).toEqual([
      ['transcribe', 'fetch failed'],
      ['transcribe', null],
    ]);
  });

  it('распознавание так и не ответило — дыра помечена в расшифровке, и звук из-за неё не удаляется', async () => {
    const root = await временная();
    const курс = path.join(root, 'Физика');
    await mkdir(курс, { recursive: true });
    let вызов = 0;
    const сессия = new LectureSession(курс, 'Физика', {
      transcribe: async () => {
        вызов += 1;
        if (вызов !== 1) throw new Error('сервер распознавания упал');
        return 'первые слова';
      },
      summarize: модель,
    });
    await сессия.start();
    for (let i = 0; i < 3; i += 1) сессия.addAudio(секунда(2), 16_000);
    const итог = await сессия.finish();

    expect(итог.untranscribedSec).toBe(4);
    expect(lectureIncomplete(итог)).toBe(true);
    const расшифровка = await readFile(итог.transcriptFile, 'utf8');
    expect(parseGaps(расшифровка)).toEqual([{ from: 2000, to: 6000 }]);
    // Звук цел: шесть секунд, как и принято.
    expect((await stat(итог.audioFile)).size).toBe(44 + 6 * 32_000);

    // Лекция разложена (у неё свойства), запись старше недели — но удалять её нельзя.
    await writeFile(итог.notesFile, `${renderFrontmatter({ course: 'Физика', number: 1, date: '2026-10-01' }, 'ru')}${await readFile(итог.notesFile, 'utf8')}`, 'utf8');
    const давно = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(итог.audioFile, давно, давно);
    expect(recordingOf(итог.notesFile)).toMatchObject({ keep: 'untranscribed' });
    expect(expiredRecordings(listRecordings(root), Date.now())).toEqual([]);
  });

  it('отрезок записи распознаётся заново; три отказа подряд — остаток сразу в неудачи', async () => {
    const папка = await временная();
    const сессия = new LectureSession(папка, '', { transcribe: async () => '', summarize: async () => '' });
    await сессия.start();
    сессия.addAudio(секунда(10), 16_000);
    const { audioFile } = await сессия.finish();

    const кусками = { minSec: 1, maxSec: 2 };
    const времена: number[] = [];
    const удача = await transcribeRange(
      audioFile,
      { from: 2000, to: 8000 },
      async (samples) => {
        времена.push(samples.length / 16_000);
        return 'текст';
      },
      кусками,
    );
    expect(удача.failed).toEqual([]);
    expect(удача.lines[0]).toEqual({ at: 2000, text: 'текст' });
    // Весь отрезок, без дыр и повторов: шесть секунд звука.
    expect(времена.reduce((a, b) => a + b, 0)).toBeCloseTo(6, 3);

    let вызовов = 0;
    const отказ = await transcribeRange(
      audioFile,
      { from: 0, to: 10_000 },
      async () => {
        вызовов += 1;
        throw new Error('нет сервера');
      },
      кусками,
    );
    expect(вызовов).toBe(3);
    expect(отказ.lines).toEqual([]);
    expect(отказ.failed).toEqual([{ from: 0, to: 10_000 }]);
  });

  it('пометки о дырах: туда и обратно, соседние сливаются', () => {
    expect(parseGaps(`# Расшифровка\n\n**[00:00]** слова\n\n${gapLine({ from: 28_000.4, to: 56_000 })}\n\nтекст %% jarvis:gap 1-2 %% в строке — не пометка\n`)).toEqual([
      { from: 28_000, to: 56_000 },
    ]);
    expect(mergeGaps([{ from: 5000, to: 6000 }, { from: 0, to: 2000 }, { from: 2000, to: 4000 }])).toEqual([
      { from: 0, to: 4000 },
      { from: 5000, to: 6000 },
    ]);
  });
});

describe('брошенная лекция: хвост, до которого распознавание не дошло', () => {
  /** Лекция закрыта, когда распознан только первый кусок из трёх. */
  async function сХвостом(папка: string): Promise<LectureSession> {
    let вызов = 0;
    // Второй кусок так и не распознаётся: процесс закрыли, очередь умерла вместе с ним.
    const стоит = new Promise<void>(() => undefined);
    const сессия = new LectureSession(
      папка,
      '',
      {
        transcribe: async () => {
          вызов += 1;
          if (вызов > 1) await стоит;
          return 'начало лекции';
        },
        summarize: async () => '',
      },
      new Date(2026, 9, 20, 10, 5),
    );
    await сессия.start();
    for (let i = 0; i < 3; i += 1) сессия.addAudio(секунда(2), 16_000);
    for (let i = 0; i < 100 && (await stat(сессия.audioFile)).size < 44 + 6 * 32_000; i += 1) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 100 && !(await readFile(сессия.transcriptFile, 'utf8')).includes('начало лекции'); i += 1) await new Promise((r) => setTimeout(r, 10));
    сессия.abandon();
    return сессия;
  }

  it('при запуске хвост распознаётся из записи, и конспект пишется по всей лекции', async () => {
    const root = await временная();
    const сессия = await сХвостом(root);
    expect(findAbandonedLectures(root)).toEqual([сессия.notesFile]);

    const уши = слух(async (samples) => `хвост ${samples.length / 16_000} с`);
    const итог = await recoverLecture(сессия.notesFile, { root, languages: { lecture: 'ru', notes: 'ru' }, summarize: модель, hearing: уши.hearing });
    expect(итог).toMatchObject({ complete: true, untranscribedSec: 0, summary: true });
    expect(уши.закрыт()).toBe(true);
    const расшифровка = await readFile(итог.transcriptFile, 'utf8');
    // Последняя строка распознана заново вместе с хвостом: шесть секунд одним куском.
    expect(расшифровка).toContain('**[00:00]** хвост 6 с');
    expect(расшифровка).not.toContain('начало лекции');
    expect(parseGaps(расшифровка)).toEqual([]);
    expect(findIncompleteLectures(root, new Date(2026, 9, 21).getTime())).toEqual([]);
  });

  it('распознавать сейчас нечем — хвост остаётся пометкой, звук под защитой, следующий запуск добирает', async () => {
    const root = await временная();
    const сессия = await сХвостом(root);
    const сегодня = new Date(2026, 9, 21).getTime();

    const итог = await recoverLecture(сессия.notesFile, { root, languages: { lecture: 'ru', notes: 'ru' }, summarize: модель, hearing: async () => null });
    expect(итог).toMatchObject({ complete: false, untranscribedSec: 6 });
    expect(parseGaps(await readFile(итог.transcriptFile, 'utf8'))).toEqual([{ from: 0, to: 6000 }]);
    // Что уже было распознано, не выброшено.
    expect(await readFile(итог.transcriptFile, 'utf8')).toContain('начало лекции');
    expect(recordingOf(итог.notesFile)).toMatchObject({ keep: 'untranscribed' });
    expect(findIncompleteLectures(root, сегодня)).toEqual([итог.notesFile]);

    const уши = слух(async () => 'вся лекция');
    const потом = await completeLecture(итог.notesFile, { root, languages: { lecture: 'ru', notes: 'ru' }, summarize: модель, hearing: уши.hearing });
    expect(потом).toMatchObject({ complete: true, untranscribedSec: 0 });
    const расшифровка = await readFile(path.join(path.dirname(потом.notesFile), `${path.basename(потом.notesFile, '.md')} — расшифровка.md`), 'utf8');
    expect(расшифровка).toContain('**[00:00]** вся лекция');
    expect(расшифровка).not.toContain('начало лекции');
    expect(parseGaps(расшифровка)).toEqual([]);
    expect(recordingOf(потом.notesFile)?.keep).toBeUndefined();
    expect(findIncompleteLectures(root, сегодня)).toEqual([]);
  });
});

describe('кончился лимит подписки', () => {
  it('лекция не считается дописанной; заглушки и итог переделываются на месте, когда модель вернулась', async () => {
    const root = await временная();
    const курс = path.join(root, 'Микроэкономика');
    await mkdir(курс, { recursive: true });
    const сессия = new LectureSession(
      курс,
      '',
      {
        transcribe: async () => 'спрос падает когда цена растёт',
        summarize: async () => {
          throw new Error("You've hit your limit · resets 9pm");
        },
        sectionEveryMs: 4000,
        sectionMinWords: 5,
      },
      new Date(2026, 9, 20, 10, 5),
    );
    await сессия.start();
    for (let i = 0; i < 3; i += 1) сессия.addAudio(секунда(4), 16_000);
    const итог = await сессия.finish();

    expect(итог).toMatchObject({ summary: false, failedSections: 3, untranscribedSec: 0 });
    expect(итог.summaryError).toContain('hit your limit');
    expect(lectureIncomplete(итог)).toBe(true);
    const до = await readFile(итог.notesFile, 'utf8');
    expect(до.match(/Раздел не собрался/gu)).toHaveLength(3);

    // Разложена как есть — и числится недописанной.
    const { finalizeLecture } = await import('./finalize');
    const место = await finalizeLecture({ root, ...итог, notes: 'ru', when: сессия.startedAt, course: 'Микроэкономика' });
    const сегодня = new Date(2026, 9, 21).getTime();
    expect(findIncompleteLectures(root, сегодня)).toEqual([место.notesFile]);
    // Старую недописанную каждый запуск заново не трогает.
    expect(findIncompleteLectures(root, new Date(2027, 0, 1).getTime())).toEqual([]);

    // Лимит всё ещё не вернулся: ничего не испорчено, лекция по-прежнему недописана.
    const рано = await completeLecture(место.notesFile, {
      root,
      languages: { lecture: 'ru', notes: 'ru' },
      summarize: async () => {
        throw new Error('limit');
      },
    });
    expect(рано).toMatchObject({ complete: false, sections: 0, summary: false });
    expect((await readFile(место.notesFile, 'utf8')).match(/Раздел не собрался/gu)).toHaveLength(3);

    // Вернулся — заглушки заменены разделами на тех же местах, итог встал над конспектом.
    const просьбы: string[] = [];
    const потом = await completeLecture(место.notesFile, {
      root,
      languages: { lecture: 'ru', notes: 'ru' },
      summarize: async (prompt) => {
        просьбы.push(prompt);
        return prompt.includes('[!abstract]') ? 'Предмет: Микроэкономика\nТема: Спрос\n\n## Кратко\nО спросе.' : `### Раздел заново ${просьбы.length}\n- пункт`;
      },
    });
    expect(потом).toMatchObject({ complete: true, sections: 3, summary: true });
    // Тема пришла от модели — лекция получила настоящее имя.
    expect(path.basename(потом.notesFile)).toBe('2026-10-20 — Спрос.md');
    const после = await readFile(потом.notesFile, 'utf8');
    expect(после).not.toContain('Раздел не собрался');
    expect(после).toContain('### Раздел заново 1 (00:00–00:04)');
    expect(после).toContain('### Раздел заново 2 (00:04–00:08)');
    expect(после).toContain('### Раздел заново 3 (00:08–00:12)');
    expect(после.match(/^### /gmu)).toHaveLength(3);
    expect(после.indexOf('## Кратко')).toBeLessThan(после.indexOf('## Конспект'));
    expect(parseFrontmatter(после)).toMatchObject({ course: 'Микроэкономика', number: 1, topic: 'Спрос' });
    // Каждой заглушке — свой отрезок расшифровки.
    expect(просьбы[0]).toMatch(/^\[00:00\] спрос/mu);
    expect(просьбы[0]).not.toMatch(/^\[00:04\]/mu);
    expect(просьбы[1]).toMatch(/^\[00:04\] спрос/mu);
    expect(просьбы[2]).toMatch(/^\[00:08\] спрос/mu);
    expect(findIncompleteLectures(root, сегодня)).toEqual([]);
  });
});

describe('дописывание по расшифровке', () => {
  const строки = (n: number): string =>
    Array.from({ length: n }, (_, i) => `**[${String(Math.floor((i * 40) / 60)).padStart(2, '0')}:${String((i * 40) % 60).padStart(2, '0')}]** ${'слово '.repeat(20).trim()}`).join('\n\n');

  it('после «ПРОПУСК» разделы не пишутся второй раз: что есть в конспекте, видно по времени, а не по счёту', async () => {
    const папка = await временная();
    const заметка = path.join(папка, '2026-10-20 1005 Лекция.md');
    // Вживую: первый кусок (0:00–5:20) модель пропустила — шум; второй раздел написан; дальше закрыли.
    await writeFile(заметка, '# Лекция\n\n## Конспект\n\n### Спрос (05:20–10:40)\n- был\n\n', 'utf8');
    // 24 куска по 40 с = 16:00: пропуск, написанный раздел и ещё один кусок лекции.
    await writeFile(path.join(папка, '2026-10-20 1005 Лекция — расшифровка.md'), строки(24), 'utf8');

    const просьбы: string[] = [];
    const итог = await finishFromTranscript({
      notesFile: заметка,
      summarize: async (prompt) => {
        просьбы.push(prompt);
        return prompt.includes('[!abstract]') ? '## Кратко\nО лекции.' : '### Предложение\n- пункт';
      },
      lectureLanguage: 'ru',
      notesLanguage: 'ru',
    });
    expect(итог).toMatchObject({ sections: 1, summary: true, complete: true });
    const текст = await readFile(заметка, 'utf8');
    expect(текст.match(/^### /gmu)).toEqual(['### ', '### ']);
    expect(текст).toContain('### Предложение (10:40–15:21)');
    const разделы = просьбы.filter((p) => !p.includes('[!abstract]'));
    expect(разделы).toHaveLength(1);
    // Новому разделу — только то, чего в конспекте нет.
    expect(разделы[0]).toMatch(/^\[10:40\] слово/mu);
    expect(разделы[0]).not.toMatch(/^\[10:00\]/mu);

    // И второй раз — ничего: последний кусок уже в конспекте.
    expect(await finishFromTranscript({ notesFile: заметка, summarize: async () => '### Лишний\n- x', lectureLanguage: 'ru', notesLanguage: 'ru' })).toMatchObject({ skipped: 'конспект уже дописан' });
  });

  it('время раздела читается из заголовка, с часами и без', () => {
    expect(sectionRange('### Пределы (12:40–17:55)')).toEqual({ from: 760, to: 1075 });
    expect(sectionRange('### Итоги (59:30–1:02:03)')).toEqual({ from: 3570, to: 3723 });
    expect(sectionRange('### Раздел без времени')).toBeNull();
  });
});

describe('полный диск', () => {
  it('звук не записался — человеку сказано, а записанное после стоит на своих секундах', async () => {
    const папка = await временная();
    const беды: Array<[string, boolean]> = [];
    const сессия = new LectureSession(папка, '', {
      transcribe: async () => '',
      summarize: async () => '',
      trouble: (что, причина) => беды.push([что, причина !== null]),
    });
    await сессия.start();
    const записано = async (байт: number): Promise<void> => {
      for (let i = 0; i < 200; i += 1) {
        const размер = await stat(сессия.audioFile).then((с) => (с.isFile() ? с.size : -1), () => -1);
        if (размер >= байт) return;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    сессия.addAudio(new Float32Array(16_000).fill(0.25), 16_000);
    await записано(44 + 32_000);

    // Диск «кончился»: на месте файла папка — дописать в неё нельзя ни на одной системе.
    const было = await readFile(сессия.audioFile);
    await rm(сессия.audioFile);
    await mkdir(сессия.audioFile);
    сессия.addAudio(new Float32Array(16_000).fill(0.5), 16_000);
    for (let i = 0; i < 200 && беды.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(беды).toEqual([['audio', true]]);

    // Место освободили.
    await rm(сессия.audioFile, { recursive: true });
    await writeFile(сессия.audioFile, было);
    сессия.addAudio(new Float32Array(16_000).fill(0.75), 16_000);
    const итог = await сессия.finish();

    expect(беды).toEqual([
      ['audio', true],
      ['audio', false],
    ]);
    expect(итог.audioLostSec).toBe(1);
    const wav = await readFile(итог.audioFile);
    // Три секунды, как и принято: вторая — тишина, третья — на своём месте.
    expect(wav.length).toBe(44 + 3 * 32_000);
    expect(wav.readUInt32LE(40)).toBe(3 * 32_000);
    expect(wav.readInt16LE(44 + 100)).toBe(Math.round(0.25 * 0x7fff));
    expect(wav.readInt16LE(44 + 32_000 + 100)).toBe(0);
    expect(wav.readInt16LE(44 + 64_000 + 100)).toBe(Math.round(0.75 * 0x7fff));
  });
});

describe('заметки пишутся через временный файл', () => {
  it('запись целиком заменяет файл и не оставляет черновиков', async () => {
    const папка = await временная();
    const файл = path.join(папка, 'Заметка.md');
    await writeFile(файл, 'старое', 'utf8');
    await writeFileAtomic(файл, 'новое');
    expect(await readFile(файл, 'utf8')).toBe('новое');
    expect(await readdir(папка)).toEqual(['Заметка.md']);
  });

  it('запись не вышла — прежняя заметка цела, а не обрезана до нуля', async () => {
    const папка = await временная();
    const файл = path.join(папка, 'Заметка.md');
    await writeFile(файл, 'конспект семестра', 'utf8');
    // Черновик записать некуда: на его месте папка.
    await mkdir(path.join(папка, `.Заметка.md.${process.pid}.tmp`));
    await expect(writeFileAtomic(файл, 'новое')).rejects.toThrow();
    expect(await readFile(файл, 'utf8')).toBe('конспект семестра');
  });
});

describe('свойства, дописанные человеком', () => {
  it('свойства лекции заменяются, а теги и свои поля остаются — и многострочные тоже', () => {
    const meta = { course: 'История', number: 3, date: '2026-10-07', start: '10:05', topic: 'Неолит' };
    const заметка = `${renderFrontmatter(meta, 'ru').replace(/---\n$/u, 'tags:\n  - экзамен\n  - важное\nпреподаватель: Коэн\n---\n')}# Неолит\n\nтекст\n`;
    const стало = withFrontmatter(заметка, { ...meta, course: 'Социология', number: 1 }, 'ru');
    expect(parseFrontmatter(стало)).toMatchObject({ course: 'Социология', number: 1, topic: 'Неолит' });
    expect(стало).toContain('tags:\n  - экзамен\n  - важное\nпреподаватель: Коэн\n---\n# Неолит');
    // Свои свойства не двоятся.
    expect(стало.match(/^курс:/gmu)).toHaveLength(1);
    expect(стало.match(/^лекция:/gmu)).toHaveLength(1);
  });

  it('перенос лекции в другой курс их не стирает', async () => {
    const root = await временная();
    const курс = path.join(root, 'История');
    await mkdir(курс, { recursive: true });
    const база = '2026-10-07 — Неолит';
    const заметка = path.join(курс, `${база}.md`);
    await writeFile(
      заметка,
      `${renderFrontmatter({ course: 'История', number: 1, date: '2026-10-07', start: '10:05', topic: 'Неолит', duration: '1:30' }, 'ru').replace(/---\n$/u, 'tags: [экзамен]\n---\n')}# Неолит\n\nРасшифровка: [[${база} — расшифровка]] · [[История]]\n\n## Конспект\n`,
      'utf8',
    );
    await writeFile(path.join(курс, `${база} — расшифровка.md`), '# Расшифровка — Неолит\n\nКонспект: [[x]]\n\n**[00:00]** слова\n', 'utf8');
    const итог = await moveLecture(root, заметка, 'Социология', 'ru');
    const текст = await readFile(итог.notesFile, 'utf8');
    expect(parseFrontmatter(текст)).toMatchObject({ course: 'Социология', topic: 'Неолит' });
    expect(текст).toContain('tags: [экзамен]');
    expect(existsSync(заметка)).toBe(false);
  });
});
