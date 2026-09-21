import { describe, expect, it } from 'vitest';

import type { Camp } from './camps';
import type { DotaPacket, MapPing } from './packet';
import { allyLanding, farmRoute, stackWindow, unseenEnemies } from './signals';

function пакет(поверх: Partial<DotaPacket> = {}): DotaPacket {
  return {
    at: 100_000,
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

function пинг(x: number, y: number, remaining = 2.4, kind = 'teleporting'): MapPing {
  return { kind, x, y, remaining, duration: 3 };
}

function лагерь(x: number, y: number, state: Camp['state']): Camp {
  return { x, y, state, seenAt: 100_000 };
}

describe('unseenEnemies', () => {
  it('молчащих дольше порога считает пропавшими', () => {
    const видел = new Map([
      ['npc_dota_hero_lina', { at: 90_000, x: 1000, y: 2000 }],
      ['npc_dota_hero_lion', { at: 99_000, x: 0, y: 0 }],
    ]);
    const пропали = unseenEnemies(видел, 100_000, 8_000);
    expect(пропали.map((п) => п.hero)).toEqual(['npc_dota_hero_lina']);
    expect(пропали[0].ageMs).toBe(10_000);
    // Место не менее важно времени: по нему видно, с какой стороны смотреть.
    expect({ x: пропали[0].x, y: пропали[0].y }).toEqual({ x: 1000, y: 2000 });
  });

  it('сортирует по давности: кого дольше нет, тот первым', () => {
    const видел = new Map([
      ['npc_dota_hero_lina', { at: 80_000, x: 0, y: 0 }],
      ['npc_dota_hero_lich', { at: 50_000, x: 0, y: 0 }],
      ['npc_dota_hero_lion', { at: 70_000, x: 0, y: 0 }],
    ]);
    expect(unseenEnemies(видел, 100_000, 8_000).map((п) => п.hero))
      .toEqual(['npc_dota_hero_lich', 'npc_dota_hero_lion', 'npc_dota_hero_lina']);
  });

  it('кого не видели ни разу — не пропавший, а неизвестный', () => {
    // Пока имя не встретилось, мы не знаем даже, кто против нас. Записывать
    // такого в пропавшие — выдавать незнание за наблюдение.
    expect(unseenEnemies(new Map(), 100_000)).toEqual([]);
  });
});

describe('allyLanding', () => {
  it('союзник садится рядом — с обратным отсчётом', () => {
    const итог = allyLanding(пакет({ pings: [пинг(800, 600)] }));
    expect(итог).toEqual({ seconds: 2.4, distance: 1000 });
  });

  it('дальний телепорт не считается', () => {
    // Замер по матчу 9009407694: телепортов сорок восемь, а ближе 1500 сел
    // ровно один. Без этого условия сигнал был бы шумом.
    expect(allyLanding(пакет({ pings: [пинг(6000, 6000)] }))).toBeNull();
  });

  it('из двоих берёт ближнего', () => {
    const итог = allyLanding(пакет({ pings: [пинг(0, 1400), пинг(300, 0)] }));
    expect(итог?.distance).toBe(300);
  });

  it('чужие пинги не путаются с телепортом', () => {
    expect(allyLanding(пакет({ pings: [пинг(100, 100, 2, 'baseattacked')] }))).toBeNull();
  });
});

describe('stackWindow', () => {
  const рядом = [лагерь(500, 500, 'alive')];

  it('на пятьдесят второй секунде рядом с живым лагерем — можно', () => {
    const итог = stackWindow(пакет({ clock: 652 }), рядом);
    expect(итог?.seconds).toBe(8);
    expect(итог?.distance).toBe(707);
  });

  it('в середине минуты — нельзя', () => {
    expect(stackWindow(пакет({ clock: 630 }), рядом)).toBeNull();
  });

  it('пустой лагерь складывать нечего', () => {
    expect(stackWindow(пакет({ clock: 652 }), [лагерь(500, 500, 'empty')])).toBeNull();
  });

  it('лагерь, про который давно не знаем, не предлагаем', () => {
    // «Не смотрели» — это не «жив». Предлагать стак туда значит выдавать
    // догадку за знание, а человек просил показывать только известное.
    expect(stackWindow(пакет({ clock: 652 }), [лагерь(500, 500, 'stale')])).toBeNull();
  });

  it('далёкий лагерь не предлагаем', () => {
    expect(stackWindow(пакет({ clock: 652 }), [лагерь(5000, 5000, 'alive')])).toBeNull();
  });

  it('мёртвому стаки не нужны', () => {
    const лежит = пакет({ clock: 652 });
    expect(stackWindow({ ...лежит, self: { ...лежит.self!, alive: false } }, рядом)).toBeNull();
  });
});

describe('farmRoute', () => {
  const лагеря = [
    лагерь(1000, 0, 'alive'),
    лагерь(2000, 0, 'alive'),
    лагерь(500, 500, 'empty'),
    лагерь(-1000, 0, 'stale'),
  ];

  it('ведёт от героя к ближайшему живому, потом дальше', () => {
    const маршрут = farmRoute(пакет(), лагеря);
    expect(маршрут.map((т) => т.x)).toEqual([1000, 2000]);
    expect(маршрут[0].legDistance).toBe(1000);
    expect(маршрут[1].legDistance).toBe(1000);
  });

  it('пустые и неизвестные лагеря в маршрут не попадают', () => {
    // «Не смотрели» — это не «жив». Вести туда человека значит выдавать
    // догадку за знание, а он пойдёт не глядя, потому что доверяет.
    const маршрут = farmRoute(пакет(), [лагерь(100, 0, 'stale'), лагерь(200, 0, 'empty')]);
    expect(маршрут).toEqual([]);
  });

  it('лагерь с врагом рядом не предлагается', () => {
    // Маршрут, ведущий в засаду, хуже отсутствующего.
    const сВрагом = пакет({
      enemies: [{ x: 1100, y: 0, icon: 'minimap_enemyicon', team: 2, hero: 'npc_dota_hero_lina', yaw: 0, vision: 1800 }],
    });
    expect(farmRoute(сВрагом, [лагерь(1000, 0, 'alive')])).toEqual([]);
  });

  it('дальние лагеря не берём: это переход, а не фарм', () => {
    expect(farmRoute(пакет(), [лагерь(8000, 0, 'alive')])).toEqual([]);
  });

  it('мёртвому маршрут не нужен', () => {
    const лежит = пакет();
    expect(farmRoute({ ...лежит, self: { ...лежит.self!, alive: false } }, лагеря)).toEqual([]);
  });

  it('длина маршрута ограничена', () => {
    const много = Array.from({ length: 10 }, (_, i) => лагерь(500 * (i + 1), 0, 'alive'));
    expect(farmRoute(пакет(), много)).toHaveLength(4);
  });
});
