/**
 * Рабочий стол macOS: окна, мышь, клавиатура, снимки экрана.
 *
 * ## Почему здесь нет процесса-демона
 *
 * Windows-драйвер держит живой PowerShell и говорит с ним построчным JSON:
 * запуск оболочки и компиляция P/Invoke стоят сотен миллисекунд, и платить
 * это на каждый клик нельзя. На маке такой цены нет. Замер на macos-latest
 * (24.09.2026, `scripts/probe-darwin-windows.mjs`) считал время целиком,
 * вместе с запуском процесса: перенос курсора — 42 мс, снимок экрана — 310 мс,
 * нажатие клавиши — 382 мс, список окон — 166–776 мс. Демон сэкономил бы
 * десятки миллисекунд и добавил бы всё то, что у демона ломается: зависший
 * процесс, забитый буфер, рассинхрон ответов. Поэтому каждая операция — свой
 * вызов `osascript`.
 *
 * ## Три разных замка Apple
 *
 * Список окон, движение мышью и нажатия клавиш требуют «Универсального
 * доступа»; снимок экрана — отдельного разрешения на запись экрана. Без
 * первого System Events отвечает ошибкой, а CGEvent молча не делает ничего —
 * худший из возможных отказов. Поэтому разрешение спрашивается прямо
 * (`AXIsProcessTrusted`) до первой операции, а не выясняется по факту падения.
 *
 * ## Ловушка, стоившая прогона
 *
 * В AppleScript имена переменных — только латиница. `set имена to name of
 * every window` даёт «syntax error: Expected expression but found unknown
 * token». Замерено пробником 24.09.2026. Русские строки в кавычках при этом
 * живут прекрасно — ломаются именно имена. Поэтому весь AppleScript ниже
 * латинский, а по-русски здесь только комментарии.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { UiElement } from '../control/elements';
import type { DesktopWindow, ScreenBounds } from './driver';

const запустить = promisify(execFile);

/**
 * Разделители полей и строк в ответах AppleScript.
 *
 * JSON в AppleScript собирается склейкой строк, и любой заголовок окна с
 * кавычкой ломает разбор. Управляющие символы US (31) и RS (30) в заголовках
 * окон не встречаются, а строить их склейкой безопасно.
 */
const FIELD = '\u001f';
const ROW = '\u001e';

/** Сколько ждать ответа. Список элементов окна бывает длинным — ему больше. */
const TIMEOUT_MS = 20_000;
const ELEMENTS_TIMEOUT_MS = 40_000;

/**
 * Сколько элементов окна перечислять.
 *
 * Каждое свойство каждого элемента — отдельное событие Apple, и дерево
 * большого окна читается секундами. Предел выбран так, чтобы кнопки и пункты
 * меню помещались, а список из тысячи ячеек таблицы не съедал минуту.
 */
const ELEMENTS_LIMIT = 150;

/**
 * Что сказать человеку, когда Универсальный доступ не дан.
 *
 * Молчать нельзя: без этого разрешения мышь и клавиатура не работают вообще,
 * а macOS об этом не сообщает — события просто пропадают.
 */
export const NO_ACCESS_MESSAGE =
  'macOS не дал управлять компьютером. Откройте: Системные настройки → ' +
  'Конфиденциальность и безопасность → Универсальный доступ — и включите там ' +
  'Rujarvis (или Терминал, если Джарвис запущен из него). Без этого разрешения ' +
  'не читается список окон, не двигается мышь и не нажимаются клавиши: ' +
  'macOS отбрасывает такие события молча.';

/** Окно на маке. Сверх общего — имя программы и номер окна внутри программы. */
export interface DarwinWindow extends DesktopWindow {
  /** Имя программы: «переключись на текстэдит» приходит именно так. */
  app: string;
  /** Свёрнутое окно на маке остаётся в списке — в отличие от Windows. */
  minimized: boolean;
  /** Номер окна внутри своей программы: им окно и адресуется обратно. */
  index: number;
}

