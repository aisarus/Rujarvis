/**
 * What the agent remembers between sessions.
 *
 * Claude Code starts each run with no history, so anything learned while doing
 * a task — where a button lives, what the user calls a thing, which of three
 * launchers is the right one — is lost the moment the run ends, and the next
 * run rediscovers it at the user's expense.
 *
 * Kept in its own file rather than in Jarvis's `memory.json`: the assistant
 * writes that one from the Electron process while an agent run is in flight,
 * and two writers on one file lose each other's work.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { jarvisPaths } from '../setup/paths';

export interface Note {
  key: string;
  value: string;
  updatedAt: number;
}

/** Заметки агента — в папке данных Джарвиса, рядом с журналом. */
function memoryFile(): string {
  return path.join(jarvisPaths().data, 'agent-notes.json');
}

function read(): Note[] {
  const file = memoryFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { notes?: Note[] };
    return Array.isArray(parsed.notes) ? parsed.notes : [];
  } catch (error) {
    // Битый файл откладываем в сторону, а не затираем.
    //
    // Раньше он читался как пустой, и следующая же заметка записывала
    // хранилище из одной строки — до двухсот накопленных заметок пропадали
    // молча. А попасть на половину файла легко: у каждой живой сессии свой
    // сервер, и писателей бывает до четырёх.
    const копия = `${file}.broken-${Date.now()}`;
    try {
      renameSync(file, копия);
      console.error(`[jarvis] память агента не разобралась, отложена в ${копия}`);
    } catch {
      console.error(`[jarvis] память агента не разобралась: ${file}`);
    }
    void error;
    return [];
  }
}

function write(notes: Note[]): void {
  const file = memoryFile();
  mkdirSync(path.dirname(file), { recursive: true });
  // Через временный файл: обрыв посреди записи не должен оставить половину,
  // которую следующий читатель примет за пустоту.
  const черновик = `${file}.${process.pid}.tmp`;
  writeFileSync(черновик, JSON.stringify({ notes }, null, 2), 'utf8');
  renameSync(черновик, file);
}

/** Stores a fact, replacing any earlier one under the same key. */
export function remember(key: string, value: string): Note[] {
  const notes = read().filter((note) => note.key.toLowerCase() !== key.toLowerCase());

  // В НАЧАЛО, а не в конец, и это не вкусовщина.
  //
  // Две записи в одну миллисекунду дают в сравнении ноль, а `sort` в
  // JavaScript устойчив — он сохраняет порядок, в котором элементы лежали.
  // Запись, положенная в конец, при совпадении времени оказывалась СТАРШЕ
  // предыдущей: «свежее первым» превращалось в «старое первым».
  //
  // Поймано на CI 23.09.2026: локально две записи обычно попадают в разные
  // миллисекунды и тест проходит, на чужой машине — нет. И это не только про
  // порядок показа: на заполненном хранилище `slice(0, 200)` при таком же
  // совпадении выбрасывал бы именно новую запись.
  notes.unshift({ key, value, updatedAt: Date.now() });

  // Bounded on purpose: an unbounded store would eventually be too large to
  // put in front of a model, and the oldest notes are the least useful.
  const kept = notes.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
  write(kept);
  return kept;
}

export function forget(key: string): boolean {
  const notes = read();
  const kept = notes.filter((note) => note.key.toLowerCase() !== key.toLowerCase());
  if (kept.length === notes.length) return false;
  write(kept);
  return true;
}

/**
 * Notes worth showing, most recent first.
 *
 * With a topic, only notes whose key or value mention it — a run about Riot
 * should not be handed everything ever learned about spreadsheets.
 */
export function recall(about?: string): Note[] {
  const notes = read().sort((a, b) => b.updatedAt - a.updatedAt);
  if (!about?.trim()) return notes.slice(0, 40);

  const needle = about.toLowerCase();
  const words = needle.split(/\s+/u).filter((word) => word.length >= 3);
  return notes
    .filter((note) => {
      const haystack = `${note.key} ${note.value}`.toLowerCase();
      return haystack.includes(needle) || words.some((word) => haystack.includes(word));
    })
    .slice(0, 40);
}
