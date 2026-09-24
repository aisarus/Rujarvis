import { describe, expect, it } from 'vitest';

import {
  AX_TRUSTED_SCRIPT,
  CURSOR_SCRIPT,
  DarwinDriver,
  ELEMENTS_SCRIPT,
  NO_ACCESS_MESSAGE,
  SCREEN_SCRIPT,
  WINDOW_LIST_SCRIPT,
  chooseWindow,
  clickScript,
  elementType,
  escapeAppleScript,
  explainMiss,
  keyScript,
  macCombo,
  parseElements,
  parseFront,
  parseWindows,
  raiseScript,
  screenshotArgs,
  scrollScript,
  typeScript,
  type DarwinWindow,
} from './darwinDriver';
import { createDesktopDriver, desktopStamp } from './platform';
import { DesktopDriver } from './driver';

const FIELD = '\u001f';
const ROW = '\u001e';

function окно(fields: (string | number)[]): string {
  return fields.join(FIELD) + ROW;
}

/**
 * Свёрнутое окно — тоже окно.
 *
 * На Windows это было сломано: свёрнутое окно отдавалось огрызком 159×27,
 * проверка размера выбрасывала его из перечисления, и «переключись на Edge»
 * не находило Edge ровно тогда, когда это нужнее всего. На маке свёрнутое
 * окно остаётся в списке и читается по имени — это измерено на macos-latest
 * 24.09.2026 на живом TextEdit («bylo=false svernuli=true razvernuli=false»,
 * заголовок читался и в свёрнутом виде). Значит, потерять его можно только
 * своими руками — вот этого и не должно случиться.
 */
describe('перечисление окон', () => {
  const вывод =
    окно(['TextEdit', 501, 1, 'Untitled', 0, 0, 0, 0, 'true', 'false']) +
    окно(['Safari', 502, 1, 'Новости', 100, 50, 1200, 800, 'false', 'true']);

  it('свёрнутое окно нулевого размера остаётся в списке', () => {
    const окна = parseWindows(вывод);
    expect(окна).toHaveLength(2);
    const свёрнутое = окна.find((item) => item.app === 'TextEdit');
    expect(свёрнутое?.minimized).toBe(true);
    expect(свёрнутое?.title).toBe('Untitled');
    expect(свёрнутое?.width).toBe(0);
  });

  it('скрипт не отсеивает окна по размеру', () => {
    // Размер в этом скрипте вообще не участвует в решении «брать или нет»:
    // ни сравнения, ни отбора. Условие по размеру здесь и было бы той самой
    // ошибкой, что стоила Windows-драйверу свёрнутых окон.
    expect(WINDOW_LIST_SCRIPT).not.toMatch(/if\s+w[wh]\s*[<>]/u);
    expect(WINDOW_LIST_SCRIPT).toContain('AXMinimized');
  });

  it('у каждого окна есть программа, номер и признак свёрнутости', () => {
    const [первое] = parseWindows(вывод);
    expect(первое).toMatchObject({ app: 'TextEdit', pid: 501, index: 1, minimized: true, focused: false });
  });

  it('обрезанные строки пропускаются, а не роняют разбор', () => {
    expect(parseWindows(`мусор${ROW}${вывод}`)).toHaveLength(2);
  });
});

describe('выбор окна', () => {
  const окна: DarwinWindow[] = parseWindows(
    окно(['TextEdit', 501, 1, 'Письмо', 0, 0, 0, 0, 'true', 'false']) +
      окно(['Safari', 502, 1, 'Новости', 0, 0, 1200, 800, 'false', 'true']) +
      окно(['Safari', 502, 2, 'Почта', 0, 0, 300, 200, 'false', 'false']),
  );

  it('находит по заголовку', () => {
    expect(chooseWindow('новост', окна)?.title).toBe('Новости');
  });

  it('находит по имени программы, когда заголовок называется иначе', () => {
    // «Переключись на сафари» приходит именем программы, а в заголовке окна
    // написано «Новости» — ровно та же беда, что была с Edge на Windows.
    expect(chooseWindow('safari', окна)?.title).toBe('Новости');
  });

  it('находит свёрнутое окно, если другого у программы нет', () => {
    const найдено = chooseWindow('textedit', окна);
    expect(найдено?.minimized).toBe(true);
    expect(найдено?.pid).toBe(501);
  });

  it('ничего не выдумывает', () => {
    expect(chooseWindow('окна-с-таким-именем-нет-12345', окна)).toBeNull();
  });

  it('отказ называет, что есть на экране', () => {
    const текст = explainMiss('окна-с-таким-именем-нет-12345', окна);
    expect(текст).toContain('окна-с-таким-именем-нет-12345');
    expect(текст).toContain('На экране:');
    expect(текст).toContain('TextEdit');
    expect(текст).toContain('Safari');
  });
});

