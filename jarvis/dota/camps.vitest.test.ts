import { describe, expect, it } from 'vitest';

import { createCamps, updateCamps } from './camps';
import { CAMP_POSITIONS } from './campPositions';
import type { DotaPacket, MapObject } from './packet';

const ЛАГЕРЬ = { x: 1000, y: 1000 };

function пакет(at: number, нейтралы: Partial<MapObject>[], герой = { x: 1100, y: 1100 }): DotaPacket {
  return {
    at,
    clock: 600,
    state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
    matchId: '1',
    self: {
      hero: 'npc_dota_hero_pudge',
      level: 10,
      alive: true,
      hp: 100,
      x: герой.x,
      y: герой.y,
      buybackCost: 0,
      buybackCooldown: 0,
    },
    gold: 0,
    lastHits: 0,
    deaths: 0,
    enemies: [],
    allies: [],
    neutrals: нейтралы.map((н) => ({
      x: ЛАГЕРЬ.x,
      y: ЛАГЕРЬ.y,
      icon: 'minimap_creep',
      team: 4,
      yaw: 0,
      vision: 750,
      ...н,
    })) as MapObject[],
    events: [],
  };
}

describe('updateCamps', () => {
  it('новый лагерь — «давно не смотрели», а не «пуст»', () => {
    // Разница ровно та, ради которой всё затевалось: «не знаю» нельзя
    // подавать как «знаю, что пусто».
    const лагеря = createCamps([ЛАГЕРЬ]);
    expect(лагеря[0].state).toBe('stale');
    expect(лагеря[0].seenAt).toBeNull();
  });

  it('увидел нейтралов — лагерь жив', () => {
    const после = updateCamps(createCamps([ЛАГЕРЬ]), пакет(1000, [{}]));
    expect(после[0].state).toBe('alive');
    expect(после[0].seenAt).toBe(1000);
  });

  it('смотрит и не видит никого — лагерь пуст', () => {
    let лагеря = updateCamps(createCamps([ЛАГЕРЬ]), пакет(1000, [{}]));
    лагеря = updateCamps(лагеря, пакет(2000, []));
    expect(лагеря[0].state).toBe('empty');
    expect(лагеря[0].seenAt).toBe(2000);
  });

  it('герой далеко — состояние не меняется', () => {
    // Пустой список нейтралов у дальнего лагеря не значит «пусто»: значит
    // «не видно». Иначе оверлей погасит полкарты, стоит уйти на базу.
    let лагеря = updateCamps(createCamps([ЛАГЕРЬ]), пакет(1000, [{}]));
    лагеря = updateCamps(лагеря, пакет(2000, [], { x: 8000, y: 8000 }));
    expect(лагеря[0].state).toBe('alive');
    expect(лагеря[0].seenAt).toBe(1000);
  });

  it('давно не смотрели — состояние выцветает в stale', () => {
    let лагеря = updateCamps(createCamps([ЛАГЕРЬ]), пакет(1000, [{}]));
    лагеря = updateCamps(лагеря, пакет(200_000, [], { x: 8000, y: 8000 }), { staleAfterMs: 60_000 });
    expect(лагеря[0].state).toBe('stale');
  });

  it('нейтралы чужого лагеря не оживляют этот', () => {
    const лагеря = updateCamps(createCamps([ЛАГЕРЬ]), пакет(1000, [{ x: 6000, y: 6000 }]));
    expect(лагеря[0].state).toBe('empty');
  });

  it('мёртвый герой ничего не наблюдает', () => {
    // Лежащий на респавне видит базу, а не лес. Записывать по его положению
    // «пусто» значит гасить лагеря каждой смертью.
    let лагеря = updateCamps(createCamps([ЛАГЕРЬ]), пакет(1000, [{}]));
    const мёртвый = пакет(2000, []);
    лагеря = updateCamps(лагеря, { ...мёртвый, self: { ...мёртвый.self!, alive: false } });
    expect(лагеря[0].state).toBe('alive');
  });

  it('по умолчанию берёт таблицу лагерей', () => {
    expect(createCamps()).toHaveLength(CAMP_POSITIONS.length);
  });
});
