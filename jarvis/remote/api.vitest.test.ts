import { describe, expect, it, vi } from 'vitest';

import { handleRemoteRequest, MAX_COMMAND_LENGTH, type RemoteHandlers } from './api';
import { createPairing } from './pairing';

function handlers(overrides: Partial<RemoteHandlers> = {}): RemoteHandlers {
  return {
    status: () => ({ listening: true, busy: false, says: 'Слушаю' }),
    say: vi.fn(),
    files: () => 'Images:\nзакат.png — 12 КБ — 19.09 13:20',
    ...overrides,
  };
}

const pairing = createPairing();

function ask(path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  return handleRemoteRequest(
    { method: options.method ?? 'GET', path, token: options.token, body: options.body },
    { pairing, handlers: handlers() },
  );
}

describe('доступ', () => {
  it.each(['/status', '/files', '/say'])('без ключа не пускает на %s', async (path) => {
    const response = await ask(path, { method: path === '/say' ? 'POST' : 'GET' });
    expect(response.status).toBe(401);
  });

  it('не пускает с неверным ключом', async () => {
    expect((await ask('/status', { token: 'не тот' })).status).toBe(401);
  });

  it('закрыт, пока пара не выдана', async () => {
    // Незаконченная настройка должна оставлять дверь закрытой, а не открытой.
    const response = await handleRemoteRequest(
      { method: 'GET', path: '/status', token: pairing.token },
      { pairing: null, handlers: handlers() },
    );
    expect(response.status).toBe(401);
  });

  it('пускает с верным ключом', async () => {
    expect((await ask('/status', { token: pairing.token })).status).toBe(200);
  });

  it('проверяет здоровье без ключа — по нему телефон находит компьютер', async () => {
    const response = await ask('/health');
    expect(response.status).toBe(200);
    // И ничего не рассказывает о человеке.
    expect(JSON.stringify(response.body)).not.toContain('Слушаю');
  });
});

describe('команды', () => {
  it('передаёт сказанное дальше', async () => {
    const say = vi.fn();
    const response = await handleRemoteRequest(
      { method: 'POST', path: '/say', token: pairing.token, body: { text: 'открой хром' } },
      { pairing, handlers: handlers({ say }) },
    );

    expect(response.status).toBe(200);
    expect(say).toHaveBeenCalledWith('открой хром');
  });

  it('отказывает пустой команде', async () => {
    const response = await ask('/say', { method: 'POST', token: pairing.token, body: { text: '  ' } });
    expect(response.status).toBe(400);
  });

  it('отказывает команде без текста', async () => {
    const response = await ask('/say', { method: 'POST', token: pairing.token, body: {} });
    expect(response.status).toBe(400);
  });

  it('обрезает попытку прислать книгу', async () => {
    const response = await ask('/say', {
      method: 'POST',
      token: pairing.token,
      body: { text: 'а'.repeat(MAX_COMMAND_LENGTH + 1) },
    });
    expect(response.status).toBe(400);
  });

  it('не принимает команду методом GET', async () => {
    // Иначе команду можно подсунуть обычной ссылкой.
    const response = await ask('/say', { method: 'GET', token: pairing.token });
    expect(response.status).toBe(405);
  });
});

describe('прочее', () => {
  it('отдаёт список файлов', async () => {
    const response = await ask('/files', { token: pairing.token });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain('закат.png');
  });

  it('на неизвестный путь отвечает 404, а не молчанием', async () => {
    expect((await ask('/чего-то-нет', { token: pairing.token })).status).toBe(404);
  });

  it('не роняет сервер, когда обработчик падает', async () => {
    const response = await handleRemoteRequest(
      { method: 'GET', path: '/status', token: pairing.token },
      {
        pairing,
        handlers: handlers({
          status: () => {
            throw new Error('внутри всё сломалось');
          },
        }),
      },
    );

    expect(response.status).toBe(500);
    // Наружу не уходит ни стек, ни текст исключения.
    expect(JSON.stringify(response.body)).not.toContain('внутри всё сломалось');
  });
});
