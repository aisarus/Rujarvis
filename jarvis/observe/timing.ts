/**
 * Сколько времени уходит, прежде чем агент начнёт делать дело.
 *
 * Замер 19 сентября на задаче про блендер: двенадцать секунд до первого
 * действия, меняющего мир. Из них `ToolSearch` вызывался четыре раза за одну
 * задачу — агент искал инструменты, которые у него уже были.
 *
 * Здесь считается именно ориентация: поиск инструментов, загрузка навыка,
 * обращение к памяти. Резать её наугад значит убрать полезное и оставить
 * дорогое, поэтому сперва — числа.
 */

import type { BackendEvent } from '../backends/types';

/** Инструменты, которые мир не меняют: это подготовка, а не дело. */
const ORIENTATION = ['ToolSearch', 'Skill', 'mcp__jarvis-desktop__recall', 'TodoWrite'];

/** Длина приставки имён инструментов рабочего стола. */
const PREFIX = 'mcp__jarvis-desktop__'.length;

function isOrientation(name: string): boolean {
  return ORIENTATION.some((prefix) => name.startsWith(prefix));
}

export class StartupTiming {
  private first: number | null = null;
  private readonly counts = new Map<string, number>();

  constructor(private readonly startedAt: number) {}

  saw(event: BackendEvent, at: number): void {
    if (event.type !== 'tool') return;
    const name = event.name ?? '';
    if (!name) return;

    if (isOrientation(name)) {
      const key = name.startsWith('mcp__jarvis-desktop__') ? name.slice(PREFIX) : name;
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      return;
    }
    if (this.first === null) this.first = at - this.startedAt;
  }

  get firstUsefulMs(): number | null {
    return this.first;
  }

  /** Строка для журнала. `null` — дела ещё не было, и говорить нечего. */
  report(): string | null {
    if (this.first === null) return null;

    const spent = [...this.counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([name, times]) => `${name} ${times}`)
      .join(', ');

    return (
      `${(this.first / 1000).toFixed(1)} с до первого дела` +
      (spent ? ` (ориентация: ${spent})` : '')
    );
  }
}
