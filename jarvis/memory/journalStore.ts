/**
 * Журнал действий на диске.
 *
 * Пассивная память. Рядом живёт активная — `JarvisMemory` в соседнем `store.ts`:
 * туда попадают выводы, которые записали намеренно (проект такой-то лежит там-то,
 * «спотифай» — это вот эта программа). Здесь же копятся события, случившиеся сами:
 * что открыли, что закрыли, что сделали, что не вышло.
 *
 * Нужны обе. Одна отвечает на «как это делается», другая на «что мы только что
 * делали» — и без второй фразы «а где он?» и «переделай» повисают в пустоте.
 *
 * Файл читается один раз при создании и переписывается целиком при каждой
 * записи. Для нескольких событий в минуту это дешевле любой хитрости, а
 * простота здесь важнее: журнал не та вещь, ради которой стоит не запуститься.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { contextGradient, type GradientOptions, type JarvisEvent } from './journal';

/** Столько событий хватает на несколько часов работы. */
const DEFAULT_LIMIT = 300;

export interface JournalOptions {
  limit?: number;
  now?: () => number;
}

export class JournalStore {
  private readonly file: string;
  private readonly limit: number;
  private readonly now: () => number;
  private events: JarvisEvent[];

  constructor(file: string, options: JournalOptions = {}) {
    this.file = file;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.now = options.now ?? Date.now;
    this.events = this.load();
  }

  record(event: Omit<JarvisEvent, 'at'> & { at?: number }): void {
    this.events.push({ ...event, at: event.at ?? this.now() });
    // Выбрасывается старое: новое всегда нужнее.
    if (this.events.length > this.limit) {
      this.events = this.events.slice(-this.limit);
    }
    this.save();
  }

  recent(): JarvisEvent[] {
    return [...this.events];
  }

  /** Строки для запроса к агенту: свежее дословно, старое сводкой. */
  context(options?: GradientOptions): string[] {
    return contextGradient(this.events, { now: this.now(), ...options });
  }

  private load(): JarvisEvent[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isEvent).slice(-this.limit);
    } catch {
      // Файла нет или он испорчен — начинаем с чистого журнала. Потеря памяти
      // о вчерашнем дне не стоит отказа работать сегодня.
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      // Запись через временный файл, как в хранилище памяти рядом.
      //
      // Прямая запись в целевой файл оставляла при обрыве обрезанный JSON: на
      // следующем запуске журнал читался как пустой, и первая же запись
      // затирала его совсем. Пропадал не «вчерашний день», а всё, включая
      // сырьё для уроков.
      const черновик = `${this.file}.${process.pid}.tmp`;
      writeFileSync(черновик, JSON.stringify(this.events), 'utf8');
      renameSync(черновик, this.file);
    } catch {
      // Диск может быть занят или полон. Память в этом запуске уже есть —
      // ронять из-за этого ассистента нельзя.
    }
  }
}

function isEvent(value: unknown): value is JarvisEvent {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<JarvisEvent>;
  return typeof item.at === 'number' && typeof item.text === 'string' && typeof item.kind === 'string';
}
