/**
 * Курсы и лекции в хранилище: у каждого курса своя папка, у лекции — тема.
 *
 *     Лекции/
 *       История человечества/
 *         История человечества.md                 страница курса
 *         2026-09-30 — Неолитическая революция.md
 *         2026-09-30 — Неолитическая революция — расшифровка.md
 *         2026-09-30 — Неолитическая революция.wav
 *
 * Лекция знает о себе по свойствам Obsidian в начале заметки (курс, номер,
 * дата, начало, тема, длительность) — по ним же Джарвис узнаёт расписание:
 * две лекции истории по вторникам около десяти — и нажатие кнопки во вторник
 * в 10:05 уже пишет в историю.
 *
 * Предмет со слуха приходит в падеже: «конспект по истории человечества» —
 * это «истории». Поэтому курсы сравниваются по основам слов, а не по буквам.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { NotesLanguage } from './session';

export interface LectureMeta {
  course: string;
  /** Номер лекции в курсе, с единицы. */
  number?: number;
  /** YYYY-MM-DD. */
  date: string;
  /** HH:MM — когда началась. */
  start?: string;
  topic?: string;
  /** Длительность, «1:28». */
  duration?: string;
}

/** Имена свойств — на языке конспекта; читаются оба. */
const СВОЙСТВА = {
  ru: { course: 'курс', number: 'лекция', date: 'дата', start: 'начало', topic: 'тема', duration: 'длительность' },
  en: { course: 'course', number: 'lecture', date: 'date', start: 'start', topic: 'topic', duration: 'duration' },
} as const;

/** Слова папок и подписей — на языке конспекта. */
export const COURSE_WORDS = {
  ru: { folder: 'Лекции', unsorted: 'Без курса', transcriptSuffix: 'расшифровка', listStart: '%% список лекций ведёт Джарвис %%', listEnd: '%% конец списка %%' },
  en: { folder: 'Lectures', unsorted: 'Unsorted', transcriptSuffix: 'transcript', listStart: '%% lecture list kept by Jarvis %%', listEnd: '%% end of list %%' },
} as const;

/** Основы слов: регистр, ё и окончания не важны; предлоги и союзы — мимо. */
export function courseStems(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((слово) => слово.length >= 3)
    .map((слово) => слово.slice(0, 5));
}

/**
 * Какой из известных курсов назван. Совпасть должны почти все основы:
 * «история» — не «история древнего мира».
 */
export function matchCourse(name: string, courses: readonly string[]): string | null {
  const искомое = courseStems(name);
  if (искомое.length === 0) return null;
  let лучший: string | null = null;
  let счёт = 0;
  for (const курс of courses) {
    const основы = courseStems(курс);
    if (основы.length === 0) continue;
    const общих = искомое.filter((о) => основы.includes(о)).length;
    const доля = общих / Math.max(искомое.length, основы.length);
    if (доля > счёт) {
      счёт = доля;
      лучший = курс;
    }
  }
  return счёт >= 0.66 ? лучший : null;
}

function минуты(hhmm: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/u.exec(hhmm ?? '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Курс по расписанию: лекции того же дня недели в пределах часа от этого
 * времени. Нужно хотя бы две — одна могла быть переносом — и явный лидер.
 */
export function guessBySchedule(when: Date, lectures: readonly LectureMeta[], windowMin = 60, minCount = 2): string | null {
  const сейчас = when.getHours() * 60 + when.getMinutes();
  const счёт = new Map<string, number>();
  for (const л of lectures) {
    const начало = минуты(л.start);
    const день = new Date(`${л.date}T12:00:00`);
    if (начало === null || Number.isNaN(день.getTime()) || день.getDay() !== when.getDay()) continue;
    if (Math.abs(начало - сейчас) > windowMin) continue;
    счёт.set(л.course, (счёт.get(л.course) ?? 0) + 1);
  }
  const по = [...счёт.entries()].sort((a, b) => b[1] - a[1]);
  const [первый, второй] = по;
  if (!первый || первый[1] < minCount || (второй && второй[1] === первый[1])) return null;
  return первый[0];
}

function вСтроку(значение: string): string {
  // Двоеточие, решётка или кавычка в начале ломают YAML — такие берём в кавычки.
  return /[:#"'[\]{}]|^\s|\s$/u.test(значение) ? JSON.stringify(значение) : значение;
}

export function renderFrontmatter(meta: LectureMeta, notes: NotesLanguage): string {
  const к = СВОЙСТВА[notes];
  const строки = ['---', `${к.course}: ${вСтроку(meta.course)}`];
  if (meta.number !== undefined) строки.push(`${к.number}: ${meta.number}`);
  строки.push(`${к.date}: ${meta.date}`);
  if (meta.start) строки.push(`${к.start}: "${meta.start}"`);
  if (meta.topic) строки.push(`${к.topic}: ${вСтроку(meta.topic)}`);
  if (meta.duration) строки.push(`${к.duration}: "${meta.duration}"`);
  строки.push('---', '');
  return строки.join('\n');
}

/** Свойства из начала заметки; не лекция Джарвиса — null. */
export function parseFrontmatter(text: string): LectureMeta | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!m) return null;
  const поля = new Map<string, string>();
  for (const строка of (m[1] ?? '').split(/\r?\n/u)) {
    const пара = /^([^:]+):\s*(.*)$/u.exec(строка);
    if (!пара) continue;
    let значение = (пара[2] ?? '').trim();
    if (/^".*"$/u.test(значение)) {
      try {
        значение = JSON.parse(значение) as string;
      } catch {
        значение = значение.slice(1, -1);
      }
    }
    поля.set((пара[1] ?? '').trim().toLowerCase(), значение);
  }
  const взять = (ключ: keyof (typeof СВОЙСТВА)['ru']): string | undefined => поля.get(СВОЙСТВА.ru[ключ]) ?? поля.get(СВОЙСТВА.en[ключ]);
  const course = взять('course');
  const date = взять('date');
  if (!course || !date) return null;
  const номер = Number(взять('number'));
  return {
    course,
    date,
    number: Number.isInteger(номер) && номер > 0 ? номер : undefined,
    start: взять('start') || undefined,
    topic: взять('topic') || undefined,
    duration: взять('duration') || undefined,
  };
}

/** Заметка без свойств в начале — те же строки, со свойствами — заменённые. */
export function withFrontmatter(text: string, meta: LectureMeta, notes: NotesLanguage): string {
  const без = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '');
  return `${renderFrontmatter(meta, notes)}${без.replace(/^\s+/u, '')}`;
}

