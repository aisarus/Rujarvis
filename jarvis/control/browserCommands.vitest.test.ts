import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UiElement } from './elements';
import type { DesktopControl } from '../desktop/driver';
import {
  открытьСсылку,
  ЖДАТЬ_ДЕРЕВО_МС,
  номерСсылки,
  окноБраузера,
  разобратьСсылку,
  ссылкиСтраницы,
  этоКлавишаВкладки,
  этоОкноБраузера,
  адресСайта,
  известныйСайт,
  выбратьВкладку,
  перейтиНаВкладку,
} from './browserCommands';
import { parseDirectCommand } from './commands';

const окно = (title: string, focused = false, minimized = false, app?: string) => ({
  title,
  focused,
  minimized,
  x: 0,
  y: 0,
  width: 1200,
  height: 900,
  pid: 1,
  ...(app ? { app } : {}),
});

describe('этоОкноБраузера', () => {
  it.each([
    // Edge пишет «Microsoft​ Edge» с пробелом нулевой ширины (U+200B).
    'Проба ссылок Джарвиса — Профиль 1: Microsoft​ Edge',
    'Новая вкладка и еще 4 страницы — Личный: Microsoft​ Edge',
    'YouTube - Google Chrome',
    'Mozilla Firefox',
  ])('«%s» — браузер', (заголовок) => {
    expect(этоОкноБраузера({ title: заголовок })).toBe(true);
  });

  it.each([
    // Замер 26.09.2026: первой в списке окон стояла полоска Edge про показ
    // экрана. Процесс тот же, но это не окно браузера, и Ctrl+W в неё не нужен.
    'www.veed.io предоставляет доступ к вашему экрану и звуковому сопровождению',
    'обычный.txt - Блокнот',
    'Claude',
  ])('«%s» — не браузер', (заголовок) => {
    expect(этоОкноБраузера({ title: заголовок })).toBe(false);
  });

  it('на маке узнаёт браузер по программе: у Safari в заголовке только страница', () => {
    expect(этоОкноБраузера({ title: 'Как выбрать велосипед', app: 'Safari' })).toBe(true);
    expect(этоОкноБраузера({ title: 'Документ', app: 'TextEdit' })).toBe(false);
  });
});

describe('окноБраузера', () => {
  it('берёт переднее, если оно браузерное', () => {
    const окна = [окно('Где-то — Google Chrome'), окно('Тут — Microsoft Edge', true)];
    expect(окноБраузера(окна)?.title).toBe('Тут — Microsoft Edge');
  });

  it('когда впереди не браузер — верхнее браузерное, а не переднее', () => {
    // Тот самый случай: впереди был Claude, Ctrl+W ушёл в него.
    const окна = [окно('Claude', true), окно('Страница — Microsoft Edge')];
    expect(окноБраузера(окна)?.title).toBe('Страница — Microsoft Edge');
  });

  it('свёрнутое — только если несвёрнутых нет', () => {
    const окна = [окно('Свёрнутое — Microsoft Edge', false, true), окно('Открытое — Google Chrome')];
    expect(окноБраузера(окна)?.title).toBe('Открытое — Google Chrome');
    expect(окноБраузера([окно('Свёрнутое — Microsoft Edge', false, true)])?.title).toBe('Свёрнутое — Microsoft Edge');
  });

  it('браузера нет — null, а не первое попавшееся окно', () => {
    expect(окноБраузера([окно('Claude', true), окно('Блокнот')])).toBeNull();
  });

  it('названный браузер — его окно, даже если сверху другой; не открыт — null', () => {
    // «Закрой вкладку Brave» при Edge сверху закрыла бы вкладку Edge.
    const окна = [окно('Почта — Microsoft Edge', true), окно('Inbar — Brave')];
    expect(окноБраузера(окна, 'brave')?.title).toBe('Inbar — Brave');
    expect(окноБраузера(окна, 'edge')?.title).toBe('Почта — Microsoft Edge');
    expect(окноБраузера(окна, 'firefox')).toBeNull();
    // На маке — по имени программы.
    expect(окноБраузера([{ ...окно('Inbar'), app: 'Brave Browser' }], 'brave')?.title).toBe('Inbar');
  });
});

