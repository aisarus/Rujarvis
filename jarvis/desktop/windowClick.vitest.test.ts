import { describe, expect, it } from 'vitest';

import type { CuaElement, CuaWindow } from './cuaProtocol';
import { pickElement, pickWindow } from './windowClick';

const окна: CuaWindow[] = [
  { app: 'msedge', pid: 10, title: 'GitHub — Microsoft Edge', windowId: 1 },
  { app: 'VoiceRecorder', pid: 20, title: 'רשמקול', windowId: 2 },
  { app: 'blender', pid: 30, title: '(Unsaved) - Blender 5.2.1 LTS', windowId: 3 },
];

const элемент = (index: number, name: string, role = 'button'): CuaElement => ({ index, role, name }) as CuaElement;

describe('нажать в окне по надписи', () => {
  it('окно — по заголовку, по программе или по части; точное раньше вхождения', () => {
    expect(pickWindow(окна, 'רשמקול')).toEqual({ окно: окна[1] });
    expect(pickWindow(окна, 'VoiceRecorder')).toEqual({ окно: окна[1] });
    expect(pickWindow(окна, 'блендер')).toEqual({ нет: true });
    expect(pickWindow(окна, 'Blender')).toEqual({ окно: окна[2] });
    expect(pickWindow(окна, 'edge')).toEqual({ окно: окна[0] });
    expect(pickWindow(окна, '   ')).toEqual({ нет: true });
  });

  it('точная надпись — нажать; единственная — нажать; несколько без точной — спросить', () => {
    const запись = элемент(4, 'התחל הקלטה');
    expect(pickElement([элемент(3, 'התחל הקלטה חדשה'), запись], 'התחל הקלטה')).toEqual({ нажать: запись });
    expect(pickElement([элемент(7, 'Сохранить как')], 'сохранить')).toEqual({ нажать: элемент(7, 'Сохранить как') });
    const два = [элемент(1, 'Сохранить как'), элемент(2, 'Сохранить всё')];
    expect(pickElement(два, 'сохранить')).toEqual({ выбрать: два });
    expect(pickElement([], 'что угодно')).toEqual({ нет: true });
  });
});
