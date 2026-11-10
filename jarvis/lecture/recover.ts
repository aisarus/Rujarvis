/**
 * Брошенная лекция: Джарвиса закрыли посреди неё — обновлением, перезапуском,
 * выходом или выключением компьютера. Звук и расшифровка на диске, а
 * разделов, итога и места в курсе нет: на них нужна минута модели, а
 * закрытие ждать не может.
 *
 * Такую лекцию узнать просто: заметка без свойств лекции (их ставит
 * `finalizeLecture` в самом конце), а рядом — её расшифровка и звук. Дописать
 * — по сохранённой расшифровке (`finishFromTranscript`) и разложить по курсу,
 * как законченную. Раньше это делалось только командой в терминале
 * (`pnpm jarvis:lecture-finish`); теперь Джарвис делает это сам при запуске.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { hasSummary, type NotesStyle } from '../notes/style';
import { writeFileAtomic } from './atomicWrite';
import { COURSE_WORDS, coursesForModel, lectureLanguagesFor, listCourses, listLectures, parseFrontmatter, type LectureLanguages } from './courses';
import { finalizeLecture, type FinalizeResult } from './finalize';
import { finishFromTranscript, parseTranscript, type TranscriptChunk } from './finishFromTranscript';
import { gapLine, gapsSeconds, mergeGaps, parseGaps, transcribeRange, wavInfo, type Gap } from './retranscribe';
import { FAILED_SECTION, метка, NOTES_WORDS, notesLanguageOf, type NotesLanguage } from './session';

/** Расшифровка рядом с заметкой — на любом из двух языков подписей. */
function расшифровкаК(база: string): string | null {
  for (const notes of ['ru', 'en'] as const) {
    const file = `${база} — ${NOTES_WORDS[notes].transcriptFile}.md`;
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Недописанные лекции: в папке лекций и в папках курсов (и «Без курса»).
 * `except` — заметки, которые пишутся прямо сейчас: у идущей лекции свойств
 * тоже ещё нет.
 */
export function findAbandonedLectures(root: string, except: ReadonlySet<string> = new Set()): string[] {
  if (!existsSync(root)) return [];
  const папки = [root, ...listCourses(root).map((курс) => path.join(root, курс))];
  for (const notes of ['ru', 'en'] as const) {
    const безКурса = path.join(root, COURSE_WORDS[notes].unsorted);
    if (existsSync(безКурса)) папки.push(безКурса);
  }
  const чужие = new Set([...except].map((f) => path.resolve(f)));
  const найдено: string[] = [];
  for (const папка of папки) {
    for (const имя of readdirSync(папка)) {
      if (!имя.endsWith('.md') || / — (расшифровка|transcript)\.md$/u.test(имя) || имя === `${path.basename(папка)}.md`) continue;
      const заметка = path.join(папка, имя);
      const база = заметка.slice(0, -3);
      if (чужие.has(path.resolve(заметка)) || !existsSync(`${база}.wav`) || !расшифровкаК(база)) continue;
      try {
        if (!parseFrontmatter(readFileSync(заметка, 'utf8'))) найдено.push(заметка);
      } catch {
        // Не читается — не трогаем.
      }
    }
  }
  return найдено.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/**
 * Заголовок WAV по настоящему размеру файла: брошенная запись могла не успеть
 * его дописать. 16 бит, моно, 16 кГц — как пишет сессия. Секунды звука.
 */
export function repairWavHeader(file: string): number {
  try {
    const данные = Math.max(0, statSync(file).size - 44);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + данные, 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(16_000, 24);
    h.writeUInt32LE(32_000, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(данные, 40);
    const fd = openSync(file, 'r+');
    try {
      writeSync(fd, h, 0, 44, 0);
    } finally {
      closeSync(fd);
    }
    return данные / 32_000;
  } catch {
    // Звука нет — конспект дописывается и без него.
    return 0;
  }
}

/** Когда шла лекция: из временного имени «2026-09-29 1005 …», иначе — время файла. */
export function lectureStartOf(notesFile: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2})(\d{2}))?/u.exec(path.basename(notesFile));
  if (m && m[4]) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const стат = statSync(notesFile);
  return new Date(стат.birthtimeMs || стат.mtimeMs);
}

export interface RecoverOptions {
  /** Папка «Лекции». */
  root: string;
  /** Языки из настроек; у курса со своими — его. */
  languages: LectureLanguages;
  notesStyle?: NotesStyle;
  summarize(prompt: string): Promise<string>;
  summarizeFinal?(prompt: string): Promise<string>;
  /**
   * Чем распознать звук, который не успели или не смогли распознать: слух на
   * языке лекции. null — сейчас распознавать нечем (идёт другая лекция, модель
   * не установлена): нераспознанное остаётся пометкой и ждёт следующего раза.
   * Не задано — запись не трогается вовсе.
   */
  hearing?(language: string): Promise<Hearing | null>;
  log?(line: string): void;
}

export interface Hearing {
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>;
  close(): void | Promise<void>;
}

export interface RecoverResult extends FinalizeResult {
  sections: number;
  summary: boolean;
  /** Итог есть, заглушек нет, дыр нет: переделывать нечего. */
  complete: boolean;
  /** Сколько секунд звука так и не распознано. */
  untranscribedSec: number;
  /** Почему итог не написан. */
  summaryError?: string;
}

const СТРОКА = /^\*\*\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\*\*\s+(.+)$/u;

/**
 * Добрать расшифровку из записи: дыры, помеченные в ней, и — у брошенной
 * лекции (`tail`) — хвост, до которого распознавание не дошло.
 *
 * Хвост — от последней строки расшифровки до конца звука: закрытие Джарвиса
 * не ждёт очередь распознавания, а у машины, которая распознаёт медленнее
 * речи, в очереди десятки минут. Последняя строка распознаётся заново вместе
 * с хвостом: где кончился её кусок, расшифровка не знает. Тишина строк не
 * даёт и стоит дёшево — её отсекает сам слух.
 *
 * Что распознать не вышло, остаётся в расшифровке пометкой: по ней звук
 * лекции не удаляется, а следующий запуск пробует снова.
 */
export async function completeTranscript(o: {
  transcriptFile: string;
  audioFile: string;
  tail: boolean;
  hearing(): Promise<Hearing | null>;
  log?(line: string): void;
}): Promise<{ fresh: TranscriptChunk[]; untranscribedSec: number }> {
  const текст = await readFile(o.transcriptFile, 'utf8').catch(() => null);
  if (текст === null) return { fresh: [], untranscribedSec: 0 };
  const помеченные = parseGaps(текст);
  if (!existsSync(o.audioFile)) return { fresh: [], untranscribedSec: gapsSeconds(помеченные) };

  const строки = текст.split(/\r?\n/u);
  const первая = строки.findIndex((с) => СТРОКА.test(с.trim()) || parseGaps(с).length > 0);
  const шапка = (первая >= 0 ? строки.slice(0, первая) : строки).join('\n').trimEnd();
  let куски = parseTranscript(текст).map((к) => ({ at: к.at * 1000, text: к.text }));

  const { durationMs } = await wavInfo(o.audioFile);
  const хвост: Gap[] = [];
  if (o.tail) {
    const от = куски.length > 0 ? (куски[куски.length - 1]?.at ?? 0) : 0;
    if (durationMs - от > 1000) хвост.push({ from: от, to: durationMs });
  }
  const отрезки = mergeGaps([...помеченные, ...хвост]).filter((д) => д.to - д.from > 500);
  if (отрезки.length === 0) return { fresh: [], untranscribedSec: 0 };

  const слух = await o.hearing().catch((error: unknown) => {
    o.log?.(`распознавать нечем: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  const остались: Gap[] = [];
  const новые: Array<{ at: number; text: string }> = [];
  try {
    for (const отрезок of отрезки) {
      if (!слух) {
        // Хвост без слуха — только то, чего в расшифровке ещё нет: её последняя строка остаётся.
        остались.push(отрезок);
        continue;
      }
      const { lines, failed } = await transcribeRange(o.audioFile, отрезок, слух.transcribe).catch((error: unknown) => {
        o.log?.(`отрезок ${метка(отрезок.from)}–${метка(отрезок.to)} не распознан: ${error instanceof Error ? error.message : String(error)}`);
        return { lines: [], failed: [отрезок] };
      });
      остались.push(...failed);
      // Распознанное заново заменяет прежние строки тех же секунд (последнюю строку перед хвостом).
      const вНеудаче = (мс: number): boolean => failed.some((д) => мс >= Math.floor(д.from / 1000) * 1000 && мс < д.to);
      const от = Math.floor(отрезок.from / 1000) * 1000;
      куски = куски.filter((к) => к.at < от || к.at >= отрезок.to || вНеудаче(к.at));
      новые.push(...lines);
      o.log?.(`добрано из записи ${метка(отрезок.from)}–${метка(отрезок.to)}: кусков ${lines.length}${failed.length > 0 ? `, не вышло ${Math.round(gapsSeconds(failed))} с` : ''}`);
    }
  } finally {
    await слух?.close();
  }

  const дыры = mergeGaps(остались);
  const тело = [
    ...куски.map((к) => ({ от: к.at, строка: `**[${метка(к.at)}]** ${к.text}` })),
    ...новые.map((к) => ({ от: к.at, строка: `**[${метка(к.at)}]** ${к.text}` })),
    ...дыры.map((д) => ({ от: д.from, строка: gapLine(д) })),
  ].sort((a, b) => a.от - b.от);
  const новый = `${шапка}\n\n${тело.map((с) => `${с.строка}\n\n`).join('')}`;
  if (новый !== текст) await writeFileAtomic(o.transcriptFile, новый);
  return { fresh: новые.map((к) => ({ at: Math.floor(к.at / 1000), text: к.text })), untranscribedSec: gapsSeconds(дыры) };
}

/**
 * Дописать брошенную лекцию и разложить по курсу. Расшифровки нет или итог
 * уже был — всё равно раскладывается: иначе лекция так и считалась бы
 * брошенной и дописывалась при каждом запуске.
 */
export async function recoverLecture(notesFile: string, o: RecoverOptions): Promise<RecoverResult> {
  // Лежит в папке курса — этот курс и есть выбранный; в самой папке лекций — решает модель.
  const папка = path.relative(o.root, path.dirname(notesFile));
  const курс = папка && !папка.startsWith('..') && !path.isAbsolute(папка) && !Object.values(COURSE_WORDS).some((w) => w.unsorted === папка) ? папка : null;
  const языки = курс ? lectureLanguagesFor(notesFile, o.languages) : o.languages;
  // Конспект дописывается на языке, на котором его начали: заголовки в заметке уже стоят.
  const notes: NotesLanguage = notesLanguageOf(readFileSync(notesFile, 'utf8')) ?? языки.notes;
  const база = notesFile.replace(/\.md$/u, '');
  const секунд = repairWavHeader(`${база}.wav`);
  const transcriptFile = `${база} — ${NOTES_WORDS[notes].transcriptFile}.md`;
  const добор = o.hearing
    ? await completeTranscript({
        transcriptFile,
        audioFile: `${база}.wav`,
        tail: true,
        hearing: () => (o.hearing ? o.hearing(языки.lecture) : Promise.resolve(null)),
        log: o.log,
      })
    : { fresh: [], untranscribedSec: 0 };
  const итог = await finishFromTranscript({
    notesFile,
    summarize: o.summarize,
    summarizeFinal: o.summarizeFinal,
    lectureLanguage: языки.lecture,
    notesLanguage: notes,
    notesStyle: o.notesStyle,
    courses: coursesForModel(o.root),
    fresh: добор.fresh,
    log: o.log,
  });
  if (итог.skipped) o.log?.(`дописывать нечего: ${итог.skipped} — раскладываю как есть`);
  const место = await finalizeLecture({
    root: o.root,
    notesFile,
    transcriptFile,
    audioFile: `${база}.wav`,
    notes,
    when: lectureStartOf(notesFile),
    durationSec: секунд,
    course: курс,
    modelCourse: итог.course,
    topic: итог.topic,
  });
  return {
    ...место,
    sections: итог.sections,
    summary: итог.summary,
    complete: (итог.complete || итог.skipped === 'расшифровки нет') && добор.untranscribedSec === 0,
    untranscribedSec: добор.untranscribedSec,
    ...(итог.summaryError ? { summaryError: итог.summaryError } : {}),
  };
}

/** За сколько дней назад недописанные лекции ещё дописываются сами. */
export const INCOMPLETE_KEEP_DAYS = 30;

/**
 * Разложенные лекции, у которых конспект не дописан: раздел остался заглушкой
 * «Раздел не собрался», итога нет, в расшифровке дыры. Так кончается лекция,
 * на которой кончился лимит подписки или упало распознавание: записано всё, а
 * дописать нечем. Это видно по самим заметкам — отдельного списка нет.
 *
 * Только недавние: лекцию, которая не дописалась за месяц запусков, каждый
 * запуск заново не трогает.
 */
export function findIncompleteLectures(root: string, now: number = Date.now(), days = INCOMPLETE_KEEP_DAYS): string[] {
  if (!existsSync(root)) return [];
  const лекции = [...listLectures(root), ...listLectures(root, COURSE_WORDS.ru.unsorted), ...listLectures(root, COURSE_WORDS.en.unsorted)];
  const найдено: string[] = [];
  for (const { file, meta } of лекции) {
    const когда = new Date(`${meta.date}T12:00:00`).getTime();
    if (Number.isNaN(когда) || now - когда > days * 24 * 60 * 60 * 1000) continue;
    try {
      const заметка = readFileSync(file, 'utf8');
      const база = file.slice(0, -3);
      const р = расшифровкаК(база);
      const расшифровка = р ? readFileSync(р, 'utf8') : '';
      const естьРечь = parseTranscript(расшифровка).length > 0;
      const дыры = parseGaps(расшифровка).length > 0 && existsSync(`${база}.wav`);
      if ((естьРечь && (FAILED_SECTION.test(заметка) || !hasSummary(заметка))) || дыры) найдено.push(file);
    } catch {
      // Не читается — не трогаем.
    }
  }
  return найдено;
}

export interface CompleteResult {
  notesFile: string;
  course: string;
  sections: number;
  summary: boolean;
  complete: boolean;
  untranscribedSec: number;
  summaryError?: string;
}

/**
 * Дописать разложенную лекцию: добрать дыры расшифровки из записи, переделать
 * заглушки разделов, написать итог. Лекция без темы или без курса получает их
 * от модели и встаёт на место — как только что законченная.
 */
export async function completeLecture(notesFile: string, o: RecoverOptions): Promise<CompleteResult> {
  const заметка = readFileSync(notesFile, 'utf8');
  const meta = parseFrontmatter(заметка);
  if (!meta) throw new Error('это не лекция Джарвиса: в заметке нет свойств лекции');
  const папка = path.basename(path.dirname(notesFile));
  const безКурса = Object.values(COURSE_WORDS).some((w) => w.unsorted === папка);
  const языки = безКурса ? o.languages : lectureLanguagesFor(notesFile, o.languages);
  const notes: NotesLanguage = notesLanguageOf(заметка) ?? языки.notes;
  const база = notesFile.slice(0, -3);
  const transcriptFile = расшифровкаК(база) ?? `${база} — ${NOTES_WORDS[notes].transcriptFile}.md`;
  const добор = o.hearing
    ? await completeTranscript({
        transcriptFile,
        audioFile: `${база}.wav`,
        tail: false,
        hearing: () => (o.hearing ? o.hearing(языки.lecture) : Promise.resolve(null)),
        log: o.log,
      })
    : { fresh: [], untranscribedSec: gapsSeconds(parseGaps(await readFile(transcriptFile, 'utf8').catch(() => ''))) };
  const итог = await finishFromTranscript({
    notesFile,
    summarize: o.summarize,
    summarizeFinal: o.summarizeFinal,
    lectureLanguage: языки.lecture,
    notesLanguage: notes,
    notesStyle: o.notesStyle,
    courses: coursesForModel(o.root),
    subject: безКурса ? '' : папка,
    fresh: добор.fresh,
    log: o.log,
  });
  let место = { notesFile, course: папка };
  if (итог.summary && (безКурса || !meta.topic) && (итог.course || итог.topic)) {
    const [часы, минуты] = (meta.start ?? '00:00').split(':').map(Number);
    const [г, м, д] = meta.date.split('-').map(Number);
    const [dh, dm] = (meta.duration ?? '0:00').split(':').map(Number);
    место = await finalizeLecture({
      root: o.root,
      notesFile,
      transcriptFile,
      audioFile: `${база}.wav`,
      notes,
      when: new Date(г ?? 1970, (м ?? 1) - 1, д ?? 1, часы ?? 0, минуты ?? 0),
      durationSec: ((dh ?? 0) * 60 + (dm ?? 0)) * 60,
      course: безКурса ? null : папка,
      modelCourse: итог.course,
      topic: meta.topic ?? итог.topic,
      ...(безКурса ? {} : { number: meta.number }),
    });
  }
  return {
    notesFile: место.notesFile,
    course: место.course,
    sections: итог.sections,
    summary: итог.summary,
    complete: итог.complete && добор.untranscribedSec === 0,
    untranscribedSec: добор.untranscribedSec,
    ...(итог.summaryError ? { summaryError: итог.summaryError } : {}),
  };
}