const элемент = (type: string, name: string, x: number, y: number, width = 100, height = 20): UiElement => ({
  type,
  name,
  id: '',
  enabled: true,
  x,
  y,
  width,
  height,
});

/**
 * Дерево живого Edge, снятое 26.09.2026: пять ссылок страницы в порядке
 * документа и одна ссылка панели браузера сверху — «Управление избранным».
 */
const ДЕРЕВО_EDGE: UiElement[] = [
  элемент('Hyperlink', 'Управление избранным', 1034, 112),
  элемент('Document', 'Проба ссылок Джарвиса', 620, 585, 1240, 890),
  элемент('Hyperlink', 'Первая ссылка', 151, 326),
  элемент('Hyperlink', 'Вторая ссылка', 150, 348),
  элемент('Hyperlink', 'Третья ссылка', 149, 372),
  элемент('Hyperlink', 'Четвёртая ссылка', 164, 394),
  элемент('Hyperlink', 'Пятая ссылка', 146, 418),
];

describe('ссылкиСтраницы', () => {
  it('только ссылки страницы, по порядку, без кнопок браузера', () => {
    // Посчитай «Управление избранным» — и «открой первую ссылку» открыло бы
    // избранное вместо первой ссылки страницы.
    expect(ссылкиСтраницы(ДЕРЕВО_EDGE).map((с) => с.name)).toEqual([
      'Первая ссылка',
      'Вторая ссылка',
      'Третья ссылка',
      'Четвёртая ссылка',
      'Пятая ссылка',
    ]);
  });

  it('на маке область страницы зовётся WebArea — ссылки находятся так же', () => {
    const дерево = ДЕРЕВО_EDGE.map((э) => (э.type === 'Document' ? { ...э, type: 'WebArea' } : э));
    expect(ссылкиСтраницы(дерево)).toHaveLength(5);
  });

  it('нет области страницы — пусто, а не все ссылки подряд', () => {
    // Лучше честно сказать «не вижу страницы», чем нажать на кнопку браузера.
    expect(ссылкиСтраницы(ДЕРЕВО_EDGE.filter((э) => э.type !== 'Document'))).toEqual([]);
  });
});

describe('номерСсылки', () => {
  it.each([
    ['третью', 3],
    ['третьей', 3],
    ['пятую', 5],
    ['четвертую', 4],
    ['номер три', 3],
    ['три', 3],
    ['3', 3],
    ['последнюю', -1],
    ['third', 3],
    ['number 2', 2],
    ['last', -1],
  ] as const)('«%s» → %i', (слова, номер) => {
    expect(номерСсылки(слова)).toBe(номер);
  });

  it.each(['банан', '', '0', 'синюю'])('«%s» — не номер', (слова) => {
    // Не число — значит не команда про ссылку. Фраза идёт дальше, а не
    // превращается в нажатие наугад.
    expect(номерСсылки(слова)).toBeNull();
  });
});

describe('разобратьСсылку', () => {
  it.each([
    ['открой третью ссылку', 3],
    ['перейди по второй ссылке', 2],
    ['открой ссылку номер пять', 5],
    ['нажми на первую ссылку', 1],
    ['открой последнюю ссылку', -1],
    ['open the third link', 3],
    ['click link 2', 2],
    ['follow the last link', -1],
  ] as const)('«%s» → ссылка %i', (фраза, номер) => {
    expect(разобратьСсылку(фраза)).toEqual({ kind: 'openLink', index: номер });
  });

  it.each(['открой ссылку', 'открой хром', 'нажми на кнопку сохранить', 'открой синюю ссылку'])(
    '«%s» — не про ссылку по номеру',
    (фраза) => {
      expect(разобратьСсылку(фраза)).toBeNull();
    },
  );

  it('«нажми на третью ссылку» — это ссылка, а не поиск кнопки «третью ссылку»', () => {
    // Разбор ссылок стоит раньше «нажми на …». Иначе искалась бы на экране
    // кнопка с надписью «третью ссылку», и нажатие не находило бы ничего.
    expect(parseDirectCommand('нажми на третью ссылку')).toEqual({ kind: 'openLink', index: 3 });
  });
});

