/**
 * Постоянные задачи — то, что Джарвис делает сам.
 *
 * Ассистент, который действует только когда его спросили, — это голосовой
 * пульт. Агент отличается тем, что у него есть собственный ход времени: он
 * просыпается, смотрит, не пора ли что-то сделать, и делает.
 *
 * Здесь только правило «пора или не пора» — чистое, без часов и без диска,
 * чтобы его можно было проверить тестами, а не наблюдением в течение суток.
 *
 * Два решения, которые важнее остальных:
 *
 *   - **Пропущенное не копится.** Компьютер был выключен сутки — это повод
 *     сделать один раз, а не сорок. Иначе первый же запуск после выходных
 *     превращается в лавину.
 *   - **За раз отдаётся одна задача.** Проснувшийся Джарвис, вываливающий
 *     на человека пять дел подряд, хуже молчащего.
 */

const MINUTE = 60_000;

export interface StandingTask {
  id: string;
  /** Что делать — фраза человека, как он её сказал. */
  text: string;
  /** Повторять каждые столько минут. */
  everyMinutes?: number;
  /** Или делать раз в сутки, в этот час (минуты от полуночи). */
  atMinuteOfDay?: number;
  createdAt: number;
  lastRunAt?: number;
  /** Временно выключена, но не забыта. */
  paused?: boolean;
  /** Молчать, когда сообщать нечего. */
  quiet?: boolean;
}

/**
 * Какую задачу пора выполнить прямо сейчас.
 *
 * Возвращает массив, а не одну задачу, потому что «ни одной» — обычный ответ,
 * и вызывающему удобнее перебором, чем проверкой на null. Но длиннее одного
 * элемента он не бывает: см. решение выше.
 */
export function dueTasks(tasks: readonly StandingTask[], now: number): StandingTask[] {
  const ready = tasks.filter((task) => !task.paused && isDue(task, now));
  if (ready.length === 0) return [];

  // Дольше всех ждавшая идёт первой: иначе редкая задача может не дождаться
  // очереди никогда.
  const sorted = [...ready].sort((a, b) => waitingSince(a) - waitingSince(b));
  return [sorted[0] as StandingTask];
}

/** Когда задача сработает в следующий раз. Для ответа «а когда?». */
export function nextRunAt(task: StandingTask, now: number): number | null {
  if (task.everyMinutes && task.everyMinutes > 0) {
    const from = task.lastRunAt ?? task.createdAt;
    return from + task.everyMinutes * MINUTE;
  }

  if (task.atMinuteOfDay !== undefined) {
    const today = atTimeOfDay(now, task.atMinuteOfDay);
    // Час уже прошёл сегодня — значит следующий раз завтра.
    return today > now && !ranAfter(task, today) ? today : today + 24 * 60 * MINUTE;
  }

  return null;
}

function isDue(task: StandingTask, now: number): boolean {
  if (task.everyMinutes && task.everyMinutes > 0) {
    // Новая задача срабатывает сразу: человек должен увидеть, что она
    // работает, а не ждать час первого доказательства.
    if (task.lastRunAt === undefined) return true;
    return now - task.lastRunAt >= task.everyMinutes * MINUTE;
  }

  if (task.atMinuteOfDay !== undefined) {
    const today = atTimeOfDay(now, task.atMinuteOfDay);
    if (now < today) return false;
    // Уже делали после сегодняшнего часа — значит на сегодня всё.
    return !ranAfter(task, today);
  }

  return false;
}

function ranAfter(task: StandingTask, moment: number): boolean {
  return task.lastRunAt !== undefined && task.lastRunAt >= moment;
}

function waitingSince(task: StandingTask): number {
  return task.lastRunAt ?? task.createdAt;
}

/** Сегодняшний момент с таким временем суток, в местном времени человека. */
function atTimeOfDay(now: number, minuteOfDay: number): number {
  const day = new Date(now);
  day.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
  return day.getTime();
}
