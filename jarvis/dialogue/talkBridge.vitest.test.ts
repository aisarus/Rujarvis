import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { TalkBridge, type TalkRequest } from './talkBridge';

let dir: string;

beforeEach(() => {
  dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'jarvis-talk-')), 'bridge');
  mkdirSync(dir, { recursive: true });
});

/** Мост с короткими сроками: тесту незачем ждать пять секунд. */
const bridge = (now?: () => number): TalkBridge =>
  new TalkBridge(dir, { waitMs: 400, stepMs: 10, now });

describe('TalkBridge', () => {
  it('доносит просьбу и возвращает ответ', async () => {
    const сервер = bridge();
    const мост = bridge();
    const услышано: TalkRequest[] = [];

    const стоп = мост.serve((request) => {
      услышано.push(request);
      return { ok: true, text: 'Запускаю: отчёт' };
    });

    const ответ = await сервер.ask('start', 'собери отчёт');
    стоп();

    expect(ответ).toEqual({ ok: true, text: 'Запускаю: отчёт' });
    expect(услышано).toHaveLength(1);
    expect(услышано[0]?.kind).toBe('start');
    expect(услышано[0]?.text).toBe('собери отчёт');
  });

  it('без моста отвечает отказом, а не тишиной', async () => {
    // Молчание инструмента модель читает как успех, и разговор скажет
    // человеку «запустил» про незапущенное.
    const ответ = await bridge().ask('stop');
    expect(ответ.ok).toBe(false);
    expect(ответ.text).toBe('Джарвис не ответил.');
  });

  it('за собой убирает: просьбу, которую не забрали, не исполнят через час', async () => {
    await bridge().ask('stop');
    expect(readdirSync(dir).filter((name) => name.startsWith('req-'))).toHaveLength(0);
  });

  it('упавший рычаг — это отказ с причиной', async () => {
    const мост = bridge();
    const стоп = мост.serve(() => {
      throw new Error('менеджер задач занят');
    });

    const ответ = await bridge().ask('start', 'что-нибудь');
    стоп();

    expect(ответ.ok).toBe(false);
    expect(ответ.text).toContain('менеджер задач занят');
  });

  it('один запрос исполняется один раз', async () => {
    // Дубль здесь — это вторая такая же задача, заведённая молча.
    const мост = bridge();
    let раз = 0;
    const стоп = мост.serve(() => {
      раз += 1;
      return { ok: true, text: 'готово' };
    });

    await bridge().ask('start', 'один раз');
    await new Promise((resolve) => setTimeout(resolve, 60));
    стоп();

    expect(раз).toBe(1);
  });

  it('битый файл не роняет мост и не путается с просьбой', async () => {
    writeFileSync(path.join(dir, 'req-мусор.json'), 'не json', 'utf8');
    const мост = bridge();
    let звали = 0;

    await мост.round(() => {
      звали += 1;
      return { ok: true, text: 'не должно случиться' };
    });

    expect(звали).toBe(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('чужой ответ не достаётся тому, кто его не просил', async () => {
    writeFileSync(path.join(dir, 'ans-чужой.json'), JSON.stringify({ ok: true, text: 'чужое' }), 'utf8');
    const ответ = await bridge().ask('stop');
    expect(ответ.text).toBe('Джарвис не ответил.');
  });

  it('просьба, пережившая перезапуск, не исполняется', async () => {
    // Человек сказал «заведи работу» вчера, Джарвис упал — и сегодня на старте
    // завёл бы её молча. Это не память, а неожиданность.
    writeFileSync(
      path.join(dir, 'req-вчерашний.json'),
      JSON.stringify({ id: 'вчерашний', kind: 'start', text: 'вчерашнее дело', at: 1 }),
      'utf8',
    );

    const мост = bridge();
    мост.clear();
    let звали = 0;
    await мост.round(() => {
      звали += 1;
      return { ok: true, text: '' };
    });

    expect(звали).toBe(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('забытый ответ выметается по старости', async () => {
    writeFileSync(path.join(dir, 'ans-старый.json'), JSON.stringify({ ok: true, text: 'вчерашнее' }), 'utf8');
    // Час спустя: свежесть меряется временем правки файла.
    const мост = bridge(() => Date.now() + 3_600_000);

    await мост.round(() => ({ ok: true, text: '' }));

    expect(readdirSync(dir)).toHaveLength(0);
  });
});
