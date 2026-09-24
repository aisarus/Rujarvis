import { afterEach, describe, expect, it } from 'vitest';

import { normaliseSettings } from '../setup/settings';
import {
  checkLocalModel,
  isPrivateEndpoint,
  localModelEnv,
  normaliseEndpoint,
  setLocalModel,
} from './localModel';
import { agentEnv } from './subscriptionEnv';

afterEach(() => setLocalModel(null));

describe('isPrivateEndpoint', () => {
  it.each([
    'http://127.0.0.1:11434',
    'http://localhost:1234',
    'http://[::1]:8080',
    'http://192.168.1.20:11434',
    'http://10.0.0.5:8080',
    'http://172.20.3.4:8080',
    'http://gpu-box.local:11434',
    'http://gpu-box:11434',
  ])('свой адрес: %s', (url) => {
    expect(isPrivateEndpoint(url)).toBe(true);
  });

  it.each([
    'https://api.anthropic.com',
    'https://openrouter.ai/api',
    'http://8.8.8.8:11434',
    'http://172.32.0.1:8080',
    'ftp://127.0.0.1',
    'http://user:secret@127.0.0.1:11434',
    'не адрес',
  ])('чужой или негодный: %s', (url) => {
    // Облачный шлюз с ключом — это платный API, а Джарвис в них не ходит.
    expect(isPrivateEndpoint(url)).toBe(false);
  });
});

describe('normaliseEndpoint', () => {
  it('убирает хвост /v1 и слеши — человек вставляет адрес как придётся', () => {
    expect(normaliseEndpoint(' http://127.0.0.1:11434/v1/ ')).toBe('http://127.0.0.1:11434');
  });
});

describe('agentEnv', () => {
  it('без своей модели — только подписка, чужие ключи убраны', () => {
    const env = agentEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-old', ANTHROPIC_BASE_URL: 'https://gw' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.PATH).toBe('/bin');
  });

  it('со своей моделью — её адрес поверх, а ключ из окружения всё равно убран', () => {
    setLocalModel({ url: 'http://127.0.0.1:11434', model: 'qwen3-coder' });
    const env = agentEnv({ ANTHROPIC_API_KEY: 'sk-old' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(env.ANTHROPIC_MODEL).toBe('qwen3-coder');
    // Служебная «лёгкая» модель Claude Code тоже должна быть своей.
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('qwen3-coder');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it('токен подписки своему серверу не уходит', () => {
    setLocalModel({ url: 'http://127.0.0.1:11434', model: 'm' });
    expect(agentEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x' }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('заглушка вместо токена: без неё Claude Code не стартует', () => {
    expect(localModelEnv({ url: 'http://x', model: 'm' }).ANTHROPIC_AUTH_TOKEN).toBe('local');
  });
});

describe('настройки', () => {
  it('публичный адрес не проходит даже руками в settings.json', () => {
    expect(normaliseSettings({ localModelUrl: 'https://openrouter.ai/api' }).localModelUrl).toBe('');
    expect(normaliseSettings({ localModelUrl: 'http://127.0.0.1:11434/v1' }).localModelUrl).toBe('http://127.0.0.1:11434');
  });
});

type Reply = { status?: number; body: unknown };

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    const reply = replies.shift() ?? { status: 500, body: {} };
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      text: async () => JSON.stringify(reply.body),
    };
  };
  return { fetch, calls };
}

describe('checkLocalModel', () => {
  const model = { url: 'http://127.0.0.1:11434', model: 'qwen3-coder' };

  it('годится, когда модель отвечает и вызывает инструмент', async () => {
    const { fetch, calls } = fakeFetch([
      { body: { content: [{ type: 'text', text: 'ready' }] } },
      { body: { content: [{ type: 'tool_use', name: 'ping', input: {} }] } },
    ]);
    const result = await checkLocalModel(model, { fetch });
    expect(result).toEqual({ ok: true, tools: true, reply: 'ready' });
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/messages');
    expect(calls[1].body.tools).toBeDefined();
  });

  it('честно говорит, что без инструментов агентом она не будет', async () => {
    const { fetch } = fakeFetch([
      { body: { content: [{ type: 'text', text: 'ready' }] } },
      { body: { content: [{ type: 'text', text: 'I cannot call tools' }] } },
    ]);
    expect(await checkLocalModel(model, { fetch })).toMatchObject({ ok: true, tools: false });
  });

  it('называет причину, когда сервер отвечает ошибкой', async () => {
    const { fetch } = fakeFetch([{ status: 404, body: { error: 'model not found' } }]);
    const result = await checkLocalModel(model, { fetch });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('404');
  });

  it('не стучится на чужой адрес вовсе', async () => {
    const { fetch, calls } = fakeFetch([]);
    const result = await checkLocalModel({ url: 'https://api.example.com', model: 'x' }, { fetch });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
