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
