import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { claudeSummaryArgs } from '../lecture/summarize';
import { cliLaunch } from './spawnCli';

describe('пустое значение ключа', () => {
  it('не исчезает из строки для cmd.exe', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const { command } = cliLaunch('claude.cmd', ['--tools', '', '--print']);
    vi.restoreAllMocks();
    expect(command).toBe('claude.cmd --tools "" --print');
  });

  // Настоящий .cmd: так Claude Code стоит, если его поставил мастер через npm.
  // 04.11.2026 каждый конспект падал именно здесь, а .exe этого не показывал.
  it.runIf(process.platform === 'win32')('доходит через настоящий .cmd до программы', () => {
    const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis-cmd-'));
    try {
      const скрипт = path.join(папка, 'argv.js');
      writeFileSync(скрипт, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
      const shim = path.join(папка, 'fake claude.cmd');
      writeFileSync(shim, `@"${process.execPath}" "${скрипт}" %*\r\n`);
      const args = claudeSummaryArgs('sonnet', 'medium');
      const { command, args: остальное, shell } = cliLaunch(shim, args);
      const итог = spawnSync(command, остальное, { shell, encoding: 'utf8' });
      expect(JSON.parse(итог.stdout)).toEqual(args);
    } finally {
      rmSync(папка, { recursive: true, force: true });
    }
  });
});
