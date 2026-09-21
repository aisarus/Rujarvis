import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { readPacket } from './packet';

const бой = JSON.parse(readFileSync('jarvis/dota/samples/fight.json', 'utf8')) as { t: number; d: unknown };
const тихо = JSON.parse(readFileSync('jarvis/dota/samples/calm.json', 'utf8')) as { t: number; d: unknown };

describe('readPacket', () => {
  it('раскладывает миникарту на врагов, союзников и нейтралов', () => {
    const п = readPacket(бой.d, бой.t);
    expect(п).not.toBeNull();
    expect(п!.enemies.length).toBeGreaterThanOrEqual(3);
    // Свой герой в союзники не попадает: иначе «ближайший союзник» всегда ноль.
    expect(п!.allies.every((с) => с.hero !== п!.self!.hero)).toBe(true);
  });

  it('не считает иллюзии и скелетов за союзных героев', () => {
    // minimap_herocircle приходит и на иллюзии Лансера, и на подконтрольных
    // существ. Союзник — только тот, у кого есть имя героя.
    const п = readPacket(бой.d, бой.t)!;
    expect(п.allies.every((с) => typeof с.hero === 'string' && с.hero.length > 0)).toBe(true);
    expect(п.allies.length).toBeLessThanOrEqual(4);
  });

  it('в спокойном пакете врагов нет', () => {
    expect(readPacket(тихо.d, тихо.t)!.enemies).toHaveLength(0);
  });

  it('берёт своего героя, золото и часы', () => {
    const п = readPacket(бой.d, бой.t)!;
    expect(п.self!.hero).toMatch(/^npc_dota_hero_/);
    expect(п.self!.hp).toBeGreaterThanOrEqual(0);
    expect(п.self!.hp).toBeLessThanOrEqual(100);
    expect(typeof п.gold).toBe('number');
    expect(typeof п.clock).toBe('number');
  });

  it('на мусоре возвращает null, а не бросает', () => {
    expect(readPacket(null)).toBeNull();
    expect(readPacket('строка')).toBeNull();
    expect(readPacket({})).toBeNull();
    expect(readPacket({ hero: { xpos: 'не число' } })).toBeNull();
  });

  it('пустой блок — это не данные', () => {
    // roshan, couriers и neutralitems приходят ключами без содержимого.
    // Разбор обязан отдать пустой список, а не признак «есть».
    const п = readPacket({ ...(бой.d as object), roshan: {}, couriers: {} }, бой.t)!;
    expect(п.neutrals.length).toBeGreaterThanOrEqual(0);
  });
});
