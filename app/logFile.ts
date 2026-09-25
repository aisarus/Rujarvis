/**
 * Дублирование консоли в файл.
 *
 * Джарвис живёт в трее, и всё, что он печатает, иначе пропадает: на просьбу
 * «посмотри логи» смотреть было бы некуда, а это единственный способ понять,
 * почему задача не сделалась.
 *
 * Формат строки: дата, время, уровень, текст —
 *
 *     2026-09-24 08:15:02 INFO  [jarvis] услышал: открой хром
 *     2026-09-24 08:15:03 ERROR [jarvis] синтез речи не удался: …
 *
 * Файл обрезается ротацией: вырос больше 5 МБ — текущий становится
 * `jarvis.1.log` (прошлый такой затирается), и запись начинается заново.
 * Сразу после сбоя человек найдёт в логе то, что было до него, а не пустоту.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/** Больше этого — ротация. */
const MAX_BYTES = 5 * 1024 * 1024;

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';

const LEVEL: Record<ConsoleMethod, string> = {
  log: 'INFO ',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

let installed = false;
let written = 0;

export function startLogFile(file: string, header: readonly string[] = []): string | null {
  if (installed) return file;

  try {
    mkdirSync(path.dirname(file), { recursive: true });
    rotate(file);
    written = existsSync(file) ? statSync(file).size : 0;
    append(file, `\n=== запуск ${stamp()} ===\n${header.map((line) => `    ${line}\n`).join('')}`);
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
        // Не вышла ротация — не долбить её на каждой строке.
        //
        // `renameSync` падает, когда файл держит другой процесс, а `written`
        // при этом остаётся выше потолка: дальше КАЖДАЯ строка журнала звала
        // existsSync, rmSync и renameSync на главном процессе Electron, и все
        // три падали снова. Считаем сверху заново и попробуем через 5 МБ.
        if (written > MAX_BYTES && !rotate(file, true)) written = 0;
        append(file, `${stamp()} ${LEVEL[method]} ${format(args)}\n`);
      } catch {
        // Запись в файл не должна мешать работе: потеря строки лога дешевле
        // упавшего ответа.
      }
    };
  }

  return file;
}

function append(file: string, text: string): void {
  appendFileSync(file, text, 'utf8');
  written += Buffer.byteLength(text, 'utf8');
}

/**
 * Текущий файл — в `jarvis.1.log`, если он велик (или `force`).
 *
 * `false` — не переименовали; звать снова прямо сейчас бесполезно.
 */
function rotate(file: string, force = false): boolean {
  try {
    if (!existsSync(file)) return true;
    if (!force && statSync(file).size <= MAX_BYTES) return true;
    const previous = file.replace(/\.log$/u, '.1.log');
    rmSync(previous, { force: true });
    renameSync(file, previous);
    written = 0;
    return true;
  } catch (error) {
    // Файл держит другой процесс — пишем дальше, но один раз говорим об этом:
    // молча растущий без предела журнал однажды займёт диск целиком.
    if (!ротацияНеВышла) {
      ротацияНеВышла = true;
      console.error('[jarvis] ротация журнала не удалась:', error);
    }
    return false;
  }
}

// Жаловались ли уже на неудачную ротацию. Иначе жалоба сама станет журналом.
let ротацияНеВышла = false;

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
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
