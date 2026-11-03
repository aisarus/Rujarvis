import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkForUpdate, isInstalledCopy, runGit, startUpdate, windowsUpdateScript, type Git } from './update';

const папки: string[] = [];
afterEach(() => {
  for (const папка of папки.splice(0)) rmSync(папка, { recursive: true, force: true });
});

function временная(имя = 'jarvis-update-'): string {
  const папка = mkdtempSync(path.join(tmpdir(), имя));
  папки.push(папка);
  return папка;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
}

/** Репозиторий-«GitHub» с одним коммитом и подписью, чтобы git не спрашивал имя. */
function origin(): string {
  const dir = временная('jarvis-origin-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'install.ps1'), 'param()\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Первая версия');
  return dir;
}

function коммит(dir: string, тема: string): void {
  writeFileSync(path.join(dir, 'файл.txt'), тема);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', тема);
}

/** Установка — неглубокий клон, как у установщика. */
function клон(from: string): string {
  const dir = path.join(временная('jarvis-src-'), 'src');
  // `file://` — иначе git клонирует локальную папку целиком и `--depth` не действует.
  const адрес = from.replace(/\\/gu, '/');
  execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'main', `file://${адрес.startsWith('/') ? '' : '/'}${адрес}`, dir], { windowsHide: true });
  return dir;
}

describe('какая копия обновляется кнопкой', () => {
  it('только та, что лежит в папке Джарвиса и является клоном', () => {
    const home = временная();
    const src = path.join(home, 'src');
    mkdirSync(src);
    expect(isInstalledCopy(src, src)).toBe(false);
    mkdirSync(path.join(src, '.git'));
    expect(isInstalledCopy(src, src)).toBe(true);
    expect(isInstalledCopy(path.join(home, 'другая'), src)).toBe(false);
  });
});

describe('проверка новой версии', () => {
  const поддельный = (ответы: Record<string, string | Error>): Git => async (args) => {
    const ключ = args[0] ?? '';
    const ответ = ответы[`${ключ} ${args[1] ?? ''}`.trim()] ?? ответы[ключ];
    if (ответ instanceof Error) throw ответ;
    if (ответ === undefined) throw new Error(`не ждали: git ${args.join(' ')}`);
    return ответ;
  };

  it('нет связи — честное «не знаю», а не «последняя версия»', async () => {
    const итог = await checkForUpdate(поддельный({ 'rev-parse --abbrev-ref': 'main\n', fetch: new Error('Could not resolve host: github.com') }));
    expect(итог.state).toBe('unknown');
  });

  it('исходники не на ветке — обновлять нечего, и это сказано', async () => {
    expect((await checkForUpdate(поддельный({ 'rev-parse --abbrev-ref': 'HEAD\n' }))).state).toBe('unknown');
  });

  it('настоящий git: неглубокий клон видит новые коммиты и их заголовки', async () => {
    const гитхаб = origin();
    const src = клон(гитхаб);
    expect(await checkForUpdate(runGit(src))).toEqual({ state: 'current', branch: 'main' });

    коммит(гитхаб, 'Конспект лекции в Zoom');
    коммит(гитхаб, 'Распознавание: путь с кириллицей');
    const итог = await checkForUpdate(runGit(src));
    expect(итог).toMatchObject({ state: 'available', branch: 'main', more: false });
    if (итог.state !== 'available') throw new Error('ждали новую версию');
    expect(итог.changes).toEqual(['Распознавание: путь с кириллицей', 'Конспект лекции в Zoom']);
    expect(итог.latest).toBe(git(гитхаб, 'rev-parse', 'HEAD').trim());
  });

  it('своя версия впереди GitHub — не «обновление»', async () => {
    const гитхаб = origin();
    const src = клон(гитхаб);
    git(src, 'config', 'user.email', 'test@example.com');
    git(src, 'config', 'user.name', 'test');
    git(src, 'config', 'commit.gpgsign', 'false');
    коммит(src, 'Своя правка');
    expect((await checkForUpdate(runGit(src))).state).toBe('current');
  });
});

describe('окно обновления', () => {
  it('сценарий ждёт Джарвиса, передаёт язык и модель, кавычки в пути не ломают строку', () => {
    const текст = windowsUpdateScript(
      { pid: 4242, home: "C:\\Users\\Алексей O'Neil\\AppData\\Local\\Rujarvis", logs: 'C:\\x\\logs', branch: 'main', language: 'en', whisperModel: 'turbo' },
      'C:\\x\\update\\install.ps1',
    );
    expect(текст).toContain('Get-Process -Id 4242');
    expect(текст).toContain("-InstallRoot 'C:\\Users\\Алексей O''Neil\\AppData\\Local\\Rujarvis'");
    expect(текст).toContain("-Language 'en'");
    expect(текст).toContain("-WhisperModel 'turbo'");
    expect(текст).toContain('Read-Host');
  });

  it('модель, которой установщик не знает, не передаётся — иначе он упал бы на проверке параметра', () => {
    const текст = windowsUpdateScript({ pid: 1, home: 'C:\\h', logs: 'C:\\l', branch: 'main', language: 'ru', whisperModel: 'large' }, 'C:\\i.ps1');
    expect(текст).not.toContain('-WhisperModel');
  });

  // Настоящий PowerShell, настоящий git и путь с кириллицей и ивритом: на
  // кодировках путей уже ломались вход в CLI и распознавание лекций.
  it.runIf(process.platform === 'win32')(
    'Windows: свежий установщик из ветки запускается с нужными параметрами, путь с «Алексей» и ивритом доходит целым',
    async () => {
      const гитхаб = origin();
      writeFileSync(
        path.join(гитхаб, 'install.ps1'),
        [
          'param([string]$Language, [string]$InstallRoot, [string]$Branch, [string]$WhisperModel)',
          '"$Language|$Branch|$WhisperModel|$InstallRoot" | Set-Content -Encoding UTF8 -Path (Join-Path $InstallRoot "marker.txt")',
          '',
        ].join('\r\n'),
      );
      git(гитхаб, 'add', '.');
      git(гитхаб, 'commit', '-q', '-m', 'Установщик-пробник');
      const src = клон(гитхаб);
      const home = path.join(временная(), 'Алексей תיקיה', 'Rujarvis');
      mkdirSync(home, { recursive: true });
      // Джарвис «уже закрылся»: pid завершившегося процесса.
      const ушедший = spawn(process.execPath, ['-e', '']);
      await new Promise((resolve) => ушедший.once('exit', resolve));

      await startUpdate({
        pid: ушедший.pid ?? 0,
        home,
        logs: path.join(home, 'logs'),
        sourceDir: src,
        branch: 'main',
        language: 'ru',
        whisperModel: 'small',
        windowStyle: 'Hidden',
      });

      const метка = path.join(home, 'marker.txt');
      for (let i = 0; i < 150 && !existsSync(метка); i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
      expect(readFileSync(метка, 'utf8').replace(/^\uFEFF/u, '').trim()).toBe(`ru|main|small|${home}`);
      // Журнал обновления — рядом с журналом Джарвиса.
      for (let i = 0; i < 50 && !existsSync(path.join(home, 'logs', 'update.log')); i += 1) await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(path.join(home, 'logs', 'update.log'))).toBe(true);
      // Дать окну дойти до конца, прежде чем папка уйдёт в уборку.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    },
    60_000,
  );
});
