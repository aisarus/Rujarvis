/**
 * Запись журнала прогонов на диск.
 *
 * Отдельно от разбора по тому же укладу, что `notes.ts` и `noteStore.ts`:
 * решения о том, что писать, проверяются тестами без файловой системы, а здесь
 * остаётся только запись.
 *
 * Пишется дописыванием, строка за строкой, а не одним куском в конце. Это не
 * придирка: прогон, который завис или был убит, — именно тот, ради которого
 * журнал и заводили. Собери файл в памяти и отдай его в конце — как раз в
 * интересных случаях он и не доедет.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BackendEvent } from '../backends/types';
import { KEEP_RUNS, lineFor, runFileName, staleRuns, summarise, type RunHead } from './runLog';

const NEWLINE = String.fromCharCode(10);

export class RunLogStore {
  private file: string | null = null;
  private startedAt = 0;

  constructor(
    private readonly dir: string,
    private readonly keep = KEEP_RUNS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Куда пишется текущий прогон. Нужно, чтобы назвать файл человеку. */
  current(): string | null {
    return this.file;
  }

  /**
   * Начать новый прогон.
   *
   * Ошибка записи не должна ронять работу: журнал — подспорье, а не условие.
   * Молча падать он тоже не вправе, поэтому о сбое сообщаем в консоль.
   */
  begin(head: Omit<RunHead, 'at'>): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      this.prune();

      const at = new Date(this.now());
      this.startedAt = this.now();
      this.file = path.join(this.dir, runFileName(head.title, at));
      writeFileSync(this.file, summarise({ ...head, at }), 'utf8');
    } catch (error) {
      this.file = null;
      console.error('[jarvis] журнал прогона не завёлся:', error);
    }
  }

  /** Записать событие. Без начатого прогона — молча мимо. */
  saw(event: BackendEvent): void {
    this.write(lineFor(event));
  }

  /** Записать что-то своё: отмену, правку на ходу, решение моста. */
  note(text: string): void {
    this.write(text);
  }

  /** Закрыть прогон. Файл остаётся: он и есть то, ради чего всё это. */
  end(): void {
    this.write('--- конец ---');
    this.file = null;
  }

  private write(text: string): void {
    if (!this.file) return;
    const since = ((this.now() - this.startedAt) / 1000).toFixed(1).padStart(7);
    try {
      appendFileSync(this.file, `${since}s  ${text}${NEWLINE}`, 'utf8');
    } catch {
      // Диск мог кончиться или файл — оказаться занят. Работа важнее записи.
    }
  }

  /**
   * Стереть старые прогоны.
   *
   * Журнал пишется на каждую задачу и растёт быстрее всего остального. За одни
   * сутки без уборки в этой системе уже накопилось 1115 брошенных временных
   * папок — повторять не будем.
   */
  private prune(): void {
    try {
      for (const name of staleRuns(readdirSync(this.dir), this.keep)) {
        unlinkSync(path.join(this.dir, name));
      }
    } catch {
      // Не смогли прибраться — не повод не писать.
    }
  }
}
