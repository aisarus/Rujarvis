import { describe, expect, it } from 'vitest';

import type { UiElement } from '../control/elements';

import { CuaDriver } from './cua';
import { DarwinWindowTools, matchingElements } from './darwinWindows';
import { createWindowTools } from './windowTools';

function элемент(name: string, type = 'Button', extra: Partial<UiElement> = {}): UiElement {
  return { name, id: '', type, enabled: true, x: 10, y: 20, width: 40, height: 20, ...extra };
}

/**
 * Номер элемента — его место в дереве окна.
 *
 * По этому же номеру потом нажимают (`window_press`), поэтому считать его по
 * находкам нельзя: вторая находка из десяти элементов — это [7], а не [2].
 */
describe('поиск в окне', () => {
  const дерево: UiElement[] = [
    элемент('Файл', 'MenuItem'),
    элемент('Правка', 'MenuItem'),
    элемент('Run in terminal'),
    элемент('Terminal'),
    элемент('Отмена'),
  ];

  it('номер считается по всему дереву, а не по находкам', () => {
    const найдено = matchingElements(дерево, 'terminal');
    expect(найдено.map((e) => e.index)).toEqual([4, 3]);
  });

  it('точное совпадение идёт первым', () => {
    // В окне рядом живут «Terminal» и «Run in terminal»: по запросу
    // «Terminal» нужна первая, иначе модель нажмёт не туда.
    expect(matchingElements(дерево, 'Terminal')[0]?.name).toBe('Terminal');
  });

  it('регистр не важен, ищется по вхождению', () => {
    expect(matchingElements(дерево, 'ПРАВ')[0]?.name).toBe('Правка');
  });

  it('пустой запрос ничего не находит', () => {
    expect(matchingElements(дерево, '   ')).toEqual([]);
  });

  it('роль отдаётся именами Windows: наверху разбора один', () => {
    expect(matchingElements(дерево, 'Файл')[0]?.role).toBe('MenuItem');
  });

  /**
   * Дословно не нашлось — ищем по смыслу.
   *
   * Интерфейс на маке бывает английским, а просят по-русски. Словарь
   * синонимов уже есть у голосовых команд (`chooseElement`), и заводить
   * второй такой же было бы двумя правдами об одном.
   */
  it('находит английскую кнопку по русскому слову', () => {
    const окно: UiElement[] = [элемент('Cancel'), элемент('Close'), элемент('Save')];
    const найдено = matchingElements(окно, 'закрыть');
    expect(найдено).toHaveLength(1);
    expect(найдено[0]).toMatchObject({ index: 2, name: 'Close' });
  });

  it('чего в окне нет — того нет', () => {
    expect(matchingElements(дерево, 'кнопкикоторойнет')).toEqual([]);
  });

  it('элемент без имени опознаётся по идентификатору', () => {
    const окно: UiElement[] = [элемент('', 'Button', { id: 'AXCloseButton' })];
    expect(matchingElements(окно, 'AXClose')[0]).toMatchObject({ index: 1, name: 'AXCloseButton' });
  });
});

describe('выбор глаз и рук по платформе', () => {
  function наПлатформе<T>(платформа: string, что: () => T): T {
    const была = process.platform;
    Object.defineProperty(process, 'platform', { value: платформа, configurable: true });
    try {
      return что();
    } finally {
      Object.defineProperty(process, 'platform', { value: была, configurable: true });
    }
  }

  it('на маке — свои, без cua-driver', () => {
    // Раньше здесь всегда был cua-driver, и на маке компьютер-юз отвечал
    // «Драйвер компьютер-юза не найден» — поймано приёмкой на macos-latest.
    const инструменты = наПлатформе('darwin', createWindowTools);
    expect(инструменты).toBeInstanceOf(DarwinWindowTools);
    инструменты.dispose();
  });

  it('на Windows — cua-driver', () => {
    const инструменты = наПлатформе('win32', createWindowTools);
    expect(инструменты).toBeInstanceOf(CuaDriver);
    инструменты.dispose();
  });
});