describe('этоКлавишаВкладки', () => {
  it('вкладочные сочетания идут в браузер', () => {
    for (const клавиши of ['ctrl+t', 'ctrl+w', 'ctrl+shift+t', 'ctrl+tab', 'ctrl+shift+tab']) {
      expect(этоКлавишаВкладки(клавиши)).toBe(true);
    }
  });

  it('остальное остаётся за передним окном: Ворд и блокнот тоже надо уметь', () => {
    for (const клавиши of ['ctrl+c', 'ctrl+v', 'enter', 'alt+f4', 'ctrl+s']) {
      expect(этоКлавишаВкладки(клавиши)).toBe(false);
    }
  });
});

describe('открытьСсылку на медленной машине', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ждёт, пока Chromium достроит дерево, а не сдаётся через три секунды', async () => {
    // В CI на Windows первая «открой третью ссылку» ответила «не вижу ни одной
    // ссылки», а следующие прошли: дерево строится по первому запросу, и
    // трёх секунд раннеру не хватило. Здесь драйвер отвечает по секунде на
    // запрос, а ссылки появляются только на четвёртом — со старым сроком это
    // падало.
    vi.useFakeTimers();
    let запросов = 0;
    const нажато: Array<{ x?: number; y?: number }> = [];
    const desktop = {
      windows: async () => [
        { title: 'Проба — Microsoft Edge', focused: true, minimized: false, x: 0, y: 0, width: 1200, height: 900, pid: 1 },
      ],
      focus: async (title: string) => ({ title }),
      elements: async () => {
        запросов++;
        await new Promise((r) => setTimeout(r, 1_000));
        return { title: 'Проба — Microsoft Edge', elements: запросов >= 4 ? ДЕРЕВО_EDGE : [] };
      },
      click: async (где: { x?: number; y?: number }) => {
        нажато.push(где);
      },
    } as unknown as DesktopControl;

    const итог = открытьСсылку(desktop, 3);
    await vi.advanceTimersByTimeAsync(ЖДАТЬ_ДЕРЕВО_МС + 2_000);
    const ссылка = await итог;

    expect(ссылка.name).toBe('Третья ссылка');
    expect(нажато).toEqual([{ x: 149, y: 372 }]);
  });

  it('если ссылок нет совсем — честный отказ со временем ожидания', async () => {
    vi.useFakeTimers();
    const desktop = {
      windows: async () => [
        { title: 'Пусто — Microsoft Edge', focused: true, minimized: false, x: 0, y: 0, width: 1200, height: 900, pid: 1 },
      ],
      focus: async (title: string) => ({ title }),
      elements: async () => ({ title: 'Пусто — Microsoft Edge', elements: [] }),
      click: async () => undefined,
    } as unknown as DesktopControl;

    const итог = открытьСсылку(desktop, 1).catch((беда: Error) => беда);
    await vi.advanceTimersByTimeAsync(ЖДАТЬ_ДЕРЕВО_МС + 2_000);
    const беда = await итог;

    expect(беда).toBeInstanceOf(Error);
    expect((беда as Error).message).toMatch(/не вижу ни одной ссылки \(ждал \d+ с\)/u);
  });
});

