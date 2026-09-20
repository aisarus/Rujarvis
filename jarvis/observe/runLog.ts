/**
 * Журнал прогонов: что на самом деле делал агент и на чём споткнулся.
 *
 * ## Зачем он появился
 *
 * 20.09.2026 человек услышал от Джарвиса «API Error: 401 API key is invalid» —
 * от системы, у которой нет ни одного ключа и которая работает только на
 * подписках. Настоящая цепочка была такая: Claude Code сорвался по неизвестной
 * причине, задача откатилась в интерпретер, тот честно ответил, что ключа нет,
 * и человек услышал четвёртый шаг, не имеющий отношения к делу.
 *
 * А первый шаг — настоящий — не был записан нигде. События агента шли в окно
 * и исчезали. Выяснение заняло полдня и кончилось тем, что задачу пришлось
 * воспроизводить вручную.
 *
 * ## Чем он отличается от окна работы
 *
 * Окно нарочно скрывает шум: человеку не нужно видеть каждый вызов
 * инструмента. Журнал не скрывает ничего и ничего не режет — он читается не
 * вслух, а глазами, и только когда что-то пошло не так. Правило простое:
 * **лучше лишняя строка, чем недостающая.**
 *
 * Один файл на прогон, имя начинается со времени — поэтому папка сортируется
 * сама и последний прогон всегда внизу.
 */

import type { BackendEvent } from '../backends/types';

/** Сколько прогонов держим. Дальше стираем: журнал пишется на каждую задачу. */
export const KEEP_RUNS = 50;

const RUN_FILE = /^\d{4}-\d{2}-\d{2}-\d{6}-.*\.log$/u;

/** Одна строка на событие. Пустой строки не возвращает никогда. */
export function lineFor(event: BackendEvent): string {
  switch (event.type) {
    case 'started':
      return `${event.backend} начал${event.sessionId ? ` (сессия ${event.sessionId})` : ''}`;
    case 'status':
      return `${event.backend} ${event.text}`;
    case 'assistant-text':
      return `${event.backend} говорит: ${event.text}`;
    case 'tool':
      return `${event.backend} инструмент ${event.name}${event.detail ? ` ${event.detail}` : ''}`;
    case 'file-changed':
      return `${event.backend} файл ${event.change.action}: ${event.change.path}`;
    case 'command':
      return `${event.backend} команда: ${event.command}${
        event.exitCode === undefined || event.exitCode === null ? '' : ` (код ${event.exitCode})`
      }`;
    case 'error':
      // Пометка об откате — та самая, которой не хватало. Без неё нельзя
      // отличить «сорвался и ушёл дальше» от «честно не смог».
      return `${event.backend} ОШИБКА${event.retryable ? ' (откатится)' : ''}: ${event.message}`;
    case 'completed': {
      const r = event.result;
      const seconds = (r.durationMs / 1000).toFixed(1);
      if (r.cancelled) return `${event.backend} отменено за ${seconds} с`;
      if (r.ok) return `${event.backend} готово за ${seconds} с: ${r.text}`;
      return `${event.backend} не вышло за ${seconds} с: ${r.error ?? 'без причины'}`;
    }
    default: {
      // Новый вид события не должен пропадать молча: журнал, который что-то
      // утаивает, создаёт впечатление, что записано всё.
      const unknown: never = event;
      return `неизвестное событие ${JSON.stringify(unknown)}`;
    }
  }
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Имя файла прогона.
 *
 * Время впереди — чтобы папка сортировалась сама, без чтения содержимого.
 * Название задачи следом, чтобы нужный прогон находился глазами.
 */
export function runFileName(title: string, at: Date): string {
  const stamp =
    `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}-` +
    `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;

  const safe = title
    .trim()
    .replace(/[\\/:"<>|?*]/gu, ' ')
    .replace(/\s+/gu, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/gu, '');

  return `${stamp}-${safe || 'без-названия'}.log`;
}

/**
 * Какие файлы пора стереть.
 *
 * Сортируем сами: список из папки приходит в порядке файловой системы, а не по
 * времени, и полагаться на него нельзя. Чужие файлы не трогаем — в этой папке
 * может лежать что-то ещё, и стирать по неосторожности хуже, чем не стирать.
 */
export function staleRuns(files: readonly string[], keep = KEEP_RUNS): string[] {
  const ours = files.filter((name) => RUN_FILE.test(name)).sort();
  return keep <= 0 ? ours : ours.slice(0, Math.max(0, ours.length - keep));
}

export interface RunHead {
  title: string;
  prompt: string;
  cwd: string;
  capabilities: readonly string[];
  /** План на бумаге. Мосту он не виден, и это не беда: настоящая
   * последовательность всё равно видна по событиям «начал» и «переключаюсь». */
  order?: readonly string[];
  rationale?: string;
  at: Date;
}

/** Шапка файла: всё, что нужно, чтобы понять условия прогона, не ища вокруг. */
export function summarise(head: RunHead): string {
  const nl = String.fromCharCode(10);
  return [
    `=== ${head.title} ===`,
    `когда:      ${head.at.toLocaleString('ru-RU')}`,
    `папка:      ${head.cwd}`,
    `умения:     ${head.capabilities.join(', ') || 'нет'}`,
    `порядок:    ${head.order?.join(' → ') || 'по обстоятельствам'}`,
    `почему:     ${head.rationale ?? 'не записано'}`,
    '',
    'просил:',
    head.prompt,
    '',
    '--- ход работы ---',
    '',
  ].join(nl);
}
