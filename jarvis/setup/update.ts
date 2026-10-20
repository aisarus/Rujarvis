/**
 * Обновление установленного Джарвиса из самой программы.
 *
 * Установка — это клон репозитория в `<папка Джарвиса>/src`, собранный на
 * машине человека, а повторный запуск установщика и есть обновление. Только
 * знать об этом должен человек. Первый живой тестер 20.10.2026 получил
 * исправление, вводя в PowerShell `git pull` и `pnpm build` по инструкции, —
 * для продукта так нельзя.
 *
 * Поэтому программа сама спрашивает GitHub, нет ли новой версии, показывает,
 * что в ней изменилось (заголовки коммитов — они пишутся по-русски и для
 * людей), и по кнопке запускает свежий установщик в отдельном окне: Джарвис
 * закрывается, установщик собирает новую версию и запускает её сам.
 *
 * Модуль не знает про Электрон: проверяется тестами без приложения.
 */

import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { tr } from '../locale/language';

/** Git в папке исходников: аргументы → вывод. Отказ — исключение. */
export type Git = (args: readonly string[], options?: { timeoutMs?: number }) => Promise<string>;

export function runGit(dir: string): Git {
  return (args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', dir, ...args],
        { timeout: options?.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr || error.message).trim().slice(0, 400)));
          else resolve(stdout);
        },
      );
    });
}

export interface Version {
  sha: string;
  short: string;
  /** Дата коммита, YYYY-MM-DD. */
  date: string;
  subject: string;
}

export type UpdateCheck =
  | { state: 'current'; branch: string }
  | { state: 'available'; branch: string; latest: string; changes: string[]; more: boolean }
  /** Проверить нечем или не вышло — ни «есть», ни «нет», а честное «не знаю». */
  | { state: 'unknown'; reason: string };

/** Сколько изменений показывать списком; остальное — «и ещё». */
const ПОКАЗАТЬ = 30;

/**
 * Запущена ли установленная копия, которую можно обновлять установщиком.
 *
 * Копия разработчика (клон где-то на рабочем столе) обновляется git'ом в
 * руках разработчика: запусти мы в ней установщик, он поставил бы вторую
 * копию в папку Джарвиса, а эта осталась бы как была.
 */
export function isInstalledCopy(appRoot: string, sourceDir: string): boolean {
  const одно = (p: string) => path.resolve(p).toLowerCase();
  return одно(appRoot) === одно(sourceDir) && existsSync(path.join(appRoot, '.git'));
}

export async function currentVersion(git: Git): Promise<Version> {
  const [sha = '', short = '', date = '', ...тема] = (await git(['log', '-1', '--format=%H%x09%h%x09%cs%x09%s'])).trim().split('\t');
  return { sha, short, date, subject: тема.join('\t') };
}

/**
 * Есть ли новая версия на GitHub.
 *
 * Ветка — та, на которой стоит установка (установщик ставит `main`, но
 * умеет и другую через `-Branch`). Refspec — тот же, что у установщика: клон
 * сделан с `--depth 1 --branch`, и простой `fetch` не завёл бы
 * `origin/<ветка>`.
 */
