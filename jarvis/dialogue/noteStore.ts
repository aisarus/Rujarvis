/**
 * Ящик правок на диске.
 *
 * ## Почему на диске
 *
 * Правки кладёт голосовой мост, а забирает агент — но агент работает внутри
 * MCP-сервера, а это отдельный процесс. Общей памяти у них нет. Файл — самое
 * простое, что у них есть общего, и его же можно прочитать глазами, когда
 * что-то пойдёт не так.
 *
 * ## Про гонку
 *
 * Два процесса пишут в один файл, и настоящей блокировки здесь нет. Это
 * осознанно: цена ошибки — одна потерянная или дважды показанная реплика, а
 * цена блокировки — залипший агент, ждущий файл, который никто не отпустит.
 *
 * Забирающий пишет пустоту сразу после чтения, а не после обработки: так окно,
 * в которое правка может задвоиться, — микросекунды, а не минуты работы.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Note } from './notes';

/** Больше этого в ящике держать незачем. */
const LIMIT = 20;

export class NoteStore {
  constructor(private readonly file: string) {}

  /** Добавить поправку. `false` — на диск не легло, и человеку об этом скажут. */
  add(text: string, at: number = Date.now()): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;

    const notes = this.read();
    // Человек повторяет себя, когда не слышит ответа. Это одна правка.
    if (notes.some((note) => note.text === trimmed)) return true;

    notes.push({ at, text: trimmed });
    return this.write(notes.slice(-LIMIT));
  }

  /** Забирает всё и очищает. */
  take(): Note[] {
    const notes = this.read();
    if (notes.length > 0) this.write([]);
    return notes;
  }

  /** Что лежит, не забирая. */
  peek(): Note[] {
    return this.read();
  }

  /**
   * Убрать одну заметку.
   *
   * Нужно, когда сказанное во время работы оказалось не поправкой, а отдельной
   * задачей: решение принимается в фоне и приходит через несколько секунд.
   * Возвращает false, если заметки уже нет — значит агент успел её забрать, и
   * работа по ней идёт. Тогда заводить вторую задачу нельзя: получится дубль.
   */
  drop(text: string): boolean {
    const trimmed = text.trim();
    const notes = this.read();
    const left = notes.filter((note) => note.text !== trimmed);
    if (left.length === notes.length) return false;
    return this.write(left);
  }

  clear(): void {
    this.write([]);
  }

  private read(): Note[] {
    try {
      if (!existsSync(this.file)) return [];
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is Note =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Note).text === 'string' &&
          typeof (item as Note).at === 'number',
      );
    } catch {
      // Битый файл — то же, что пустой ящик. Ронять из-за него работу нельзя.
      return [];
    }
  }

  /**
   * Записать. Возвращает, дошло ли до диска.
   *
   * Раньше отказ глотался молча, а инструмент отвечал человеку успехом:
   * «Учту» звучало, поправка не сохранялась, и узнать об этом было неоткуда.
   * Ронять помощника из-за занятого диска по-прежнему не будем — но и врать
   * не будем.
   */
  private write(notes: Note[]): boolean {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(notes), 'utf8');
      return true;
    } catch (error) {
      console.error(`[jarvis] ящик поправок не записался: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
