import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CliHandle, CliProcessOptions } from '../backends/process';
import { geminiAcceptsPattern } from '../backends/geminiPolicy';
import type { AgentStatus, TextAgent } from '../lecture/summarize';
import type { AgentId } from '../backends/types';
import { createAgentDocumentAgent, createGeminiDocumentAgent, geminiDocumentPolicy } from './agents';

/**
 * Разбор документа — не только у того, у кого Claude Code. У Gemini права те
 * же: читать папку задачи, писать только в `out/`, без оболочки и сети.
 */

/** Строка аргументов так, как её сверяет Gemini: ключи по алфавиту, пары в `\0`. */
function аргументы(args: Record<string, unknown>): string {
  return `{${Object.keys(args)
    .sort()
    .map((ключ) => `\0${JSON.stringify(ключ)}:${JSON.stringify(args[ключ])}\0`)
    .join(',')}}`;
}

/** Правила записи из текста политики: разрешающие и запрещающие шаблоны. */
function правилаЗаписи(текст: string): { можно: RegExp[]; нельзя: RegExp[] } {
  const можно: RegExp[] = [];
  const нельзя: RegExp[] = [];
  for (const блок of текст.split('[[rule]]')) {
    const шаблон = /^argsPattern = (".*")$/mu.exec(блок)?.[1];
    if (!шаблон) continue;
    const regex = new RegExp(JSON.parse(шаблон) as string);
    (блок.includes('decision = "allow"') ? можно : нельзя).push(regex);
  }
  return { можно, нельзя };
}

describe('политика разбора документа у Gemini', () => {
  const cwd = 'C:\\Users\\Иван\\AppData\\Local\\Temp\\jarvis-doc-abc';
  const текст = geminiDocumentPolicy(cwd, 'win32');
  const { можно, нельзя } = правилаЗаписи(текст);
  const пишет = (file: string): boolean => {
    const строка = аргументы({ content: 'x', file_path: file });
    return можно.some((r) => r.test(строка)) && !нельзя.some((r) => r.test(строка));
  };

  it.each(['out/Статья — читаем вместе.md', './out/manifest.json', 'out\\graphs\\спрос.svg', `${cwd}\\out\\x.md`])('в out/ — можно: %s', (file) => {
    expect(пишет(file)).toBe(true);
  });

  it.each(['in/документ.pdf', 'заметка.md', '..\\x.md', 'out/../in/x.md', 'C:\\Users\\Иван\\Desktop\\x.md', 'out/.gemini/settings.json'])(
    'мимо out/ — нельзя: %s',
    (file) => {
      expect(пишет(file)).toBe(false);
    },
  );

  it('ни веба, ни оболочки, ни сервера; шаблоны Gemini принимает', () => {
    expect(текст).not.toMatch(/web_fetch|google_web_search|mcpName/u);
    expect(текст).toMatch(/toolName = "run_shell_command"\ndecision = "deny"/u);
    const шаблоны = [...текст.matchAll(/^argsPattern = (".*")$/gmu)].map((m) => JSON.parse(m[1] ?? '""') as string);
    expect(шаблоны.filter((ш) => !geminiAcceptsPattern(ш))).toEqual([]);
  });
});

describe('разбор документа агентом', () => {
  it('Gemini: политика лежит в доме, режим правки, подсказка про его инструменты, папка задачи', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'jarvis-doc-gemini-'));
    const job = { cwd: mkdtempSync(path.join(os.tmpdir(), 'jarvis-doc-job-')), prompt: 'ДОКУМЕНТ: in/статья.pdf' };
    const запуски: CliProcessOptions[] = [];
    const spawnCli = (options: CliProcessOptions): CliHandle => {
      запуски.push(options);
      return {
        cancel: () => {},
        wait: async () => {
          options.onStdoutLine('{"type":"init","session_id":"s"}');
          options.onStdoutLine('{"type":"result","status":"success","stats":{"input_tokens":1}}');
          return { exitCode: 0, signal: null, stderr: '', cancelled: false, timedOut: false };
        },
      };
    };
    await createGeminiDocumentAgent({ command: '/bin/gemini', home, spawnCli, adminPolicies: () => false })(job);
    const запуск = запуски[0];
    expect(запуск?.cwd).toBe(job.cwd);
    expect(запуск?.args).toEqual(expect.arrayContaining(['--approval-mode', 'auto_edit', '--allowed-mcp-server-names', 'none']));
    expect(запуск?.stdin).toMatch(/read_file[\s\S]*ДОКУМЕНТ: in\/статья\.pdf$/u);
    const политика = запуск?.args[(запуск?.args.indexOf('--admin-policy') ?? 0) + 1] ?? '';
    expect(readFileSync(политика, 'utf8')).not.toContain('web_fetch');
    expect(запуск?.env?.GEMINI_CLI_HOME).toBe(home);
  });

  it('с одним Gemini: Pro, не справился — out/ очищена и Flash', async () => {
    const job = { cwd: mkdtempSync(path.join(os.tmpdir(), 'jarvis-doc-job-')), prompt: 'x' };
    mkdirSync(path.join(job.cwd, 'out'));
    const вызовы: string[] = [];
    const статусы = async (): Promise<Partial<Record<AgentId, AgentStatus>>> => ({
      'claude-code': { installed: false, loggedIn: false },
      gemini: { installed: true, loggedIn: true, path: '/g' },
    });
    const агент = createAgentDocumentAgent({
      statuses: статусы,
      prefer: () => 'auto',
      agentFor: (a: TextAgent, model) => async () => {
        вызовы.push(`${a.id}:${model}`);
        if (model === 'pro') {
          writeFileSync(path.join(job.cwd, 'out', 'половина.md'), 'недописано');
          throw new Error('exhausted your daily quota');
        }
      },
    });
    await агент(job);
    expect(вызовы).toEqual(['gemini:pro', 'gemini:flash']);
    expect(existsSync(path.join(job.cwd, 'out', 'половина.md'))).toBe(false);
  });

  it('никого — понятная ошибка', async () => {
    const агент = createAgentDocumentAgent({ statuses: async () => ({}), prefer: () => 'auto', agentFor: () => async () => {} });
    await expect(агент({ cwd: os.tmpdir(), prompt: 'x' })).rejects.toThrow(/Claude Code, Codex или Gemini|Claude Code, Codex or Gemini/u);
  });
});
