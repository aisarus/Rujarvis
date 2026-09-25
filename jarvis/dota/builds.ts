/**
 * Что покупать: данные из OpenDota, решение — здесь.
 *
 * ## Почему из сети, а не с экрана
 *
 * Человек просил подсказки по сборке и рассчитывал взять их из таблицы по Tab.
 * Я достал настоящий кадр этой таблицы и посмотрел: там **нет предметов
 * вообще** — только герой, игрок, таланты, уровень, золото и убийства.
 *
 * Зато вражеские герои у нас есть с первой минуты: GSI присылает их именами.
 * А что на них обычно собирают — знает OpenDota, бесплатно и без ключа, по
 * статистике миллионов игр. Экран для этого не нужен вовсе.
 *
 * Чего так не узнать — **что противник купил на самом деле**. Этого нет ни в
 * канале, ни в таблице, и честнее сказать сразу, чем изображать всеведение.
 *
 * ## Что берётся и как
 *
 * Три запроса, все разовые, все в начале матча:
 *
 * - `/api/heroes` — номера, имена и роли всех героев;
 * - `/api/constants/item_ids` и `/api/constants/items` — номер предмета в имя и цену;
 * - `/api/heroes/{id}/itemPopularity` — что берут на этом герое по стадиям игры.
 *
 * Ответы кладутся на диск. Без сети помощник работает по вчерашнему кэшу, а
 * без кэша молчит про сборку — и это лучше, чем советовать наугад.
 *
 * ## Чего здесь нет
 *
 * Утверждения, что так лучше. `itemPopularity` говорит, что берут **чаще**, и
 * ничего больше; выдавать частоту за правильность — обычная подмена. Поэтому и
 * формулировка в голосе: «обычно берут», а не «надо взять».
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Стадии игры так, как их делит OpenDota. */
export type Stage = 'start' | 'early' | 'mid' | 'late';

export interface BuildItem {
  /** Имя в игре без приставки: `power_treads`. */
  key: string;
  /** Как называется по-человечески. */
  name: string;
  cost: number;
  stage: Stage;
  /** В скольких матчах встретился — по нему и отсортировано. */
  seen: number;
}

export interface BuildBook {
  hero: string;
  /** Предметы по порядку стадий, внутри стадии — по частоте. */
  order: readonly BuildItem[];
  /** Когда эти данные скачаны. */
  fetchedAt: number;
}

/** Роли врагов — по классификации самой OpenDota. */
export interface EnemyRead {
  /** Сколько из них помечены как Disabler: контроль. */
  disablers: number;
  /** Сколько помечены как Nuker: урон заклинаниями. */
  nukers: number;
  heroes: readonly string[];
}

const БАЗА = 'https://api.opendota.com/api';
const СТАДИИ: readonly { поле: string; stage: Stage }[] = [
  { поле: 'start_game_items', stage: 'start' },
  { поле: 'early_game_items', stage: 'early' },
  { поле: 'mid_game_items', stage: 'mid' },
  { поле: 'late_game_items', stage: 'late' },
];

/** Сколько предметов брать с каждой стадии: дальше начинается шум. */
const С_КАЖДОЙ = 4;

export interface Fetcher {
  (url: string): Promise<unknown>;
}

