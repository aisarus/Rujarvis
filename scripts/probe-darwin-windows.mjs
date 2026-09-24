/**
 * Что на macOS доступно, а что требует разрешений — и работает ли управление
 * окном по-настоящему.
 *
 * Драйвер окон для Mac писать вслепую нельзя: у Apple несколько разных
 * замков, и какой из них закрыт, на словах не узнать.
 *
 * Первый заход (24.09.2026, macos-latest) показал:
 *   - Универсальный доступ в CI открыт: AXIsProcessTrusted → true;
 *   - список окон и признак AXMinimized через System Events работают
 *     (776 и 166 мс), но на машине CI окон нет — списки пустые;
 *   - screencapture работает;
 *   - cliclick отсутствует: мышь придётся делать через CoreGraphics;
 *   - мой вызов CGWindowList упал на ошибке в мосте ObjC.
 *
 * Второй заход чинит мост, добавляет мышь и клавиши и — главное — поднимает
 * на маке настоящее окно (TextEdit), чтобы проверить весь путь: найти,
 * свернуть, увидеть свёрнутым, развернуть.
 *
 *   node scripts/probe-darwin-windows.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Выполнить и вернуть исход, не роняя пробник: отказ — тоже измерение. */
async function попытка(имя, файл, аргументы, timeoutMs = 25_000) {
  const начало = Date.now();
  try {
    const { stdout, stderr } = await run(файл, аргументы, { timeout: timeoutMs, maxBuffer: 8 << 20 });
    return { имя, ок: true, мс: Date.now() - начало, вывод: (stdout || stderr).trim().slice(0, 1500) };
  } catch (error) {
    const текст = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join(' | ');
    return { имя, ок: false, мс: Date.now() - начало, вывод: String(текст).trim().slice(0, 1500) };
  }
}

const jxa = (код) => ['-l', 'JavaScript', '-e', код];
const applescript = (код) => ['-e', код];

const итоги = [];
async function проба(имя, файл, аргументы) {
  const итог = await попытка(имя, файл, аргументы);
  итоги.push(итог);
  console.log(`\n=== ${имя} — ${итог.ок ? 'вышло' : 'ОТКАЗ'} (${итог.мс} мс)`);
  console.log(итог.вывод || '(пусто)');
  return итог;
}

// --- 1. Список окон без Универсального доступа -------------------------------
//
// CGWindowListCopyWindowInfo отдаёт CFArrayRef. В JXA его надо сперва
// превратить в объект ObjC, иначе deepUnwrap возвращает не массив — на этом
// первый заход и упал.
const CG_LIST = `
  ObjC.import('CoreGraphics');
  ObjC.import('Foundation');
  const ref = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  const data = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  const rows = data.slice(0, 15).map((w) => ({
    app: w.kCGWindowOwnerName,
    title: w.kCGWindowName === undefined ? '(заголовок скрыт)' : w.kCGWindowName,
    pid: w.kCGWindowOwnerPID,
    layer: w.kCGWindowLayer,
  }));
  JSON.stringify({ всего: data.length, первые: rows }, null, 1);
`;

// --- 2. Мышь через CoreGraphics ----------------------------------------------
// cliclick на маке не стоит, ставить его установщиком не хочется: лишняя
// зависимость ради двух вызовов. CGEvent есть в системе всегда.
const CG_MOUSE = `
  ObjC.import('CoreGraphics');
  const point = $.CGPointMake(120, 120);
  const move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, move);
  const where = $.CGEventGetLocation($.CGEventCreate($()));
  'курсор после переноса: ' + where.x + ',' + where.y;
`;

// --- 3. Клавиши через System Events ------------------------------------------
const SE_KEY = `
  tell application "System Events" to key code 123
  return "клавиша ушла"
`;

// --- 4. Весь путь управления окном на настоящем окне -------------------------
//
// Запускаем TextEdit и проверяем то самое, на чём сегодня погорели на
// Windows: видно ли окно, когда оно свёрнуто, и разворачивается ли обратно.
const SE_WINDOW_CYCLE = `
  tell application "TextEdit" to activate
  delay 1.5
  tell application "System Events"
    tell process "TextEdit"
      set имена to name of every window
      if (count of windows) is 0 then return "TextEdit без окон: " & (имена as text)
      set w to window 1
      set былоСвёрнуто to (value of attribute "AXMinimized" of w) as text
      set value of attribute "AXMinimized" of w to true
      delay 1
      set сталоСвёрнуто to (value of attribute "AXMinimized" of w) as text
      set видноСвёрнутым to (name of w)
      set value of attribute "AXMinimized" of w to false
      delay 1
      set послеРазворота to (value of attribute "AXMinimized" of w) as text
      set frontmost to true
      return "окно «" & видноСвёрнутым & "»; было=" & былоСвёрнуто & " свернули=" & сталоСвёрнуто & " развернули=" & послеРазворота
    end tell
  end tell
`;

// --- 5. Поднять программу по имени -------------------------------------------
const SE_RAISE = `
  tell application "System Events"
    set p to first process whose name contains "TextEdit"
    set frontmost of p to true
    return "впереди: " & (name of first process whose frontmost is true)
  end tell
`;

await проба('CGWindowList: список окон без Универсального доступа', 'osascript', jxa(CG_LIST));
await проба('CGEvent: перенос курсора', 'osascript', jxa(CG_MOUSE));
await проба('System Events: клавиша', 'osascript', applescript(SE_KEY));
await проба('Весь путь: найти окно, свернуть, увидеть, развернуть', 'osascript', applescript(SE_WINDOW_CYCLE));
await проба('System Events: поднять программу по имени', 'osascript', applescript(SE_RAISE));
await проба('CGWindowList ПОСЛЕ запуска TextEdit', 'osascript', jxa(CG_LIST));

console.log('\n=== сводка');
for (const итог of итоги) console.log(`${итог.ок ? 'вышло ' : 'ОТКАЗ '} ${итог.имя}`);
