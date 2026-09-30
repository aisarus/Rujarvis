/**
 * Лекция кончилась — разложить её по месту: папка курса, тема в имени,
 * свойства в заметке, строка на странице курса.
 *
 * Делается ПОСЛЕ записи, а не во время: пока звук пишется, Windows может не
 * дать переименовать файл, в который пишут. Поэтому во время лекции файлы
 * называются временно («2026-09-30 1005 Лекция»), а здесь получают настоящие
 * имена — все три разом и со ссылками друг на друга.
 *
 * Курс решается по старшинству: выбранный человеком (кнопкой на плашке или
 * голосом) → угаданный по расписанию → названный моделью по содержанию. Модель
 * получает список курсов и выбирает из него; нового не нашлось — называет
 * новый курс сама.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  COURSE_WORDS,
  coursePage,
  dateParts,
  durationText,
  lectureBase,
  listCourses,
  listLectures,
  matchCourse,
  parseFrontmatter,
  safeName,
  stripCourseGloss,
  withFrontmatter,
  type LectureMeta,
} from './courses';
import { NOTES_WORDS, type NotesLanguage } from './session';

export interface FinalizeInput {
  /** Папка «Лекции» в хранилище. */
  root: string;
  notesFile: string;
  transcriptFile: string;
  audioFile: string;
  notes: NotesLanguage;
  /** Когда лекция началась. */
  when: Date;
  durationSec: number;
  /** Выбранный человеком или по расписанию; null — решает модель. */
  course: string | null;
  /** Что назвала модель. */
  modelCourse?: string;
  topic?: string;
  /**
   * Эта запись заменяет лекцию того же курса за тот же день — запасной
   * диктофон или официальная запись курса. Прежние файлы уходят в Корзину
   * (`trash`), а номер лекции остаётся прежним. Лекций того дня две — не
   * заменяется ничего: какую из них заменить, не угадать.
   */
  replaceSameDay?: boolean;
  trash?(file: string): Promise<void>;
  /** Номер лекции уже известен — её перерасшифровали, и место в курсе прежнее. */
  number?: number;
}

export interface FinalizeResult {
  notesFile: string;
  transcriptFile: string;
  audioFile: string;
  course: string;
  number: number;
}

/** Имя, которого в папке ещё нет (своё прежнее имя не в счёт). */
function свободнаяБаза(папка: string, база: string, свои: ReadonlySet<string>, суффикс: string): string {
  const занято = (б: string): boolean =>
    [`${б}.md`, `${б} — ${суффикс}.md`, `${б}.wav`].some((имя) => {
      const полный = path.join(папка, имя);
      return existsSync(полный) && !свои.has(path.resolve(полный));
    });
  if (!занято(база)) return база;
  for (let n = 2; ; n += 1) if (!занято(`${база} (${n})`)) return `${база} (${n})`;
}

/** Переименовать, если есть что и куда; Windows иногда держит файл секунду после записи. */
async function переложить(от: string, куда: string): Promise<void> {
  if (path.resolve(от) === path.resolve(куда) || !existsSync(от)) return;
  for (let попытка = 0; ; попытка += 1) {
    try {
      await rename(от, куда);
      return;
    } catch (error) {
      const код = (error as NodeJS.ErrnoException).code;
      if (попытка >= 4 || (код !== 'EPERM' && код !== 'EBUSY' && код !== 'EACCES')) throw error;
      await new Promise((r) => setTimeout(r, 500 * (попытка + 1)));
    }
  }
}

