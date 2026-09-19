/**
 * Дублирование консоли в файл.
 *
 * Джарвис запускается ярлыком, и всё, что он печатает, живёт в окне командной
 * строки: окно закрылось — разбираться не с чем. На просьбу «посмотри логи»
 * смотреть было буквально некуда, а это единственный способ понять, почему
 * задача не сделалась.
 *
 * Консольный вывод сохраняется: окно по-прежнему показывает всё, что
 * показывало. Файл появляется рядом с остальными данными и обрезается, когда
 * вырастает, — журнал, съевший диск, хуже отсутствующего.
 */

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Больше этого — начинаем заново: старое всё равно никто не читает. */
const MAX_BYTES = 5 * 1024 * 1024;

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';

let installed = false;

export function startLogFile(file: string): string | null {
  if (installed) return file;

  try {
    mkdirSync(path.dirname(file), { recursive: true });
    rotate(file);
    appendFileSync(file, `\n=== запуск ${new Date().toISOString()} ===\n`, 'utf8');
  } catch (error) {
    console.error('[jarvis] не удалось открыть файл логов:', error);
    return null;
  }

  installed = true;

  for (const method of ['log', 'info', 'warn', 'error'] as ConsoleMethod[]) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      original(...args);
      try {
        appendFileSync(file, `${stamp()} ${format(args)}\n`, 'utf8');
      } catch {
        // Запись в файл не должна мешать работе: потеря строки лога дешевле
        // упавшего ответа.
      }
    };
  }

  return file;
}

function rotate(file: string): void {
  try {
    if (statSync(file).size > MAX_BYTES) writeFileSync(file, '', 'utf8');
  } catch {
    // Файла ещё нет — обрезать нечего.
  }
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function format(args: readonly unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.message}\n${arg.stack ?? ''}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}
