import { describe, expect, it } from 'vitest';

import { dueTasks, nextRunAt, type StandingTask } from './schedule';

const MINUTE = 60_000;
/** 19 сентября 2026, 15:00 — фиксированная точка, чтобы «в 18:00» было завтра. */
const NOW = new Date(2026, 8, 19, 15, 0, 0).getTime();

function every(minutes: number, overrides: Partial<StandingTask> = {}): StandingTask {
  return {
    id: 'т1',
    text: 'проверь почту',
    everyMinutes: minutes,
    createdAt: NOW - 10 * MINUTE,
    ...overrides,
  };
}

describe('dueTasks — по интервалу', () => {
  it('запускает новую задачу сразу, чтобы человек увидел, что она работает', () => {
    expect(dueTasks([every(60)], NOW)).toHaveLength(1);
  });

  it('молчит, пока интервал не прошёл', () => {
    const task = every(60, { lastRunAt: NOW - 30 * MINUTE });
    expect(dueTasks([task], NOW)).toHaveLength(0);
  });

  it('запускает, когда интервал прошёл', () => {
    const task = every(60, { lastRunAt: NOW - 61 * MINUTE });
    expect(dueTasks([task], NOW)).toHaveLength(1);
  });

  it('не копит пропущенные запуски', () => {
    // Компьютер был выключен сутки. Это повод сделать один раз, а не сорок.
    const task = every(60, { lastRunAt: NOW - 40 * 60 * MINUTE });
    expect(dueTasks([task], NOW)).toHaveLength(1);
  });
});

describe('dueTasks — ко времени суток', () => {
  const at = (hour: number, overrides: Partial<StandingTask> = {}): StandingTask => ({
    id: 'т2',
    text: 'подведи итоги дня',
    atMinuteOfDay: hour * 60,
    createdAt: NOW - 24 * 60 * MINUTE,
    ...overrides,
  });

  it('не срабатывает раньше назначенного часа', () => {
    expect(dueTasks([at(18)], NOW)).toHaveLength(0);
  });

  it('срабатывает после назначенного часа', () => {
    expect(dueTasks([at(14)], NOW)).toHaveLength(1);
  });

  it('не повторяется в тот же день', () => {
    const task = at(14, { lastRunAt: NOW - 30 * MINUTE });
    expect(dueTasks([task], NOW)).toHaveLength(0);
  });

  it('повторяется на следующий день', () => {
    const task = at(14, { lastRunAt: NOW - 24 * 60 * MINUTE });
    expect(dueTasks([task], NOW)).toHaveLength(1);
  });

  it('не навёрстывает вчерашнее, когда час уже прошёл', () => {
    // Итоги вчерашнего дня в три часа дня сегодня не нужны никому.
    const task = at(2, { lastRunAt: NOW - 13 * 60 * MINUTE });
    expect(dueTasks([task], NOW)).toHaveLength(0);
  });
});

describe('dueTasks — общее', () => {
  it('пропускает выключенные', () => {
    expect(dueTasks([every(60, { paused: true })], NOW)).toHaveLength(0);
  });

  it('за один раз отдаёт не больше одной задачи', () => {
    // Иначе проснувшийся после простоя Джарвис вываливает на человека всё
    // сразу и говорит минуту без остановки.
    const tasks = [
      every(60, { id: 'а' }),
      every(60, { id: 'б' }),
      every(60, { id: 'в' }),
    ];
    expect(dueTasks(tasks, NOW)).toHaveLength(1);
  });

  it('берёт ту, что ждёт дольше всех', () => {
    const tasks = [
      every(60, { id: 'свежая', lastRunAt: NOW - 61 * MINUTE }),
      every(60, { id: 'давняя', lastRunAt: NOW - 300 * MINUTE }),
    ];
    expect(dueTasks(tasks, NOW)[0]?.id).toBe('давняя');
  });

  it('ничего не выдумывает на пустом списке', () => {
    expect(dueTasks([], NOW)).toEqual([]);
  });
});

describe('nextRunAt', () => {
  it('говорит, когда задача сработает снова', () => {
    const task = every(60, { lastRunAt: NOW });
    expect(nextRunAt(task, NOW)).toBe(NOW + 60 * MINUTE);
  });

  it('для задачи по времени суток называет ближайший такой час', () => {
    const task: StandingTask = {
      id: 'т3',
      text: 'итоги',
      atMinuteOfDay: 18 * 60,
      createdAt: NOW,
    };
    expect(nextRunAt(task, NOW)).toBe(new Date(2026, 8, 19, 18, 0, 0).getTime());
  });

  it('переносит на завтра, если час уже прошёл', () => {
    const task: StandingTask = {
      id: 'т4',
      text: 'итоги',
      atMinuteOfDay: 9 * 60,
      createdAt: NOW,
      lastRunAt: NOW,
    };
    expect(nextRunAt(task, NOW)).toBe(new Date(2026, 8, 20, 9, 0, 0).getTime());
  });
});
