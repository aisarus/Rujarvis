/**
 * Что произошло у обеих команд: глиф, сканирование, выкупы.
 *
 * ## Откуда это берётся
 *
 * Дота присылает чат-события игры в блоке `events` как строку с JSON. В матче
 * `9009407694` таких видов девятнадцать, и три из них — сведения, которых нет
 * больше нигде в канале:
 *
 * - `CHAT_MESSAGE_GLYPH_USED` — `playerid1` здесь **номер команды** (2 или 3),
 *   а не слот игрока. За игру двенадцать применений;
 * - `CHAT_MESSAGE_SCAN_USED` — номер команды лежит в `value`. Одно за игру;
 * - `CHAT_MESSAGE_BUYBACK` — а здесь `playerid1` уже слот игрока. Два за игру.
 *
 * ## Почему нет обратного отсчёта глифа
 *
 * Хотелось показывать «их глиф готов через столько-то». Проверил по записи:
 * команда 2 применила глиф на 09:19 и на 12:05 — интервал 2:46, а
 * общеизвестная перезарядка пять минут. Значит она зависит от событий игры или
 * от версии, и зашитое число врало бы уверенным голосом.
 *
 * Вместо этого — факт: **глиф применён**. Сразу после применения тем же глифом
 * башню уже не спасут, и это окно известно точно, без единой догадки. Сколько
 * времени прошло, показываем числом; «готов ли» — не утверждаем.
 *
 * ## Чего здесь нет
 *
 * Рошана. В ленте на экране он есть, в событиях GSI — нет ни в одном из
 * девятнадцати видов. Это зрение, вторая очередь.
 */
import type { DotaPacket } from './packet';

/** Команда: 2 — radiant, 3 — dire. */
export type Team = 2 | 3;

export interface TeamEvent {
  /** Игровые часы события. */
  clock: number;
  /** Настенное время: по нему считается давность. */
  at: number;
}

export interface Timers {
  /** Последнее применение глифа каждой командой. */
  glyph: { 2: TeamEvent | null; 3: TeamEvent | null };
  /** Последнее сканирование каждой командой. */
  scan: { 2: TeamEvent | null; 3: TeamEvent | null };
  /** Последние выкупы: слот игрока и когда. */
  buybacks: readonly { slot: number; clock: number; at: number }[];
  /** Чтобы не считать одно событие дважды: Дота повторяет их в пакетах. */
  seen: ReadonlySet<string>;
}

export function createTimers(): Timers {
  return {
    glyph: { 2: null, 3: null },
    scan: { 2: null, 3: null },
    buybacks: [],
    seen: new Set(),
  };
}

const КОМАНДА = (значение: unknown): Team | null => (значение === 2 || значение === 3 ? значение : null);

export function applyTimers(timers: Timers, packet: DotaPacket): Timers {
  let глиф = timers.glyph;
  let скан = timers.scan;
  let выкупы = timers.buybacks;
  const видели = new Set(timers.seen);
  let менялось = false;

  for (const событие of packet.events) {
    const д = событие.data;
    if (!д || typeof д.type !== 'string') continue;

    // Дота шлёт одно и то же событие в нескольких подряд идущих пакетах.
    // Ключ из вида и игрового времени отличает повтор от второго такого же.
    // Без времени ключ был `ТИП|undefined`, и все следующие такие события
    // молча отбрасывались как повторы: за матч засчитывался ровно один выкуп.
    // Отсутствие измерения стирало данные.
    const время = typeof д.time === 'number' ? д.time : событие.gameTime;
    const ключ = typeof время === 'number' ? `${д.type}|${время}` : null;
    // Без времени не дедуплицируем вовсе: лучше посчитать дважды, чем
    // выбросить всё, кроме первого.
    if (ключ !== null) {
      if (видели.has(ключ)) continue;
      видели.add(ключ);
    }

    const часы = packet.clock ?? 0;
    if (д.type === 'CHAT_MESSAGE_GLYPH_USED') {
      const к = КОМАНДА(д.playerid1);
      if (к) { глиф = { ...глиф, [к]: { clock: часы, at: packet.at } }; менялось = true; }
    } else if (д.type === 'CHAT_MESSAGE_SCAN_USED') {
      const к = КОМАНДА(д.value);
      if (к) { скан = { ...скан, [к]: { clock: часы, at: packet.at } }; менялось = true; }
    } else if (д.type === 'CHAT_MESSAGE_BUYBACK') {
      const слот = typeof д.playerid1 === 'number' ? д.playerid1 : -1;
      if (слот >= 0) { выкупы = [...выкупы, { slot: слот, clock: часы, at: packet.at }]; менялось = true; }
    }
  }

  if (!менялось && видели.size === timers.seen.size) return timers;
  return { glyph: глиф, scan: скан, buybacks: выкупы, seen: видели };
}

/** Команда противника. */
export function enemyTeam(mine: number | null): Team | null {
  if (mine === 2) return 3;
  if (mine === 3) return 2;
  return null;
}

/**
 * Стоит ли герой на чужой половине.
 *
 * База dire в углу с положительными координатами, radiant — с отрицательными,
 * и река идёт по диагонали `x + y = 0`. Знак зависит от команды, и перепутать
 * его значит получить сигнал, который врёт ровно наоборот.
 */
export function onEnemyHalf(team: number | null, x: number, y: number): boolean {
  if (team === 3) return x + y < 0;
  if (team === 2) return x + y > 0;
  return false;
}

/**
 * Слоты 0–4 — radiant, 5–9 — dire. Нужно, чтобы отличить свой выкуп от чужого:
 * «выкупился их керри» и «выкупился наш саппорт» — разные новости.
 */
export function slotTeam(slot: number): Team | null {
  if (slot >= 0 && slot <= 4) return 2;
  if (slot >= 5 && slot <= 9) return 3;
  return null;
}
