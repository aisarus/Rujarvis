import { describe, expect, it } from 'vitest';

import { applyPacket, createState } from './state';
import type { DotaPacket } from './packet';

function пакет(at: number, поверх: Partial<DotaPacket> = {}): DotaPacket {
  return {
    at,
    clock: 600,
    state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
    matchId: '1',
    self: {
      hero: 'npc_dota_hero_skeleton_king',
      level: 10,
      alive: true,
      hp: 100,
      x: 0,
      y: 0,
      buybackCost: 900,
      buybackCooldown: 0,
    },
    gold: 0,
    lastHits: 0,
    deaths: 0,
    team: 3,
    enemies: [],
    allies: [],
    neutrals: [],
    vision: [],
    pings: [],
    events: [],
    ...поверх,
  };
}

/** Тот же пакет, но герой лежит. */
function мёртвый(at: number, поверх: Partial<DotaPacket> = {}): DotaPacket {
  const п = пакет(at, поверх);
  return { ...п, self: { ...п.self!, alive: false } };
}

describe('applyPacket', () => {
  it('запоминает, с какого мига золото перешло отметку', () => {
    let с = applyPacket(createState(), пакет(1000, { gold: 500 }), { goldMark: 2000 });
    expect(с.goldSince).toBeNull();
    с = applyPacket(с, пакет(2000, { gold: 2500 }), { goldMark: 2000 });
    expect(с.goldSince).toBe(2000);
    с = applyPacket(с, пакет(9000, { gold: 2600 }), { goldMark: 2000 });
    // Отсчёт не сбрасывается, пока золото выше отметки.
    expect(с.goldSince).toBe(2000);
  });

  it('потратил — отсчёт золота начинается заново', () => {
    let с = applyPacket(createState(), пакет(1000, { gold: 2500 }), { goldMark: 2000 });
    с = applyPacket(с, пакет(2000, { gold: 100 }), { goldMark: 2000 });
    expect(с.goldSince).toBeNull();
  });

  it('считает, сколько раз героя поймали, по флагу', () => {
    let с = applyPacket(createState(), пакет(1000));
    с = applyPacket(с, мёртвый(2000));
    expect(с.caughtOut).toBe(1);
    с = applyPacket(с, мёртвый(3000));
    // Пока лежит — это всё та же смерть, а не новая.
    expect(с.caughtOut).toBe(1);
  });

  it('настоящие смерти берёт из счётчика игры, а не из флага', () => {
    // У Рейдж Кинга реинкарнация тоже гасит `alive`: за матч 21.09.2026
    // восемнадцать пометок дали восемь настоящих смертей. Флаг годится для
    // «тебя поймали», счётчик — для «ты умер».
    let с = applyPacket(createState(), пакет(1000, { deaths: 0 }));
    с = applyPacket(с, мёртвый(2000, { deaths: 0 }));
    expect(с.caughtOut).toBe(1);
    expect(с.deaths).toBe(0);
    с = applyPacket(с, пакет(3000, { deaths: 1 }));
    expect(с.deaths).toBe(1);
  });

  it('пакет без героя состояние не портит', () => {
    let с = applyPacket(createState(), пакет(1000, { gold: 2500 }), { goldMark: 2000 });
    с = applyPacket(с, пакет(2000, { self: null }), { goldMark: 2000 });
    expect(с.goldSince).toBe(1000);
  });

  it('пакет без золота отсчёт не сбрасывает', () => {
    // В меню и на загрузке блок player приходит пустым. Считать это тратой
    // денег значит терять отсчёт на каждой паузе.
    let с = applyPacket(createState(), пакет(1000, { gold: 2500 }), { goldMark: 2000 });
    с = applyPacket(с, пакет(2000, { gold: null }), { goldMark: 2000 });
    expect(с.goldSince).toBe(1000);
  });
});
