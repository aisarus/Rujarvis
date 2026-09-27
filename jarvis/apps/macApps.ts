/**
 * Программы на маке: открыть, найти установленные, найти запущенные, закрыть.
 *
 * На Windows это `cmd /c start`, меню «Пуск», `tasklist` и `taskkill`. На маке
 * ни одного из них нет, и до 27.09.2026 «открой хром» отвечал «Не смог
 * открыть», «открой что-то ещё» — «Windows не ответил про магазин», а
 * «закрой хром» уходил агенту на минуты. Здесь — то же самое штатными
 * средствами мака: `open`, папки программ, System Events.
 *
 * Голосовой мост и проверка в CI зовут одни и те же функции: проверка, у
 * которой своя копия, зеленела бы и тогда, когда мост от неё отступил.
 */
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { InstalledList, InstalledProgram } from './installed';

const запустить = promisify(execFile);

/**
 * Имена таблицы запуска (они по-виндовому: `chrome`, `msedge`, `wt`) — в
 * имена программ мака. Блокнота, проводника и параметров на маке нет —
 * ближайшее по смыслу: TextEdit, Finder, Системные настройки.
 */
const MAC_APPS: Readonly<Record<string, string>> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  telegram: 'Telegram',
  firefox: 'Firefox',
  notepad: 'TextEdit',
  wordpad: 'TextEdit',
  calc: 'Calculator',
  explorer: 'Finder',
  wt: 'Terminal',
  code: 'Visual Studio Code',
  spotify: 'Spotify',
  winword: 'Microsoft Word',
  excel: 'Microsoft Excel',
  'ms-settings:': 'System Settings',
  // Оконные имена Windows — для «переключись на …»: на маке окно
  // принадлежит программе, и зовётся она иначе.
  windowsterminal: 'Terminal',
  systemsettings: 'System Settings',
  obs64: 'OBS',
  dota2: 'Dota 2',
};

/** Имя программы мака для цели из таблицы запуска, или `null`. */
export function macAppName(target: string): string | null {
  return MAC_APPS[target.toLowerCase()] ?? null;
}

/** Где мак держит программы: системные, общие и свои у человека. */
export function macAppFolders(home = os.homedir()): string[] {
  return [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    path.join(home, 'Applications'),
  ];
}

/**
 * Установленные программы — папки `.app`.
 *
 * Список полный по определению: магазина, который мог бы не ответить, здесь
 * нет — программы из App Store лежат в тех же папках.
 */
export function listMacApplications(
  folders: readonly string[] = macAppFolders(),
  read: (folder: string) => string[] = (folder) => readdirSync(folder),
): InstalledList {
  const programs: InstalledProgram[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    let names: string[];
    try {
      names = read(folder);
    } catch {
      continue;
    }
    for (const entry of names) {
      if (!entry.endsWith('.app')) continue;
      const name = entry.slice(0, -'.app'.length);
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      // posix нарочно: пути маковские, и проверка на Windows обязана видеть их такими же.
      programs.push({ name, target: path.posix.join(folder, entry), kind: 'path' });
    }
  }
  return { programs, полный: true };
}

/**
 * Открыть программу, путь или ссылку — и узнать, вышло ли.
 *
 * `open` ждётся до конца, а не отпускается: он отвечает быстро и честно
 * («Unable to find application named …»), и сказать «Открываю», когда ничего
 * не открылось, значило бы соврать.
 */
export async function openOnMac(target: string, kind: 'path' | 'aumid' | 'url' | 'app'): Promise<void> {
  const args = kind === 'app' ? ['-a', target] : [target];
  try {
    await запустить('open', args, { timeout: 15_000 });
  } catch (беда) {
    const stderr = (беда as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (беда instanceof Error ? беда.message : String(беда)));
  }
}

/** Запущенная программа с окнами — как её видит System Events. */
export interface MacRunningApp {
  name: string;
  pid: number;
}

const ПОЛЕ = String.fromCharCode(31);
const СТРОКА = String.fromCharCode(30);

/** Скрипт: имя и pid каждой программы переднего плана. */
export const RUNNING_APPS_SCRIPT = [
  'set out to ""',
  'tell application "System Events"',
  '  repeat with p in (every application process whose background only is false)',
  `    set out to out & (name of p) & (ASCII character 31) & (unix id of p) & (ASCII character 30)`,
  '  end repeat',
  'end tell',
  'return out',
].join('\n');

/** Разобрать ответ `RUNNING_APPS_SCRIPT`. */
export function parseRunningApps(stdout: string): MacRunningApp[] {
  const apps: MacRunningApp[] = [];
  for (const row of stdout.split(СТРОКА)) {
    const [name, pid] = row.trim().split(ПОЛЕ);
    const номер = Number.parseInt(pid ?? '', 10);
    if (name && Number.isFinite(номер)) apps.push({ name, pid: номер });
  }
  return apps;
}

