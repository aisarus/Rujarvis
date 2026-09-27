import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createCodexProbe } from './cliProbes';

/**
 * Пробы CLI на Windows: `codex.cmd` из npm — через оболочку, одной строкой.
 *
 * Живой лог владельца 26–27.09.2026: DEP0190 пять раз за шесть запусков —
 * пробы звали execFile с `shell: true` и отдельным массивом аргументов. Node
 * обещает это убрать, и тогда установленный codex.cmd стал бы «не установлен».
 * Проба настоящая: временный .cmd отвечает версией, как npm-обёртка.
 */
const временные: string[] = [];
afterEach(() => {
  for (const папка of временные.splice(0)) rmSync(папка, { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('пробы CLI через оболочку', () => {
  it('codex.cmd в папке с пробелом: версия читается, DEP0190 нет', async () => {
    const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis probe '));
    временные.push(папка);
    const cmd = path.join(папка, 'codex.cmd');
    writeFileSync(cmd, '@echo off\r\nif "%1"=="--version" (echo codex-cli 9.9.9) else (echo Not logged in)\r\n', 'utf8');

    const предупреждения: string[] = [];
    const слушатель = (w: Error & { code?: string }) => предупреждения.push(w.code ?? w.name);
    process.on('warning', слушатель);
    try {
      const статус = await createCodexProbe({ ...process.env, JARVIS_CODEX_PATH: cmd }).status();
      expect(статус.installed).toBe(true);
      expect(статус.version).toBe('codex-cli 9.9.9');
    } finally {
      process.off('warning', слушатель);
    }
    expect(предупреждения).not.toContain('DEP0190');
  }, 20_000);
});
