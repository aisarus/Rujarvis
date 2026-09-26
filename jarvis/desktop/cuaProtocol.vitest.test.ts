import { describe, expect, it } from 'vitest';

// Перевод строки отдельной постоянной: обратный слеш в исходнике этого файла
// не переживает переписывания скриптом, и склейка строк молча ломалась.
const NEWLINE = String.fromCharCode(10);

import {
  countedElements,
  findElement,
  listedWindows,
  matchingElements,
  namedElements,
  tooBigToRead,
  matchingAmong,
  snapshotFromStructured,
} from './cuaProtocol';

describe('разбор списка окон', () => {
  const answer = [
    '✅ Found 3 window(s) across 3 app(s); 3 on-screen.',
    '- claude.exe (pid 15184) "Claude" [window_id: 132238]',
    '- cua-driver.exe (pid 13736) "Cua.AgentCursorOverlay.default" [window_id: 132538]',
    '- explorer.exe (pid 9392) "Program Manager" [window_id: 65980]',
  ].join('\n');

  it('вынимает программу, pid, заголовок и номер окна', () => {
    expect(listedWindows(answer)[0]).toEqual({
      app: 'claude.exe',
      pid: 15184,
      title: 'Claude',
      windowId: 132238,
    });
  });

  it('прячет собственное наложение курсора и рабочий стол', () => {
    const titles = listedWindows(answer).map((w) => w.title);
    expect(titles).toEqual(['Claude']);
  });

  it('не падает на ответе без единого окна', () => {
    expect(listedWindows('✅ Found 0 window(s).')).toEqual([]);
  });
});

describe('счётчик элементов', () => {
  it('читает число из заголовка ответа', () => {
    expect(countedElements('window_id=1 pid=2 elements=283\n\n- Window "X"')).toBe(283);
  });

  it('возвращает null, когда счётчика нет', () => {
    expect(countedElements('Nothing to return')).toBeNull();
  });

  // Ровно этот случай однажды притворился дешёвым режимом: окно было не
  // отрисовано, дерево схлопнулось до горстки элементов, а ответ выглядел
  // как настоящий.
  it('отличает схлопнувшееся дерево от живого', () => {
    expect(countedElements('window_id=1 pid=2 elements=3')).toBe(3);
  });
});

describe('поиск элемента по имени', () => {
  const tree = [
    'window_id=132238 pid=15184 elements=283',
    '',
    '- Window "Claude"',
    '  - Pane "Claude"',
    '    - [20] Button "Terminal" [id=_r_f0_ actions=[toggle]]',
    '    - [21] Button "Changes" [id=_r_f6_ actions=[toggle]]',
    '    - Button "Forward"',
    '    - [170] Button "Run in terminal" [id=_r_fu_ actions=[invoke]]',
  ].join('\n');

  it('отдаёт номер, по которому можно нажать', () => {
    expect(findElement(tree, 'Terminal')).toEqual({
      index: 20,
      role: 'Button',
      name: 'Terminal',
    });
  });

  it('предпочитает точное совпадение имени вхождению', () => {
    // «Run in terminal» тоже содержит слово, но кнопка «Terminal» — точная.
    expect(findElement(tree, 'Terminal')?.index).toBe(20);
  });

  it('находит по вхождению, когда точного имени нет', () => {
    expect(findElement(tree, 'Run in')?.index).toBe(170);
  });

  it('не обращает внимания на регистр', () => {
    expect(findElement(tree, 'terminal')?.index).toBe(20);
  });

  // Элемент без номера нажать нечем, и предлагать его — обман.
  it('пропускает элементы без номера', () => {
    expect(findElement(tree, 'Forward')).toBeNull();
  });

  it('возвращает null, когда такого имени нет', () => {
    expect(findElement(tree, 'Настройки')).toBeNull();
  });

  it('перечисляет всё именованное с номерами', () => {
    expect(namedElements(tree).map((e) => e.name)).toEqual([
      'Terminal',
      'Changes',
      'Run in terminal',
    ]);
  });
});

describe('сторож размера', () => {
  // Замер: полное дерево окна Электрона — 27 509 знаков, около 6 900 токенов,
  // вдесятеро дороже снимка того же окна. Пускать такое в разговор нельзя.
  it('заворачивает ответ размером с полное дерево', () => {
    expect(tooBigToRead('x'.repeat(27_509))).toBe(true);
  });

  it('пропускает ответ размером с находку по имени', () => {
    expect(tooBigToRead('x'.repeat(1_643))).toBe(false);
  });

  it('пропускает ответ ровно на границе', () => {
    expect(tooBigToRead('x'.repeat(6_000))).toBe(false);
    expect(tooBigToRead('x'.repeat(6_001))).toBe(true);
  });
});

