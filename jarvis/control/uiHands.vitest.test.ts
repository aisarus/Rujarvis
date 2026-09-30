import { describe, expect, it } from 'vitest';

import type { DesktopControl, DesktopWindow } from '../desktop/driver';
import type { UiElement } from './elements';
import { claudeSessions, UiHands, UiRefusal } from './uiHands';

const эл = (type: string, name: string, x = 10, y = 20): UiElement => ({ name, id: '', type, enabled: true, x, y, width: 40, height: 20 });
const окно = (title: string, focused = false): DesktopWindow => ({ title, x: 0, y: 0, width: 800, height: 600, pid: 1, focused } as DesktopWindow);

/** Рабочий стол на бумаге: пишет, что с ним делали, и ничего не жмёт по-настоящему. */
function стол(windows: DesktopWindow[], elements: UiElement[], title = 'Claude') {
  const сделано: string[] = [];
  const desktop = {
    windows: async () => windows,
    elements: async () => ({ title, elements }),
    focus: async (t: string) => {
      const w = windows.find((x) => x.title.toLowerCase().includes(t.toLowerCase()));
      if (!w) throw new Error(`нет окна ${t}`);
      сделано.push(`focus ${w.title}`);
      return { title: w.title };
    },
    click: async (o: { x?: number; y?: number }) => {
      const e = elements.find((x) => x.x === o.x && x.y === o.y);
      сделано.push(`click ${e?.name ?? `${o.x},${o.y}`}`);
    },
    key: async (k: string) => {
      сделано.push(`key ${k}`);
    },
    type: async (t: string) => {
      сделано.push(`type ${t}`);
    },
  } as unknown as DesktopControl;
  const руки = new UiHands({ desktop, wait: async () => {}, windowNames: (n) => (n === 'хром' ? ['Chrome'] : []) });
  return { руки, сделано };
}

/** Боковая панель и переключатели приложения Claude, как их видит UIA (замер 30.09.2026). */
const CLAUDE = [
  эл('RadioButton', 'Chat and Cowork, awaiting your input', 100, 10),
  эл('RadioButton', 'Code', 200, 10),
  эл('Button', 'New', 20, 50),
  эл('Button', 'New session in jarvis-code', 20, 60),
  эл('Button', 'New session in merchant', 20, 70),
  эл('Button', 'Idle Голосовой слой и руки', 20, 80),
  эл('Button', 'Awaiting input Починить сборку', 20, 90),
  эл('Button', 'Unread response Учёба по конспектам', 20, 100),
  эл('Edit', 'Prompt', 400, 500),
  эл('Button', 'Отправить', 450, 500),
  эл('Button', 'Удалить сессию', 20, 110),
];

