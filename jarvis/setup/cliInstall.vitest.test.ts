import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { jarvisCliPath, resolveCli } from '../backends/cliProbes';
import { findNpm, installCli, npmFailure, type Runner } from './cliInstall';

describe('npm для установки агента', () => {
  it('из PATH, а нет в PATH — там, где его кладут установщики Node', () => {
    const есть = new Set(['/opt/homebrew/bin/npm']);
    expect(findNpm({ PATH: '/usr/bin:/bin' }, (f) => есть.has(f.split(path.sep).join('/')), 'darwin')?.split(path.sep).join('/')).toBe('/opt/homebrew/bin/npm');
    expect(findNpm({ PATH: '' }, () => false, 'darwin')).toBeNull();
    const win = findNpm({ PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, (f) => f.endsWith(path.join('nodejs', 'npm.cmd')), 'win32');
    expect(win).toContain('npm.cmd');
  });
});

describe('Claude Code или Codex кнопкой', () => {
  const дом = path.join('/tmp', 'jarvis-home');

  it('общая папка npm — первым делом; встал — путь к нему', async () => {
    const вызовы: string[][] = [];
    const run: Runner = async (_npm, args) => {
      вызовы.push(args);
      return { code: 0, output: 'added 1 package' };
    };
    const итог = await installCli('codex', { home: дом, npm: 'npm', run, found: () => '/opt/homebrew/bin/codex' });
    expect(итог).toEqual({ ok: true, path: '/opt/homebrew/bin/codex', where: 'npm' });
    expect(вызовы).toEqual([['install', '-g', '@openai/codex']]);
  });

  it('в общую папку нельзя (EACCES) — в папку Джарвиса, и его там находят', async () => {
    const вызовы: string[][] = [];
    const run: Runner = async (_npm, args) => {
      вызовы.push(args);
      return args.includes('--prefix') ? { code: 0, output: 'added 1 package' } : { code: 243, output: 'npm error code EACCES' };
    };
    const файл = jarvisCliPath('claude', дом);
    const итог = await installCli('claude', { home: дом, npm: 'npm', run, found: () => null, exists: (f) => f === файл });
    expect(итог).toEqual({ ok: true, path: файл, where: 'jarvis' });
    expect(вызовы[1]).toEqual(['install', '-g', '@anthropic-ai/claude-code', '--prefix', path.join(дом, 'node')]);
    // Поставленное туда resolveCli находит сам — кнопка «Проверить» его увидит.
    expect(resolveCli('claude', { JARVIS_HOME: дом, PATH: '' }, (f) => f === jarvisCliPath('claude', path.resolve(дом)))).toBe(jarvisCliPath('claude', path.resolve(дом)));
  });

  it('не встал никуда — причина словами, сеть — отдельно', async () => {
    const run: Runner = async () => ({ code: 1, output: 'npm error code ENOTFOUND\nnpm error network request failed' });
    const итог = await installCli('codex', { home: дом, npm: 'npm', run, found: () => null, exists: () => false });
    expect(итог.ok).toBe(false);
    expect(итог.ok ? '' : итог.message).toMatch(/интернет|internet/u);
    expect(npmFailure('npm error code E404\nnpm error 404 Not Found')).toContain('404');
  });

  it('npm нет вовсе — сказать, что делать, а не «ошибка»', async () => {
    const итог = await installCli('codex', { home: дом, npm: null });
    expect(итог.ok ? '' : итог.message).toMatch(/Node/u);
  });
});