describe('только настоящие находки', () => {
  // Драйвер отдаёт найденное вместе с предками по дереву — чтобы было видно,
  // где элемент живёт. Предок не находка: живой прогон вернул шесть «находок»
  // на запрос, которого в окне не было, и все шесть были предками.
  const withAncestors = [
    'window_id=1 pid=2 elements=283',
    '',
    '- Window "Claude"',
    '  - Pane "Claude"',
    '    - [2] Button "Закрыть" [actions=[invoke]]',
    '    - [97] Group "Primary pane" [actions=[invoke]]',
    '      - [20] Button "Terminal" [id=_r_f0_ actions=[toggle]]',
    '      - [170] Button "Run in terminal" [id=_r_fu_ actions=[invoke]]',
  ].join(NEWLINE);

  it('отбрасывает предков, оставляя совпавшие по имени', () => {
    expect(matchingElements(withAncestors, 'Terminal').map((e) => e.index)).toEqual([20, 170]);
  });

  it('ставит точное совпадение первым', () => {
    expect(matchingElements(withAncestors, 'Terminal')[0]?.index).toBe(20);
  });

  it('на отсутствующее имя не возвращает ничего', () => {
    expect(matchingElements(withAncestors, 'Настройки')).toEqual([]);
  });

  it('не обращает внимания на регистр', () => {
    expect(matchingElements(withAncestors, 'ЗАКРЫТЬ').map((e) => e.index)).toEqual([2]);
  });
});

describe('snapshotFromStructured', () => {
  // Форма снята с живого драйвера 26.09.2026, а не придумана: до этого замера
  // press и type_text получали голый номер и отвечали «bare element_index is
  // not accepted», то есть ввод в браузере не работал вовсе.
  const живойОтвет = {
    snapshot_id: 's00000001',
    element_count: 197,
    elements: [
      {
        actions: ['invoke'],
        depth: 5,
        element_index: 2,
        element_token: 's00000001:2',
        enabled: true,
        frame: { h: 49, w: 58, x: 1489, y: 24 },
        label: 'Закрыть',
        role: 'Button',
      },
      {
        element_index: 7,
        element_token: 's00000001:7',
        label: 'Адресная строка и панель поиска',
        role: 'Edit',
      },
    ],
  };

  it('несёт знак снимка и знак каждого элемента', () => {
    const снимок = snapshotFromStructured(живойОтвет);

    expect(снимок.snapshotId).toBe('s00000001');
    expect(снимок.elements.map((э) => э.token)).toEqual(['s00000001:2', 's00000001:7']);
    expect(снимок.elements.map((э) => э.index)).toEqual([2, 7]);
    expect(снимок.elements[1]?.name).toBe('Адресная строка и панель поиска');
  });

  it('пропускает элементы без номера и без имени', () => {
    // Безымянный элемент нечем назвать человеку, а без номера его нечем нажать:
    // показать такой значит обещать действие, которого нет.
    const снимок = snapshotFromStructured({
      snapshot_id: 's1',
      elements: [
        { element_index: 1, label: '', role: 'Pane' },
        { label: 'Без номера', role: 'Button' },
        { element_index: 3, label: 'Годный', role: 'Button', element_token: 's1:3' },
      ],
    });

    expect(снимок.elements.map((э) => э.name)).toEqual(['Годный']);
  });

  it('не падает на чужом и пустом ответе', () => {
    // Драйвер старее нашего структурной части может и не прислать — тогда
    // остаётся разбор разметки, а не исключение посреди нажатия.
    for (const чужое of [undefined, null, {}, { elements: 'не массив' }, 42]) {
      const снимок = snapshotFromStructured(чужое);
      expect(снимок.elements).toEqual([]);
      expect(снимок.snapshotId).toBeNull();
    }
  });

  it('отбор совпавших один и тот же для разметки и для структуры', () => {
    // Два источника элементов — одно правило. Со своим отбором у каждого
    // «найди адресную строку» отвечало бы по-разному в зависимости от того,
    // какой источник ответил, и объяснить это было бы нечем.
    const снимок = snapshotFromStructured(живойОтвет);
    const через = matchingAmong(снимок.elements, 'Адресная строка');

    expect(через.map((э) => э.index)).toEqual([7]);
    expect(через[0]?.token).toBe('s00000001:7');
  });
});

