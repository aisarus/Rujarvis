import { describe, expect, it } from 'vitest';

import { UI_STRINGS } from './strings';

/**
 * Строка, добавленная в один язык и забытая в другом.
 *
 * Типизация тут не спасает: `en` выводится из своего же литерала, а `ru`
 * приведён к общему типу. Пункт меню, дописанный только по-русски, соберётся
 * и молча покажет англичанину пустоту. Ловится это только сверкой ключей.
 */
describe('строки интерфейса', () => {
  it('одинаковые ключи в обоих языках', () => {
    expect(Object.keys(UI_STRINGS.en).sort()).toEqual(Object.keys(UI_STRINGS.ru).sort());
  });

  it('ни одна строка не пустая', () => {
    const пустые: string[] = [];
    for (const [language, table] of Object.entries(UI_STRINGS)) {
      for (const [key, value] of Object.entries(table)) {
        if (typeof value === 'string' && value.trim().length === 0) пустые.push(`${language}.${key}`);
      }
    }
    expect(пустые).toEqual([]);
  });
});
