import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadBuildBook, nextItem, readEnemies, stageAt, type BuildBook, type Fetcher } from './builds';

const ГЕРОИ = [
  { id: 42, name: 'npc_dota_hero_skeleton_king', localized_name: 'Wraith King', roles: ['Carry', 'Durable'] },
  { id: 25, name: 'npc_dota_hero_lina', localized_name: 'Lina', roles: ['Nuker', 'Disabler'] },
  { id: 26, name: 'npc_dota_hero_lion', localized_name: 'Lion', roles: ['Support', 'Disabler', 'Nuker'] },
  { id: 31, name: 'npc_dota_hero_lich', localized_name: 'Lich', roles: ['Support', 'Nuker'] },
];

const НОМЕРА: Record<string, string> = { '16': 'branches', '29': 'boots', '1': 'blink', '116': 'black_king_bar' };
const ПРЕДМЕТЫ = {
  branches: { dname: 'Iron Branch', cost: 55 },
  boots: { dname: 'Boots of Speed', cost: 500 },
  blink: { dname: 'Blink Dagger', cost: 2250 },
  black_king_bar: { dname: 'Black King Bar', cost: 4050 },
};
const ПОПУЛЯРНОСТЬ = {
  start_game_items: { '16': 143 },
  early_game_items: { '29': 98 },
  mid_game_items: { '1': 63 },
  late_game_items: { '116': 18 },
};

function поддельнаяСеть(поверх: Record<string, unknown> = {}): { fetcher: Fetcher; запросов: string[] } {
  const запросов: string[] = [];
  const fetcher: Fetcher = async (url) => {
    запросов.push(url);
    if (url in поверх) return поверх[url];
    if (url.endsWith('/heroes')) return ГЕРОИ;
    if (url.endsWith('/constants/item_ids')) return НОМЕРА;
    if (url.endsWith('/constants/items')) return ПРЕДМЕТЫ;
    if (url.includes('/itemPopularity')) return ПОПУЛЯРНОСТЬ;
    throw new Error(`неожиданный запрос ${url}`);
  };
  return { fetcher, запросов };
}

const папка = () => mkdtempSync(join(tmpdir(), 'сборки-'));

describe('loadBuildBook', () => {
  it('складывает порядок покупок по стадиям', async () => {
    const { fetcher } = поддельнаяСеть();
    const книга = await loadBuildBook({ hero: 'npc_dota_hero_skeleton_king', cacheDir: папка(), fetcher });

    expect(книга?.order.map((п) => п.key)).toEqual(['branches', 'boots', 'blink', 'black_king_bar']);
    expect(книга?.order.map((п) => п.stage)).toEqual(['start', 'early', 'mid', 'late']);
    expect(книга?.order[3].cost).toBe(4050);
  });

  it('второй раз берёт из кэша, а не из сети', async () => {
    const где = папка();
    const первая = поддельнаяСеть();
    await loadBuildBook({ hero: 'npc_dota_hero_skeleton_king', cacheDir: где, fetcher: первая.fetcher });

    const вторая = поддельнаяСеть();
    const книга = await loadBuildBook({ hero: 'npc_dota_hero_skeleton_king', cacheDir: где, fetcher: вторая.fetcher });

    expect(вторая.запросов).toEqual([]);
    expect(книга?.order).toHaveLength(4);
  });

  it('без сети живёт по вчерашнему кэшу', async () => {
    const где = папка();
    const рабочая = поддельнаяСеть();
    await loadBuildBook({ hero: 'npc_dota_hero_skeleton_king', cacheDir: где, fetcher: рабочая.fetcher });

    const мёртвая: Fetcher = async () => { throw new Error('сети нет'); };
    const книга = await loadBuildBook({
      hero: 'npc_dota_hero_skeleton_king', cacheDir: где, fetcher: мёртвая, staleDays: 0,
    });

    expect(книга?.order).toHaveLength(4);
  });

  it('без сети и без кэша молчит, а не выдумывает', async () => {
    // Совет наугад хуже молчания: человек ему поверит именно потому, что он
    // прозвучал уверенно.
    const мёртвая: Fetcher = async () => { throw new Error('сети нет'); };
    expect(await loadBuildBook({ hero: 'npc_dota_hero_skeleton_king', cacheDir: папка(), fetcher: мёртвая }))
      .toBeNull();
  });

  it('незнакомый герой не ломает разбор', async () => {
    const { fetcher } = поддельнаяСеть();
    expect(await loadBuildBook({ hero: 'npc_dota_hero_выдуманный', cacheDir: папка(), fetcher })).toBeNull();
  });

  it('битый кэш не мешает скачать заново', async () => {
    const где = папка();
    writeFileSync(join(где, 'сборка-skeleton_king.json'), 'это не json', 'utf8');
    const { fetcher } = поддельнаяСеть();
    const книга = await loadBuildBook({ hero: 'npc_dota_hero_skeleton_king', cacheDir: где, fetcher });
    expect(книга?.order).toHaveLength(4);
    // И перезаписан целым.
    expect(JSON.parse(readFileSync(join(где, 'сборка-skeleton_king.json'), 'utf8')).order).toHaveLength(4);
  });
});

