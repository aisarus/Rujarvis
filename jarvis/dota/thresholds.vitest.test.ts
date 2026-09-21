import { describe, expect, it } from 'vitest';

import { DEFAULT_DANGER, DEFAULT_GOLD, judgeDanger, judgeGold } from './thresholds';
import type { DotaPacket, MapObject } from './packet';
import { createState, type DotaState } from './state';

function враг(расстояние: number, имя = 'npc_dota_hero_lina'): MapObject {
  return { x: расстояние, y: 0, icon: 'minimap_enemyicon', team: 2, hero: имя, yaw: 0, vision: 1800 };
}

function пакет(враги: MapObject[], хп = 100, жив = true): DotaPacket {
  return {
    at: 1000,
    clock: 600,
    state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
    matchId: '1',
    self: {
      hero: 'npc_dota_hero_skeleton_king',
      level: 10,
      alive: жив,
      hp: хп,
      x: 0,
      y: 0,
      buybackCost: 900,
      buybackCooldown: 0,
    },
    gold: 0,
    lastHits: 0,
    deaths: 0,
    enemies: враги,
    allies: [],
    neutrals: [],
    events: [],
  };
}

describe('judgeDanger', () => {
  it('трое в радиусе — опасность', () => {
    const ворота = judgeDanger(пакет([
      враг(500),
      враг(700, 'npc_dota_hero_lion'),
      враг(1100, 'npc_dota_hero_lich'),
    ]));
    expect(ворота.passed).toBe(false);
    expect(ворота.why).toContain('трое');
  });

  it('двое в радиусе при полном здоровье — не опасность', () => {
    expect(judgeDanger(пакет([враг(500), враг(700, 'npc_dota_hero_lion')])).passed).toBe(true);
  });

  it('трое, но далеко — не опасность', () => {
    const далеко = [враг(2000), враг(2100, 'npc_dota_hero_lion'), враг(2200, 'npc_dota_hero_lich')];
    expect(judgeDanger(пакет(далеко)).passed).toBe(true);
  });

  it('один вплотную при низком здоровье — опасность', () => {
    expect(judgeDanger(пакет([враг(400)], 30)).passed).toBe(false);
  });

  it('один вплотную при высоком здоровье — не опасность', () => {
    expect(judgeDanger(пакет([враг(400)], 90)).passed).toBe(true);
  });

  it('мёртвому предупреждать не о чем — нечем мерить', () => {
    const ворота = judgeDanger(пакет([враг(100), враг(200), враг(300)], 0, false));
    expect(ворота.passed).toBeNull();
  });

  it('без своего героя — нечем мерить, а не «спокойно»', () => {
    // Третье значение существует ровно ради этого случая: отсутствие данных
    // нельзя подать как «опасности нет». Молчание прибора и молчание карты
    // должны звучать по-разному.
    const пустой = { ...пакет([]), self: null };
    expect(judgeDanger(пустой).passed).toBeNull();
  });

  it('порог — данные: другое правило даёт другой ответ', () => {
    const мягкое = { ...DEFAULT_DANGER, nearCount: 2 };
    const двое = пакет([враг(500), враг(700, 'npc_dota_hero_lion')]);
    expect(judgeDanger(двое).passed).toBe(true);
    expect(judgeDanger(двое, мягкое).passed).toBe(false);
  });
});

describe('judgeGold', () => {
  function состояние(поверх: Partial<DotaState>): DotaState {
    return { ...createState(), ...поверх };
  }

  it('золото лежит дольше положенного — сказать', () => {
    const с = состояние({ goldSince: 1000, latest: { ...пакет([]), at: 60_000, gold: 2500 } });
    expect(judgeGold(с).passed).toBe(false);
  });

  it('золото только что перешло отметку — молчать', () => {
    const с = состояние({ goldSince: 55_000, latest: { ...пакет([]), at: 60_000, gold: 2500 } });
    expect(judgeGold(с).passed).toBe(true);
  });

  it('золота не набралось — молчать', () => {
    const с = состояние({ goldSince: null, latest: { ...пакет([]), at: 60_000, gold: 100 } });
    expect(judgeGold(с).passed).toBe(true);
  });

  it('без пакета — нечем мерить', () => {
    expect(judgeGold(состояние({ latest: null })).passed).toBeNull();
  });

  it('мёртвому про покупки не говорят', () => {
    // Замер по матчу 9009407694: без этой оговорки порог давал пять реплик
    // вместо двух, и три из пяти — пока герой лежал на респавне.
    const лежит = пакет([], 0, false);
    const с = состояние({ goldSince: 1000, latest: { ...лежит, at: 60_000, gold: 2500 } });
    expect(judgeGold(с).passed).toBe(true);
  });

  it('после воскрешения фраза звучит сразу — отсчёт не сбрасывался', () => {
    const живой = { ...пакет([]), at: 61_000, gold: 2500 };
    expect(judgeGold(состояние({ goldSince: 1000, latest: живой })).passed).toBe(false);
  });
});

describe('значения по умолчанию', () => {
  it('те, что измерены на матче 9009407694', () => {
    // Числа не украшение: при другом наборе прогон по записи даст другие
    // 18 из 18 и другую одну ложную. Менять их можно только вместе с прогоном.
    expect(DEFAULT_DANGER.nearRadius).toBe(1200);
    expect(DEFAULT_DANGER.nearCount).toBe(3);
    expect(DEFAULT_DANGER.closeRadius).toBe(600);
    expect(DEFAULT_DANGER.closeHp).toBe(40);
    expect(DEFAULT_GOLD.amount).toBe(2000);
    expect(DEFAULT_GOLD.heldMs).toBe(45_000);
  });
});
