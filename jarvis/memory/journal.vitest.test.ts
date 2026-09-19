import { describe, expect, it } from 'vitest';

import { contextGradient, type JarvisEvent } from './journal';

const NOW = new Date(2026, 8, 19, 15, 0, 0).getTime();
const MINUTE = 60_000;

function event(minutesAgo: number, kind: JarvisEvent['kind'], text: string): JarvisEvent {
  return { at: NOW - minutesAgo * MINUTE, kind, text };
}

function gradient(events: JarvisEvent[]): string[] {
  return contextGradient(events, { now: NOW });
}

describe('contextGradient', () => {
  it('молчит, когда ничего не было', () => {
    // Пустая строка «ничего не делал» занимает место и ничего не сообщает.
    expect(gradient([])).toEqual([]);
  });

  it('свежее передаёт дословно', () => {
    const lines = gradient([
      event(1, 'launch', 'открыл Chrome'),
      event(3, 'file', 'сделал закат.png'),
    ]);

    expect(lines[0]).toContain('открыл Chrome');
    expect(lines[0]).toContain('сделал закат.png');
  });

  it('ставит самое свежее первым', () => {
    // Спрашивают почти всегда про последнее: «а где он», «переделай».
    const lines = gradient([
      event(9, 'launch', 'открыл Steam'),
      event(1, 'launch', 'открыл Chrome'),
    ]);

    expect(lines[0].indexOf('Chrome')).toBeLessThan(lines[0].indexOf('Steam'));
  });

  it('не зачитывает бесконечный список свежего', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      event(index * 0.1, 'launch', `открыл программу ${index}`),
    );

    const lines = gradient(many);

    expect(lines[0]).toContain('программу 0');
    expect(lines[0]).toContain('ещё 12');
    expect(lines[0]).not.toContain('программу 19');
  });

  it('то, что старше свежего, сжимает в сводку', () => {
    const lines = gradient([
      event(1, 'launch', 'открыл Chrome'),
      event(40, 'launch', 'открыл Steam'),
      event(45, 'launch', 'открыл Dota'),
      event(50, 'file', 'сделал отчёт.xlsx'),
    ]);

    const summary = lines.find((line) => line.startsWith('До этого')) ?? '';
    expect(summary).toContain('Steam');
    expect(summary).toContain('Dota');
    // Сводка считает, а не пересказывает.
    expect(summary).not.toContain('открыл Steam');
  });

  it('самое старое превращает в счётчик', () => {
    const old = Array.from({ length: 30 }, (_, index) =>
      event(200 + index, 'launch', `старое ${index}`),
    );

    const lines = gradient([event(1, 'launch', 'открыл Chrome'), ...old]);
    const tail = lines.at(-1) ?? '';

    expect(tail).toContain('30');
    expect(tail).not.toContain('старое 0');
  });

  it('три слоя не смешиваются', () => {
    const lines = gradient([
      event(1, 'launch', 'открыл Chrome'),
      event(40, 'launch', 'открыл Steam'),
      event(300, 'launch', 'открыл Word'),
    ]);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Chrome');
    expect(lines[1]).toContain('Steam');
    expect(lines[2]).toMatch(/\d/u);
  });

  it('называет неудачи отдельно — их важно не повторять', () => {
    const lines = gradient([{ at: NOW - MINUTE, kind: 'error', text: 'не смог закрыть Steam' }]);
    expect(lines[0]).toContain('не смог закрыть Steam');
  });

  it('не повторяет одно и то же действие подряд', () => {
    // «Открой хром» трижды подряд — это одно намерение, а не три факта.
    const lines = gradient([
      event(1, 'launch', 'открыл Chrome'),
      event(2, 'launch', 'открыл Chrome'),
      event(3, 'launch', 'открыл Chrome'),
    ]);

    expect(lines[0].match(/Chrome/gu)).toHaveLength(1);
  });

  it('в сводке не перечисляет больше пяти имён', () => {
    const events = Array.from({ length: 9 }, (_, index) =>
      event(40 + index, 'launch', `программа ${index}`),
    );

    const summary = gradient([...events]).find((line) => line.startsWith('До этого')) ?? '';
    expect(summary.match(/программа/gu)?.length).toBeLessThanOrEqual(5);
  });
});
