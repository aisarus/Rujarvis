import { describe, expect, it } from 'vitest';

import { LAUNCH_NAMES, windowCandidates } from './launch';
import { listMacApplications, macAppName, parseRunningApps, quitMenuScript } from './macApps';

/**
 * Программы на маке (27.09.2026). Живьём — `pnpm jarvis:mac-apps-check` в CI
 * мака: открыть, увидеть запущенной, закрыть.
 */
describe('программы на маке', () => {
  it('у каждой цели таблицы запуска есть имя программы мака', () => {
    // Иначе новая строка таблицы на Windows открывается, а на маке — «Не смог
    // открыть»: так и было со всей таблицей до 27.09.2026.
    const безИмени = [...new Set(LAUNCH_NAMES.map(([, target]) => target))].filter((t) => !macAppName(t));
    expect(безИмени).toEqual([]);
    expect(macAppName('chrome')).toBe('Google Chrome');
    expect(macAppName('notepad')).toBe('TextEdit');
  });

  it('установленное — папки .app, без повторов, отсутствующая папка не мешает', () => {
    const папки: Record<string, string[]> = {
      '/Applications': ['Safari.app', 'Telegram.app', '.DS_Store', 'Утилиты'],
      '/System/Applications': ['Calculator.app', 'Safari.app'],
    };
    const список = listMacApplications(['/Applications', '/нет-такой', '/System/Applications'], (папка) => {
      const есть = папки[папка];
      if (!есть) throw new Error('ENOENT');
      return есть;
    });
    expect(список.полный).toBe(true);
    expect(список.programs.map((p) => p.name)).toEqual(['Safari', 'Telegram', 'Calculator']);
    expect(список.programs[0]).toEqual({ name: 'Safari', target: '/Applications/Safari.app', kind: 'path' });
  });

  it('запущенные: имя и pid из ответа System Events', () => {
    const US = String.fromCharCode(31);
    const RS = String.fromCharCode(30);
    expect(parseRunningApps(`Google Chrome${US}812${RS}TextEdit${US}90${RS}\n`)).toEqual([
      { name: 'Google Chrome', pid: 812 },
      { name: 'TextEdit', pid: 90 },
    ]);
    expect(parseRunningApps('')).toEqual([]);
  });

  it('«переключись на …» на маке ищет программу по её имени на маке', () => {
    // msedge, WindowsTerminal, explorer — имена процессов Windows; на маке
    // окна принадлежат Microsoft Edge, Terminal и Finder.
    expect(windowCandidates('эдж', 'darwin')).toEqual(['Microsoft Edge', 'эдж']);
    expect(windowCandidates('терминал', 'darwin')).toEqual(['Terminal', 'терминал']);
    expect(windowCandidates('проводник', 'darwin')).toEqual(['Finder', 'проводник']);
    expect(windowCandidates('настройки', 'darwin')).toEqual(['System Settings', 'настройки']);
    // На Windows — как было.
    expect(windowCandidates('эдж', 'win32')).toEqual(['msedge', 'эдж']);
    // Имени мака нет — остаётся имя таблицы: «blender» совпадает и там.
    expect(windowCandidates('блендер', 'darwin')).toEqual(['blender', 'блендер']);
  });

  it('«Завершить» ищется по ⌘Q, а не по надписи на языке системы', () => {
    const скрипт = quitMenuScript(4321);
    expect(скрипт).toContain('unix id is 4321');
    expect(скрипт).toContain('AXMenuItemCmdChar');
    expect(скрипт).not.toMatch(/Quit|Завершить/u);
  });
});