describe('вкладка по названию (живой журнал 28.09.2026)', () => {
  const вкладка = (name: string, x: number): UiElement => ({
    name, id: '', type: 'TabItem', enabled: true, x, y: 20, width: 200, height: 30,
  });
  const ПОЛОСА = [
    вкладка('Новая вкладка', 100),
    вкладка('Netflix Israel - Watch TV Shows Online', 300),
    вкладка('inbar - Поиск', 500),
    { name: 'inbar - Поиск', id: '', type: 'Document', enabled: true, x: 600, y: 500, width: 1200, height: 800 },
  ];

  it('сказанное кириллицей и с ошибкой находит вкладку латиницей', () => {
    expect(выбратьВкладку('инбар', ПОЛОСА)?.x).toBe(500);
    expect(выбратьВкладку('имбар', ПОЛОСА)?.x).toBe(500);
    expect(выбратьВкладку('нетфликс', ПОЛОСА)?.x).toBe(300);
    // Падеж и известное имя сайта: «с ютубом» — вкладка YouTube.
    expect(выбратьВкладку('ютубом', [...ПОЛОСА, вкладка('Смешные котики - YouTube', 700)])?.x).toBe(700);
  });

  it('не вкладку и непохожее — не выбирает', () => {
    expect(выбратьВкладку('ютуб', ПОЛОСА)).toBeNull();
    expect(выбратьВкладку('по', ПОЛОСА)).toBeNull();
  });

  it('ищет во втором окне браузера и щёлкает по вкладке там', async () => {
    const поднято: string[] = [];
    const нажато: Array<{ x?: number; y?: number }> = [];
    let впереди = 'Claude';
    const окна = [
      { title: 'Claude', focused: true, minimized: false, x: 0, y: 0, width: 800, height: 600, pid: 1 },
      { title: 'Новая вкладка — Личный: Microsoft Edge', focused: false, minimized: false, x: 0, y: 0, width: 800, height: 600, pid: 2 },
      { title: 'aisarus/distrib и еще 2 страницы — Личный: Microsoft Edge', focused: false, minimized: true, x: 0, y: 0, width: 800, height: 600, pid: 3 },
    ];
    const desktop = {
      windows: async () => окна,
      focus: async (title: string) => {
        поднято.push(title);
        впереди = title;
        return { title };
      },
      elements: async () => ({
        title: впереди,
        elements: впереди.startsWith('aisarus') ? ПОЛОСА : [вкладка('Новая вкладка', 100)],
      }),
      click: async (где: { x?: number; y?: number }) => {
        нажато.push(где);
      },
    } as unknown as DesktopControl;

    const найдено = await перейтиНаВкладку(desktop, 'инбар');
    expect(найдено?.name).toBe('inbar - Поиск');
    expect(поднято).toEqual([окна[1]?.title, окна[2]?.title]);
    expect(нажато).toEqual([{ x: 500, y: 20 }]);
  });

  it('нет такой вкладки — null и ни одного щелчка', async () => {
    const нажато: unknown[] = [];
    const desktop = {
      windows: async () => [{ title: 'Проба — Microsoft Edge', focused: true, minimized: false, x: 0, y: 0, width: 800, height: 600, pid: 1 }],
      focus: async (title: string) => ({ title }),
      elements: async () => ({ title: 'Проба — Microsoft Edge', elements: ПОЛОСА }),
      click: async (где: unknown) => {
        нажато.push(где);
      },
    } as unknown as DesktopControl;
    expect(await перейтиНаВкладку(desktop, 'телеграм')).toBeNull();
    expect(нажато).toEqual([]);
  });
});

describe('адрес сайта по имени', () => {
  it('известное — по таблице, на обоих языках', () => {
    expect(адресСайта('нетфликс')).toBe('https://www.netflix.com');
    expect(адресСайта('Netflix')).toBe('https://www.netflix.com');
    expect(адресСайта('ютуб')).toBe('https://www.youtube.com');
  });

  it('с доменом — как адрес, остальное — первый результат поиска, а не угаданный домен', () => {
    expect(адресСайта('habr ru')).toBe('https://habr.ru');
    expect(адресСайта('habr точка com')).toBe('https://habr.com');
    expect(адресСайта('сайт моей школы')).toBe(`https://duckduckgo.com/?q=${encodeURIComponent('!ducky сайт моей школы')}`);
  });
});

describe('известный сайт с ошибкой распознавания (живой журнал 29.09.2026)', () => {
  it('«гидхаб», «дит хаб», «git hub» — GitHub', () => {
    for (const имя of ['гидхаб', 'Дит Хаб', 'git hub', 'гитхаб']) {
      expect(известныйСайт(имя), имя).toBe('https://github.com');
    }
  });

  it('непохожее и программы — не сайт', () => {
    for (const имя of ['отж', 'блокнот', 'диктофон', 'калькулятор']) {
      expect(известныйСайт(имя), имя).toBeNull();
    }
  });
});
