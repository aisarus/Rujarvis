/**
 * Правка человека обязана догнать агента на любом инструменте.
 *
 * Проверяется через настоящий MCP-сервер и настоящего клиента, а не через
 * вызов обработчика напрямую: терялось именно на шве — ящик наполнялся, а
 * заглядывал в него агент по доброй воле, и по замеру 20.09.2026 сорок одна
 * правка из шестидесяти трёх не дошла ни до кого.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { NoteStore } from '../dialogue/noteStore';
import { createDesktopMcpServer } from './mcpServer';

const дом = mkdtempSync(path.join(os.tmpdir(), 'jarvis-mcp-notes-'));
process.env.JARVIS_NOTES = path.join(дом, 'notes.json');
process.env.JARVIS_PLAN = path.join(дом, 'plan.json');

afterAll(() => {
  rmSync(дом, { recursive: true, force: true });
});

/** Текст из ответа инструмента, склеенный в одну строку. */
function текстОтвета(результат: unknown): string {
  const content = (результат as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .filter((часть) => часть.type === 'text')
    .map((часть) => часть.text ?? '')
    .join('\n');
}

async function поднять(): Promise<Client> {
  const server = createDesktopMcpServer();
  const [клиент, сервер] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'проверка', version: '1.0.0' });
  await Promise.all([server.connect(сервер), client.connect(клиент)]);
  return client;
}

describe('правка доезжает на любом инструменте', () => {
  beforeEach(() => {
    new NoteStore(process.env.JARVIS_NOTES as string).take();
  });

  it('приклеивается к ответу постороннего инструмента', async () => {
    const client = await поднять();
    new NoteStore(process.env.JARVIS_NOTES as string).add('крышу сделай синей');

    // show_plan про правки ничего не знает — в этом и смысл.
    const ответ = await client.callTool({ name: 'show_plan', arguments: {} });
    expect(текстОтвета(ответ)).toContain('крышу сделай синей');
    await client.close();
  });

  // Дважды учтённая правка хуже неучтённой: «на два тона темнее», применённое
  // трижды, — это чёрный цвет.
  it('второй раз не приклеивается', async () => {
    const client = await поднять();
    new NoteStore(process.env.JARVIS_NOTES as string).add('крышу сделай синей');

    await client.callTool({ name: 'show_plan', arguments: {} });
    const второй = await client.callTool({ name: 'show_plan', arguments: {} });
    expect(текстОтвета(второй)).not.toContain('крышу сделай синей');
    await client.close();
  });

  // Пустой ящик не должен ничего дописывать: лишний текст в каждом ответе —
  // это лишние токены на каждое действие длинной работы.
  it('пустой ящик ничего не добавляет', async () => {
    const client = await поднять();
    const ответ = await client.callTool({ name: 'show_plan', arguments: {} });
    expect(текстОтвета(ответ)).not.toContain('после того, как ты взялся');
    await client.close();
  });

  // check_notes и так отдаёт ящик. Если приклеить и ему, человек получит свою
  // правку дважды в одном ответе.
  it('check_notes не показывает правку дважды', async () => {
    const client = await поднять();
    new NoteStore(process.env.JARVIS_NOTES as string).add('крышу сделай синей');

    const ответ = await client.callTool({ name: 'check_notes', arguments: {} });
    const текст = текстОтвета(ответ);
    expect(текст).toContain('крышу сделай синей');
    expect(текст.split('крышу сделай синей').length - 1).toBe(1);
    await client.close();
  });
});
