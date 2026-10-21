/**
 * Записи лекций на диске: сколько места занимают и как их удалить.
 *
 * Звук пишется сплошным WAV, 16 кГц: полторы минуты — три мегабайта, пара в
 * полтора часа — около 280 МБ. У владельца за полторы недели семестра
 * набралось 2,5 ГБ (замер 21.10.2026), за семестр выйдет 15–19.
 *
 * Удаляется только звук, и насовсем, а не в Корзину: место ради этого и
 * освобождают. Конспект, расшифровка и вопросы остаются. Пропадает «▶ с этой
 * минуты» и возможность перерасшифровать лекцию — поэтому звук лекции, у
 * которой расшифровки нет или в ней ни слова, не трогается: это единственный
 * шанс её переделать.
 *
 * Запись — только WAV рядом с заметкой лекции Джарвиса (со свойствами лекции).
 * Чужой звук, положенный в хранилище руками, и запись идущей лекции (её
 * заметка без свойств до конца лекции) сюда не попадают.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { COURSE_WORDS, parseFrontmatter } from './courses';
import { NOTES_WORDS, type NotesLanguage } from './session';

/** Записи старше этого удаляются сами, если в настройках так и оставлено. */
export const RECORDING_KEEP_DAYS = 7;
const ДЕНЬ = 24 * 60 * 60 * 1000;

export interface Recording {
  /** Папка курса — или «Без курса». */
  course: string;
  /** Имя лекции — как у заметки, без `.md`. */
  lecture: string;
  notesFile: string;
  audioFile: string;
  bytes: number;
  /** Когда запись легла на диск, мс. */
  modifiedMs: number;
  /** Почему звук нужен: расшифровки нет или в ней ни слова. Нет — можно удалять. */
  keep?: 'no-transcript' | 'empty-transcript';
}

export interface RecordingsSummary {
  count: number;
  bytes: number;
  /** Сколько из них можно удалить — с расшифровкой. */
  deletable: number;
  deletableBytes: number;
}

/** Строка расшифровки с речью: «**[12:34]** текст». */
const РЕЧЬ = /^\*\*\[\d[\d:]*\]\*\*[ \t]+\S/mu;

/** Расшифровка лекции и язык её подписей — по имени файла. */
function расшифровкаК(база: string): { file: string; notes: NotesLanguage } | null {
  for (const notes of ['ru', 'en'] as const) {
    const file = `${база} — ${NOTES_WORDS[notes].transcriptFile}.md`;
    if (existsSync(file)) return { file, notes };
  }
  return null;
}

/** Запись лекции по её заметке; звука нет или это не лекция Джарвиса — null. */
export function recordingOf(notesFile: string): Recording | null {
  const база = path.join(path.dirname(notesFile), path.basename(notesFile, '.md'));
  const audioFile = `${база}.wav`;
  try {
    if (!existsSync(audioFile) || !parseFrontmatter(readFileSync(notesFile, 'utf8'))) return null;
    const звук = statSync(audioFile);
    const р = расшифровкаК(база);
    const keep = !р ? 'no-transcript' : РЕЧЬ.test(readFileSync(р.file, 'utf8')) ? undefined : 'empty-transcript';
    return {
      course: path.basename(path.dirname(notesFile)),
      lecture: path.basename(notesFile, '.md'),
      notesFile,
      audioFile,
      bytes: звук.size,
      modifiedMs: звук.mtimeMs,
      ...(keep ? { keep } : {}),
    };
  } catch {
    return null;
  }
}

/** Все записи в «Лекциях»: по курсам и «Без курса». Входящие — не лекции. */
export function listRecordings(root: string): Recording[] {
  if (!existsSync(root)) return [];
  const неЛекции = new Set<string>([COURSE_WORDS.ru.inbox, COURSE_WORDS.en.inbox]);
  const записи: Recording[] = [];
  for (const папка of readdirSync(root, { withFileTypes: true })) {
    if (!папка.isDirectory() || папка.name.startsWith('.') || неЛекции.has(папка.name)) continue;
    const где = path.join(root, папка.name);
    for (const имя of readdirSync(где)) {
      if (!/\.wav$/iu.test(имя)) continue;
      const запись = recordingOf(path.join(где, `${имя.slice(0, -4)}.md`));
      if (запись) записи.push(запись);
    }
  }
  return записи.sort((a, b) => a.modifiedMs - b.modifiedMs);
}

export function summarizeRecordings(records: readonly Recording[]): RecordingsSummary {
  const можно = records.filter((r) => !r.keep);
  return {
    count: records.length,
    bytes: records.reduce((n, r) => n + r.bytes, 0),
    deletable: можно.length,
    deletableBytes: можно.reduce((n, r) => n + r.bytes, 0),
  };
}

/** Записи, которым пора уйти: с расшифровкой и старше недели. */
export function expiredRecordings(records: readonly Recording[], now: number, days = RECORDING_KEEP_DAYS): Recording[] {
  return records.filter((r) => !r.keep && now - r.modifiedMs >= days * ДЕНЬ);
}

function дата(when: Date, notes: NotesLanguage): string {
  const д = (n: number): string => String(n).padStart(2, '0');
  return notes === 'en'
    ? `${when.getFullYear()}-${д(when.getMonth() + 1)}-${д(when.getDate())}`
    : `${д(when.getDate())}.${д(when.getMonth() + 1)}.${when.getFullYear()}`;
}

/**
 * Удалить звук лекции. В заметке проигрыватель звука заменяется строкой о
 * том, что звук удалён: иначе Obsidian показывал бы на его месте ссылку в
 * никуда.
 */
export async function deleteRecording(record: Recording, now: Date = new Date()): Promise<void> {
  if (record.keep) throw new Error(`звук лекции «${record.lecture}» нужен: ${record.keep === 'no-transcript' ? 'расшифровки нет' : 'расшифровка пустая'}`);
  await rm(record.audioFile, { force: true });
  const notes = расшифровкаК(path.join(path.dirname(record.notesFile), record.lecture))?.notes ?? 'ru';
  const строка =
    notes === 'en'
      ? `*Lecture audio deleted on ${дата(now, notes)} to save disk space; the notes and transcript remain.*`
      : `*Звук лекции удалён ${дата(now, notes)}, чтобы не занимать место: конспект и расшифровка остались.*`;
  try {
    const текст = await readFile(record.notesFile, 'utf8');
    const имя = path.basename(record.audioFile).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const стало = текст.replace(new RegExp(`^!\\[\\[${имя}\\]\\][ \\t]*$`, 'mu'), строка);
    if (стало !== текст) await writeFile(record.notesFile, стало, 'utf8');
  } catch {
    // Заметку не поправили — звук всё равно удалён, а ссылка просто ведёт в никуда.
  }
}

/** Удалить звук у всех записей, какие можно; нужные пропускаются. */
export async function deleteRecordings(
  records: readonly Recording[],
  now: Date = new Date(),
): Promise<{ deleted: number; bytes: number; kept: number; failed: number }> {
  let deleted = 0;
  let bytes = 0;
  let failed = 0;
  for (const r of records) {
    if (r.keep) continue;
    try {
      await deleteRecording(r, now);
      deleted += 1;
      bytes += r.bytes;
    } catch {
      // Файл занят проигрывателем или Obsidian — удалится в следующий раз.
      failed += 1;
    }
  }
  return { deleted, bytes, kept: records.filter((r) => r.keep).length, failed };
}
