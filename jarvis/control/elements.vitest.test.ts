import { describe, expect, it } from 'vitest';

import { chooseElement, type UiElement } from './elements';

/** Реальные элементы, снятые с этой машины. */
function element(overrides: Partial<UiElement>): UiElement {
  return {
    name: '',
    id: '',
    type: 'Button',
    enabled: true,
    x: 100,
    y: 100,
    width: 60,
    height: 30,
    ...overrides,
  };
}

const WINDOW = [
  element({ name: 'Interpreter', type: 'Pane', width: 1773, height: 1001 }),
  element({ name: 'Свернуть', x: 1708, y: 71 }),
  element({ name: 'Развернуть', x: 1764, y: 71 }),
  element({ name: 'Закрыть', x: 1822, y: 71 }),
  element({ name: 'Open explorer', x: 110, y: 70 }),
  element({ name: 'File', x: 151, y: 70 }),
  element({ name: 'Edit', x: 199, y: 70 }),
  element({ name: 'View', x: 252, y: 70 }),
  element({ name: 'Help', x: 307, y: 70 }),
];

describe('chooseElement', () => {
  it('находит по точному названию', () => {
    expect(chooseElement('закрыть', WINDOW)?.name).toBe('Закрыть');
  });

  it('не зависит от регистра и окончания', () => {
    expect(chooseElement('Свернуть', WINDOW)?.name).toBe('Свернуть');
  });

  it('не путает «свернуть» с «развернуть»', () => {
    // Одно содержит другое целиком: точное совпадение обязано побеждать.
    expect(chooseElement('свернуть', WINDOW)?.name).toBe('Свернуть');
    expect(chooseElement('развернуть', WINDOW)?.name).toBe('Развернуть');
  });

  it('находит английскую кнопку по русскому слову', () => {
    // Интерфейс бывает на любом языке, а человек говорит по-русски.
    expect(chooseElement('правка', WINDOW)?.name).toBe('Edit');
    expect(chooseElement('вид', WINDOW)?.name).toBe('View');
    expect(chooseElement('справка', WINDOW)?.name).toBe('Help');
  });

  it('находит по части названия', () => {
    expect(chooseElement('explorer', WINDOW)?.name).toBe('Open explorer');
  });

  it('предпочитает кнопку огромной панели', () => {
    const elements = [
      element({ name: 'Сохранить документ', type: 'Pane', width: 1900, height: 1000 }),
      element({ name: 'Сохранить', type: 'Button', width: 80, height: 30, x: 500, y: 400 }),
    ];
    expect(chooseElement('сохранить', elements)?.type).toBe('Button');
  });

  it('пропускает выключенные — по ним нечего кликать', () => {
    const elements = [
      element({ name: 'Сохранить', enabled: false }),
      element({ name: 'Сохранить как', enabled: true, x: 300 }),
    ];
    expect(chooseElement('сохранить', elements)?.x).toBe(300);
  });

  it('находит по английскому AutomationId, когда название на иврите', () => {
    // Ровно случай этой машины: Name на иврите, AutomationId английский.
    const elements = [
      element({ name: 'סגור כרטיסיה', id: 'CloseButton', x: 1120 }),
      element({ name: 'הוסף כרטיסיה חדשה', id: 'AddButton', x: 1065 }),
    ];
    expect(chooseElement('close', elements)?.id).toBe('CloseButton');
    expect(chooseElement('add', elements)?.id).toBe('AddButton');
  });

  it('понимает русское слово через английский AutomationId', () => {
    const elements = [element({ name: 'סגור כרטיסיה', id: 'CloseButton', x: 1120 })];
    expect(chooseElement('закрыть', elements)?.id).toBe('CloseButton');
  });

  it('молчит, когда похожего нет', () => {
    // Выдуманный элемент хуже отказа: клик уйдёт не туда, и это заметят не сразу.
    expect(chooseElement('телепортация', WINDOW)).toBe(null);
  });

  it('молчит на пустом запросе и пустом окне', () => {
    expect(chooseElement('', WINDOW)).toBe(null);
    expect(chooseElement('закрыть', [])).toBe(null);
  });

  it('не считает совпадением одну случайную букву', () => {
    expect(chooseElement('я', WINDOW)).toBe(null);
  });
});

describe('составные запросы', () => {
  const tabs = [
    element({ name: 'סגור כרטיסיה', id: 'CloseButton', x: 1120 }),
    element({ name: 'הוסף כרטיסיה חדשה', id: 'AddButton', x: 1065 }),
  ];

  it('находит по значимому слову внутри фразы', () => {
    // Целиком «закрыть вкладку» не написано нигде, а «закрыть» — это close.
    expect(chooseElement('закрыть вкладку', tabs)?.id).toBe('CloseButton');
    expect(chooseElement('добавить вкладку', tabs)?.id).toBe('AddButton');
  });

  it('точное совпадение всё равно сильнее совпадения по слову', () => {
    const elements = [
      element({ name: 'Сохранить как', x: 100 }),
      element({ name: 'Сохранить', x: 200 }),
    ];
    expect(chooseElement('сохранить', elements)?.x).toBe(200);
  });
});
