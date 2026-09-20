/**
 * Что на этой машине установлено и что из этого Windows умеет запустить.
 *
 * Две разные вещи, и путать их дорого.
 *
 * ПУСКОВОЕ ИМЯ — строка, которую понимает `start`: она ищется в PATH, а если
 * там нет — в реестре, в «App Paths». Поэтому `chrome` работает, хотя ни в
 * каком PATH его нет, а `blender` не работает, хотя Blender установлен. Ровно
 * на этом сломался запуск: в пусковую таблицу попало «блендер → blender», имя
 * выглядело правдоподобно, проверить его было нечем, и Джарвис перестал
 * открывать то, что открывал.
 *
 * СПИСОК УСТАНОВЛЕННОГО — ярлыки меню «Пуск» плюс то, что Windows считает
 * запускаемым сама: программы из магазина и игры Steam ярлыков не имеют.
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface InstalledProgram {
  /** Имя, каким его видит человек в меню «Пуск». */
  name: string;
  /** Чем это запускается: путь к ярлыку, идентификатор из магазина или ссылка. */
  target: string;
  kind: 'path' | 'aumid' | 'url';
  /** Папка издателя — она связывает игру с её запускателем. */
  folder?: string;
}

/** Как запускать то, что вернул Windows. */
export function startKind(target: string): 'path' | 'aumid' | 'url' {
  if (target.includes('://')) return 'url';
  return 'aumid';
}

async function walkShortcuts(dir: string, depth: number, into: InstalledProgram[]): Promise<void> {
  if (depth > 4) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkShortcuts(full, depth + 1, into);
    } else if (entry.name.toLowerCase().endsWith('.lnk')) {
      into.push({
        name: entry.name.slice(0, -4),
        target: full,
        kind: 'path',
        folder: path.basename(dir),
      });
    }
  }
}

/** То, что Windows считает запускаемым: магазин, игры, ярлыки без .lnk. */
async function listShellApps(): Promise<Array<{ name: string; appId: string }>> {
  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Кодировка задаётся здесь, а не предполагается: при перенаправленном
        // выводе PowerShell пишет кодовой страницей консоли, Node читает как
        // UTF-8, и «Архиватор Windows» приезжает мусором.
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
          'Get-StartApps | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as Array<{ Name?: string; AppID?: string }>;
    return parsed
      .filter((entry) => entry.Name && entry.AppID)
      .map((entry) => ({ name: entry.Name as string, appId: entry.AppID as string }));
  } catch (error) {
    // Молчать нельзя. Пустой список выглядит как «ничего не установлено», а на
    // деле это половина правды — и половина опасная: без записей из магазина
    // «дота» не находит Dota 2 и уходит искать среди остального, где ближайшим
    // по звуку оказываются «Источники данных ODBC». Ложные совпадения ловились
    // ровно в этом состоянии.
    console.error('[jarvis] список программ из магазина не получен:', error);
    return [];
  }
}

/**
 * Все программы, о которых машина знает.
 *
 * Список из одних ярлыков — половина правды, и половина опасная: без записей
 * из магазина «дота» не находит Dota 2 и уходит искать среди остального, где
 * ближайшим по звуку оказываются «Источники данных ODBC».
 */
export async function listInstalledPrograms(): Promise<InstalledProgram[]> {
  const roots = [
    path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ProgramData ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ].filter((root) => root.length > 0);

  const found: InstalledProgram[] = [];
  for (const root of roots) await walkShortcuts(root, 0, found);

  for (const app of await listShellApps()) {
    if (found.some((item) => item.name.toLowerCase() === app.name.toLowerCase())) continue;
    found.push({ name: app.name, target: app.appId, kind: startKind(app.appId) });
  }
  return found;
}

/** Откуда `start` возьмёт программу, или null — если ниоткуда. */
export type StartSource = 'протокол' | 'PATH' | 'реестр' | null;

let machinePath: string | null = null;

/**
 * PATH машины, а не тот, что достался этому процессу.
 *
 * Разница ловится больно. Проверка, запущенная из Git Bash, наследует
 * `Git/usr/bin` — а там лежат `wordpad` и `notepad`, шелловские заглушки
 * самого Git. Проверка отвечала «запускается», Джарвис из своего окружения
 * этих файлов не видел. Спрашивать надо у Windows, а не у своей оболочки.
 */
async function systemPath(): Promise<string> {
  if (machinePath !== null) return machinePath;
  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + " +
          "[Environment]::GetEnvironmentVariable('Path','User')",
      ],
      { windowsHide: true },
    );
    machinePath = stdout.trim();
  } catch {
    machinePath = process.env.PATH ?? '';
  }
  return machinePath;
}

/** Окружение процесса с подменённым PATH: без своей оболочки в нём. */
async function cleanEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') continue;
    env[key] = value;
  }
  env.PATH = await systemPath();
  return env;
}

/**
 * Умеет ли Windows запустить эту строку.
 *
 * Спрашивается ровно то, что делает мост: `start <строка>`. Он смотрит в PATH
 * и в «App Paths» реестра — и больше никуда, поэтому правдоподобное имя
 * программы само по себе не значит ничего.
 */
export async function startSource(target: string): Promise<StartSource> {
  if (target.includes('://') || /^[a-z][a-z0-9+.-]*:$/iu.test(target)) return 'протокол';

  try {
    await run('where.exe', [target], { windowsHide: true, env: await cleanEnv() });
    return 'PATH';
  } catch {
    // Нет в PATH — значит остаётся реестр.
  }

  const key = String.raw`SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths`;
  for (const hive of ['HKLM', 'HKCU']) {
    for (const name of [`${target}.exe`, target]) {
      try {
        await run('reg', ['query', `${hive}\\${key}\\${name}`], { windowsHide: true });
        return 'реестр';
      } catch {
        // Следующее написание.
      }
    }
  }
  return null;
}
