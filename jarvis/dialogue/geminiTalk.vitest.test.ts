import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CliHandle, CliProcessOptions } from '../backends/process';
import type { BackendAvailability } from '../backends/types';
import { GeminiTalkLive, geminiTalkPolicy } from './geminiTalk';
import { pickTalkAgent } from './talkSession';

/**
 * Разговор через Gemini — для того, у кого из агентов только Google-аккаунт.
 * Каждый ход — отдельный запуск; нить держит сам Gemini (`--resume`).
 */

function готов(id: BackendAvailability['id'], path = `/bin/${id}`): BackendAvailability {
  return { id, installed: true, authenticated: true, ready: true, path, checkedAt: 0 };
}

describe('кто ведёт разговор', () => {
  it('Gemini — когда нет ни Claude Code, ни Codex', () => {
    expect(pickTalkAgent([{ ...готов('claude-code'), ready: false }, готов('gemini')])?.id).toBe('gemini');
  });

  it('выбранный в настройках — первым', () => {
    expect(pickTalkAgent([готов('claude-code'), готов('codex'), готов('gemini')], 'gemini')?.id).toBe('gemini');
    expect(pickTalkAgent([готов('claude-code'), готов('codex'), { ...готов('gemini'), ready: false }], 'gemini')?.id).toBe('claude-code');
  });
});

describe('ход разговора через Gemini', () => {
  it('политика: только глаголы разговора — ни чтения, ни записи, ни поиска', () => {
    const текст = geminiTalkPolicy(true);
    expect(текст).toContain('mcpName = "jarvis-talk"');
    expect(текст).toContain('"start_work"');
    expect(текст).not.toMatch(/read_file|write_file|google_web_search/u);
  });

  it('первый ход заводит нить, второй идёт --resume этой нитью', async () => {
    const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis-gemini-talk-'));
    const talk = path.join(папка, 'talk.json');
    writeFileSync(
      talk,
      JSON.stringify({ mcpServers: { 'jarvis-talk': { command: 'node', args: ['mcp.cjs'], env: { JARVIS_MCP_ROLE: 'talk' } } } }),
    );
    const запуски: CliProcessOptions[] = [];
    const spawnCli = (options: CliProcessOptions): CliHandle => {
      запуски.push(options);
      return {
        cancel: () => {},
        wait: async () => {
          options.onStdoutLine('{"type":"init","session_id":"нить-1","model":"flash"}');
          options.onStdoutLine('{"type":"message","role":"assistant","content":"Да, слушаю.","delta":true}');
          options.onStdoutLine('{"type":"result","status":"success","stats":{"input_tokens":5}}');
          return { exitCode: 0, signal: null, stderr: '', cancelled: false, timedOut: false };
        },
      };
    };
    const live = new GeminiTalkLive({ command: '/bin/gemini', cwd: папка, home: папка, mcpConfig: talk, silenceMs: 1000, spawnCli });

    const первый = await live.ask('привет').result();
    expect(первый.text).toBe('Да, слушаю.');
    const второй = await live.ask('а почему?').result();
    expect(второй.ok).toBe(true);

    expect(запуски[0]?.args).not.toContain('--resume');
    expect(запуски[1]?.args).toEqual(expect.arrayContaining(['--resume', 'нить-1']));
    for (const запуск of запуски) {
      expect(запуск.args).toEqual(expect.arrayContaining(['--allowed-mcp-server-names', 'jarvis-talk']));
      expect(запуск.env?.JARVIS_MCP_ROLE).toBe('talk');
      expect(запуск.env?.JARVIS_GEMINI_MCP_SCRIPT).toBe('mcp.cjs');
      const политика = запуск.args[запуск.args.indexOf('--admin-policy') + 1] ?? '';
      expect(readFileSync(политика, 'utf8')).toContain('mcpName = "jarvis-talk"');
    }
  });
});