describe('UiHands', () => {
  it('переключается на раздел внутри окна раньше, чем на окно', async () => {
    const { руки, сделано } = стол([окно('Claude', true), окно('main.ts - Visual Studio Code')], CLAUDE);
    expect(await руки.switchTo('код')).toContain('Code');
    expect(сделано).toEqual(['click Code']);
  });

  it('переключается на окно по звучанию и по запасному имени', async () => {
    const { руки, сделано } = стол([окно('Claude'), окно('Google Chrome'), окно('Discord')], [], 'Explorer');
    expect(await руки.switchTo('клауд')).toContain('Claude');
    expect(await руки.switchTo('хром')).toContain('Chrome');
    expect(сделано).toEqual(['focus Claude', 'focus Google Chrome']);
  });

  it('не нашлось — null, без броска: фразу забирает разговор', async () => {
    const { руки, сделано } = стол([окно('Claude')], CLAUDE);
    expect(await руки.switchTo('телеграм')).toBeNull();
    expect(сделано).toEqual([]);
  });

  it('модель не жмёт отправку и удаление, человек — может', async () => {
    const { руки, сделано } = стол([окно('Claude', true)], CLAUDE);
    await expect(руки.press('отправить', 'model')).rejects.toBeInstanceOf(UiRefusal);
    await expect(руки.press('удалить сессию', 'model')).rejects.toBeInstanceOf(UiRefusal);
    expect(сделано).toEqual([]);
    await руки.press('отправить', 'person');
    expect(сделано).toEqual(['click Отправить']);
  });

  it('модель не жмёт Enter и Shift+Delete, остальные клавиши — да', async () => {
    const { руки, сделано } = стол([], []);
    await expect(руки.keys('Enter', 'model')).rejects.toBeInstanceOf(UiRefusal);
    await expect(руки.keys('ctrl+enter', 'model')).rejects.toBeInstanceOf(UiRefusal);
    await expect(руки.keys('shift+delete', 'model')).rejects.toBeInstanceOf(UiRefusal);
    await руки.keys('ctrl + t', 'model');
    await руки.keys('enter', 'person');
    expect(сделано).toEqual(['key ctrl+t', 'key enter']);
  });

  it('меню по пути: каждый шаг — нажатие', async () => {
    const { руки, сделано } = стол([], [эл('MenuItem', 'Файл', 1, 1), эл('MenuItem', 'Экспорт', 2, 2), эл('Button', 'Файлы', 3, 3)], 'Blender');
    expect(await руки.menu(['файл', 'экспорт'], 'model')).toBe('открыл Файл → Экспорт');
    expect(сделано).toEqual(['click Файл', 'click Экспорт']);
  });

  it('пишет Claude: поле Prompt, текст, Enter — хоть модель, хоть человек', async () => {
    const { руки, сделано } = стол([окно('Claude', true)], CLAUDE);
    const итог = await руки.claudeSend('почини сборку');
    expect(сделано).toEqual(['click Prompt', 'type почини сборку', 'key enter']);
    // Продиктованное в журнал не идёт — в ответе только длина.
    expect(итог).not.toContain('почини');
  });

  it('Claude на заднем плане — сначала вперёд', async () => {
    const { руки, сделано } = стол([окно('Explorer', true), окно('Claude')], CLAUDE);
    await руки.claudeMode('chat');
    expect(сделано).toEqual(['focus Claude', 'click Chat and Cowork, awaiting your input']);
  });

  it('говорит, кто ждёт, и открывает сессию на слух', async () => {
    const { руки, сделано } = стол([окно('Claude', true)], CLAUDE);
    const ждут = await руки.claudeWaiting();
    expect(ждут).toContain('Починить сборку');
    expect(ждут).toContain('Учёба по конспектам');
    expect(ждут).not.toContain('Голосовой слой');
    await руки.claudeOpenSession('починить сборку');
    await руки.claudeNewSession('мерчант');
    await руки.claudeNewSession();
    expect(сделано).toEqual(['click Awaiting input Починить сборку', 'click New session in merchant', 'click New']);
  });

  it('сессию находит и по одному слову из названия', async () => {
    // Живой прогон разговора 30.09.2026: «открой в клоде сессию про сборку» —
    // модель передала одно слово «сборку».
    const { руки, сделано } = стол([окно('Claude', true)], CLAUDE);
    await руки.claudeOpenSession('сборку');
    expect(сделано).toEqual(['click Awaiting input Починить сборку']);
  });

  it('прервать нечего — так и говорит, а не жмёт наугад', async () => {
    const { руки, сделано } = стол([окно('Claude', true)], CLAUDE);
    await expect(руки.claudeInterrupt()).rejects.toThrow(/прерывать нечего/u);
    expect(сделано).toEqual([]);
  });

  it('без приложения Claude — честная ошибка', async () => {
    const { руки } = стол([окно('Explorer', true)], []);
    await expect(руки.claudeSend('привет')).rejects.toThrow(/не открыто/u);
  });
});

describe('claudeSessions', () => {
  it('читает состояние из названия кнопки', () => {
    expect(claudeSessions(CLAUDE).map((s) => [s.title, s.state])).toEqual([
      ['Голосовой слой и руки', 'свободна'],
      ['Починить сборку', 'ждёт ответа'],
      ['Учёба по конспектам', 'новый ответ'],
    ]);
  });
});