// --- Скрипты ---------------------------------------------------------------

/** Аргументы `osascript` для AppleScript и для JXA. */
export function appleScriptArgs(script: string): string[] {
  return ['-e', script];
}

export function jxaArgs(script: string): string[] {
  return ['-l', 'JavaScript', '-e', script];
}

/**
 * Строка внутри AppleScript.
 *
 * Экранируются обратная косая и кавычка; перевод строки становится `\n` —
 * AppleScript понимает эти escape-последовательности, а буквальный перенос
 * внутри литерала — синтаксическая ошибка.
 */
export function escapeAppleScript(text: string): string {
  return text
    .replace(/\\/gu, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\r\n?/gu, '\n')
    .replace(/\n/gu, '\\n');
}

/** Дан ли Универсальный доступ. Спрашиваем прямо, не пробуя ничего сделать. */
export const AX_TRUSTED_SCRIPT = `
  ObjC.import('ApplicationServices');
  String($.AXIsProcessTrusted());
`;

/**
 * Список окон со всеми программами переднего плана.
 *
 * Свёрнутое окно обязано быть в списке. На Windows ровно это и было сломано:
 * свёрнутое окно отдавалось огрызком 159×27, проверка размера выбрасывала его,
 * и «переключись на Edge» не находило Edge именно тогда, когда это нужнее
 * всего. Здесь размер вообще ни на что не влияет: в список попадает каждое
 * окно, а свёрнутость едет отдельным полем. У свёрнутого окна macOS отдаёт
 * позицию и размер ошибкой — отсюда `try` вокруг каждого чтения.
 */
export const WINDOW_LIST_SCRIPT = `
set fieldSep to character id 31
set rowSep to character id 30
set out to ""
tell application "System Events"
  repeat with p in (every process whose background only is false)
    set appName to ""
    try
      set appName to name of p
    end try
    set appPid to 0
    try
      set appPid to unix id of p
    end try
    set appFront to false
    try
      set appFront to frontmost of p
    end try
    set wins to {}
    try
      set wins to windows of p
    end try
    repeat with i from 1 to (count of wins)
      set w to item i of wins
      set wName to ""
      try
        set wName to name of w
      end try
      if wName is missing value then set wName to ""
      set wMin to false
      try
        set wMin to (value of attribute "AXMinimized" of w) is true
      end try
      set wMain to false
      try
        set wMain to (value of attribute "AXMain" of w) is true
      end try
      set wx to 0
      set wy to 0
      try
        set pos to position of w
        set wx to item 1 of pos
        set wy to item 2 of pos
      end try
      set ww to 0
      set wh to 0
      try
        set sz to size of w
        set ww to item 1 of sz
        set wh to item 2 of sz
      end try
      set out to out & appName & fieldSep & appPid & fieldSep & i & fieldSep & wName & fieldSep & wx & fieldSep & wy & fieldSep & ww & fieldSep & wh & fieldSep & wMin & fieldSep & (appFront and wMain) & rowSep
    end repeat
  end repeat
end tell
return out
`;

/** Разбор ответа `WINDOW_LIST_SCRIPT`. */
export function parseWindows(output: string): DarwinWindow[] {
  const windows: DarwinWindow[] = [];
  for (const row of output.split(ROW)) {
    if (!row.trim()) continue;
    const fields = row.split(FIELD);
    if (fields.length < 10) continue;
    const [app, pid, index, title, x, y, width, height, minimized, focused] = fields as string[];
    windows.push({
      app: (app ?? '').trim(),
      pid: number(pid),
      index: number(index),
      title: title ?? '',
      x: number(x),
      y: number(y),
      width: number(width),
      height: number(height),
      minimized: (minimized ?? '').trim() === 'true',
      focused: (focused ?? '').trim() === 'true',
    });
  }
  return windows;
}