const сетью: Fetcher = async (url) => {
  // Со сроком: зависший OpenDota не давал дойти ни до `catch`, ни до кэша —
  // человек весь матч оставался без подсказок, хотя вчерашний кэш лежал рядом.
  const ответ = await fetch(url, {
    headers: { 'User-Agent': 'rujarvis-dota-assist' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!ответ.ok) throw new Error(`${url} ответил ${ответ.status}`);
  return ответ.json();
};

interface Сырьё {
  heroes: { id: number; name: string; localized_name: string; roles: string[] }[];
  itemIds: Record<string, string>;
  items: Record<string, { dname?: string; cost?: number | null }>;
}

async function скачать(fetcher: Fetcher): Promise<Сырьё> {
  const [heroes, itemIds, items] = await Promise.all([
    fetcher(`${БАЗА}/heroes`),
    fetcher(`${БАЗА}/constants/item_ids`),
    fetcher(`${БАЗА}/constants/items`),
  ]);
  return {
    heroes: heroes as Сырьё['heroes'],
    itemIds: itemIds as Сырьё['itemIds'],
    items: items as Сырьё['items'],
  };
}

/**
 * Собрать книгу покупок для героя.
 *
 * `cacheDir` — куда класть скачанное. Сеть спрашивается только если кэша нет
 * или он старше `staleDays`: списки предметов меняются с патчами, а не за ночь.
 */
export async function loadBuildBook(options: {
  hero: string;
  cacheDir: string;
  fetcher?: Fetcher;
  staleDays?: number;
}): Promise<BuildBook | null> {
  const { hero, cacheDir } = options;
  const fetcher = options.fetcher ?? сетью;
  const протухает = (options.staleDays ?? 7) * 24 * 3600_000;
  const файл = join(cacheDir, `сборка-${hero.replace('npc_dota_hero_', '')}.json`);

  const изКэша = прочитатьКэш(файл);
  if (изКэша && Date.now() - изКэша.fetchedAt < протухает) return изКэша;

  try {
    const сырьё = await скачать(fetcher);
    const герой = сырьё.heroes.find((г) => г.name === hero);
    if (!герой) return изКэша;

    const популярность = await fetcher(`${БАЗА}/heroes/${герой.id}/itemPopularity`) as
      Record<string, Record<string, number>>;

    const order: BuildItem[] = [];
    for (const { поле, stage } of СТАДИИ) {
      const раздел = популярность[поле] ?? {};
      const лучшие = Object.entries(раздел)
        .sort((a, б) => б[1] - a[1])
        .slice(0, С_КАЖДОЙ);
      for (const [номер, сколько] of лучшие) {
        const ключ = сырьё.itemIds[номер];
        const о = ключ ? сырьё.items[ключ] : undefined;
        if (!ключ || !о) continue;
        order.push({
          key: ключ,
          name: о.dname ?? ключ,
          cost: о.cost ?? 0,
          stage,
          seen: сколько,
        });
      }
    }

    const книга: BuildBook = { hero, order, fetchedAt: Date.now() };
    записатьКэш(файл, книга);
    return книга;
  } catch (беда) {
    // Сети нет — живём по вчерашнему. Нет и его — молчим про сборку: совет
    // наугад хуже молчания. Но причину называем: «сети нет», «OpenDota сменил
    // формат» и «ошибка в нашем коде» снаружи были неразличимы.
    console.error('[dota] сборка не скачалась:', беда instanceof Error ? беда.message : беда);
    return изКэша;
  }
}

function прочитатьКэш(файл: string): BuildBook | null {
  try {
    if (!existsSync(файл)) return null;
    const книга = JSON.parse(readFileSync(файл, 'utf8')) as BuildBook;
    return Array.isArray(книга.order) ? книга : null;
  } catch {
    return null;
  }
}

function записатьКэш(файл: string, книга: BuildBook): void {
  try {
    mkdirSync(dirname(файл), { recursive: true });
    writeFileSync(файл, JSON.stringify(книга), 'utf8');
  } catch { /* не записалось — не беда, в следующий раз скачаем снова */ }
}

/**
 * Какая стадия игры сейчас — по игровым часам.
 *
 * Границы грубые и названы прямо: до гудка — старт, первые десять минут —
 * ранняя, до двадцати пяти — середина, дальше — поздняя. Точности тут не
 * бывает, но без стадии советы выходят нелепые: прогон 21.09.2026 на
 * тридцатой минуте предлагал купить ветку за 55 золота, потому что её не было
 * в сумке.
 */
export function stageAt(clock: number | null): Stage {
  if (clock === null || clock < 0) return 'start';
  if (clock < 600) return 'early';
  if (clock < 1500) return 'mid';
  return 'late';
}

const ПОРЯДОК: readonly Stage[] = ['start', 'early', 'mid', 'late'];

/**
 * Что покупать дальше.
 *
 * Пропускает то, что уже есть на руках, в рюкзаке и в тайнике: предлагать
 * второй раз то же самое — верный способ, чтобы подсказку выключили.
 *
 * И пропускает всё, чья стадия уже прошла: непокупка стартовой ветки к
 * середине игры — не пробел, а решение.
 */
export function nextItem(
  book: BuildBook | null,
  owned: readonly string[],
  clock: number | null = null,
): BuildItem | null {
  if (!book) return null;
  const есть = new Set(owned.map((и) => и.replace(/^item_/, '')));
  const сейчас = ПОРЯДОК.indexOf(stageAt(clock));
  return book.order.find((п) => (
    !есть.has(п.key) && п.cost > 0 && ПОРЯДОК.indexOf(п.stage) >= сейчас
  )) ?? null;
}

/**
 * Кто против нас — по ролям из OpenDota.
 *
 * Роли — их классификация, не моя выдумка. «Трое с контролем» говорит, стоит ли
 * думать о защите от него, и это всё, что честно можно вывести из ролей.
 */
export function readEnemies(
  enemyHeroes: readonly string[],
  heroes: readonly { name: string; roles: string[] }[],
): EnemyRead {
  let disablers = 0;
  let nukers = 0;
  for (const имя of enemyHeroes) {
    const г = heroes.find((x) => x.name === имя);
    if (!г) continue;
    if (г.roles.includes('Disabler')) disablers += 1;
    if (г.roles.includes('Nuker')) nukers += 1;
  }
  return { disablers, nukers, heroes: [...enemyHeroes] };
}
