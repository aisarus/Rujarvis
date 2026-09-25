import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GateBridge } from './gateBridge';
import { decideToolUse } from './gateHook';
import { setLanguage } from '../locale/language';
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

  it('кириллица в конце надписи не делает кнопку безопасной', () => {
    // Граница слова в JS считает словом только латиницу, поэтому «Перевод»,
    // «Написать» и «ПИН-код» проходили мимо всех трёх шаблонов и получали
    // класс «безопасно» — три красные линии из четырёх молча открывались.
    expect(level('mcp__jarvis-desktop__browser_click', { text: 'Перевод' })).toBe('dangerous');
    expect(level('mcp__jarvis-desktop__browser_click', { text: 'Написать' })).toBe('sensitive');
    expect(level('mcp__jarvis-desktop__browser_fill', { label: 'ПИН-код', value: '1234' })).toBe('sensitive');
    expect(level('mcp__jarvis-desktop__browser_fill', { label: 'ПИН', value: '1234' })).toBe('sensitive');

    // А соседнее слово с тем же началом трогать не за что.
    expect(level('mcp__jarvis-desktop__browser_click', { text: 'Переводчик' })).toBe('safe');
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
        return 'allow';
      },
    );
    expect(result).toBeNull();
    expect(asked).toBe(false);
  });

  it('allows a red-line action only on a yes, and says what was asked', async () => {
    const input = { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: context.cwd };
    const yes = await decideToolUse(input, config, async () => 'allow');
    const no = await decideToolUse(input, config, async () => 'deny');
    expect(yes?.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(no?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(no?.hookSpecificOutput.permissionDecisionReason).toContain('git push origin main');
  });

  it('refuses a call it cannot read instead of letting it through', async () => {
    const result = await decideToolUse({ tool_input: {} }, config, async () => 'allow');
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
      expect(await hook.ask('Отправить письмо?', 'sensitive')).toBe('allow');
      expect(await hook.ask('Оплатить?', 'dangerous')).toBe('deny');
    } finally {
      stop();
    }
    expect(questions).toEqual(['Отправить письмо?', 'Оплатить?']);
  });

  it('treats silence as a no', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const hook = new GateBridge(dir, { stepMs: 5, waitMs: 50 });
    // Молчание — не отказ человека, и называется оно своим словом. Решение
    // то же (не пускать), но чинить по нему будут разное.
    expect(await hook.ask('Удалить?', 'dangerous')).toBe('timeout');
  });

  it('сломанный мост не выдаётся за отказ человека', async () => {
    // Папка, в которую нельзя писать: у моста нет способа задать вопрос.
    // Раньше это давало то же `false`, что и «человек сказал нет», и агент
    // сообщал человеку, что тот отказал, хотя вопроса не было вовсе.
    const занято = path.join(mkdtempSync(path.join(os.tmpdir(), 'gate-')), 'файл');
    writeFileSync(занято, 'не папка', 'utf8');
    const hook = new GateBridge(занято, { stepMs: 5, waitMs: 50 });
    expect(await hook.ask('Удалить?', 'dangerous')).toBe('failed');
  });
});

describe('язык вопросов хука', () => {
  afterEach(() => setLanguage('ru'));

  it('спрашивает на выбранном языке, а класс риска от языка не зависит', () => {
    const ctx = { cwd: '/tmp/project' };
    const ru = classifyToolUse('Bash', { command: 'git push origin main' }, ctx);
    setLanguage('en');
    const en = classifyToolUse('Bash', { command: 'git push origin main' }, ctx);

    expect(ru.summary).toContain('Агент хочет выполнить команду');
    expect(en.summary).toBe('The agent wants to run: git push origin main.');
    expect(en.level).toBe(ru.level);
  });
});