function number(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Сравнение без «ё».
 *
 * Разбор фразы приводит речь к одному виду и меняет «ё» на «е»: человек
 * говорит одинаково, а пишет по-разному. В ЗАГОЛОВКЕ окна «ё» при этом
 * остаётся как есть, и поиск по дословному совпадению промахивается.
 *
 * Поймано приёмкой на Windows 25.09.2026: окно «Проба приёмки Rujarvis» не
 * нашлось по фразе, которая дошла до драйвера как «проба приемки rujarvis».
 * Любое русское окно с «ё» — «Счёт», «Приём», «Ещё одна задача» — не нашлось
 * бы так же. Поэтому через это приведение проходят ОБЕ стороны сравнения.
 */
export function simplify(text: string): string {
  // Сначала Юникод складывается в составленный вид. «Ё» бывает записана
  // двумя способами: одним знаком (U+0451) или «е» с отдельным знаком над ней
  // (U+0435 U+0308). Для строки это разные буквы, и замена одной не трогает
  // вторую.
  //
  // Замер на macos-latest 25.09.2026: заголовок окна TextEdit с файлом
  // «приёмка-rujarvis.txt» пришёл составленным — 43f 440 438 451 43c 43a 430.
  // То есть здесь повезло; приведение стоит один вызов и держит тот случай,
  // когда не повезёт.
  return text.normalize('NFC').toLowerCase().replace(/ё/gu, 'е');
}

/**
 * Какое окно имел в виду человек.
 *
 * Сначала по заголовку, потом по имени программы — как на Windows и по той же
 * причине: «переключись на эдж» приходит именем программы, а в заголовке
 * написано что-то своё. Среди окон одной программы берём самое большое:
 * у свёрнутого размер нулевой, и оно честно уходит в конец — но остаётся
 * в выборе, если других окон нет.
 */
export function chooseWindow(needle: string, windows: readonly DarwinWindow[]): DarwinWindow | null {
  const wanted = simplify(needle.trim());
  if (!wanted) return null;

  const byTitle = windows.filter((item) => simplify(item.title).includes(wanted));
  const byApp = windows.filter((item) => simplify(item.app).includes(wanted));
  const found = byTitle.length ? byTitle : byApp;
  if (!found.length) return null;

  return [...found].sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

/**
 * Отказ называет, что есть на экране.
 *
 * «Не получилось» не говорит человеку ничего: ни что искали, ни что рядом.
 * Список того, что открыто, делает следующую попытку осмысленной — это же
 * правило записано в win32-драйвере («Na ekrane:»).
 */
export function explainMiss(needle: string, windows: readonly DarwinWindow[]): string {
  const nearby = [...new Set(windows.map((item) => item.app || item.title).filter(Boolean))]
    .slice(0, 8)
    .join(', ');
  return `Окно не найдено: ${needle}. На экране: ${nearby || 'ничего'}`;
}

/**
 * Поднять окно и рассказать, что вышло вперёд на самом деле.
 *
 * Свёрнутое окно сначала разворачивается: поднять свёрнутое нельзя, а
 * «переключись» при свёрнутом окне — обычный случай, а не редкость.
 * Отчитываемся тем, что впереди после попытки, а не тем, что просили: драйвер,
 * который говорит «переключился» не глядя, стоит человеку минуты выяснений.
 */
export function raiseScript(pid: number, index: number): string {
  return `
set fieldSep to character id 31
tell application "System Events"
  set p to first process whose unix id is ${Math.trunc(pid)}
  try
    set w to window ${Math.trunc(index)} of p
    try
      if (value of attribute "AXMinimized" of w) is true then
        set value of attribute "AXMinimized" of w to false
      end if
    end try
    perform action "AXRaise" of w
  end try
  set frontmost of p to true
  delay 0.3
  set f to first process whose frontmost is true
  set frontName to name of f
  set frontPid to unix id of f
  set frontTitle to ""
  try
    set frontTitle to name of window 1 of f
  end try
  if frontTitle is missing value then set frontTitle to ""
  return frontName & fieldSep & frontTitle & fieldSep & frontPid
end tell
`;
}

/** Кто впереди после попытки поднять окно. */
export function parseFront(output: string): { app: string; title: string; pid: number } {
  const [app, title, pid] = output.trim().split(FIELD);
  return { app: (app ?? '').trim(), title: title ?? '', pid: number(pid) };
}

/**
 * Границы экрана.
 *
 * Берём CGDisplayBounds, а не размер снимка: клики адресуются в той же системе
 * координат, что и CGEvent, а снимок на экране Retina вдвое крупнее её.
 */
export const SCREEN_SCRIPT = `
  ObjC.import('CoreGraphics');
  const display = $.CGMainDisplayID();
  const bounds = $.CGDisplayBounds(display);
  JSON.stringify({
    x: Math.round(bounds.origin.x),
    y: Math.round(bounds.origin.y),
    width: Math.round(bounds.size.width),
    height: Math.round(bounds.size.height),
  });
`;

/** Где курсор. */
export const CURSOR_SCRIPT = `
  ObjC.import('CoreGraphics');
  const where = $.CGEventGetLocation($.CGEventCreate($()));
  JSON.stringify({ x: Math.round(where.x), y: Math.round(where.y) });
`;

/**
 * Мышь через CoreGraphics.
 *
 * `cliclick` на маке не стоит, и тащить его установщиком ради двух вызовов
 * незачем: CGEvent есть в системе всегда. Проверено на macos-latest.
 */
export function moveScript(x: number, y: number): string {
  return `
  ObjC.import('CoreGraphics');
  const point = $.CGPointMake(${round(x)}, ${round(y)});
  const move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, move);
  'ok';
`;
}

export type MouseButton = 'left' | 'right' | 'middle';

/**
 * Клик там, где сказано.
 *
 * Координата едет в самом событии, поэтому отдельного переноса курсора не
 * нужно. Двойной клик — не два одиночных: без поля ClickState система считает
 * их двумя разными кликами, и «открой двойным» не срабатывает.
 */
export function clickScript(
  button: MouseButton,
  double: boolean,
  at?: { x: number; y: number },
): string {
  const down = { left: 'kCGEventLeftMouseDown', right: 'kCGEventRightMouseDown', middle: 'kCGEventOtherMouseDown' }[button];
  const up = { left: 'kCGEventLeftMouseUp', right: 'kCGEventRightMouseUp', middle: 'kCGEventOtherMouseUp' }[button];
  const which = { left: 'kCGMouseButtonLeft', right: 'kCGMouseButtonRight', middle: 'kCGMouseButtonCenter' }[button];
  const times = double ? 2 : 1;
  const point = at
    ? `$.CGPointMake(${round(at.x)}, ${round(at.y)})`
    : '$.CGEventGetLocation($.CGEventCreate($()))';

  return `
  ObjC.import('CoreGraphics');
  const point = ${point};
  function post(type, clicks) {
    const event = $.CGEventCreateMouseEvent($(), type, point, $.${which});
    $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, clicks);
    $.CGEventPost($.kCGHIDEventTap, event);
  }
  for (let click = 1; click <= ${times}; click += 1) {
    post($.${down}, click);
    post($.${up}, click);
  }
  'ok';
`;
}

/**
 * Колесо.
 *
 * Считаем строками, а не пикселями: «прокрути на три» означает три щелчка
 * колеса, как и на Windows, где то же число умножается на 120. Знак тот же:
 * положительное — вверх.
 */
export function scrollScript(amount: number, at?: { x: number; y: number }): string {
  const move = at
    ? `
  const point = $.CGPointMake(${round(at.x)}, ${round(at.y)});
  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft));`
    : '';
  return `
  ObjC.import('CoreGraphics');${move}
  const wheel = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 1, ${round(amount)});
  $.CGEventPost($.kCGHIDEventTap, wheel);
  'ok';
`;
}

function round(value: number): number {
  return Math.round(Number.isFinite(value) ? value : 0);
}

/**
 * Печать текста — через буфер обмена, а не через клавиши.
 *
 * `keystroke` гонит символ через текущую раскладку. Замер на macos-latest
 * 24.09.2026, на живом окне TextEdit: `keystroke "Hello"` напечатал «Hello»,
 * а `keystroke "Привет"` — «aaaaaa». Отказа при этом нет: System Events
 * отвечает «сделано». Диктовка по-русски превращалась бы в кашу молча.
 *
 * Раскладка — не наше дело и не наша забота: у человека с русским Джарвисом
 * она вполне может быть русской, и тогда так же молча поехала бы латиница.
 * Поэтому путь один на всё, независимый от раскладки: положить в буфер и
 * нажать Cmd+V. Замер там же: «Привет» пришёл буква в букву, 691 мс.
 *
 * CGEvent с юникодной строкой был бы ближе всего к тому, как это сделано на
 * Windows (SendInput с флагом UNICODE), но мост JXA его не вывозит: буфером
 * NSMutableData — «Ref has incompatible type (-2700)», массивом чисел — без
 * отказа, но в окне оказываются не те буквы. Замерено там же, оба раза.
 *
 * Буфер сохраняется и возвращается обратно. Задержка перед возвратом не
 * украшение: вставку выполняет чужая программа, и вернуть буфер раньше, чем
 * она его прочитает, значит вставить не то.
 */
export function typeScript(text: string): string {
  return `
set saved to missing value
try
  set saved to the clipboard as record
end try
set the clipboard to "${escapeAppleScript(text)}"
tell application "System Events" to key code 9 using {command down}
delay 0.4
try
  if saved is not missing value then set the clipboard to saved
end try
return "ok"
`;
}

/**
 * Клавиши по кодам, как их нумерует macOS.
 *
 * Имена как у Windows-драйвера: остальной Джарвис говорит его языком, и
 * заводить второй словарь ради одной платформы значит развести их через месяц.
 */
const KEY_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12,
  w: 13, e: 14, r: 15, y: 16, t: 17, o: 31, u: 32, i: 34, p: 35, l: 37, j: 38,
  k: 40, n: 45, m: 46,
  '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26, '8': 28, '9': 25, '0': 29,
  enter: 36, return: 36, tab: 48, space: 49, backspace: 51, esc: 53, escape: 53,
  delete: 117, del: 117,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

const MODIFIERS: Record<string, string> = {
  cmd: 'command down',
  command: 'command down',
  ctrl: 'control down',
  control: 'control down',
  alt: 'option down',
  option: 'option down',
  shift: 'shift down',
};

/**
 * Сочетания Windows на языке мака.
 *
 * Весь Джарвис говорит именами Windows: таблица команд отдаёт `ctrl+c` за
 * «скопируй» и `win+down` за «сверни окно». Прогнать это на маке как есть —
 * значит не сделать ничего: Control+C на маке не копирует, а клавиши Windows
 * там нет вовсе. Поэтому сочетание переводится целиком, а не по частям:
 * «отмени» и «повтори» на маке не зеркальны (Cmd+Z и Cmd+Shift+Z), а
 * переключение вкладок как раз и на маке живёт на Control.
 *
 * Это решение по правилам macOS, а не замер: в прогоне на macos-latest
 * проверено одно сочетание — `ctrl+a` (то есть Cmd+A) в TextEdit, по тому,
 * что следом напечатанный текст заменил собой прежний.
 */
const MAC_COMBOS: Record<string, string> = {
  'ctrl+y': 'cmd+shift+z',
  'ctrl+tab': 'ctrl+tab',
  'ctrl+shift+tab': 'ctrl+shift+tab',
  'ctrl+home': 'cmd+up',
  'ctrl+end': 'cmd+down',
  home: 'cmd+left',
  end: 'cmd+right',
  'alt+tab': 'cmd+tab',
  'alt+f4': 'cmd+w',
  'win+up': 'ctrl+cmd+f',
  'win+down': 'cmd+m',
  'win+d': 'f11',
  f5: 'cmd+r',
  f11: 'ctrl+cmd+f',
};

export function macCombo(keys: string): string {
  const parts = keys
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const whole = parts.join('+');
  const known = MAC_COMBOS[whole];
  if (known) return known;

  // Общее правило: Ctrl и клавиша Windows на маке — это Command, Alt — Option.
  return parts
    .map((part) => (part === 'ctrl' || part === 'control' || part === 'win' ? 'cmd' : part === 'alt' ? 'option' : part))
    .join('+');
}

export function keyScript(keys: string): string {
  const parts = macCombo(keys).split('+');
  const modifiers: string[] = [];
  let code: number | null = null;

  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    const known = KEY_CODES[part];
    if (known === undefined) throw new Error(`Неизвестная клавиша: ${part}`);
    code = known;
  }

  if (code === null) throw new Error(`В сочетании нет клавиши: ${keys}`);
  const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
  return `tell application "System Events" to key code ${code}${using}`;
}

/**
 * Элементы окна из дерева доступности.
 *
 * То же, чем пользуются экранные читалки: у кнопки есть имя и координаты,
 * поэтому «кликни закрыть» не требует ни снимка экрана, ни угадывания
 * пикселей. Имя и описание идут вместе с AXIdentifier: имя переводится вслед
 * за языком интерфейса, а идентификатор остаётся английским — на Windows это
 * уже спасало на иврите.
 *
 * Обход списка написан как `item i of kids`, и переписывать его в изящное
 * `repeat with e in kids` нельзя. Переменная цикла получает тогда ссылку,
 * которую System Events потом не разрешает: ошибка приходит на КАЖДОМ
 * свойстве — роль, значение, фокус, — а обёрнутая в `try` она превращается в
 * пустоту. Замерено 24.09.2026: полтора прогона ушло на поиск несуществующей
 * беды с печатью, потому что так написанная читалка молча возвращала «».
 */
export const ELEMENTS_SCRIPT = `
set fieldSep to character id 31
set rowSep to character id 30
set out to ""
set frontName to ""
tell application "System Events"
  set p to first process whose frontmost is true
  set appName to name of p
  try
    set w to window 1 of p
    try
      set frontName to name of w
    end try
    if frontName is missing value then set frontName to ""
    set kids to entire contents of w
    set total to count of kids
    if total > ${ELEMENTS_LIMIT} then set total to ${ELEMENTS_LIMIT}
    repeat with i from 1 to total
      set e to item i of kids
      set eRole to ""
      try
        set eRole to role of e
      end try
      if eRole is missing value then set eRole to ""
      set eName to ""
      try
        set eName to name of e
      end try
      if eName is missing value then set eName to ""
      if eName is "" then
        try
          set eName to description of e
        end try
      end if
      if eName is missing value then set eName to ""
      set eId to ""
      try
        set eId to value of attribute "AXIdentifier" of e
      end try
      if eId is missing value then set eId to ""
      set eOn to true
      try
        set eOn to (enabled of e) is true
      end try
      set ex to 0
      set ey to 0
      set ew to 0
      set eh to 0
      try
        set pos to position of e
        set ex to item 1 of pos
        set ey to item 2 of pos
        set sz to size of e
        set ew to item 1 of sz
        set eh to item 2 of sz
      end try
      if ew > 0 and eh > 0 then
        set out to out & eName & fieldSep & eId & fieldSep & eRole & fieldSep & eOn & fieldSep & ex & fieldSep & ey & fieldSep & ew & fieldSep & eh & rowSep
      end if
    end repeat
  end try
  return appName & fieldSep & frontName & rowSep & out
end tell
`;

/**
 * Роли macOS именами Windows.
 *
 * Выбор элемента по названию (`jarvis/control/elements.ts`) знает типы
 * Windows и по ним решает, по чему вообще имеет смысл кликать. Переводим
 * здесь, чтобы этот выбор был один на обе платформы.
 */
export function elementType(role: string): string {
  const known: Record<string, string> = {
    AXButton: 'Button',
    AXPopUpButton: 'ComboBox',
    AXComboBox: 'ComboBox',
    AXMenuItem: 'MenuItem',
    AXMenuBarItem: 'MenuItem',
    AXMenuButton: 'SplitButton',
    AXCheckBox: 'CheckBox',
    AXRadioButton: 'RadioButton',
    AXTabGroup: 'TabItem',
    AXLink: 'Hyperlink',
    AXTextField: 'Edit',
    AXTextArea: 'Edit',
    AXSearchField: 'Edit',
    AXRow: 'ListItem',
    AXCell: 'ListItem',
    AXOutline: 'TreeItem',
    AXStaticText: 'Text',
    AXImage: 'Image',
    AXGroup: 'Group',
    AXToolbar: 'ToolBar',
    AXWindow: 'Window',
  };
  if (known[role]) return known[role] as string;
  // Незнакомая роль всё равно едет наверх под своим именем: выбор по названию
  // умеет отбросить неинтересное сам, а молча потерянный элемент — не умеет.
  return role ? role.replace(/^AX/u, '') : 'Custom';
}

export function parseElements(output: string): { title: string; elements: UiElement[] } {
  const rows = output.split(ROW);
  const head = (rows.shift() ?? '').split(FIELD);
  const app = (head[0] ?? '').trim();
  const windowTitle = head[1] ?? '';

  const elements: UiElement[] = [];
  for (const row of rows) {
    if (!row.trim()) continue;
    const fields = row.split(FIELD);
    if (fields.length < 8) continue;
    const [name, id, role, enabled, x, y, width, height] = fields as string[];
    const w = number(width);
    const h = number(height);
    elements.push({
      name: (name ?? '').trim(),
      id: (id ?? '').trim(),
      type: elementType((role ?? '').trim()),
      enabled: (enabled ?? '').trim() === 'true',
      // Центр элемента — туда и кликаем, как на Windows.
      x: number(x) + Math.round(w / 2),
      y: number(y) + Math.round(h / 2),
      width: w,
      height: h,
    });
  }

  return { title: windowTitle || app, elements };
}

/** Аргументы `screencapture`. `-x` — без звука затвора. */
export function screenshotArgs(filePath: string, region?: ScreenBounds): string[] {
  if (!region) return ['-x', filePath];
  return [
    '-x',
    '-R',
    `${round(region.x)},${round(region.y)},${round(region.width)},${round(region.height)}`,
    filePath,
  ];
}

// --- Драйвер ---------------------------------------------------------------

export class DarwinDriver {
  /**
   * Ответ на «дан ли доступ» помнится, пока он «да».
   *
   * Спрашивать перед каждым кликом — лишние 40 мс на ровном месте. Отказ не
   * запоминается: человек мог открыть настройки и включить разрешение, не
   * перезапуская Джарвиса.
   */
  private granted: Promise<void> | null = null;

  private async osascript(args: string[], timeoutMs = TIMEOUT_MS): Promise<string> {
    try {
      const { stdout } = await запустить('osascript', args, { timeout: timeoutMs, maxBuffer: 16 << 20 });
      return stdout;
    } catch (error) {
      // osascript пишет причину в stderr, а Node прячет её в поле объекта
      // ошибки. Без этого наверх уходит «Command failed» — отказ, по которому
      // нельзя понять ничего.
      const reason = (error as { stderr?: string }).stderr?.trim();
      throw new Error(reason || (error instanceof Error ? error.message : String(error)));
    }
  }

  private access(): Promise<void> {
    if (this.granted) return this.granted;
    this.granted = this.osascript(jxaArgs(AX_TRUSTED_SCRIPT), 10_000)
      .then((answer) => {
        if (answer.trim() !== 'true') throw new Error(NO_ACCESS_MESSAGE);
      })
      .catch((error: unknown) => {
        this.granted = null;
        throw error;
      });
    return this.granted;
  }

  /**
   * Границы экрана.
   *
   * Разрешения не требует: это свойство дисплея, а не чужого окна.
   */
  async screen(): Promise<ScreenBounds> {
    const answer = await this.osascript(jxaArgs(SCREEN_SCRIPT));
    return JSON.parse(answer) as ScreenBounds;
  }

  async windows(): Promise<DarwinWindow[]> {
    await this.access();
    return parseWindows(await this.osascript(appleScriptArgs(WINDOW_LIST_SCRIPT)));
  }

  async cursor(): Promise<{ x: number; y: number }> {
    await this.access();
    return JSON.parse(await this.osascript(jxaArgs(CURSOR_SCRIPT))) as { x: number; y: number };
  }

  /**
   * Снимок экрана.
   *
   * Универсального доступа не требует — у записи экрана своё разрешение, и
   * гнать человека не в те настройки хуже, чем не сказать ничего.
   */
  async screenshot(filePath: string, region?: ScreenBounds): Promise<ScreenBounds & { path: string }> {
    await запустить('screencapture', screenshotArgs(filePath, region), { timeout: TIMEOUT_MS });
    const bounds = region ?? (await this.screen());
    return { path: filePath, ...bounds };
  }

  async move(x: number, y: number): Promise<void> {
    await this.access();
    await this.osascript(jxaArgs(moveScript(x, y)));
  }

  async click(options: { x?: number; y?: number; button?: MouseButton; double?: boolean }): Promise<void> {
    await this.access();
    const at = options.x !== undefined && options.y !== undefined ? { x: options.x, y: options.y } : undefined;
    await this.osascript(jxaArgs(clickScript(options.button ?? 'left', options.double === true, at)));
  }

  async scroll(amount: number, at?: { x: number; y: number }): Promise<void> {
    await this.access();
    await this.osascript(jxaArgs(scrollScript(amount, at)));
  }

  async type(text: string): Promise<void> {
    await this.access();
    await this.osascript(appleScriptArgs(typeScript(text)));
  }

  async key(keys: string): Promise<void> {
    await this.access();
    await this.osascript(appleScriptArgs(keyScript(keys)));
  }

  async elements(): Promise<{ title: string; elements: UiElement[] }> {
    await this.access();
    return parseElements(await this.osascript(appleScriptArgs(ELEMENTS_SCRIPT), ELEMENTS_TIMEOUT_MS));
  }

  /**
   * Поднять окно и проверить, что оно действительно впереди.
   *
   * Сравниваем pid программы, а не заголовок: заголовок — надпись, а не имя.
   * Два окна одной программы называются одинаково, и проверка по надписи
   * отчиталась бы успехом, подняв не то окно.
   */
  async focus(title: string): Promise<{ title: string }> {
    await this.access();
    const windows = await this.windows();
    const target = chooseWindow(title, windows);
    if (!target) throw new Error(explainMiss(title, windows));

    const front = parseFront(await this.osascript(appleScriptArgs(raiseScript(target.pid, target.index))));
    if (front.pid !== target.pid) {
      throw new Error(
        `Не вышло поднять окно. Просили: «${target.title || target.app}». Впереди: «${front.title || front.app}»`,
      );
    }
    return { title: front.title || front.app || target.title };
  }

  /** Демона нет — гасить нечего. Метод есть, чтобы драйверы были взаимозаменяемы. */
  dispose(): void {}
}
