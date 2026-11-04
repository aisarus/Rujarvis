import { describe, expect, it } from 'vitest';

import { GRAPH_FORCES, mergeGraphSettings, type GraphColorGroup } from './graphSettings';

const группы = (настройки: Record<string, unknown>): GraphColorGroup[] => настройки.colorGroups as GraphColorGroup[];

describe('настройки графа Obsidian', () => {
  it('у каждого курса свой цвет, расшифровки на обоих языках скрыты, силы подобраны', () => {
    const { settings, newGroups, courses, changed } = mergeGraphSettings(null, 'Лекции', ['Физика', 'Алгебра']);
    expect(changed).toBe(true);
    expect(newGroups).toBe(2);
    expect(courses).toBe(2);
    expect(группы(settings).map((г) => г.query)).toEqual(['path:"Лекции/Алгебра/"', 'path:"Лекции/Физика/"']);
    expect(new Set(группы(settings).map((г) => г.color.rgb)).size).toBe(2);
    expect(settings.search).toBe('-file:"— расшифровка" -file:"— transcript"');
    expect(settings).toMatchObject({ hideUnresolved: true, showOrphans: false, ...GRAPH_FORCES });
  });

  it('неизвестные ключи, свои цвета человека и его фильтр остаются', () => {
    const было = {
      'неизвестный-ключ': 42,
      scale: 0.35,
      search: 'path:Лекции -tag:#черновик',
      colorGroups: [{ query: 'tag:#важное', color: { a: 1, rgb: 0xe6194b } }],
    };
    const { settings } = mergeGraphSettings(было, 'Лекции', ['Физика']);
    expect(settings['неизвестный-ключ']).toBe(42);
    expect(settings.scale).toBe(0.35);
    expect(settings.search).toBe('path:Лекции -tag:#черновик -file:"— расшифровка" -file:"— transcript"');
    expect(группы(settings)[0]).toEqual({ query: 'tag:#важное', color: { a: 1, rgb: 0xe6194b } });
    // Цвет человека занят: курс получает другой.
    expect(группы(settings)[1]?.color.rgb).not.toBe(0xe6194b);
  });

  it('повторное нажатие ничего не меняет, а курс хранит свой цвет, и выбранный человеком тоже', () => {
    const первое = mergeGraphSettings(null, 'Лекции', ['Физика', 'Алгебра']);
    expect(mergeGraphSettings(первое.settings, 'Лекции', ['Физика', 'Алгебра'])).toMatchObject({ changed: false, newGroups: 0 });

    // Человек перекрасил физику, а потом появился курс, который по алфавиту раньше всех.
    const перекрашено = { ...первое.settings, colorGroups: группы(первое.settings).map((г) => (г.query.includes('Физика') ? { ...г, color: { a: 1, rgb: 123 } } : г)) };
    const потом = mergeGraphSettings(перекрашено, 'Лекции', ['Астрономия', 'Физика', 'Алгебра']);
    expect(потом.newGroups).toBe(1);
    const цвет = (курс: string): number | undefined => группы(потом.settings).find((г) => г.query.includes(курс))?.color.rgb;
    expect(цвет('Физика')).toBe(123);
    expect(цвет('Алгебра')).toBe(группы(первое.settings)[0]?.color.rgb);
    expect(new Set(группы(потом.settings).map((г) => г.color.rgb)).size).toBe(3);
  });

  it('наша прежняя запись без косой черты чинится, и цвет остаётся: «История» не красит «Историю человечества»', () => {
    const было = { colorGroups: [{ query: 'path:"Лекции/История"', color: { a: 1, rgb: 5 } }, { query: 'path:Лекции/Свой', color: { a: 1, rgb: 6 } }] };
    const { settings, newGroups, changed } = mergeGraphSettings(было, 'Лекции', ['История', 'История человечества', 'Свой']);
    expect(changed).toBe(true);
    expect(newGroups).toBe(1);
    expect(группы(settings)[0]).toEqual({ query: 'path:"Лекции/История/"', color: { a: 1, rgb: 5 } });
    // Запись человека, хоть и про тот же курс, остаётся какой была.
    expect(группы(settings)[1]?.query).toBe('path:Лекции/Свой');
    expect(группы(settings)[2]?.query).toBe('path:"Лекции/История человечества/"');
  });

  it('запрос того же курса в другой записи — та же группа, второй не заводится', () => {
    const было = { colorGroups: [{ query: 'path:Лекции/Физика/', color: { a: 1, rgb: 5 } }] };
    const { settings, newGroups } = mergeGraphSettings(было, 'Лекции', ['Физика']);
    expect(newGroups).toBe(0);
    expect(группы(settings)).toHaveLength(1);
  });

  it('палитра кончилась — цвета всё равно разные; лекции в корне хранилища — путь без папки', () => {
    const курсы = Array.from({ length: 30 }, (_, i) => `Курс ${String(i).padStart(2, '0')}`);
    const { settings } = mergeGraphSettings(null, '', курсы);
    expect(new Set(группы(settings).map((г) => г.color.rgb)).size).toBe(30);
    expect(группы(settings)[0]?.query).toBe('path:"Курс 00/"');
  });
});
