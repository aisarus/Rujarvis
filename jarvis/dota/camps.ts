/**
 * Лагерь в трёх состояниях: жив, пуст, давно не смотрели.
 *
 * ## Почему три, а не два
 *
 * Потому что «я там никого не вижу» и «там никого нет» — разные новости, и
 * вторая следует из первой, только если ты туда смотришь. Человек сформулировал
 * это сам: показывать надо те лагеря, «про которые известно».
 *
 * Оверлей, гасящий половину карты, стоит герою отойти на базу, хуже
 * отсутствующего: он выглядит осведомлённым.
 *
 * ## Как решается, смотрим ли мы
 *
 * По близости героя. Точнее было бы учитывать вардов, союзников и аванпосты —
 * у каждого объекта на миникарте своя `visionrange`, — но этого достаточно для
 * первого шага и не требует ни одного допущения.
 *
 * ## Почему мёртвый герой ничего не наблюдает
 *
 * У мёртвого в GSI остаются координаты места гибели, а не фонтана: замер по
 * матчу `9009407694` — герой «стоит» там, где его убили, все двадцать восемь
 * секунд респавна. Считать по ним «лагерь пуст» значит гасить лес каждой
 * смертью, причём как раз в тех местах, куда человек лез и погиб.
 */
import { CAMP_POSITIONS, type CampPosition } from './campPositions';
import type { DotaPacket } from './packet';

/** Жив, пуст или давно не смотрели. */
export type CampState = 'alive' | 'empty' | 'stale';

export interface Camp {
  x: number;
  y: number;
  state: CampState;
  /** Когда в последний раз видели своими глазами. */
  seenAt: number | null;
}

/** Насколько близко к лагерю считается «вижу». Обзор героя днём — 1800. */
const ВИДНО = 900;

/** Радиус, в котором нейтрал считается принадлежащим лагерю. */
const СВОЙ = 600;

/** Через сколько без взгляда состояние выцветает в «не знаю». */
const ВЫЦВЕТАЕТ = 60_000;

export function createCamps(positions: readonly CampPosition[] = CAMP_POSITIONS): Camp[] {
  return positions.map((п) => ({ x: п.x, y: п.y, state: 'stale' as CampState, seenAt: null }));
}

export function updateCamps(
  camps: readonly Camp[],
  packet: DotaPacket,
  options: { staleAfterMs?: number } = {},
): Camp[] {
  const выцветает = options.staleAfterMs ?? ВЫЦВЕТАЕТ;
  const свой = packet.self;
  const наблюдаем = Boolean(свой?.alive);

  return camps.map((лагерь) => {
    const состарился = (): Camp => {
      const прошло = лагерь.seenAt === null ? Infinity : packet.at - лагерь.seenAt;
      return прошло > выцветает ? { ...лагерь, state: 'stale' } : { ...лагерь };
    };

    if (!наблюдаем || !свой) return состарился();

    const доГероя = Math.hypot(лагерь.x - свой.x, лагерь.y - свой.y);
    if (доГероя > ВИДНО) return состарился();

    const есть = packet.neutrals.some((н) => Math.hypot(н.x - лагерь.x, н.y - лагерь.y) < СВОЙ);
    return { ...лагерь, state: есть ? 'alive' : 'empty', seenAt: packet.at };
  });
}
