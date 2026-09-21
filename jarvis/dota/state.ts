/**
 * Свёрнутое состояние матча.
 *
 * ## Что здесь есть и чего нет
 *
 * Здесь только то, что нельзя узнать из одного пакета: с какого мига копится
 * золото, сколько раз героя поймали, что видно у лагерей. Всё, что читается из
 * последнего пакета напрямую, здесь не дублируется — иначе два источника
 * правды разойдутся, и спорить они будут молча.
 *
 * ## Поймали и умер — разные числа
 *
 * `caughtOut` растёт по флагу `alive`, `deaths` берётся из счётчика игры. У
 * Рейдж Кинга реинкарнация гасит флаг, не увеличивая счётчик: за матч
 * `9009407694` восемнадцать пометок обернулись восемью смертями, и первая же
 * попытка считать смерти по флагу завысила бы их вдвое.
 *
 * Для порога опасности правильны именно восемнадцать: героя ловили
 * восемнадцать раз, и предупредить надо было все восемнадцать.
 */
import { createCamps, updateCamps, type Camp } from './camps';
import type { DotaPacket } from './packet';

export interface DotaState {
  latest: DotaPacket | null;
  camps: Camp[];
  /** Миг, когда золото перешло отметку и с тех пор её не опускалось. */
  goldSince: number | null;
  /** Смерти по счётчику игры. */
  deaths: number;
  /** Сколько раз героя убили, считая реинкарнации. */
  caughtOut: number;
}

/**
 * Отметка золота по умолчанию. Замер 21.09.2026: пять раз за матч человек
 * просидел на двух тысячах дольше сорока пяти секунд. На полутора тысячах
 * таких периодов семь, на трёх — ни одного.
 */
export const GOLD_MARK = 2000;

export function createState(): DotaState {
  return { latest: null, camps: createCamps(), goldSince: null, deaths: 0, caughtOut: 0 };
}

export function applyPacket(
  state: DotaState,
  packet: DotaPacket,
  options: { goldMark?: number } = {},
): DotaState {
  const отметка = options.goldMark ?? GOLD_MARK;
  const былЖив = state.latest?.self?.alive ?? true;

  let золотоС = state.goldSince;
  // Про золото верим только пакету с героем и с числом. Пакет без героя — это
  // меню, загрузка или конец матча, а пустой блок `player` там значит «нечего
  // сказать», а не «денег нет». Принять это за трату — ровно та ошибка, ради
  // которой в доме заведены трёхзначные ворота: отсутствие измерения нельзя
  // читать как измеренный ноль.
  if (packet.self && packet.gold !== null) {
    if (packet.gold >= отметка) золотоС ??= packet.at;
    else золотоС = null;
  }

  const поймали = state.caughtOut + (былЖив && packet.self?.alive === false ? 1 : 0);

  return {
    latest: packet,
    camps: packet.self ? updateCamps(state.camps, packet) : state.camps,
    goldSince: золотоС,
    deaths: packet.deaths ?? state.deaths,
    caughtOut: поймали,
  };
}