describe('nextItem', () => {
  const книга: BuildBook = {
    hero: 'npc_dota_hero_skeleton_king',
    fetchedAt: Date.now(),
    order: [
      { key: 'branches', name: 'Iron Branch', cost: 55, stage: 'start', seen: 143 },
      { key: 'boots', name: 'Boots of Speed', cost: 500, stage: 'early', seen: 98 },
      { key: 'blink', name: 'Blink Dagger', cost: 2250, stage: 'mid', seen: 63 },
    ],
  };

  it('предлагает первое, чего ещё нет', () => {
    expect(nextItem(книга, ['item_branches'])?.key).toBe('boots');
  });

  it('приставка item_ не мешает узнать предмет', () => {
    // GSI присылает `item_blink`, OpenDota знает его как `blink`. Без этого
    // помощник советовал бы то, что уже лежит в сумке.
    expect(nextItem(книга, ['item_branches', 'item_boots'])?.key).toBe('blink');
  });

  it('всё куплено — молчит', () => {
    expect(nextItem(книга, ['item_branches', 'item_boots', 'item_blink'])).toBeNull();
  });

  it('без книги молчит', () => {
    expect(nextItem(null, [])).toBeNull();
  });
});

describe('readEnemies', () => {
  it('считает контроль и урон заклинаниями по ролям OpenDota', () => {
    const итог = readEnemies(
      ['npc_dota_hero_lina', 'npc_dota_hero_lion', 'npc_dota_hero_lich'],
      ГЕРОИ,
    );
    expect(итог.disablers).toBe(2);
    expect(итог.nukers).toBe(3);
  });

  it('незнакомого героя пропускает, а не считает нулём', () => {
    const итог = readEnemies(['npc_dota_hero_выдуманный', 'npc_dota_hero_lina'], ГЕРОИ);
    expect(итог.disablers).toBe(1);
    expect(итог.heroes).toHaveLength(2);
  });
});

describe('стадия игры', () => {
  const книга: BuildBook = {
    hero: 'npc_dota_hero_skeleton_king',
    fetchedAt: Date.now(),
    order: [
      { key: 'branches', name: 'Iron Branch', cost: 55, stage: 'start', seen: 143 },
      { key: 'boots', name: 'Boots of Speed', cost: 500, stage: 'early', seen: 98 },
      { key: 'blink', name: 'Blink Dagger', cost: 2250, stage: 'mid', seen: 63 },
      { key: 'black_king_bar', name: 'Black King Bar', cost: 4050, stage: 'late', seen: 18 },
    ],
  };

  it('часы определяют стадию', () => {
    expect(stageAt(null)).toBe('start');
    expect(stageAt(-30)).toBe('start');
    expect(stageAt(300)).toBe('early');
    expect(stageAt(900)).toBe('mid');
    expect(stageAt(1800)).toBe('late');
  });

  it('прошедшая стадия не предлагается', () => {
    // Прогон 21.09.2026 на тридцатой минуте советовал ветку за 55 золота —
    // просто потому, что её не было в сумке. Непокупка стартового предмета к
    // середине игры не пробел, а решение.
    expect(nextItem(книга, [], 1800)?.key).toBe('black_king_bar');
    expect(nextItem(книга, [], 900)?.key).toBe('blink');
  });

  it('без часов ведёт себя как в начале игры', () => {
    expect(nextItem(книга, [])?.key).toBe('branches');
  });
});
