import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { cliLaunch, needsShell } from './spawnCli';

/**
 * Запуск CLI на Windows.
 *
 * Проба версии включала оболочку, а настоящие запуски — нет, и человек видел
 * «Claude Code готов» при том, что каждая задача кончалась «spawn EINVAL».
 * Вторая половина беды — пробел в пути: ПУТЬ доезжал до cmd.exe обрезанным по
 * первому пробелу, и CLI получал статус «не установлен».
 */
const ПУТЬ_С_ПРОБЕЛОМ = 'C:@Users@Иван Петров@AppData@Roaming@npm@claude.cmd'.split('@').join(String.fromCharCode(92));
const БС_ЗДЕСЬ = String.fromCharCode(92);

describe('needsShell', () => {
  it('на Windows требует оболочку для cmd и bat', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    expect(needsShell('claude.cmd')).toBe(true);
    expect(needsShell('CODEX.BAT')).toBe(true);
    // Node запускает обычный исполняемый файл сам, и оболочка тут только
    // добавила бы разбор кавычек там, где он не нужен.
    expect(needsShell('claude.exe')).toBe(false);
    expect(needsShell('claude')).toBe(false);
  });

  it('вне Windows оболочка не нужна никогда', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    expect(needsShell('claude.cmd')).toBe(false);
  });
});

describe('cliLaunch', () => {
  it('обычный файл отдаёт как есть', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    const итог = cliLaunch('/usr/bin/claude', ['--version']);
    expect(итог).toEqual({ command: '/usr/bin/claude', args: ['--version'], shell: false });
  });

  it('прячет пробел в пути за кавычки, а не теряет хвост', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const итог = cliLaunch(ПУТЬ_С_ПРОБЕЛОМ, ['--print']);
    expect(итог.shell).toBe(true);
    // Без кавычек cmd.exe увидел бы команду до первого пробела.
    expect(итог.command.startsWith('"')).toBe(true);
    expect(итог.command).toContain('Иван Петров');
    expect(итог.command).toContain('--print');
  });

  it('под оболочку отдаёт одну строку, а не список', () => {
    // Список при shell: true Node склеивает сам и ничего не экранирует —
    // и печатает об этом DEP0190 на каждый запуск.
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    expect(cliLaunch('claude.cmd', ['--print', 'сделай']).args).toEqual([]);
  });

  it('кавычит аргумент с пробелом, а не только команду', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const итог = cliLaunch('claude.cmd', ['--add-dir', 'C:' + БС_ЗДЕСЬ + 'Мои файлы']);
    expect(итог.command).toContain('"C:' + БС_ЗДЕСЬ + 'Мои файлы"');
  });

  it('удваивает кавычку внутри пути: так её понимает cmd.exe', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const итог = cliLaunch('claude.cmd', ['--print', 'скажи "привет"']);
    expect(итог.command).toContain('""привет""');
  });
});

/**
 * Настоящий cmd.exe и настоящая обёртка `.cmd`, как у npm.
 *
 * Строки выше проверяют, какую строку мы собрали, но не то, что из неё
 * вынет CLI. 27.09.2026 `pnpm jarvis:preflight -- --with-agent` поймал:
 * Codex на Windows отвечал «Error loading config.toml: invalid type:
 * string "{command=C:…» — у `-c mcp_servers.…={command="C:\\…"}` без
 * пробелов кавычки не ставились, и разбор аргументов их съедал. С путём
 * «C:\Program Files\…» всё работало — поэтому живые проверки под tsx
 * проходили, а сервер под Электроном (путь без пробелов) — нет.
 */
describe.skipIf(process.platform !== 'win32')('cliLaunch через настоящий cmd.exe', () => {
  it('CLI получает аргументы ровно такими, какими их собрали', () => {
    const папка = mkdtempSync(path.join(os.tmpdir(), 'spawncli-'));
    writeFileSync(path.join(папка, 'echo.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))', 'utf8');
    // Как обёртка npm: node со скриптом рядом и все аргументы — через %*.
    const обёртка = path.join(папка, 'echo.cmd');
    writeFileSync(обёртка, `@"${process.execPath}" "%~dp0echo.cjs" %*\r\n`, 'utf8');

    const БС = String.fromCharCode(92);
    const аргументы = [
      'exec',
      `mcp_servers.jarvis-talk={command="C:${БС}${БС}a${БС}${БС}electron.exe",args=["C:${БС}${БС}b${БС}${БС}mcp.cjs"],env={X="1"}}`,
      'features.shell_tool=false',
      'скажи "привет" с пробелом',
    ];
    const запуск = cliLaunch(обёртка, аргументы);
    const итог = spawnSync(запуск.command, запуск.args, { shell: запуск.shell, encoding: 'utf8', windowsHide: true });
    expect(итог.status).toBe(0);
    expect(JSON.parse(итог.stdout) as string[]).toEqual(аргументы);
  });
});
