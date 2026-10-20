import { describe, expect, it } from 'vitest';

import { createAgentFinalSummarizer, createAgentSummarizer, pickTextAgent, type AgentStatus, type TextAgent } from './summarize';
import type { AgentId } from '../backends/types';

/**
 * Конспект лекции и заготовка учёбы — не только у того, у кого Claude Code.
 *
 * Раньше их звали `claude -p` напрямую, и у студента с одним Google-аккаунтом
 * (Gemini) или одним Codex конспект молча не собирался. Теперь отвечает
 * выбранный в настройках агент, а нет его — первый готовый.
 */

const вошёл = (path: string): AgentStatus => ({ installed: true, loggedIn: true, path });
const нет: AgentStatus = { installed: false, loggedIn: false };

function статусы(части: Partial<Record<AgentId, AgentStatus>>): () => Promise<Partial<Record<AgentId, AgentStatus>>> {
  return async () => части;
}

describe('кто пишет конспект', () => {
  it('сам — первый готовый: Claude Code, потом Codex, потом Gemini', () => {
    expect(pickTextAgent({ 'claude-code': вошёл('/c'), codex: вошёл('/x'), gemini: вошёл('/g') })?.id).toBe('claude-code');
    expect(pickTextAgent({ 'claude-code': нет, codex: вошёл('/x'), gemini: вошёл('/g') })?.id).toBe('codex');
    expect(pickTextAgent({ 'claude-code': нет, codex: нет, gemini: вошёл('/g') })).toEqual({ id: 'gemini', path: '/g' });
  });

  it('выбранный в настройках — первым, если готов; не готов — следующий', () => {
    const все = { 'claude-code': вошёл('/c'), codex: вошёл('/x'), gemini: вошёл('/g') };
    expect(pickTextAgent(все, 'gemini')?.id).toBe('gemini');
    expect(pickTextAgent({ ...все, gemini: { installed: true, loggedIn: false, path: '/g' } }, 'gemini')?.id).toBe('claude-code');
  });

  it('Gemini без входа не зовут: его вход известен точно; Claude с «не знаю» — зовут', () => {
    expect(pickTextAgent({ gemini: { installed: true, loggedIn: 'unknown', path: '/g' } })).toBeNull();
    expect(pickTextAgent({ 'claude-code': { installed: true, loggedIn: 'unknown', path: '/c' } })?.id).toBe('claude-code');
  });

  it('никого — понятная ошибка, а не тишина', async () => {
    const summarize = createAgentSummarizer({ statuses: статусы({}), prefer: () => 'auto', answer: async () => 'не должно' });
    await expect(summarize('x')).rejects.toThrow(/Claude Code, Codex или Gemini|Claude Code, Codex or Gemini/u);
  });
});

describe('конспект с одним Gemini', () => {
  it('раздел — Gemini Flash, итог — Pro, а Pro не ответил — Flash', async () => {
    const вызовы: Array<{ agent: TextAgent; model: string | undefined }> = [];
    const answer = async (agent: TextAgent, model: string | undefined): Promise<string> => {
      вызовы.push({ agent, model });
      if (model === 'pro') throw new Error('exhausted your daily quota');
      return `ответ ${model}`;
    };
    const только = статусы({ 'claude-code': нет, codex: нет, gemini: вошёл('/g') });

    const раздел = createAgentSummarizer({ statuses: только, prefer: () => 'auto', answer });
    expect(await раздел('кусок лекции')).toBe('ответ flash');

    const журнал: string[] = [];
    const итог = createAgentFinalSummarizer({ statuses: только, prefer: () => 'auto', answer, log: (l) => журнал.push(l) });
    expect(await итог('вся лекция')).toBe('ответ flash');
    expect(вызовы.map((в) => `${в.agent.id}:${в.model}`)).toEqual(['gemini:flash', 'gemini:pro', 'gemini:flash']);
    expect(журнал.join('\n')).toMatch(/Gemini \(pro\) не ответил/u);
  });

  it('с одним Codex — модель, выбранная человеком в самом Codex', async () => {
    const модели: Array<string | undefined> = [];
    const summarize = createAgentFinalSummarizer({
      statuses: статусы({ codex: вошёл('/x') }),
      prefer: () => 'auto',
      answer: async (_agent, model) => {
        модели.push(model);
        return 'ок';
      },
    });
    expect(await summarize('лекция')).toBe('ок');
    expect(модели).toEqual([undefined]);
  });

  it('у Claude Code как раньше: раздел Sonnet, итог Opus', async () => {
    const модели: Array<string | undefined> = [];
    const answer = async (_agent: TextAgent, model: string | undefined): Promise<string> => {
      модели.push(model);
      return 'ок';
    };
    const claude = статусы({ 'claude-code': вошёл('/c'), gemini: вошёл('/g') });
    await createAgentSummarizer({ statuses: claude, prefer: () => 'auto', answer })('x');
    await createAgentFinalSummarizer({ statuses: claude, prefer: () => 'auto', answer })('x');
    expect(модели).toEqual(['sonnet', 'opus']);
  });
});
