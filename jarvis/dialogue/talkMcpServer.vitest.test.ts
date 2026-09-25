/**
 * Рычаги разговора — через настоящий сервер и настоящего клиента.
 *
 * Вызывать обработчики напрямую бессмысленно: ломается обычно шов. Имя,
 * которое не проходит проверку схемы, отсутствующий инструмент, отказ, не
 * помеченный отказом, — всё это живёт именно здесь, между сервером и клиентом.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { NoteStore } from './noteStore';
import { PlanStore } from '../agent/planStore';
import { TALK_TOOLS } from './talkSession';
import { createTalkMcpServer } from './talkMcpServer';
import { makePlan } from '../agent/plan';
import type { TalkAnswer, TalkCommandKind } from './talkBridge';

const дом = mkdtempSync(path.join(os.tmpdir(), 'jarvis-talk-mcp-'));
process.env.JARVIS_NOTES = path.join(дом, 'notes.json');
process.env.JARVIS_PLAN = path.join(дом, 'plan.json');
process.env.JARVIS_JOURNAL = path.join(дом, 'journal.json');

afterAll(() => {
  rmSync(дом, { recursive: true, force: true });
});

/** Мост, которого нет: запоминает просьбы и отвечает заготовленным. */
class ПоддельныйМост {
  readonly просьбы: Array<{ kind: TalkCommandKind; text?: string }> = [];
  ответ: TalkAnswer = { ok: true, text: 'сделано' };

  ask(kind: TalkCommandKind, text?: string): Promise<TalkAnswer> {
    this.просьбы.push({ kind, text });
    return Promise.resolve(this.ответ);
  }
}

function текстОтвета(результат: unknown): string {
  const content = (результат as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .filter((часть) => часть.type === 'text')
    .map((часть) => часть.text ?? '')
    .join('\n');
}

function отказ(результат: unknown): boolean {
  return (результат as { isError?: boolean }).isError === true;
}

async function поднять(мост = new ПоддельныйМост()): Promise<{ client: Client; мост: ПоддельныйМост }> {
  const server = createTalkMcpServer(мост as never);
  const [к, с] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'проверка', version: '1.0.0' });
  await Promise.all([server.connect(с), client.connect(к)]);
  return { client, мост };
}

beforeEach(() => {
  new NoteStore(process.env.JARVIS_NOTES as string).clear();
  new PlanStore(process.env.JARVIS_PLAN as string).clear();
});

describe('набор рычагов', () => {
  it('ровно те, что объявлены, и ничего сверх', async () => {
    // Лишний инструмент у разговора — это рука, которой у него быть не должно.
    const { client } = await поднять();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TALK_TOOLS].sort());
    await client.close();
  });

  it('рабочих инструментов здесь нет вовсе', async () => {
    const { client } = await поднять();
    const имена = (await client.listTools()).tools.map((tool) => tool.name);
    for (const чужое of ['screenshot', 'click', 'browser_open', 'blender_python']) {
      expect(имена).not.toContain(чужое);
    }
    await client.close();
  });
});

describe('start_work', () => {
  it('передаёт задачу мосту и пересказывает ответ', async () => {
    const { client, мост } = await поднять();
    мост.ответ = { ok: true, text: 'Запускаю: собрать отчёт' };

    const ответ = await client.callTool({ name: 'start_work', arguments: { task: 'собери отчёт' } });

    expect(мост.просьбы).toEqual([{ kind: 'start', text: 'собери отчёт' }]);
    expect(текстОтвета(ответ)).toBe('Запускаю: собрать отчёт');
    expect(отказ(ответ)).toBe(false);
    await client.close();
  });

  it('отказ помечает отказом, а не пересказывает как успех', async () => {
    const { client, мост } = await поднять();
    мост.ответ = { ok: false, text: 'Джарвис не ответил.' };

    const ответ = await client.callTool({ name: 'start_work', arguments: { task: 'что-нибудь' } });

    expect(отказ(ответ)).toBe(true);
    await client.close();
  });
});

describe('stop_work', () => {
  it('просит мост погасить работу', async () => {
    const { client, мост } = await поднять();
    await client.callTool({ name: 'stop_work', arguments: {} });
    expect(мост.просьбы).toEqual([{ kind: 'stop', text: undefined }]);
    await client.close();
  });
});

describe('pause_work и resume_work', () => {
  it('отложить — это не погасить, и мост узнаёт об этом разными словами', async () => {
    // Иначе «отложи пока» теряет работу насовсем: сессия агента закрывается, и
    // продолжать оказывается нечего.
    const { client, мост } = await поднять();

    await client.callTool({ name: 'pause_work', arguments: {} });
    await client.callTool({ name: 'resume_work', arguments: {} });

    expect(мост.просьбы.map((п) => п.kind)).toEqual(['pause', 'resume']);
    await client.close();
  });

  it('отказ моста пересказывается отказом', async () => {
    const { client, мост } = await поднять();
    мост.ответ = { ok: false, text: 'Продолжать нечего.' };

    const ответ = await client.callTool({ name: 'resume_work', arguments: {} });

    expect(отказ(ответ)).toBe(true);
    expect(текстОтвета(ответ)).toBe('Продолжать нечего.');
    await client.close();
  });
});

describe('add_note', () => {
  it('кладёт поправку в тот же ящик, из которого берёт агент', async () => {
    const { client } = await поднять();

    await client.callTool({ name: 'add_note', arguments: { text: 'шрифт крупнее' } });

    const ящик = new NoteStore(process.env.JARVIS_NOTES as string).peek();
    expect(ящик.map((note) => note.text)).toEqual(['шрифт крупнее']);
    await client.close();
  });

  it('пустую поправку отклоняет', async () => {
    const { client } = await поднять();
    const ответ = await client.callTool({ name: 'add_note', arguments: { text: '   ' } });
    expect(отказ(ответ)).toBe(true);
    await client.close();
  });
});

describe('add_step', () => {
  it('дописывает шаг в тот же план, что видит человек', async () => {
    const store = new PlanStore(process.env.JARVIS_PLAN as string);
    store.write(makePlan('собрать отчёт', ['найти данные'], 1000));
    const { client } = await поднять();

    const ответ = await client.callTool({ name: 'add_step', arguments: { text: 'добавить подвал' } });

    expect(store.read()?.steps.map((step) => step.text)).toEqual(['найти данные', 'добавить подвал']);
    expect(текстОтвета(ответ)).toContain('2');
    await client.close();
  });

  it('без плана отказывает, а не выдумывает план', async () => {
    const { client } = await поднять();
    const ответ = await client.callTool({ name: 'add_step', arguments: { text: 'куда-нибудь' } });
    expect(отказ(ответ)).toBe(true);
    expect(текстОтвета(ответ)).toContain('Плана нет');
    await client.close();
  });
});

describe('work_now', () => {
  it('отдаёт план, не спрашивая занятого агента', async () => {
    new PlanStore(process.env.JARVIS_PLAN as string).write(
      makePlan('собрать отчёт', ['найти данные'], 1000),
    );
    const { client } = await поднять();

    const ответ = await client.callTool({ name: 'work_now', arguments: {} });

    expect(текстОтвета(ответ)).toContain('найти данные');
    await client.close();
  });

  it('без плана говорит, что плана нет', async () => {
    const { client } = await поднять();
    expect(текстОтвета(await client.callTool({ name: 'work_now', arguments: {} }))).toContain(
      'Плана пока нет',
    );
    await client.close();
  });
});
