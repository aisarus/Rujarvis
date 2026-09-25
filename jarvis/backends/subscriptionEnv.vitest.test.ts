import { describe, expect, it } from 'vitest';

import { strippedKeys, subscriptionEnv } from './subscriptionEnv';

describe('окружение без ключей', () => {
  // Ровно тот случай: старый ключ в системе перебивал вход по подписке, и
  // каждая задача три минуты билась в него ради «401 API key is invalid».
  it('убирает ключ Anthropic', () => {
    const clean = subscriptionEnv({ ANTHROPIC_API_KEY: 'sk-старый', PATH: '/usr/bin' });
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.PATH).toBe('/usr/bin');
  });

  it('убирает и токен, и чужой адрес, и ключ OpenAI', () => {
    const clean = subscriptionEnv({
      ANTHROPIC_AUTH_TOKEN: 'т',
      ANTHROPIC_BASE_URL: 'https://чужой',
      OPENAI_API_KEY: 'к',
      OPENAI_BASE_URL: 'https://чужой',
    });
    expect(Object.keys(clean)).toEqual([]);
  });

  it('не трогает исходное окружение', () => {
    const original = { ANTHROPIC_API_KEY: 'sk-старый' };
    subscriptionEnv(original);
    expect(original.ANTHROPIC_API_KEY).toBe('sk-старый');
  });

  it('оставляет всё остальное как было', () => {
    const clean = subscriptionEnv({ JARVIS_DATA_ROOT: 'C:/данные', HOME: '/дом' });
    expect(clean).toEqual({ JARVIS_DATA_ROOT: 'C:/данные', HOME: '/дом' });
  });
});

describe('что убрали', () => {
  it('называет найденное, чтобы это не выясняли второй раз', () => {
    expect(strippedKeys({ ANTHROPIC_API_KEY: 'sk-1', OPENAI_API_KEY: 'sk-2' })).toEqual([
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
    ]);
  });

  it('пустая переменная — не ключ', () => {
    expect(strippedKeys({ ANTHROPIC_API_KEY: '   ' })).toEqual([]);
  });

  it('когда чисто — молчит', () => {
    expect(strippedKeys({ PATH: '/usr/bin' })).toEqual([]);
  });
});
