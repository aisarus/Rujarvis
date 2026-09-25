/**
 * Постоянные указания человека — его собственный системный промпт.
 *
 * Обычный файл, который он правит сам. Правка действует со следующей же
 * задачей: файл перечитывается, когда меняется время его изменения, и никакой
 * пересборки для этого не нужно.
 *
 * Перечитывать на каждый запрос без разбора тоже нельзя — задача начинается с
 * голоса, и лишнее обращение к диску в этот момент стоит миллисекунд там, где
 * их считают.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Что лежит в файле, пока человек его не тронул. */
const TEMPLATE = `# Характер и постоянные указания

Всё, что написано здесь, Джарвис получает при каждой задаче — раньше самой
просьбы. Это то, чего вы хотите от него всегда.

Правьте свободно: изменения действуют со следующей задачи, перезапуск не нужен.

## Примеры того, что сюда пишут

- Отвечай коротко. Одна-две фразы, если не просили подробностей.
- Не извиняйся и не объясняй, что ты ассистент.
- Русский язык, обращение на «ты».
- Если задача займёт больше минуты — скажи об этом сразу.
- Не трогай ничего в папке D:\\Работа без отдельной просьбы.

## Мои указания

`;

export class StandingInstructions {
  private readonly file: string;
  private cached = '';
  private cachedAt = -1;

  constructor(file: string) {
    this.file = file;
  }

  /** Создаёт файл с образцом, если его ещё нет. Возвращает путь. */
  ensure(): string {
    try {
      statSync(this.file);
    } catch {
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(this.file, TEMPLATE, 'utf8');
      } catch {
        // Не удалось создать — не повод не запускаться: указаний просто нет.
      }
    }
    return this.file;
  }

  /** Текст указаний, или пусто. Перечитывает только изменившийся файл. */
  read(): string {
    let modified: number;
    try {
      modified = statSync(this.file).mtimeMs;
    } catch {
      return '';
    }

    if (modified !== this.cachedAt) {
      try {
        this.cached = stripHeadings(readFileSync(this.file, 'utf8'));
        this.cachedAt = modified;
      } catch {
        return this.cached;
      }
    }
    return this.cached;
  }
}

/**
 * Убирает заголовки и пояснения образца, оставляя сами указания.
 *
 * Иначе в промпт уезжает инструкция к файлу вместо его содержимого, и модель
 * читает «правьте свободно» как указание себе.
 */
function stripHeadings(content: string): string {
  const marker = content.indexOf('## Мои указания');
  const body = marker === -1 ? content : content.slice(marker + '## Мои указания'.length);

  return body
    .split(/\r?\n/u)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .trim();
}
