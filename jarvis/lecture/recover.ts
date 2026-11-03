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
import path from 'node:path';

import type { NotesStyle } from '../notes/style';
import { COURSE_WORDS, coursesForModel, lectureLanguagesFor, listCourses, parseFrontmatter, type LectureLanguages } from './courses';
import { finalizeLecture, type FinalizeResult } from './finalize';
import { finishFromTranscript } from './finishFromTranscript';
import { NOTES_WORDS, notesLanguageOf, type NotesLanguage } from './session';

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
  log?(line: string): void;
}

export interface RecoverResult extends FinalizeResult {
  sections: number;
  summary: boolean;
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
  const итог = await finishFromTranscript({
    notesFile,
    summarize: o.summarize,
    summarizeFinal: o.summarizeFinal,
    lectureLanguage: языки.lecture,
    notesLanguage: notes,
    notesStyle: o.notesStyle,
    courses: coursesForModel(o.root),
    log: o.log,
  });
  if (итог.skipped) o.log?.(`дописывать нечего: ${итог.skipped} — раскладываю как есть`);
  const место = await finalizeLecture({
    root: o.root,
    notesFile,
    transcriptFile: `${база} — ${NOTES_WORDS[notes].transcriptFile}.md`,
    audioFile: `${база}.wav`,
    notes,
    when: lectureStartOf(notesFile),
    durationSec: секунд,
    course: курс,
    modelCourse: итог.course,
    topic: итог.topic,
  });
  return { ...место, sections: итог.sections, summary: итог.summary };
}
