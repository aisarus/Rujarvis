/**
 * Когда показать карточку снова. Две кнопки, как у Lamdan: «Ещё раз» и
 * «Знаю».
 *
 * «Ещё раз» — через десять минут, интервал сначала. «Знаю» — через день,
 * потом через три, дальше каждый раз в два с половиной раза дольше: 3 → 8 →
 * 20 → 50 дней. Новая карточка — сразу.
 */

import type { CardState } from './types';

const МИНУТА = 60_000;
const ДЕНЬ = 24 * 60 * МИНУТА;

export function newCardState(now = Date.now()): CardState {
  return { due: now, interval: 0, lapses: 0 };
}

export function reviewCard(state: CardState | undefined, verdict: 'again' | 'know', now = Date.now()): CardState {
  const было = state ?? newCardState(now);
  if (verdict === 'again') return { due: now + 10 * МИНУТА, interval: 0, lapses: было.lapses + 1 };
  const interval = было.interval === 0 ? 1 : было.interval < 3 ? 3 : Math.round(было.interval * 2.5);
  return { due: now + interval * ДЕНЬ, interval, lapses: было.lapses };
}

export function isDue(state: CardState | undefined, now = Date.now()): boolean {
  return !state || state.due <= now;
}
