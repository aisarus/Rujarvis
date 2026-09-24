/**
 * Что на macOS доступно без разрешений, а что требует их.
 *
 * Драйвер окон для Mac писать вслепую нельзя: у Apple три разных замка, и
 * какой из них закрыт, на словах не узнать.
 *
 *   - список окон с именем программы и рамкой — CGWindowList, вроде бы без
 *     разрешений;
 *   - ЗАГОЛОВОК окна — с macOS 10.15 требует «Запись экрана»;
 *   - поднять, свернуть, нажать — требует «Универсальный доступ».
 *
 * Пробник гоняет каждый путь по отдельности и печатает, что вышло. Запускается
 * на настоящем маке в CI: машины под рукой нет, а гадать дороже.
 *
 *   node scripts/probe-darwin-windows.mjs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Выполнить и вернуть исход, не роняя пробник: отказ — тоже измерение. */
async function попытка(имя, файл, аргументы, timeoutMs = 20_000) {
  const начало = Date.now();
  try {
    const { stdout, stderr } = await run(файл, аргументы, { timeout: timeoutMs, maxBuffer: 8 << 20 });
    return { имя, ок: true, мс: Date.now() - начало, вывод: (stdout || stderr).trim().slice(0, 1200) };
  } catch (error) {
    const текст = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join(' | ');
    return { имя, ок: false, мс: Date.now() - начало, вывод: String(текст).trim().slice(0, 1200) };
  }
}

const jxa = (код) => ['-l', 'JavaScript', '-e', код];

// 1. Список окон через CoreGraphics. Имя программы и рамка — без разрешений;
//    заголовок приходит только с «Записью экрана».
const CG_LIST = `
  ObjC.import('CoreGraphics');
  ObjC.import('Foundation');
  const list = $.CGWindowListCopyWindowInfo(
    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
    $.kCGNullWindowID,
  );
  const data = ObjC.deepUnwrap(list) || [];
  const rows = data.slice(0, 12).map((w) => ({
    app: w.kCGWindowOwnerName,
    title: w.kCGWindowName === undefined ? '(нет заголовка)' : w.kCGWindowName,
    pid: w.kCGWindowOwnerPID,
    layer: w.kCGWindowLayer,
    bounds: w.kCGWindowBounds,
  }));
  JSON.stringify({ всего: data.length, первые: rows }, null, 1);
`;

// 2. Тот же список через System Events — этот путь требует «Универсальный доступ».
const SE_LIST = `
  tell application "System Events"
    set out to {}
    repeat with p in (every process whose background only is false)
      repeat with w in (every window of p)
        set end of out to (name of p) & " :: " & (name of w)
      end repeat
    end repeat
    return out
  end tell
`;

// 3. Признак свёрнутости — то, на чём мы сегодня погорели на Windows.
const SE_MINIMIZED = `
  tell application "System Events"
    set out to {}
    repeat with p in (every process whose background only is false)
      repeat with w in (every window of p)
        set end of out to (name of w) & " свёрнуто=" & (value of attribute "AXMinimized" of w as text)
      end repeat
    end repeat
    return out
  end tell
`;

// 4. Разрешён ли «Универсальный доступ» вообще — спрашиваем прямо, не пробуя
//    ничего сделать. Это и будет проверкой перед работой.
const AX_TRUSTED = `
  ObjC.import('ApplicationServices');
  String($.AXIsProcessTrusted());
`;

const пробы = [
  ['CGWindowList: список окон', 'osascript', jxa(CG_LIST)],
  ['AXIsProcessTrusted: дан ли Универсальный доступ', 'osascript', jxa(AX_TRUSTED)],
  ['System Events: список окон', 'osascript', ['-e', SE_LIST]],
  ['System Events: признак свёрнутости', 'osascript', ['-e', SE_MINIMIZED]],
  ['screencapture: снимок экрана', 'screencapture', ['-x', '/tmp/rujarvis-probe.png']],
  ['есть ли cliclick', 'which', ['cliclick']],
];

const итоги = [];
for (const [имя, файл, аргументы] of пробы) {
  const итог = await попытка(имя, файл, аргументы);
  итоги.push(итог);
  console.log(`\n=== ${имя} — ${итог.ок ? 'вышло' : 'ОТКАЗ'} (${итог.мс} мс)`);
  console.log(итог.вывод || '(пусто)');
}

console.log('\n=== сводка');
for (const итог of итоги) console.log(`${итог.ок ? 'вышло ' : 'ОТКАЗ '} ${итог.имя}`);
