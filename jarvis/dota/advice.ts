/**
 * Что показать на экране и что сказать вслух.
 *
 * ## Почему это отдельно от окна
 *
 * Окно — дело вкуса и пикселей, и проверить его можно только глазами на живой
 * игре. Решение «сейчас надо сказать» — арифметика, и она проверяется прогоном
 * по записи. Разделив их, можно доказать поведение помощника, не запуская Доту.
 *
 * ## Два канала, и они не равны
 *
 * **Картинка показывает всё и постоянно.** Опасность, золото, выкуп, лагеря —
 * это состояние, и оно ничего не стоит: смотреть можно, а можно не смотреть.
 *
 * **Голос вмешивается редко.** Не из экономии — обращений к модели здесь нет
 * вовсе, — а потому что внимание одно. Если говорить обо всём, решающую фразу
 * человек не услышит, и весь прибор пойдёт насмарку ровно тогда, когда нужен.
 *
 * ## Почему нужна память
 *
 * Порог горит, пока горит условие: трое рядом — это десять секунд подряд по
 * два-три пакета в секунду, то есть двадцать пять «скажи» на одну опасность.
 * Память помнит, о чём уже сказано, и молчит, пока повод не сменится.
 */
import { isFailure, type Gate } from '../measure/gate';
import type { CampState } from './camps';
import type { DotaState } from './state';
import { judgeDanger, judgeGold, type DangerRule, type GoldRule } from './thresholds';

/** Что человек попросил голосом. */
export type OverlayMode = 'full' | 'silent' | 'off';

export interface OverlayView {
  /** Тревога, спокойствие или «нечем мерить» — три состояния, как и везде. */
  danger: { level: 'calm' | 'alarm' | 'unknown'; why?: string };
  /** Ближайший враг, если он виден. */
  nearestEnemy: { hero: string; distance: number } | null;
  gold: { amount: number | null; sitting: boolean };
  buyback: { cost: number; ready: boolean } | null;
  camps: { alive: number; empty: number; stale: number };
  /**
   * Те же лагеря, но с координатами и возрастом знания: их надо рисовать на
   * миникарте, и блёклостью показывать, насколько сведения свежи.
   */
  campPoints: readonly { x: number; y: number; state: CampState; ageMs: number | null }[];
  /** Где стоит герой. Нужно и для рисования, и для проверки пересчёта координат. */
  selfPos: { x: number; y: number } | null;
  clock: number | null;
}

export interface AdviceMemory {
  /** О какой тревоге уже сказано: миг её начала. */
  spokenDanger: number | null;
  /** Когда в последний раз говорили про опасность. */
  dangerSpokenAt: number | null;
  /** О каком накоплении золота уже сказано. */
  spokenGold: number | null;
  /** Горела ли тревога в прошлом пакете — по этому видно начало новой. */
  dangerWasOn: boolean;
  /** Миг начала текущей тревоги. */
  dangerSince: number | null;
}

/**
 * Сколько молчать про опасность после того, как о ней сказали.
 *
 * Без выдержки прогон по матчу `9009407694` давал 46 реплик за 54 минуты — раз
 * в семьдесят секунд. Причина не в пороге: условие в замесе то гаснет, то
 * загорается, и «22:28 lina в 278» через секунду становилось «22:29 lina в
 * 106». Это одна и та же опасность, о которой человек уже знает.
 *
 * Восемь секунд — та же склейка, по которой тревоги считаются эпизодами.
 */
const МОЛЧАТЬ_ПОСЛЕ_ТРЕВОГИ = 8_000;

export interface Advice {
  view: OverlayView;
  /** Что произнести. `null` — молчать. */
  speech: string | null;
  memory: AdviceMemory;
}

export function createMemory(): AdviceMemory {
  return {
    spokenDanger: null,
    dangerSpokenAt: null,
    spokenGold: null,
    dangerWasOn: false,
    dangerSince: null,
  };
}

const УРОВЕНЬ = (ворота: Gate): OverlayView['danger']['level'] => {
  if (ворота.passed === null) return 'unknown';
  return ворота.passed ? 'calm' : 'alarm';
};

export interface AdviceOptions {
  danger?: DangerRule;
  gold?: GoldRule;
}