/** То, что Windows не пускает в имена, и лишние пробелы. */
export function safeName(text: string, max = 80): string {
  return text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
    .replace(/[.\s]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Имя лекции: дата и тема; без темы — одна дата. */
export function lectureBase(date: string, topic: string | undefined): string {
  const тема = safeName(topic ?? '', 70);
  return тема ? `${date} — ${тема}` : date;
}

/** Дата и время по-человечески для свойств: YYYY-MM-DD и HH:MM. */
export function dateParts(when: Date): { date: string; start: string } {
  const д = (n: number): string => String(n).padStart(2, '0');
  return { date: `${when.getFullYear()}-${д(when.getMonth() + 1)}-${д(when.getDate())}`, start: `${д(when.getHours())}:${д(when.getMinutes())}` };
}

export function durationText(seconds: number): string {
  const всего = Math.max(0, Math.round(seconds / 60));
  return `${Math.floor(всего / 60)}:${String(всего % 60).padStart(2, '0')}`;
}

export interface LectureFile {
  file: string;
  meta: LectureMeta;
}

function заметкаЛекции(имя: string, папка: string): boolean {
  if (!имя.endsWith('.md')) return false;
  const база = имя.slice(0, -3);
  if (база === папка) return false;
  return !база.endsWith(` — ${COURSE_WORDS.ru.transcriptSuffix}`) && !база.endsWith(` — ${COURSE_WORDS.en.transcriptSuffix}`);
}

/**
 * Курсы — папки в `Лекции`. «Без курса» — не курс: это лекции, которым
 * курс не нашёлся, и предлагать его в списке или модели незачем.
 */
export function listCourses(root: string): string[] {
  if (!existsSync(root)) return [];
  const неКурсы = new Set<string>([COURSE_WORDS.ru.unsorted, COURSE_WORDS.en.unsorted]);
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !неКурсы.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Лекции курса (или всех курсов) — по свойствам заметок. */
export function listLectures(root: string, course?: string): LectureFile[] {
  const курсы = course ? [course] : listCourses(root);
  const лекции: LectureFile[] = [];
  for (const курс of курсы) {
    const папка = path.join(root, курс);
    if (!existsSync(папка)) continue;
    for (const имя of readdirSync(папка)) {
      if (!заметкаЛекции(имя, курс)) continue;
      const файл = path.join(папка, имя);
      let текст: string;
      try {
        текст = readFileSync(файл, 'utf8');
      } catch {
        continue;
      }
      const meta = parseFrontmatter(текст);
      if (meta) лекции.push({ file: файл, meta: { ...meta, course: курс } });
    }
  }
  return лекции.sort((a, b) => a.meta.date.localeCompare(b.meta.date) || (a.meta.start ?? '').localeCompare(b.meta.start ?? ''));
}

/**
 * Список лекций на странице курса — между двумя пометками. Всё, что человек
 * написал на странице сам, остаётся как было.
 */
export function coursePage(existing: string | null, course: string, lectures: readonly LectureFile[], notes: NotesLanguage): string {
  const с = COURSE_WORDS[notes];
  const пункты = lectures.map((л) => {
    const база = path.basename(л.file, '.md');
    const [г, м, д] = л.meta.date.split('-');
    const номер = л.meta.number ? `${л.meta.number}. ` : '- ';
    return `${номер}[[${база}]] — ${д}.${м}.${г}`;
  });
  const блок = [с.listStart, ...пункты, с.listEnd].join('\n');
  if (existing) {
    const от = existing.indexOf(с.listStart);
    const до = existing.indexOf(с.listEnd);
    if (от >= 0 && до > от) return `${existing.slice(0, от)}${блок}${existing.slice(до + с.listEnd.length)}`;
    return `${existing.trimEnd()}\n\n${блок}\n`;
  }
  return `# ${course}\n\n${блок}\n`;
}

/** Строки «Предмет: …» и «Тема: …» в начале ответа модели — и остальной ответ. */
export function splitCourseAndTopic(reply: string): { course?: string; topic?: string; rest: string } {
  const строки = reply.replace(/\r\n/gu, '\n').split('\n');
  let course: string | undefined;
  let topic: string | undefined;
  let i = 0;
  for (; i < строки.length; i += 1) {
    const строка = (строки[i] ?? '').trim().replace(/^\*\*|\*\*$/gu, '');
    if (!строка) continue;
    const курс = /^\**(предмет|курс|subject|course)\**\s*:\s*\**\s*(.+?)\s*\**$/iu.exec(строка);
    const тема = /^\**(тема|topic)\**\s*:\s*\**\s*(.+?)\s*\**$/iu.exec(строка);
    if (курс) course = (курс[2] ?? '').replace(/[«»"]/gu, '').trim() || undefined;
    else if (тема) topic = (тема[2] ?? '').replace(/[«»"]/gu, '').trim() || undefined;
    else break;
  }
  return { course, topic, rest: строки.slice(i).join('\n').trim() };
}