describe('AppleScript', () => {
  /**
   * В AppleScript имена переменных — только латиница.
   *
   * `set имена to name of every window` даёт «syntax error: Expected
   * expression but found unknown token». Замерено на macos-latest 24.09.2026.
   * Русские строки в кавычках при этом живут прекрасно — ломаются именно
   * имена, поэтому литералы из проверки вырезаются.
   */
  const безЛитералов = (script: string): string => script.replace(/"(?:[^"\\]|\\.)*"/gu, '""');

  const скрипты: [string, string][] = [
    ['список окон', WINDOW_LIST_SCRIPT],
    ['элементы окна', ELEMENTS_SCRIPT],
    ['поднять окно', raiseScript(501, 2)],
    ['клавиша', keyScript('ctrl+c')],
    ['печать кириллицы', typeScript('Привет, мир')],
    ['разрешение', AX_TRUSTED_SCRIPT],
    ['экран', SCREEN_SCRIPT],
    ['курсор', CURSOR_SCRIPT],
    ['клик', clickScript('left', true, { x: 10, y: 20 })],
    ['колесо', scrollScript(-3, { x: 10, y: 20 })],
  ];

  for (const [имя, скрипт] of скрипты) {
    it(`${имя}: вне кавычек только латиница`, () => {
      expect(безЛитералов(скрипт)).not.toMatch(/\p{Script=Cyrillic}/u);
    });
  }

  it('кириллица печатается — она внутри кавычек', () => {
    expect(typeScript('Привет')).toContain('"Привет"');
  });

  it('кавычка и косая в тексте не ломают скрипт', () => {
    expect(escapeAppleScript('он сказал "да" \\ и ушёл')).toBe('он сказал \\"да\\" \\\\ и ушёл');
  });

  it('перенос строки становится escape-последовательностью', () => {
    // Буквальный перенос внутри литерала AppleScript — синтаксическая ошибка.
    expect(escapeAppleScript('первая\r\nвторая')).toBe('первая\\nвторая');
    expect(typeScript('а\nб')).not.toContain('\n');
  });

  it('поднятие адресует окно числами, а не подставленным текстом', () => {
    const скрипт = raiseScript(501, 2);
    expect(скрипт).toContain('unix id is 501');
    expect(скрипт).toContain('window 2 of p');
    expect(скрипт).toContain('AXRaise');
  });

  it('кто впереди — читается из ответа', () => {
    expect(parseFront(`Safari${FIELD}Новости${FIELD}502\n`)).toEqual({
      app: 'Safari',
      title: 'Новости',
      pid: 502,
    });
  });
});

/**
 * Сочетания Windows на языке мака.
 *
 * Весь Джарвис говорит именами Windows: таблица команд отдаёт `ctrl+c` за
 * «скопируй». Пропустить это на мак как есть — значит не сделать ничего:
 * Control+C там не копирует.
 */
describe('сочетания клавиш', () => {
  it.each([
    ['ctrl+c', 'cmd+c'],
    ['ctrl+v', 'cmd+v'],
    ['ctrl+shift+t', 'cmd+shift+t'],
    ['ctrl+y', 'cmd+shift+z'],
    ['ctrl+home', 'cmd+up'],
    ['alt+f4', 'cmd+w'],
    ['alt+tab', 'cmd+tab'],
    ['win+down', 'cmd+m'],
    ['f5', 'cmd+r'],
    ['enter', 'enter'],
  ])('%s → %s', (было, стало) => {
    expect(macCombo(было)).toBe(стало);
  });

  it('переключение вкладок остаётся на Control — так и на маке', () => {
    expect(macCombo('ctrl+tab')).toBe('ctrl+tab');
    expect(macCombo('ctrl+shift+tab')).toBe('ctrl+shift+tab');
    expect(keyScript('ctrl+tab')).toContain('control down');
  });

  it('собирает код клавиши и модификаторы', () => {
    expect(keyScript('ctrl+c')).toBe('tell application "System Events" to key code 8 using {command down}');
    expect(keyScript('down')).toBe('tell application "System Events" to key code 125');
  });

  it('неизвестную клавишу называет, а не глотает', () => {
    expect(() => keyScript('ctrl+щ')).toThrow(/Неизвестная клавиша/u);
    expect(() => keyScript('shift')).toThrow(/нет клавиши/u);
  });
});

