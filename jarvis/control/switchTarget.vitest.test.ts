import { describe, expect, it } from 'vitest';

import type { UiElement } from './elements';
import { describeScreen, planSwitch } from './switchTarget';

const эл = (type: string, name: string, enabled = true): UiElement => ({ name, id: '', type, enabled, x: 1, y: 1, width: 1, height: 1 });

describe('planSwitch', () => {
  const окна = [{ title: 'Claude', focused: true }, { title: 'Discord' }, { title: 'Jarvis' }, { title: 'Program Manager' }];

  it('раздел внутри активного окна — первым', () => {
    const план = planSwitch('код', окна, [эл('RadioButton', 'Code'), эл('RadioButton', 'Chat and Cowork')]);
    expect(план).toMatchObject({ kind: 'element', element: { name: 'Code' } });
  });

  it('окно — когда внутри нет похожего', () => {
    expect(planSwitch('дискорд', окна, [эл('RadioButton', 'Code')])).toEqual({ kind: 'window', title: 'Discord' });
  });

  it('на маке находит окно по программе: в заголовке Chrome только страница', () => {
    // Живой журнал тестера 30.09.2026: «переключись на хром» не находило Chrome.
    const мак = [{ title: 'Новая вкладка', app: 'Google Chrome' }, { title: '', app: 'Keynote' }, { title: '', app: 'Electron' }];
    // Ищется дальше по программе: маковский `focus` понимает и её.
    expect(planSwitch('хром', мак, [])).toEqual({ kind: 'window', title: 'Google Chrome' });
    // Два окна одной программы — не соперники: переход всё равно уверенный.
    expect(planSwitch('хром', [...мак, { title: 'GitHub', app: 'Google Chrome' }], [])).toEqual({ kind: 'window', title: 'Google Chrome' });
    // Окно без заголовка ищется по программе, а не пустой строкой.
    expect(planSwitch('кейнот', мак, [])).toEqual({ kind: 'window', title: 'Keynote' });
    // Своё окно Джарвиса на маке — «Electron» без заголовка.
    expect(describeScreen('', мак, [])).toBe('Окна: Новая вкладка Google Chrome; Keynote\nАктивное окно: неизвестно');
  });

  it('свои окна Джарвиса не выбирает', () => {
    expect(planSwitch('джарвис', окна, [])).toBeNull();
  });

  it('выключенные элементы не считает', () => {
    expect(planSwitch('код', [], [эл('RadioButton', 'Code', false)])).toBeNull();
  });
});

describe('describeScreen', () => {
  it('окна, активное окно и что в нём нажать — по видам, без повторов', () => {
    const текст = describeScreen('Claude', [{ title: 'Claude', focused: true }, { title: 'Discord', minimized: true }, { title: 'Jarvis' }], [
      эл('RadioButton', 'Code'),
      эл('Button', 'New'),
      эл('Button', 'New'),
      эл('Pane', 'Рамка'),
      эл('Button', 'Скрытая', false),
    ]);
    expect(текст).toBe(['Окна: Claude (активно); Discord (свёрнуто)', 'Активное окно: Claude', 'RadioButton: Code', 'Button: New'].join('\n'));
  });

  it('длинный список обрезает и говорит, сколько осталось', () => {
    const кнопки = Array.from({ length: 5 }, (_, i) => эл('Button', `Кнопка ${i}`));
    expect(describeScreen('X', [], кнопки, 3)).toContain('| …ещё 2');
  });
});