export async function checkForUpdate(git: Git): Promise<UpdateCheck> {
  let branch: string;
  try {
    branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch (error) {
    return { state: 'unknown', reason: `${tr('не прочитал версию', 'could not read the version')}: ${сообщение(error)}` };
  }
  if (!branch || branch === 'HEAD') {
    return { state: 'unknown', reason: tr('исходники не на ветке — обновлять нечего', 'the sources are not on a branch — nothing to update') };
  }
  try {
    await git(['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { timeoutMs: 90_000 });
  } catch (error) {
    return { state: 'unknown', reason: `${tr('GitHub не ответил', 'GitHub did not answer')}: ${сообщение(error)}` };
  }
  try {
    const [мой, свежий] = await Promise.all([
      git(['rev-parse', 'HEAD']).then((s) => s.trim()),
      git(['rev-parse', `origin/${branch}`]).then((s) => s.trim()),
    ]);
    if (мой === свежий) return { state: 'current', branch };
    // Своя версия впереди GitHub — обновлять не на что.
    if (await git(['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD']).then(() => true, () => false)) {
      return { state: 'current', branch };
    }
    const строки = (await git(['log', '--no-merges', `-n${ПОКАЗАТЬ + 1}`, '--format=%s', `HEAD..origin/${branch}`]))
      .split(/\r?\n/u)
      .map((s) => s.trim())
      .filter(Boolean);
    return { state: 'available', branch, latest: свежий, changes: строки.slice(0, ПОКАЗАТЬ), more: строки.length > ПОКАЗАТЬ };
  } catch (error) {
    return { state: 'unknown', reason: `${tr('не сравнил версии', 'could not compare versions')}: ${сообщение(error)}` };
  }
}

function сообщение(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/u)[0]?.slice(0, 200) ?? '';
}

// ——— Запуск обновления ———

export interface UpdateLaunch {
  /** Процесс Джарвиса: окно обновления ждёт, пока он закроется. */
  pid: number;
  /** Папка Джарвиса — корень установки. */
  home: string;
  logs: string;
  branch: string;
  language: 'ru' | 'en';
  /** Модель распознавания из настроек: установщик не должен сменить её на «рекомендованную». */
  whisperModel?: string;
}

const МОДЕЛИ_УСТАНОВЩИКА = new Set(['tiny', 'base', 'small', 'turbo', 'medium']);

/** Строка PowerShell в одинарных кавычках: своя кавычка удваивается. */
function пс(значение: string): string {
  return `'${значение.replace(/'/gu, "''")}'`;
}

/** Строка оболочки в одинарных кавычках. */
function sh(значение: string): string {
  return `'${значение.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Сценарий окна обновления на Windows.
 *
 * Сначала ждёт, пока закроется сам Джарвис: установщик гасит работающую
 * копию вместе с её детьми, и окно, запущенное Джарвисом, погибло бы с ним.
 * Потом — свежий установщик с теми же языком и моделью. Упал — окно не
 * закрывается: причину надо прочитать, а не поймать взглядом.
 */
export function windowsUpdateScript(o: UpdateLaunch, installer: string): string {
  const журнал = path.win32.join(o.logs, 'update.log');
  const параметры = [`-Language ${пс(o.language)}`, `-InstallRoot ${пс(o.home)}`, `-Branch ${пс(o.branch)}`];
  if (o.whisperModel && МОДЕЛИ_УСТАНОВЩИКА.has(o.whisperModel)) параметры.push(`-WhisperModel ${пс(o.whisperModel)}`);
  return [
    '# Rujarvis: обновление. Файл пишет сама программа перед каждым обновлением.',
    "$ErrorActionPreference = 'Stop'",
    "try { $Host.UI.RawUI.WindowTitle = 'Rujarvis' } catch {}",
    `Write-Host ''`,
    `Write-Host ${пс(tr('  Обновляю Джарвис. Это займёт несколько минут, потом он запустится сам.', '  Updating Jarvis. This takes a few minutes, then it starts by itself.'))} -ForegroundColor Cyan`,
    `$deadline = (Get-Date).AddSeconds(90)`,
    `while ((Get-Process -Id ${o.pid} -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 300 }`,
    '$ok = $false',
    `try { Start-Transcript -Path ${пс(журнал)} -Force | Out-Null } catch {}`,
    'try {',
    `    & ${пс(installer)} ${параметры.join(' ')}`,
    '    $ok = $true',
    '} catch {',
    `    Write-Host ''`,
    `    Write-Host (${пс(tr('  Обновление не удалось: ', '  The update failed: '))} + $_.Exception.Message) -ForegroundColor Red`,
    '}',
    'try { Stop-Transcript | Out-Null } catch {}',
    'if (-not $ok) {',
    `    Write-Host (${пс(tr('  Подробности: ', '  Details: '))} + ${пс(журнал)})`,
    `    Write-Host ${пс(tr('  Если Джарвис не запускается, повторите обновление командой установки.', '  If Jarvis does not start, repeat the update with the install command.'))}`,
    `    Read-Host ${пс(tr('  Нажмите Enter, чтобы закрыть окно', '  Press Enter to close this window'))} | Out-Null`,
    '} else {',
    '    Start-Sleep -Seconds 4',
    '}',
    '',
  ].join('\r\n');
}

/** Сценарий окна обновления на маке: тот же порядок, файл `.command` открывает Терминал. */
export function macUpdateScript(o: UpdateLaunch, installer: string): string {
  const журнал = path.posix.join(o.logs, 'update.log');
  const параметры = ['--language', o.language, '--branch', o.branch];
  if (o.whisperModel && МОДЕЛИ_УСТАНОВЩИКА.has(o.whisperModel)) параметры.push('--whisper-model', o.whisperModel);
  return [
    '#!/bin/bash',
    '# Rujarvis: обновление. Файл пишет сама программа перед каждым обновлением.',
    'set -o pipefail',
    `echo; echo ${sh(tr('  Обновляю Джарвис. Это займёт несколько минут, потом он запустится сам.', '  Updating Jarvis. This takes a few minutes, then it starts by itself.'))}; echo`,
    'for _ in $(seq 1 300); do',
    `  kill -0 ${o.pid} 2>/dev/null || break`,
    '  sleep 0.3',
    'done',
    `if bash ${sh(installer)} ${параметры.map(sh).join(' ')} 2>&1 | tee ${sh(журнал)}; then`,
    `  echo; echo ${sh(tr('  Готово. Окно можно закрыть.', '  Done. You can close this window.'))}`,
    'else',
    `  echo; echo ${sh(tr('  Обновление не удалось. Подробности: ', '  The update failed. Details: '))}${sh(журнал)}`,
    `  read -r -p ${sh(tr('  Нажмите Enter, чтобы закрыть окно ', '  Press Enter to close this window '))}`,
    'fi',
    '',
  ].join('\n');
}

export interface StartUpdateOptions extends UpdateLaunch {
  sourceDir: string;
  platform?: NodeJS.Platform;
  /** Окно обновления видно человеку; в проверках — скрыто. */
  windowStyle?: 'Normal' | 'Hidden';
  spawnImpl?: typeof spawn;
}

/**
 * Достать свежий установщик из только что скачанной ветки — байтами, как
 * есть: PowerShell 5.1 читает файл без BOM в кодировке системы, и русские
 * строки установщика превратились бы в мусор.
 */
function достатьУстановщик(sourceDir: string, branch: string, file: string, куда: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', sourceDir, 'show', `origin/${branch}:${file}`],
      { encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (error, stdout) => {
        if (error) return reject(new Error(`${tr('нет установщика в ветке', 'no installer in the branch')} ${branch}: ${сообщение(error)}`));
        writeFileSync(куда, stdout);
        resolve();
      },
    );
  });
}

/**
 * Подготовить и запустить окно обновления. Вызывающий после этого
 * закрывает Джарвис — окно ждёт именно этого.
 *
 * Все файлы — в `<папка Джарвиса>/update`: всё на диске живёт под одной
 * крышей.
 *
 * На Windows окно открывает скрытый PowerShell через `Start-Process`, а
 * команда передаётся в `-EncodedCommand`. Так путь с кириллицей в имени
 * пользователя («Алексей») не проходит ни через чьи кавычки и кодовые
 * страницы — на этом уже спотыкались вход в CLI и распознавание лекций. А
 * родитель окна — этот скрытый PowerShell, не Джарвис: установщик,
 * гасящий Джарвиса со всеми детьми, окно обновления не тронет.
 */
export async function startUpdate(o: StartUpdateOptions): Promise<void> {
  const platform = o.platform ?? process.platform;
  const spawnImpl = o.spawnImpl ?? spawn;
  const папка = path.join(o.home, 'update');
  mkdirSync(папка, { recursive: true });
  mkdirSync(o.logs, { recursive: true });

  if (platform === 'win32') {
    const установщик = path.win32.join(папка, 'install.ps1');
    await достатьУстановщик(o.sourceDir, o.branch, 'install.ps1', установщик);
    const сценарий = path.win32.join(папка, 'update.ps1');
    // BOM: PowerShell 5.1 без него читает файл в кодировке системы.
    writeFileSync(сценарий, `﻿${windowsUpdateScript(o, установщик)}`, 'utf8');
    const команда = [
      'Start-Process -FilePath powershell.exe',
      `-WindowStyle ${o.windowStyle ?? 'Normal'}`,
      `-ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ${пс(`"${сценарий}"`)})`,
    ].join(' ');
    const дитя = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(команда, 'utf16le').toString('base64')],
      { stdio: 'ignore', windowsHide: true },
    );
    await дождаться(дитя);
    return;
  }

  if (platform === 'darwin') {
    const установщик = path.posix.join(папка, 'install.sh');
    await достатьУстановщик(o.sourceDir, o.branch, 'install.sh', установщик);
    const сценарий = path.posix.join(папка, 'update.command');
    writeFileSync(сценарий, macUpdateScript(o, установщик), 'utf8');
    chmodSync(сценарий, 0o755);
    // `open` файла `.command` открывает Терминал без разрешения на
    // автоматизацию — в отличие от osascript.
    const дитя = spawnImpl('open', ['-a', 'Terminal', сценарий], { stdio: 'ignore', detached: true });
    await дождаться(дитя);
    return;
  }

  throw new Error(tr('обновление из программы есть на Windows и маке', 'in-app update is available on Windows and macOS'));
}

/** Запускающий процесс должен отработать: молчаливый отказ здесь — Джарвис закрылся бы зря. */
function дождаться(дитя: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    дитя.once('error', reject);
    дитя.once('exit', (код) => (код === 0 ? resolve() : reject(new Error(`${tr('окно обновления не открылось, код', 'the update window did not open, code')} ${код}`))));
  });
}
