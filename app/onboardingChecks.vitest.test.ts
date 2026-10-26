import { describe, expect, it } from 'vitest';

import { agentFailure, checkBrains, hearingSpeed } from './onboardingChecks';

describe('успевает ли компьютер за лектором', () => {
  it('по времени на фразу — с запасом на кусок лекции', () => {
    expect(hearingSpeed(3)).toBe('fast'); // видеокарта
    expect(hearingSpeed(15)).toBe('tight');
    expect(hearingSpeed(30)).toBe('slow'); // мак на Intel без видеокарты
  });
});

describe('отказ агента — словами, что делать', () => {
  it('вход, лимит, тариф, не установлен', () => {
    expect(agentFailure('claude', 'Claude Code вышел с кодом 1: Invalid API key · Please run /login')).toMatch(/Войти|Sign in/u);
    expect(agentFailure('codex', "Codex вышел с кодом 1: The 'gpt-x' model is not supported when using Codex with a ChatGPT account.")).toMatch(/Plus/u);
    expect(agentFailure('codex', 'Codex вышел с кодом 1: usage limit reached')).toMatch(/Лимит|limit/u);
    expect(agentFailure('codex', 'Codex не найден — раздел конспекта собрать нечем')).toMatch(/Установить|Install/u);
    expect(agentFailure('codex', 'что-то совсем другое')).toBe('что-то совсем другое');
    // Настоящий ответ Codex без входа: в номере запроса бывают цифры «429».
    expect(agentFailure('codex', 'Codex вышел с кодом 1: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: a50bed539a429f486-TLV, request id: req_59485d0429')).toMatch(/Войти|Sign in/u);
    expect(agentFailure('claude', 'Claude Code вышел с кодом 1: Failed to authenticate: OAuth session expired and could not be refreshed')).toMatch(/Войти|Sign in/u);
    expect(agentFailure('codex', 'Codex вышел с кодом 1: stream error: 429 Too Many Requests')).toMatch(/Лимит|limit/u);
  });
});

describe('проверка модели', () => {
  it('спрашивает каждого установленного; кто пишет — первый ответивший в порядке выбора', async () => {
    const спросили: string[] = [];
    const итог = await checkBrains('auto', {
      installed: () => true,
      ask: async (cli) => {
        спросили.push(cli);
        if (cli === 'claude') throw new Error('Claude Code вышел с кодом 1: Please run /login');
        return 'готово';
      },
    });
    expect(спросили.sort()).toEqual(['claude', 'codex']);
    expect(итог.order).toEqual(['claude', 'codex']);
    expect(итог.results.find((r) => r.cli === 'claude')).toMatchObject({ ok: false });
    expect(итог.results.find((r) => r.cli === 'claude')?.message).toMatch(/Войти|Sign in/u);
    expect(итог.results.find((r) => r.cli === 'codex')).toMatchObject({ ok: true, message: 'готово' });
  });

  it('никого нет — пустой итог, а не падение', async () => {
    expect(await checkBrains('auto', { installed: () => false })).toEqual({ order: [], results: [] });
  });
});
