import { describe, expect, it } from 'vitest';

import {
  AX_TRUSTED_SCRIPT,
  CG_WINDOW_LIST_SCRIPT,
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
  mergeWindows,
  parseElements,
  parseFront,
  parseCgWindows,
  parseWindows,
  raiseScript,
  screenshotArgs,
  scrollScript,
  simplify,
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

/**
 * Второй глаз: оконный сервер.
 *
 * System Events спрашивает о окнах саму программу, и та отвечает не сразу.
 * Замер на macos-latest 25.09.2026 на живом окне Электрона: оконный сервер
 * увидел новое окно через 85 мс, System Events — через 514. Приёмка ждала
 * 600 мс и получала пустой список при живом окне на экране.
 */
describe('свод двух списков окон', () => {
  const отСобытий = parseWindows(
    окно(['TextEdit', 501, 1, 'Письмо', 0, 0, 640, 480, 'false', 'true']) +
      окно(['TextEdit', 501, 2, 'Свёрнутое', 0, 0, 0, 0, 'true', 'false']),
  );

  it('добирает окно, которого System Events ещё не видит', () => {
    const сведено = mergeWindows(отСобытий, [
      { app: 'Electron', pid: 900, title: 'Проба приёмки', x: 10, y: 20, width: 300, height: 160 },
    ]);
    expect(сведено).toHaveLength(3);
    expect(сведено[2]).toMatchObject({ app: 'Electron', pid: 900, title: 'Проба приёмки', index: 0 });
  });

  it('не двоит окно, которое видно обоим', () => {
    const сведено = mergeWindows(отСобытий, [
      { app: 'TextEdit', pid: 501, title: 'Письмо', x: 0, y: 0, width: 640, height: 480 },
    ]);
    expect(сведено).toHaveLength(2);
  });

  it('свёрнутое окно и номер приходят от System Events — у сервера их нет', () => {
    const сведено = mergeWindows(отСобытий, []);
    expect(сведено.find((о) => о.title === 'Свёрнутое')).toMatchObject({ minimized: true, index: 2 });
  });

  it('безымянное окно уже перечисленной программы не добирается', () => {
    // Заголовок у оконного сервера прячется без разрешения на запись экрана,
    // и такое окно не отличить от уже перечисленного.
    expect(
      mergeWindows(отСобытий, [{ app: 'TextEdit', pid: 501, title: '', x: 0, y: 0, width: 10, height: 10 }]),
    ).toHaveLength(2);
  });

  it('безымянное окно незнакомой программы добирается: хоть что-то на экране есть', () => {
    expect(
      mergeWindows(отСобытий, [{ app: 'Preview', pid: 700, title: '', x: 0, y: 0, width: 300, height: 200 }]),
    ).toHaveLength(3);
  });

  it('разбор ответа оконного сервера', () => {
    const строки = parseCgWindows(
      JSON.stringify([{ app: 'Electron', pid: 900, title: 'Проба', x: 1, y: 2, width: 3, height: 4 }]),
    );
    expect(строки[0]).toEqual({ app: 'Electron', pid: 900, title: 'Проба', x: 1, y: 2, width: 3, height: 4 });
  });

  it('скрипт берёт только обычные окна, а не курсор и строку меню', () => {
    expect(CG_WINDOW_LIST_SCRIPT).toContain('kCGWindowLayer === 0');
    // Без castRefToObject deepUnwrap возвращает не массив — замерено 24.09.2026.
    expect(CG_WINDOW_LIST_SCRIPT).toContain('castRefToObject');
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

  /**
   * «Ё» в заголовке не должна прятать окно.
   *
   * Разбор фразы приводит речь к одному виду и меняет «ё» на «е»: человек
   * говорит одинаково, а пишет по-разному. В заголовке окна «ё» остаётся как
   * есть. Поймано приёмкой на Windows 25.09.2026: окно «Проба приёмки
   * Rujarvis» не нашлось по фразе, дошедшей до драйвера как «проба приемки
   * rujarvis». «Счёт», «Приём», «Ещё одна задача» — то же самое.
   */
  it('находит окно с «ё» в заголовке по фразе без «ё»', () => {
    const сЁ = parseWindows(окно(['Electron', 700, 1, 'Проба приёмки Rujarvis', 0, 0, 420, 220, 'false', 'false']));
    expect(chooseWindow('проба приемки rujarvis', сЁ)?.title).toBe('Проба приёмки Rujarvis');
  });

  it('находит программу с «ё» в имени', () => {
    const сЁ = parseWindows(окно(['Приём звука', 701, 1, 'Window', 0, 0, 420, 220, 'false', 'false']));
    expect(chooseWindow('прием звука', сЁ)?.app).toBe('Приём звука');
  });

  it('приведение трогает и строчную, и прописную «ё»', () => {
    expect(simplify('Ещё Приём ЁЖ')).toBe('еще прием еж');
  });

  it('«ё» из двух знаков — та же «ё»', () => {
    // На маке имена файлов ходят и составленными, и разложенными: «ё» бывает
    // одним кодом (U+0451) и парой «е» + знак над ней (U+0435 U+0308).
    expect(simplify('приёмка'.normalize('NFD'))).toBe('приемка');
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

  /**
   * Печать идёт через буфер обмена, а не через клавиши.
   *
   * `keystroke "Привет"` на маке с латинской раскладкой напечатал «aaaaaa» —
   * замерено на macos-latest 24.09.2026, отказа при этом не было. Раскладка
   * у человека с русским Джарвисом вполне может быть и русской, и тогда так
   * же молча поехала бы латиница. Буфер обмена от раскладки не зависит.
   */
  it('текст едет через буфер обмена и Cmd+V', () => {
    const скрипт = typeScript('Привет');
    expect(скрипт).toContain('set the clipboard to "Привет"');
    expect(скрипт).toContain('key code 9 using {command down}');
    expect(скрипт).not.toContain('keystroke');
  });

  it('буфер обмена возвращается на место', () => {
    const скрипт = typeScript('Привет');
    expect(скрипт).toContain('set saved to the clipboard as record');
    expect(скрипт).toContain('set the clipboard to saved');
    // Вернуть буфер раньше, чем чужая программа его прочитает, значит
    // вставить не то: задержка стоит между вставкой и возвратом.
    expect(скрипт.indexOf('delay')).toBeGreaterThan(скрипт.indexOf('key code 9'));
    expect(скрипт.indexOf('delay')).toBeLessThan(скрипт.indexOf('set the clipboard to saved'));
  });

  it('кавычка и косая в тексте не ломают скрипт', () => {
    expect(escapeAppleScript('он сказал "да" \\ и ушёл')).toBe('он сказал \\"да\\" \\\\ и ушёл');
  });

  it('перенос строки становится escape-последовательностью', () => {
    // Буквальный перенос внутри литерала AppleScript — синтаксическая ошибка.
    expect(escapeAppleScript('первая\r\nвторая')).toBe('первая\\nвторая');
    expect(typeScript('а\nб')).toContain('"а\\nб"');
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
