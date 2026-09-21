import { describe, expect, it } from 'vitest';

import { advise, createMemory, type OverlayMode } from './advice';
import type { DotaPacket, MapObject } from './packet';
import { applyPacket, createState, type DotaState } from './state';

function враг(расстояние: number, имя = 'npc_dota_hero_lina'): MapObject {
  return { x: расстояние, y: 0, icon: 'minimap_enemyicon', team: 2, hero: имя, yaw: 0, vision: 1800 };
}

function пакет(at: number, враги: MapObject[], поверх: Partial<DotaPacket> = {}): DotaPacket {
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
    enemies: враги,
    allies: [],
    neutrals: [],
    vision: [],
    events: [],
    ...поверх,
  };
}

const ТРОЕ = [враг(400), враг(600, 'npc_dota_hero_lion'), враг(900, 'npc_dota_hero_lich')];

/** Прогнать несколько пакетов и собрать всё, что было сказано. */
function прогнать(пакеты: DotaPacket[], mode: OverlayMode = 'full'): string[] {
  let состояние: DotaState = createState();
  let память = createMemory();
  const сказано: string[] = [];
  for (const п of пакеты) {
    состояние = applyPacket(состояние, п);
    const итог = advise(состояние, память, mode);
    память = итог.memory;
    if (итог.speech) сказано.push(итог.speech);
  }
  return сказано;
}

describe('advise', () => {
  it('про одну тревогу говорит один раз, а не двадцать пять', () => {
    // Порог горит, пока горит условие. При двух-трёх пакетах в секунду десять
    // секунд опасности — это два десятка «скажи» на один повод.
    const десятьСекунд = Array.from({ length: 25 }, (_, i) => пакет(1000 + i * 400, ТРОЕ));
    expect(прогнать(десятьСекунд)).toHaveLength(1);
  });

  it('новая тревога после настоящего затишья — новая фраза', () => {
    // «Настоящего» — значит дольше выдержки. Секундный провал условия посреди
    // замеса это та же опасность, и второй раз о ней говорить незачем.
    const сказано = прогнать([
      пакет(1000, ТРОЕ),
      пакет(2000, ТРОЕ),
      пакет(3000, []),
      пакет(30_000, []),
      пакет(31_000, ТРОЕ),
    ]);
    expect(сказано).toHaveLength(2);
  });

  it('мигание условия в замесе не даёт второй фразы', () => {
    const сказано = прогнать([
      пакет(1000, ТРОЕ),
      пакет(1400, []),
      пакет(1800, ТРОЕ),
      пакет(2200, []),
      пакет(2600, ТРОЕ),
    ]);
    expect(сказано).toHaveLength(1);
  });

  it('называет ближайшего и расстояние', () => {
    expect(прогнать([пакет(1000, ТРОЕ)])[0]).toBe('lina в 400');
  });

  it('на низком здоровье говорит про здоровье, а не про метры', () => {
    const сказано = прогнать([пакет(1000, ТРОЕ, {
      self: { ...пакет(1000, []).self!, hp: 25 },
    })]);
    expect(сказано[0]).toBe('lina рядом, ты на 25');
  });

  it('«только показывай» — картинка есть, голоса нет', () => {
    expect(прогнать([пакет(1000, ТРОЕ)], 'silent')).toEqual([]);
  });

  it('выключенный оверлей молчит тоже', () => {
    expect(прогнать([пакет(1000, ТРОЕ)], 'off')).toEqual([]);
  });

  it('картинка живёт независимо от голоса', () => {
    // Молчание не значит слепоту: в режиме «только показывай» состояние
    // обязано считаться полностью, иначе нечего рисовать.
    const состояние = applyPacket(createState(), пакет(1000, ТРОЕ));
    const итог = advise(состояние, createMemory(), 'silent');
    expect(итог.speech).toBeNull();
    expect(итог.view.danger.level).toBe('alarm');
    expect(итог.view.nearestEnemy).toEqual({ hero: 'npc_dota_hero_lina', distance: 400 });
  });

  it('опасность важнее денег: при обеих говорит про опасность', () => {
    const богатый = пакет(100_000, ТРОЕ, { gold: 5000 });
    let состояние = applyPacket(createState(), пакет(1000, [], { gold: 5000 }));
    состояние = applyPacket(состояние, богатый);
    const итог = advise(состояние, createMemory(), 'full');
    expect(итог.speech).toBe('lina в 400');
  });

  it('без пакетов — «нечем мерить», а не «спокойно»', () => {
    const итог = advise(createState(), createMemory(), 'full');
    expect(итог.view.danger.level).toBe('unknown');
    expect(итог.speech).toBeNull();
  });

  it('мёртвый герой даёт «нечем мерить» и молчание', () => {
    const лежит = пакет(1000, ТРОЕ);
    const состояние = applyPacket(createState(), { ...лежит, self: { ...лежит.self!, alive: false } });
    const итог = advise(состояние, createMemory(), 'full');
    expect(итог.view.danger.level).toBe('unknown');
    expect(итог.speech).toBeNull();
  });

  it('считает лагеря по состояниям', () => {
    const итог = advise(applyPacket(createState(), пакет(1000, [])), createMemory(), 'full');
    const { alive, empty, stale } = итог.view.camps;
    expect(alive + empty + stale).toBeGreaterThan(0);
  });
});

describe('опоздавшие подсказки', () => {
  it('на нуле здоровья молчит: удар уже прошёл', () => {
    // Ноль при живом флаге — миг гибели. Прогон по матчу 9009407694 выдавал
    // здесь «ты на 0»: подсказка, которая опоздала и делает вид, что успела.
    const умирает = пакет(1000, ТРОЕ, { self: { ...пакет(1000, []).self!, hp: 0 } });
    expect(прогнать([умирает])).toEqual([]);
  });
});