export function advise(
  state: DotaState,
  memory: AdviceMemory,
  mode: OverlayMode,
  options: AdviceOptions = {},
): Advice {
  const пакет = state.latest;
  const опасность = пакет ? judgeDanger(пакет, options.danger) : null;
  const золото = judgeGold(state, options.gold);

  const лагеря = { alive: 0, empty: 0, stale: 0 };
  for (const л of state.camps) лагеря[л.state] += 1;

  const свой = пакет?.self ?? null;
  const ближайший = свой && пакет
    ? пакет.enemies
      .map((в) => ({ hero: в.hero ?? '?', distance: Math.round(Math.hypot(в.x - свой.x, в.y - свой.y)) }))
      .sort((a, б) => a.distance - б.distance)[0] ?? null
    : null;

  const view: OverlayView = {
    danger: опасность
      ? { level: УРОВЕНЬ(опасность), why: опасность.why }
      : { level: 'unknown', why: 'пакетов ещё не было' },
    nearestEnemy: ближайший,
    gold: { amount: пакет?.gold ?? null, sitting: isFailure(золото) },
    buyback: свой ? { cost: свой.buybackCost, ready: свой.buybackCooldown === 0 } : null,
    camps: лагеря,
    campPoints: state.camps.map((л) => ({
      x: л.x,
      y: л.y,
      state: л.state,
      ageMs: л.seenAt === null || !пакет ? null : пакет.at - л.seenAt,
    })),
    selfPos: свой ? { x: свой.x, y: свой.y } : null,
    clock: пакет?.clock ?? null,
  };

  // Начало тревоги — переход из «не горит» в «горит». Всё время, пока она
  // горит, это одна и та же тревога, и говорить о ней нужно один раз.
  const горит = Boolean(опасность && isFailure(опасность));
  const началась = горит && !memory.dangerWasOn;
  const dangerSince = началась ? (пакет?.at ?? null) : (горит ? memory.dangerSince : null);

  let speech: string | null = null;
  let spokenDanger = memory.spokenDanger;
  let dangerSpokenAt = memory.dangerSpokenAt;
  let spokenGold = memory.spokenGold;

  const сейчас = пакет?.at ?? 0;
  const выдержка = dangerSpokenAt !== null && сейчас - dangerSpokenAt < МОЛЧАТЬ_ПОСЛЕ_ТРЕВОГИ;

  // Ноль здоровья при живом флаге — это миг гибели: удар уже прошёл, флаг ещё
  // не обновился. Прогон по матчу выдавал здесь «ты на 0», и это худший вид
  // подсказки — та, что опоздала и делает вид, что успела.
  const ужеПоздно = свой !== null && свой.hp <= 0;

  // Молчим целиком, если человек попросил только картинку или всё выключил.
  if (mode === 'full') {
    if (горит && dangerSince !== null && dangerSince !== spokenDanger && !выдержка && !ужеПоздно) {
      speech = сказатьПроОпасность(ближайший, view.gold.amount, свой?.hp ?? null);
      spokenDanger = dangerSince;
      dangerSpokenAt = сейчас;
    } else if (isFailure(золото) && state.goldSince !== spokenGold) {
      // Золото — вторым: опасность важнее денег всегда.
      speech = `${пакет?.gold} золота лежит`;
      spokenGold = state.goldSince;
    }
  }

  return {
    view,
    speech,
    memory: { spokenDanger, dangerSpokenAt, spokenGold, dangerWasOn: горит, dangerSince },
  };
}

/**
 * Фраза про опасность.
 *
 * Коротко и с числом: «трое рядом» человек проверит глазами за секунду, а
 * «Лина в двухстах» говорит, куда смотреть. Длиннее двух-трёх слов в замесе
 * не слышат.
 */
function сказатьПроОпасность(
  ближайший: { hero: string; distance: number } | null,
  _золото: number | null,
  хп: number | null,
): string {
  const имя = ближайший ? ближайший.hero.replace('npc_dota_hero_', '') : null;
  if (!имя) return 'опасно';
  if (хп !== null && хп < 40) return `${имя} рядом, ты на ${хп}`;
  return `${имя} в ${ближайший!.distance}`;
}
