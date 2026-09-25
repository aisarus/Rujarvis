import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { START_APPS_COMMAND } from './installed';

const run = promisify(execFile);
const onWindows = process.platform === 'win32';

/**
 * Проверка кодировки списка установленных программ.
 *
 * Живёт отдельно от самого списка нарочно: ошибка была не в разборе, а в том,
 * как Node читает вывод PowerShell, и поймать её можно только настоящим
 * запуском.
 *
 * Стоила она дорого и тихо: «Архиватор Windows» приезжал как «��娢��� Windows»,
 * и ни одна программа с русским именем не находилась голосом.
 */
// Строка берётся из самого кода, а не переписывается сюда. Со своей копией
// проверка оставалась зелёной после удаления `[Console]::OutputEncoding` из
// `installed.ts` — то есть защищала свой текст, а не работу программы.
const COMMAND = START_APPS_COMMAND;

describe.runIf(onWindows)('список установленных программ', () => {
  it(
    'отдаёт имена в том виде, в каком их видит человек',
    async () => {
      const { stdout } = await run(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', COMMAND],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      );

      const apps = JSON.parse(stdout) as Array<{ Name?: string }>;
      expect(apps.length).toBeGreaterThan(10);

      const names = apps.map((app) => app.Name ?? '').join(' ');

      // Символ замены появляется ровно тогда, когда байты прочитаны не той
      // кодировкой. Одного его достаточно, чтобы признать список испорченным.
      expect(names).not.toContain('�');
    },
    90_000,
  );
});
