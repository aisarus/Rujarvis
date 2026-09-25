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

/**
 * Запрос списка программ к PowerShell.
 *
 * Вынесен наружу, потому что его проверяют настоящим запуском: ошибка была не
 * в разборе, а в том, как Node читает вывод PowerShell. Пока проверка держала
 * свою копию строки, удаление `[Console]::OutputEncoding` отсюда оставляло её
 * зелёной — а голосом переставали находиться программы с русскими именами.
 *
 * Кодировка задаётся здесь, а не предполагается: при перенаправленном выводе
 * PowerShell пишет кодовой страницей консоли, Node читает как UTF-8, и
 * «Архиватор Windows» приезжает мусором.
 */
export const START_APPS_COMMAND =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Get-StartApps | ConvertTo-Json -Compress';

/**
 * То, что Windows считает запускаемым: магазин, игры, ярлыки без .lnk.
 *
 * `null` — НЕ «ничего не нашлось», а «спросить не вышло». Разница в том, что
 * на первое чинят машину, а на второе — программу, и склеивать их нельзя:
 * без записей из магазина «дота» не находит Dota 2 и уходит искать среди
 * остального, где ближайшим по звуку оказываются «Источники данных ODBC».
 */
async function listShellApps(): Promise<Array<{ name: string; appId: string }> | null> {
  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        START_APPS_COMMAND,
      ],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    // Пустой вывод — это не пустой список, а немой PowerShell: Get-StartApps
    // на живой Windows не возвращает ноль программ никогда.
    if (!stdout.trim()) throw new Error('Get-StartApps ничего не ответил');
    const parsed = JSON.parse(stdout) as unknown;
    // Одна программа — и ConvertTo-Json отдаёт объект, а не массив: ключа
    // -AsArray в 5.1 нет, поэтому равняем здесь. Без этого `.filter` бросал
    // исключение, и оно превращалось в «ничего не установлено».
    const список = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ Name?: string; AppID?: string }>;
    return список
      .filter((entry) => entry && entry.Name && entry.AppID)
      .map((entry) => ({ name: entry.Name as string, appId: entry.AppID as string }));
  } catch (error) {
    // Молчать нельзя. Пустой список выглядит как «ничего не установлено», а на
    // деле это половина правды — и половина опасная: без записей из магазина
    // «дота» не находит Dota 2 и уходит искать среди остального, где ближайшим
    // по звуку оказываются «Источники данных ODBC». Ложные совпадения ловились
    // ровно в этом состоянии.
    console.error('[jarvis] список программ из магазина не получен:', error);
    return null;
  }
}

/** Список программ и то, полон ли он. */
export interface InstalledList {
  programs: InstalledProgram[];
  /**
   * `false` — записи магазина получить не вышло, и список неполон.
   *
   * Решать по неполному списку должен тот, кто его видит: «не нашёл» при
   * `полный: false` значит «не знаю», а не «не установлено».
   */
  полный: boolean;
}

/**
 * Все программы, о которых машина знает.
 *
 * Список из одних ярлыков — половина правды, и половина опасная: без записей
 * из магазина «дота» не находит Dota 2 и уходит искать среди остального, где
 * ближайшим по звуку оказываются «Источники данных ODBC».
 */
export async function listInstalledPrograms(): Promise<InstalledList> {
  // Проверяется сама переменная, а не склеенный путь: path.join('', 'Microsoft',
  // …) возвращает непустую ОТНОСИТЕЛЬНУЮ строку, и старый фильтр по длине не
  // отсекал ничего — обход шёл от текущей рабочей папки.
  const roots = [process.env.APPDATA, process.env.ProgramData]
    .filter((base): base is string => Boolean(base && base.trim()))
    .map((base) => path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));

  const found: InstalledProgram[] = [];
  for (const root of roots) await walkShortcuts(root, 0, found);

  const изМагазина = await listShellApps();
  for (const app of изМагазина ?? []) {
    if (found.some((item) => item.name.toLowerCase() === app.name.toLowerCase())) continue;
    found.push({ name: app.name, target: app.appId, kind: startKind(app.appId) });
  }
  return { programs: found, полный: изМагазина !== null };
}

/**
 * Откуда `start` возьмёт программу.
 *
 * `null` — ниоткуда, программы нет. `'неизвестно'` — спросить не вышло, и
 * это третий ответ, а не первый: на «нет» чинят машину, на «не спросили» —
 * программу. Свернуть одно в другое значит отправить человека чинить не то.
 */
export type StartSource = 'протокол' | 'PATH' | 'реестр' | 'неизвестно' | null;

let machinePath: string | null = null;

/**
 * PATH машины, а не тот, что достался этому процессу.
 *
 * Разница ловится больно. Проверка, запущенная из Git Bash, наследует
 * `Git/usr/bin` — а там лежат `wordpad` и `notepad`, шелловские заглушки
 * самого Git. Проверка отвечала «запускается», Джарвис из своего окружения
 * этих файлов не видел. Спрашивать надо у Windows, а не у своей оболочки.
 */
async function systemPath(): Promise<string | null> {
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
    if (!stdout.trim()) return null;
    machinePath = stdout.trim();
  } catch {
    // Молча подставить PATH процесса нельзя: там лежат заглушки Git, ради
    // которых эта функция и написана, и ответ «запускается» вышел бы по
    // заведомо неверному окружению — да ещё и осел бы в кэше до конца жизни
    // процесса. Лучше честное «не знаю».
    return null;
  }
  return machinePath;
}

/** Окружение процесса с подменённым PATH: без своей оболочки в нём. */
async function cleanEnv(): Promise<NodeJS.ProcessEnv | null> {
  const путь = await systemPath();
  if (путь === null) return null;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === 'path') continue;
    env[key] = value;
  }
  env.PATH = путь;
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

  const env = await cleanEnv();
  // PATH машины получить не вышло: спросить не у чего, и врать нечем.
  if (!env) return 'неизвестно';

  try {
    await run('where.exe', [target], { windowsHide: true, env });
    return 'PATH';
  } catch (error) {
    // where.exe говорит «не найдено» кодом 1. Всё остальное — не ответ:
    // самого where нет, вызов оборвался по тайм-ауту, процесс убит. Считать
    // это за «не найдено» значит выдать «нечем мерить» за «не установлено».
    if (!сказалНеНашёл(error)) return 'неизвестно';
  }

  const key = String.raw`SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths`;
  let спроситьНеВышло = false;
  for (const hive of ['HKLM', 'HKCU']) {
    for (const name of [`${target}.exe`, target]) {
      try {
        await run('reg', ['query', `${hive}\\${key}\\${name}`], { windowsHide: true });
        return 'реестр';
      } catch (error) {
        // reg query тоже отвечает «нет такого ключа» кодом 1.
        if (!сказалНеНашёл(error)) спроситьНеВышло = true;
      }
    }
  }
  return спроситьНеВышло ? 'неизвестно' : null;
}

/**
 * Отличает ответ «не найдено» от «спросить не вышло».
 *
 * И `where.exe`, и `reg query` сообщают «нет такого» кодом возврата 1. Код 2
 * у where — «неверные аргументы», отсутствие самого файла даёт ENOENT, а
 * оборванный по тайм-ауту вызов не даёт кода вовсе.
 */
function сказалНеНашёл(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 1;
}
