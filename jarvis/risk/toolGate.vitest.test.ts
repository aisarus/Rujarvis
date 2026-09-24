import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GateBridge } from './gateBridge';
import { decideToolUse } from './gateHook';
import { classifyToolUse, isSystemPath, within, type GateContext } from './toolGate';

const context: GateContext = {
  cwd: 'C:/Users/user/projects/site',
  outputDir: 'C:/Users/user/Desktop/Джарвис',
  homeDir: 'C:/Users/user/AppData/Local/Rujarvis',
  tempDir: 'C:/Users/user/AppData/Local/Temp',
  userHome: 'C:/Users/user',
};

const level = (tool: string, input: Record<string, unknown>) => classifyToolUse(tool, input, context).level;

describe('classifyToolUse', () => {
  it('lets ordinary shell work through and stops destructive and outward commands', () => {
    expect(level('Bash', { command: 'pnpm test' })).toBe('normal');
    expect(level('Bash', { command: 'git push origin main' })).toBe('sensitive');
    expect(level('Bash', { command: 'git push --force origin main' })).toBe('dangerous');
    expect(level('PowerShell', { command: 'Remove-Item C:/x -Recurse' })).toBe('dangerous');
  });

  it('treats writes by where they land', () => {
    expect(level('Write', { file_path: 'C:/Users/user/projects/site/index.html' })).toBe('normal');
    expect(level('Edit', { file_path: 'src/app.ts' })).toBe('normal');
    expect(level('Write', { file_path: 'C:/Users/user/Desktop/Джарвис/отчёт.md' })).toBe('normal');
    expect(level('Write', { file_path: 'C:/Users/user/Documents/diary.txt' })).toBe('sensitive');
    expect(level('Write', { file_path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' })).toBe('dangerous');
  });

  it('asks before the agent edits its own standing instructions or the CLI settings', () => {
    expect(level('Write', { file_path: 'C:/Users/user/AppData/Local/Rujarvis/data/характер.md' })).toBe('sensitive');
    expect(level('Edit', { file_path: 'C:/Users/user/.claude/settings.json' })).toBe('sensitive');
  });

  it('still lets work on Jarvis itself happen inside its sources, but not in its data', () => {
    const self = { ...context, cwd: 'C:/Users/user/AppData/Local/Rujarvis/src' };
    expect(classifyToolUse('Edit', { file_path: 'C:/Users/user/AppData/Local/Rujarvis/src/jarvis/core.ts' }, self).level).toBe('normal');
    expect(classifyToolUse('Write', { file_path: 'C:/Users/user/AppData/Local/Rujarvis/data/характер.md' }, self).level).toBe('sensitive');
  });

  it('reads buttons for money and messages to other people', () => {
    expect(level('mcp__jarvis-desktop__browser_click', { text: 'Оплатить заказ' })).toBe('dangerous');
    expect(level('mcp__jarvis-desktop__browser_click', { text: 'Buy now' })).toBe('dangerous');
    expect(level('mcp__jarvis-desktop__browser_click', { text: 'Отправить' })).toBe('sensitive');
    expect(level('mcp__jarvis-desktop__browser_click', { text: 'Документация' })).toBe('safe');
    expect(level('mcp__jarvis-desktop__browser_fill', { label: 'Номер карты', value: '4111' })).toBe('sensitive');
    expect(level('mcp__jarvis-desktop__browser_fill', { label: 'Поиск', value: 'погода' })).toBe('safe');
  });

  it('asks before a skill lands in every Claude Code session and before running a program', () => {
    expect(level('mcp__jarvis-desktop__write_skill', { name: 'x' })).toBe('sensitive');
    expect(level('mcp__jarvis-desktop__show_file', { file: 'C:/Downloads/setup.exe', open: true })).toBe('sensitive');
    expect(level('mcp__jarvis-desktop__show_file', { file: 'C:/Downloads/photo.png', open: true })).toBe('safe');
  });

  it('asks before moving a file from outside the work into the results', () => {
    expect(level('mcp__jarvis-desktop__move_to_output', { file: 'C:/Users/user/.ssh/id_ed25519' })).toBe('sensitive');
    expect(level('mcp__jarvis-desktop__move_to_output', { file: 'C:/Users/user/AppData/Local/Temp/a.png' })).toBe('normal');
  });

  it('leaves reading alone', () => {
    expect(level('Read', { file_path: 'C:/Users/user/.ssh/config' })).toBe('safe');
    expect(level('WebFetch', { url: 'https://example.com' })).toBe('safe');
  });
});

describe('path helpers', () => {
  it('compares paths without regard to case, slashes or dot segments', () => {
    expect(within('c:\\users\\USER\\projects\\site\\a.ts', ['C:/Users/user/projects/site'])).toBe(true);
    expect(within('C:/Users/user/projects/site/../other/a.ts', ['C:/Users/user/projects/site'])).toBe(false);
    expect(within('C:/Users/user/projects/site-2/a.ts', ['C:/Users/user/projects/site'])).toBe(false);
  });

  it('knows system folders on both platforms', () => {
    expect(isSystemPath('C:\\Program Files\\App\\x.dll')).toBe(true);
    expect(isSystemPath('/etc/hosts')).toBe(true);
    expect(isSystemPath('/home/user/etc/hosts')).toBe(false);
  });
});

describe('decideToolUse', () => {
  const config = { outputDir: context.outputDir, homeDir: context.homeDir };

  it('stays out of the way of ordinary work and never asks about it', async () => {
    let asked = false;
    const result = await decideToolUse(
      { tool_name: 'Bash', tool_input: { command: 'pnpm build' }, cwd: context.cwd },
      config,
      async () => {
        asked = true;
        return true;
      },
    );
    expect(result).toBeNull();
    expect(asked).toBe(false);
  });

  it('allows a red-line action only on a yes, and says what was asked', async () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: context.cwd };
    const yes = await decideToolUse(input, config, async () => true);
    const no = await decideToolUse(input, config, async () => false);
    expect(yes?.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(no?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(no?.hookSpecificOutput.permissionDecisionReason).toContain('git push origin main');
  });

  it('refuses a call it cannot read instead of letting it through', async () => {
    const result = await decideToolUse({ tool_input: {} }, config, async () => true);
    expect(result?.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('GateBridge', () => {
  it('carries a question to the main process and the answer back', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const hook = new GateBridge(dir, { stepMs: 5, waitMs: 2_000 });
    const main = new GateBridge(dir, { stepMs: 5 });
    const questions: string[] = [];
    const stop = main.serve((question) => {
      questions.push(question.summary);
      return question.level === 'sensitive';
    });
    try {
      expect(await hook.ask('Отправить письмо?', 'sensitive')).toBe(true);
      expect(await hook.ask('Оплатить?', 'dangerous')).toBe(false);
    } finally {
      stop();
    }
    expect(questions).toEqual(['Отправить письмо?', 'Оплатить?']);
  });

  it('treats silence as a no', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const hook = new GateBridge(dir, { stepMs: 5, waitMs: 50 });
    expect(await hook.ask('Удалить?', 'dangerous')).toBe(false);
  });
});
