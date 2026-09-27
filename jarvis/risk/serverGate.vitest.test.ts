import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GateBridge } from './gateBridge';
import { gateFromConfigFile, guardEveryTool, serverGateFromEnv, type ServerGate } from './serverGate';

/**
 * Красные линии внутри MCP-сервера — путь «Б», выбранный владельцем 27.09.2026.
 *
 * Мост вопросов здесь настоящий — тот же, через который приложение спрашивает
 * голосом; «человек» отвечает из теста.
 */

type Handler = (args: unknown, extra: unknown) => unknown;

/** Сервер-заглушка: запоминает, что зарегистрировано. */
function сервер(): { registerTool(name: string, config: unknown, handler: Handler): void; инструменты: Map<string, Handler> } {
  const инструменты = new Map<string, Handler>();
  return {
    инструменты,
    registerTool(name, _config, handler) {
      инструменты.set(name, handler);
    },
  };
}

const гасить: Array<() => void> = [];
afterEach(() => {
  for (const g of гасить.splice(0)) g();
});

/** gate.json и мост, на котором «человек» отвечает `ответ`. */
function сторож(ответ: boolean | null): { файл: string; вопросы: string[] } {
  const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis-server-gate-'));
  const bridgeDir = path.join(папка, 'gate');
  const файл = path.join(папка, 'gate.json');
  writeFileSync(файл, JSON.stringify({ bridgeDir, language: 'ru' }), 'utf8');
  const вопросы: string[] = [];
  if (ответ !== null) {
    гасить.push(
      new GateBridge(bridgeDir, { stepMs: 20 }).serve((вопрос) => {
        вопросы.push(вопрос.summary);
        return ответ;
      }),
    );
  }
  return { файл, вопросы };
}

describe('проверка внутри сервера', () => {
  it('«Купить» в браузере — спрашивает, и отказ человека не пускает инструмент', async () => {
    const { файл, вопросы } = сторож(false);
    const s = сервер();
    guardEveryTool(s, gateFromConfigFile(файл));
    let нажато = false;
    s.registerTool('browser_click', {}, () => {
      нажато = true;
      return { content: [{ type: 'text', text: 'нажал' }] };
    });

    const ответ = (await s.инструменты.get('browser_click')?.({ text: 'Купить' }, {})) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };

    expect(вопросы).toHaveLength(1);
    expect(вопросы[0]).toMatch(/Купить/u);
    expect(нажато).toBe(false);
    expect(ответ.isError).toBe(true);
    expect(ответ.content[0]?.text).toMatch(/не разрешил/u);
  }, 20_000);

  it('человек разрешил — инструмент работает', async () => {
    const { файл } = сторож(true);
    const s = сервер();
    guardEveryTool(s, gateFromConfigFile(файл));
    s.registerTool('browser_click', {}, () => ({ content: [{ type: 'text', text: 'нажал' }] }));

    const ответ = (await s.инструменты.get('browser_click')?.({ text: 'Купить' }, {})) as { isError?: boolean };
    expect(ответ.isError).toBeUndefined();
  }, 20_000);

  it('безопасный инструмент идёт без вопроса', async () => {
    const { файл, вопросы } = сторож(false);
    const s = сервер();
    guardEveryTool(s, gateFromConfigFile(файл));
    s.registerTool('window_list', {}, () => ({ content: [{ type: 'text', text: 'окна' }] }));

    const ответ = (await s.инструменты.get('window_list')?.({}, {})) as { content: Array<{ text: string }> };
    expect(ответ.content[0]?.text).toBe('окна');
    expect(вопросы).toEqual([]);
  });

  it('сломанный gate.json — отказ, а не «как раньше»', async () => {
    const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis-server-gate-'));
    const файл = path.join(папка, 'gate.json');
    writeFileSync(файл, '{ это не json', 'utf8');
    const s = сервер();
    guardEveryTool(s, gateFromConfigFile(файл));
    let позван = false;
    s.registerTool('window_list', {}, () => {
      позван = true;
      return { content: [] };
    });

    const ответ = (await s.инструменты.get('window_list')?.({}, {})) as { isError?: boolean; content: Array<{ text: string }> };
    expect(позван).toBe(false);
    expect(ответ.isError).toBe(true);
    expect(ответ.content[0]?.text).toMatch(/Проверка разрешений не сработала/u);
  });

  it('проверка — внешний слой: инструмент, добавленный после, тоже проверяется', async () => {
    const запрещать: ServerGate = { check: async () => 'нельзя' };
    const s = сервер();
    guardEveryTool(s, запрещать);
    s.registerTool('любой_новый', {}, () => ({ content: [] }));
    const ответ = (await s.инструменты.get('любой_новый')?.({}, {})) as { isError?: boolean };
    expect(ответ.isError).toBe(true);
  });

  it('включается только переменной окружения — у Claude Code спрашивает его хук', () => {
    expect(serverGateFromEnv({})).toBeNull();
    expect(serverGateFromEnv({ JARVIS_TOOL_GATE: '  ' })).toBeNull();
    expect(serverGateFromEnv({ JARVIS_TOOL_GATE: 'C:/x/gate.json' })).not.toBeNull();
  });
});