export async function finalizeLecture(input: FinalizeInput): Promise<FinalizeResult> {
  const с = NOTES_WORDS[input.notes];
  const к = COURSE_WORDS[input.notes];
  const известные = listCourses(input.root);
  // Модель повторяет строку списка целиком — «Курс (на иврите)»: скобки прочь.
  const названный = input.modelCourse ? safeName(stripCourseGloss(input.modelCourse), 60) : '';
  const курс =
    (input.course ? matchCourse(input.course, известные) ?? safeName(input.course, 60) : null) ||
    (названный ? matchCourse(названный, известные) ?? названный : '') ||
    к.unsorted;
  const папка = path.join(input.root, курс);
  await mkdir(папка, { recursive: true });

  const свои = new Set([input.notesFile, input.transcriptFile, input.audioFile].map((ф) => path.resolve(ф)));
  let прошлые = listLectures(input.root, курс).filter((л) => !свои.has(path.resolve(л.file)));
  const { date, start } = dateParts(input.when);

  let номер = input.number ?? прошлые.reduce((макс, л) => Math.max(макс, л.meta.number ?? 0), 0) + 1;
  const тотЖеДень = прошлые.filter((л) => л.meta.date === date);
  const заменяемая = input.replaceSameDay && тотЖеДень.length === 1 ? тотЖеДень[0] : undefined;
  if (заменяемая && input.trash) {
    const база = path.join(path.dirname(заменяемая.file), path.basename(заменяемая.file, '.md'));
    for (const файл of [`${база}.md`, `${база} — ${с.transcriptFile}.md`, `${база}.wav`]) {
      if (existsSync(файл) && !свои.has(path.resolve(файл))) await input.trash(файл);
    }
    номер = заменяемая.meta.number ?? номер;
    прошлые = прошлые.filter((л) => л !== заменяемая);
  }
  const база = свободнаяБаза(папка, lectureBase(date, input.topic), свои, с.transcriptFile);
  const заметка = path.join(папка, `${база}.md`);
  const расшифровка = path.join(папка, `${база} — ${с.transcriptFile}.md`);
  const звук = path.join(папка, `${база}.wav`);

  const meta: LectureMeta = { course: курс, number: номер, date, start, topic: input.topic, duration: durationText(input.durationSec) };

  // Заметка: свойства, заголовок — тема, строка ссылок — на новые имена.
  let текст = await readFile(input.notesFile, 'utf8');
  текст = withFrontmatter(текст, meta, input.notes);
  текст = текст.replace(/^# .*$/mu, `# ${input.topic ?? курс}`);
  const ссылки = `${с.transcript}: [[${path.basename(расшифровка, '.md')}]] · [[${курс}]]\n\n![[${path.basename(звук)}]]`;
  // Прежний проигрыватель звука — долой: лекция, которую переносят второй
  // раз, получила бы их два.
  текст = текст.replace(/^!\[\[[^\]]*\.wav\]\][ \t]*\r?\n?/gmu, '');
  текст = текст.replace(new RegExp(`^${с.transcript}: .*$`, 'mu'), ссылки).replace(/\n{3,}/gu, '\n\n');
  await writeFile(input.notesFile, текст, 'utf8');

  if (existsSync(input.transcriptFile)) {
    let р = await readFile(input.transcriptFile, 'utf8');
    р = р.replace(/^# .*$/mu, `# ${с.transcript} — ${input.topic ?? курс}`);
    р = р.replace(new RegExp(`^${с.notesLink}: \\[\\[.*\\]\\]$`, 'mu'), `${с.notesLink}: [[${база}]]`);
    await writeFile(input.transcriptFile, р, 'utf8');
  }

  await переложить(input.audioFile, звук);
  await переложить(input.transcriptFile, расшифровка);
  await переложить(input.notesFile, заметка);

  // Страница курса — список всех его лекций, включая эту. Лекция переехала из
  // другого курса — у того страница тоже обновляется, иначе в ней висела бы
  // ссылка в никуда.
  await обновитьСтраницу(input.root, курс, input.notes);
  const прежний = path.relative(input.root, path.dirname(input.notesFile));
  if (прежний && !прежний.startsWith('..') && !path.isAbsolute(прежний) && прежний !== курс && existsSync(path.join(input.root, прежний, `${прежний}.md`))) {
    await обновитьСтраницу(input.root, прежний, input.notes);
  }

  return { notesFile: заметка, transcriptFile: расшифровка, audioFile: звук, course: курс, number: номер };
}

async function обновитьСтраницу(root: string, курс: string, notes: NotesLanguage): Promise<void> {
  const страница = path.join(root, курс, `${курс}.md`);
  const было = existsSync(страница) ? await readFile(страница, 'utf8') : null;
  await writeFile(страница, coursePage(было, курс, listLectures(root, курс), notes), 'utf8');
}

/**
 * «Это не история, это социология» — лекция переезжает в другой курс: папка,
 * номер, свойства, обе страницы курсов. Тема и дата остаются.
 */
export async function moveLecture(root: string, notesFile: string, course: string, notes: NotesLanguage): Promise<FinalizeResult> {
  const с = NOTES_WORDS[notes];
  const текст = await readFile(notesFile, 'utf8');
  const meta = parseFrontmatter(текст);
  if (!meta) throw new Error('это не лекция Джарвиса: в заметке нет свойств лекции');
  const база = path.join(path.dirname(notesFile), path.basename(notesFile, '.md'));
  const [часы, минуты] = (meta.start ?? '00:00').split(':').map(Number);
  const [г, м, д] = meta.date.split('-').map(Number);
  const [dh, dm] = (meta.duration ?? '0:00').split(':').map(Number);
  return finalizeLecture({
    root,
    notesFile,
    transcriptFile: `${база} — ${с.transcriptFile}.md`,
    audioFile: `${база}.wav`,
    notes,
    when: new Date(г ?? 1970, (м ?? 1) - 1, д ?? 1, часы ?? 0, минуты ?? 0),
    durationSec: ((dh ?? 0) * 60 + (dm ?? 0)) * 60,
    course,
    topic: meta.topic,
  });
}