/**
 * Что голосом не закрывается: оболочка мака и сам Джарвис — как `explorer`
 * и системные процессы на Windows.
 */
const MAC_PROTECTED = new Set(['finder', 'dock', 'systemuiserver', 'loginwindow', 'controlcenter', 'electron', 'rujarvis']);

/** Программы переднего плана; сбой — пустой список, как у `tasklist`. */
export async function listMacRunningApps(): Promise<MacRunningApp[]> {
  try {
    const { stdout } = await запустить('osascript', ['-e', RUNNING_APPS_SCRIPT], { timeout: 15_000 });
    return parseRunningApps(stdout).filter((app) => !MAC_PROTECTED.has(app.name.toLowerCase()));
  } catch {
    return [];
  }
}

/**
 * Запустить то, что отдала таблица или список установленного.
 *
 * Путь к `.app` и ссылка открываются как есть; имя из таблицы запуска
 * (`chrome`) — переводится в имя программы мака.
 */
export async function launchOnMac(target: string, kind: 'path' | 'aumid' | 'url'): Promise<void> {
  if (kind === 'url' || target.startsWith('/')) return openOnMac(target, kind);
  return openOnMac(macAppName(target) ?? target, 'app');
}

/** Строка AppleScript в кавычках. */
function appleString(text: string): string {
  return `"${text.split('\\').join('\\\\').split('"').join('\\"')}"`;
}

/**
 * Попросить программу выйти — как Cmd+Q.
 *
 * Несохранённое программа спросит сама, и это правильно: штатный выход не
 * теряет работу. Принудительный — отдельно и только с согласия человека.
 */
export async function quitMacApp(name: string): Promise<void> {
  const app = (await listMacRunningApps()).find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (app) {
    try {
      const { stdout } = await запустить('osascript', ['-e', quitMenuScript(app.pid)], { timeout: 15_000 });
      if (stdout.trim() === 'ok') return;
    } catch {
      // Меню не прочиталось — ниже прямая просьба.
    }
  }
  // Запасной путь — просьба самой программе. Без ожидания ответа: программа
  // с несохранённым показывает «Сохранить?», и `quit` висел бы до срока Apple
  // Events — двух минут. Вышла ли она, смотрит `quitAndWait`.
  const скрипт = ['ignoring application responses', `  tell application ${appleString(name)} to quit`, 'end ignoring'];
  await запустить('osascript', скрипт.flatMap((строка) => ['-e', строка]), { timeout: 15_000 });
}

/**
 * Нажать «Завершить» в меню программы — через System Events.
 *
 * Прямое `tell application "TextEdit" to …` в CI висело две минуты и падало
 * с -1712 (probe-darwin-driver, 24.09.2026): управлять каждой программой
 * macOS разрешает отдельно. System Events драйвер уже использует и разрешение
 * на него есть. Пункт ищется не по надписи — она на языке системы, — а по
 * сочетанию: ⌘Q без других модификаторов. Окно вперёд не выводится.
 */
export function quitMenuScript(pid: number): string {
  return [
    'tell application "System Events"',
    `  set p to first process whose unix id is ${Math.trunc(pid)}`,
    '  set m to menu 1 of menu bar item 2 of menu bar 1 of p',
    '  repeat with i in (reverse of (menu items of m))',
    '    try',
    '      if (value of attribute "AXMenuItemCmdChar" of i) is "Q" and (value of attribute "AXMenuItemCmdModifiers" of i) is 0 then',
    '        click i',
    '        return "ok"',
    '      end if',
    '    end try',
    '  end repeat',
    'end tell',
    'return "нет"',
  ].join('\n');
}

/** Запущена ли программа с таким именем. */
export async function isMacAppRunning(name: string): Promise<boolean> {
  return (await listMacRunningApps()).some((app) => app.name.toLowerCase() === name.toLowerCase());
}

/**
 * Попросить выйти и подождать: `true` — вышла.
 *
 * Не вышла за несколько секунд — почти всегда спрашивает про несохранённое.
 * Решать, терять ли его, — человеку, а не нам.
 */
export async function quitAndWait(name: string, waitMs = 4_000, stepMs = 400): Promise<boolean> {
  await quitMacApp(name);
  const конец = Date.now() + waitMs;
  while (Date.now() < конец) {
    await new Promise((готово) => setTimeout(готово, stepMs));
    if (!(await isMacAppRunning(name))) return true;
  }
  return false;
}

/**
 * Закрыть принудительно — сигналом каждому процессу этой программы.
 *
 * Номера берутся из только что прочитанного списка по точному имени, а не по
 * маске: гасится ровно то, что человек назвал и на что согласился.
 */
export async function forceQuitMacApp(name: string): Promise<boolean> {
  const свои = (await listMacRunningApps()).filter((app) => app.name.toLowerCase() === name.toLowerCase());
  for (const app of свои) {
    try {
      process.kill(app.pid, 'SIGKILL');
    } catch {
      // Уже вышла.
    }
  }
  return свои.length > 0;
}