describe('элементы окна', () => {
  const вывод =
    ['TextEdit', 'Untitled'].join(FIELD) +
    ROW +
    ['Закрыть', 'AXCloseButton', 'AXButton', 'true', 10, 20, 30, 40].join(FIELD) +
    ROW +
    ['Текст', '', 'AXTextArea', 'false', 0, 100, 800, 600].join(FIELD) +
    ROW;

  it('считает центр элемента — туда и кликаем', () => {
    const { elements } = parseElements(вывод);
    expect(elements[0]).toMatchObject({ name: 'Закрыть', id: 'AXCloseButton', x: 25, y: 40 });
  });

  it('заголовок окна едет отдельно от элементов', () => {
    expect(parseElements(вывод).title).toBe('Untitled');
  });

  it('выключенный элемент помечен выключенным', () => {
    expect(parseElements(вывод).elements[1]?.enabled).toBe(false);
  });

  it('роли мака названы именами Windows: выбор по названию один на обе', () => {
    expect(elementType('AXButton')).toBe('Button');
    expect(elementType('AXMenuItem')).toBe('MenuItem');
    expect(elementType('AXTextField')).toBe('Edit');
    expect(elementType('AXWhatever')).toBe('Whatever');
  });
});

describe('снимок экрана', () => {
  it('без области снимает весь экран', () => {
    expect(screenshotArgs('/tmp/shot.png')).toEqual(['-x', '/tmp/shot.png']);
  });

  it('область едет одним аргументом -R', () => {
    expect(screenshotArgs('/tmp/shot.png', { x: 1, y: 2, width: 3, height: 4 })).toEqual([
      '-x',
      '-R',
      '1,2,3,4',
      '/tmp/shot.png',
    ]);
  });
});

/**
 * Разрешение спрашивается прямо, а не выясняется по факту падения.
 *
 * Без Универсального доступа CGEvent молча не делает ничего: клик «проходит»,
 * а на экране не меняется ничего. Это худший из отказов — он не виден.
 */
describe('Универсальный доступ', () => {
  function сДвойником(ответ: string): { driver: DarwinDriver; вызовы: string[][] } {
    const driver = new DarwinDriver();
    const вызовы: string[][] = [];
    (driver as unknown as { osascript(args: string[]): Promise<string> }).osascript = async (args) => {
      вызовы.push(args);
      return args.join(' ').includes('AXIsProcessTrusted') ? ответ : '';
    };
    return { driver, вызовы };
  }

  it('без разрешения до работы дело не доходит', async () => {
    const { driver, вызовы } = сДвойником('false');
    await expect(driver.windows()).rejects.toThrow(/Универсальный доступ/u);
    expect(вызовы).toHaveLength(1);
  });

  it('говорит, что открыть и зачем', () => {
    expect(NO_ACCESS_MESSAGE).toContain('Системные настройки');
    expect(NO_ACCESS_MESSAGE).toContain('Универсальный доступ');
  });

  it('отказ не запоминается: разрешение могли выдать и не перезапустить', async () => {
    const { driver } = сДвойником('false');
    await expect(driver.key('ctrl+c')).rejects.toThrow(/Универсальный доступ/u);
    await expect(driver.key('ctrl+c')).rejects.toThrow(/Универсальный доступ/u);
  });

  it('разрешение спрашивается один раз, а не перед каждым кликом', async () => {
    const { driver, вызовы } = сДвойником('true');
    await driver.key('ctrl+c');
    await driver.key('ctrl+v');
    expect(вызовы).toHaveLength(3);
  });
});

describe('выбор драйвера по платформе', () => {
  function наПлатформе<T>(платформа: string, что: () => T): T {
    const была = process.platform;
    Object.defineProperty(process, 'platform', { value: платформа, configurable: true });
    try {
      return что();
    } finally {
      Object.defineProperty(process, 'platform', { value: была, configurable: true });
    }
  }

  it('на маке — драйвер мака', () => {
    expect(наПлатформе('darwin', createDesktopDriver)).toBeInstanceOf(DarwinDriver);
  });

  it('на Windows — драйвер Windows', () => {
    expect(наПлатформе('win32', createDesktopDriver)).toBeInstanceOf(DesktopDriver);
  });

  it('в журнале прогона видно, чем работали', () => {
    expect(наПлатформе('darwin', desktopStamp).path).toContain('osascript');
    expect(наПлатформе('win32', desktopStamp).path).toContain('win32-driver.ps1');
  });
});
