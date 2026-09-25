import { describe, expect, it } from 'vitest';

import { describeDiff, diff, nothingChanged, unmet, type Snapshot } from './machine';

function снимок(
  front: string,
  windows: Array<[string, string]>,
  processes: string[] = [],
): Snapshot {
  return {
    at: 0,
    front,
    windows: windows.map(([title, process]) => ({ title, process, focused: title === front })),
    processes,
  };
}

describe('разница снимков', () => {
  it('замечает смену переднего окна', () => {
    const было = снимок('Blender', [['Blender', 'blender'], ['Edge', 'msedge']]);
    const стало = снимок('Edge', [['Blender', 'blender'], ['Edge', 'msedge']]);
    expect(diff(было, стало).front).toEqual({ was: 'Blender', now: 'Edge' });
  });

  it('замечает запуск и закрытие программы', () => {
    const было = снимок('A', [['A', 'a']], ['a']);
    const стало = снимок('A', [['A', 'a'], ['B', 'b']], ['a', 'b']);
    expect(diff(было, стало).started).toEqual(['b']);
    expect(diff(стало, было).stopped).toEqual(['b']);
  });

  // Смена вкладки в браузере выглядит как смена заголовка у того же окна.
  // Считать её парой «закрылось и открылось» значило бы не отличить
  // переключение вкладки от закрытия браузера.
  it('смену вкладки называет переименованием, а не закрытием', () => {
    const было = снимок('Почта — Edge', [['Почта — Edge', 'msedge']]);
    const стало = снимок('Карты — Edge', [['Карты — Edge', 'msedge']]);
    const d = diff(было, стало);

    expect(d.renamed).toEqual([{ was: 'Почта — Edge', now: 'Карты — Edge' }]);
    expect(d.closed).toEqual([]);
    expect(d.opened).toEqual([]);
  });

  it('окно чужой программы переименованием не считает', () => {
    const было = снимок('Почта', [['Почта', 'msedge']]);
    const стало = снимок('Блокнот', [['Блокнот', 'notepad']]);
    const d = diff(было, стало);

    expect(d.renamed).toEqual([]);
    expect(d.closed).toEqual(['Почта']);
    expect(d.opened).toEqual(['Блокнот']);
  });

  it('одинаковые снимки — пустая разница', () => {
    const s = снимок('A', [['A', 'a']], ['a']);
    expect(nothingChanged(diff(s, s))).toBe(true);
    expect(describeDiff(diff(s, s))).toBe('ничего не изменилось');
  });

  it('разницу называет словами', () => {
    const было = снимок('A', [['A', 'a']], ['a']);
    const стало = снимок('B', [['A', 'a'], ['B', 'b']], ['a', 'b']);
    const слова = describeDiff(diff(было, стало));

    expect(слова).toContain('впереди');
    expect(слова).toContain('открылось: B');
    expect(слова).toContain('запустилось: b');
  });
});

describe('сбылось ли ожидание', () => {
  const было = снимок('Blender', [['Blender', 'blender']], ['blender']);
  const стало = снимок('Почта — Edge', [['Blender', 'blender'], ['Почта — Edge', 'msedge']], [
    'blender',
    'msedge',
  ]);
  const d = diff(было, стало);

  it('переключение засчитано по части заголовка', () => {
    expect(unmet({ frontContains: 'Edge' }, d)).toBeNull();
  });

  // Причина словами, а не булевым: «не сработало» без объяснения заставляет
  // воспроизводить вручную, а это и есть то, на что уходил целый день.
  it('несбывшееся объясняет, чем именно', () => {
    const беда = unmet({ frontContains: 'Блокнот' }, d);
    expect(беда).toContain('Почта');
    expect(беда).toContain('Блокнот');
  });

  it('запуск засчитан по имени программы', () => {
    expect(unmet({ started: 'msedge' }, d)).toBeNull();
    expect(unmet({ started: 'notepad' }, d)).toContain('не запустилось');
  });

  it('смена заголовка засчитана', () => {
    const было2 = снимок('Почта — Edge', [['Почта — Edge', 'msedge']]);
    const стало2 = снимок('Карты — Edge', [['Карты — Edge', 'msedge']]);
    expect(unmet({ titleChanged: true }, diff(было2, стало2))).toBeNull();
  });

  // Команды, которые НЕ должны ничего делать, — половина проверки: именно так
  // ловится перехват обычной просьбы таблицей команд.
  it('ожидание бездействия нарушается запуском программы', () => {
    expect(unmet({ nothing: true }, diff(было, было))).toBeNull();
    expect(unmet({ nothing: true }, d)).toContain('ожидали бездействия');
  });

  // Дрейф фокуса не считается: на живом столе окно впереди меняется само.
  // Требовать полной неподвижности значит валить проверку на пустом месте.
  it('дрейф фокуса бездействием не нарушает', () => {
    const дрейф = снимок('Почта — Edge', [['Blender', 'blender']], ['blender']);
    expect(unmet({ nothing: true }, diff(было, дрейф))).toBeNull();
  });

  // На живой машине рядом всегда что-то шевелится: уведомление, фоновая
  // программа, часы в заголовке. Проверяется наличие ожидаемого, а не
  // отсутствие остального.
  it('постороннее движение не мешает засчитать ожидаемое', () => {
    const шумно = снимок(
      'Почта — Edge',
      [['Blender', 'blender'], ['Почта — Edge', 'msedge'], ['Уведомление', 'shell']],
      ['blender', 'msedge', 'shell'],
    );
    expect(unmet({ frontContains: 'Edge' }, diff(было, шумно))).toBeNull();
  });
});
