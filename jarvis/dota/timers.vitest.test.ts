import { describe, expect, it } from 'vitest';

import type { DotaEvent, DotaPacket } from './packet';
import { applyTimers, createTimers, enemyTeam, onEnemyHalf, slotTeam } from './timers';

function событие(type: string, поверх: Record<string, unknown> = {}): DotaEvent {
  return { kind: 'generic_event', gameTime: 600, data: { type, time: 600, ...поверх } };
}

function пакет(at: number, события: DotaEvent[]): DotaPacket {
  return {
    at,
    clock: 600,
    state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
    matchId: '1',
    self: null,
    gold: null,
    lastHits: null,
    deaths: null,
    team: 3,
    enemies: [],
    allies: [],
    neutrals: [],
    vision: [],
    pings: [],
    events: события,
  };
}

describe('applyTimers', () => {
  it('глиф записывается за команду, а не за игрока', () => {
    // В CHAT_MESSAGE_GLYPH_USED поле playerid1 — номер команды (2 или 3), хотя
    // называется как слот игрока. В CHAT_MESSAGE_BUYBACK то же поле — уже слот.
    const итог = applyTimers(createTimers(), пакет(1000, [событие('CHAT_MESSAGE_GLYPH_USED', { playerid1: 2 })]));
    expect(итог.glyph[2]?.at).toBe(1000);
    expect(итог.glyph[3]).toBeNull();
  });

  it('скан берёт команду из value, а не из playerid', () => {
    const итог = applyTimers(createTimers(), пакет(1000, [
      событие('CHAT_MESSAGE_SCAN_USED', { value: 3, playerid1: -1 }),
    ]));
    expect(итог.scan[3]?.at).toBe(1000);
  });

  it('одно событие не считается дважды', () => {
    // Дота повторяет событие в нескольких подряд идущих пакетах. Без защиты
    // один выкуп превратился бы в десяток реплик подряд.
    const е = событие('CHAT_MESSAGE_BUYBACK', { playerid1: 1 });
    let т = applyTimers(createTimers(), пакет(1000, [е]));
    т = applyTimers(т, пакет(1400, [е]));
    т = applyTimers(т, пакет(1800, [е]));
    expect(т.buybacks).toHaveLength(1);
  });

  it('два разных выкупа считаются порознь', () => {
    let т = applyTimers(createTimers(), пакет(1000, [событие('CHAT_MESSAGE_BUYBACK', { playerid1: 1, time: 600 })]));
    т = applyTimers(т, пакет(2000, [событие('CHAT_MESSAGE_BUYBACK', { playerid1: 7, time: 900 })]));
    expect(т.buybacks.map((в) => в.slot)).toEqual([1, 7]);
  });

  it('пакет без новых событий не создаёт нового состояния', () => {
    const было = applyTimers(createTimers(), пакет(1000, []));
    expect(applyTimers(было, пакет(2000, []))).toBe(было);
  });

  it('чужой номер команды не принимается', () => {
    const итог = applyTimers(createTimers(), пакет(1000, [событие('CHAT_MESSAGE_GLYPH_USED', { playerid1: 7 })]));
    expect(итог.glyph[2]).toBeNull();
    expect(итог.glyph[3]).toBeNull();
  });
});

describe('стороны', () => {
  it('противник — другая команда', () => {
    expect(enemyTeam(3)).toBe(2);
    expect(enemyTeam(2)).toBe(3);
    expect(enemyTeam(null)).toBeNull();
  });

  it('слот говорит о команде', () => {
    expect(slotTeam(0)).toBe(2);
    expect(slotTeam(4)).toBe(2);
    expect(slotTeam(5)).toBe(3);
    expect(slotTeam(9)).toBe(3);
    expect(slotTeam(11)).toBeNull();
  });

  it('чужая половина зависит от того, за кого играешь', () => {
    // Перепутать знак значит получить сигнал, который врёт ровно наоборот:
    // «ты у них» будет загораться на собственной базе.
    expect(onEnemyHalf(3, -4000, -4000)).toBe(true);
    expect(onEnemyHalf(3, 4000, 4000)).toBe(false);
    expect(onEnemyHalf(2, 4000, 4000)).toBe(true);
    expect(onEnemyHalf(2, -4000, -4000)).toBe(false);
    expect(onEnemyHalf(null, 4000, 4000)).toBe(false);
  });
});
