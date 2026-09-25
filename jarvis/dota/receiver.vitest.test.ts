import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import type { DotaPacket } from './packet';
import { startReceiver, type Receiver } from './receiver';

const бой = JSON.parse(readFileSync('jarvis/dota/samples/fight.json', 'utf8')) as { d: unknown };

/**
 * POST голым сокетом, а не через `fetch`.
 *
 * Причин две, и обе настоящие. Первая: в наборе тестов поднят MSW с
 * `onUnhandledRequest: 'error'` — он перехватывает `fetch` и валит запрос к
 * собственному серверу. Глушить сторож ради одного теста неправильно, он там
 * не зря. Вторая: Дота тоже ходит не через `fetch`, так что проводной формат
 * здесь ровно тот, который будет в бою.
 */
function послать(порт: number, тело: string): Promise<string> {
  return new Promise((готово, беда) => {
    const сокет = connect(порт, '127.0.0.1', () => {
      сокет.write(
        `POST / HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${порт}\r\n`
        + `Content-Type: application/json\r\n`
        + `Content-Length: ${Buffer.byteLength(тело)}\r\n`
        + `Connection: close\r\n\r\n${тело}`,
      );
    });
    let ответ = '';
    сокет.on('data', (кусок) => { ответ += кусок; });
    сокет.on('end', () => готово(ответ));
    сокет.on('error', беда);
  });
}

let приёмник: Receiver | null = null;
afterEach(async () => { await приёмник?.stop(); приёмник = null; });

describe('startReceiver', () => {
  it('отдаёт разобранный пакет на каждый POST', async () => {
    const пришли: DotaPacket[] = [];
    приёмник = await startReceiver({ port: 0, onPacket: (п) => { пришли.push(п); } });

    await послать(приёмник.port, JSON.stringify(бой.d));

    expect(пришли).toHaveLength(1);
    expect(пришли[0].enemies.length).toBeGreaterThanOrEqual(3);
    expect(пришли[0].self?.hero).toBe('npc_dota_hero_skeleton_king');
  });

  it('на мусоре не падает и зовёт onJunk', async () => {
    const мусор: string[] = [];
    const пришли: DotaPacket[] = [];
    приёмник = await startReceiver({
      port: 0,
      onPacket: (п) => { пришли.push(п); },
      onJunk: (с) => { мусор.push(с); },
    });

    await послать(приёмник.port, '{это не json');

    expect(мусор).toHaveLength(1);
    expect(пришли).toHaveLength(0);
  });

  it('ошибка в обработчике не роняет приёмник', async () => {
    // Дота шлёт пакеты дважды в секунду и не ждёт нас. Исключение в пороге не
    // должно обрывать приём: иначе одна опечатка глушит всё до конца матча, а
    // молчащий помощник выглядит в точности как спокойный.
    let сколько = 0;
    приёмник = await startReceiver({
      port: 0,
      onPacket: () => { сколько += 1; if (сколько === 1) throw new Error('нарочно'); },
    });

    const тело = JSON.stringify(бой.d);
    await послать(приёмник.port, тело);
    const ответ = await послать(приёмник.port, тело);

    expect(ответ).toContain('200');
    expect(сколько).toBe(2);
  });

  it('поднимается на свободном порту и отпускает его при остановке', async () => {
    приёмник = await startReceiver({ port: 0, onPacket: () => {} });
    const порт = приёмник.port;
    expect(порт).toBeGreaterThan(0);

    await приёмник.stop();
    приёмник = null;

    // Тот же порт должен снова открыться: иначе повторный запуск в одной
    // сессии упрётся в собственный недозакрытый сервер.
    const второй = await startReceiver({ port: порт, onPacket: () => {} });
    expect(второй.port).toBe(порт);
    await второй.stop();
  });
});

describe('запись сырого', () => {
  it('отдаёт тело до разбора', async () => {
    const сырые: string[] = [];
    приёмник = await startReceiver({
      port: 0,
      onPacket: () => {},
      onRaw: (т) => { сырые.push(т); },
    });

    const тело = JSON.stringify(бой.d);
    await послать(приёмник.port, тело);

    expect(сырые).toEqual([тело]);
  });

  it('ошибка записи не мешает разбору', async () => {
    // Журнал не та вещь, ради которой стоит потерять пакет.
    const пришли: DotaPacket[] = [];
    приёмник = await startReceiver({
      port: 0,
      onPacket: (п) => { пришли.push(п); },
      onRaw: () => { throw new Error('диск полон'); },
    });

    await послать(приёмник.port, JSON.stringify(бой.d));

    expect(пришли).toHaveLength(1);
  });
});

describe('занятый порт', () => {
  it('отвечает отказом, а не убивает процесс', async () => {
    // Без этого занятый порт вылетал необработанным событием сервера: стек
    // вызовов в консоль и смерть процесса мимо всякой обработки.
    приёмник = await startReceiver({ port: 0, onPacket: () => {} });

    await expect(startReceiver({ port: приёмник.port, onPacket: () => {} }))
      .rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('пароль приёмника', () => {
  /**
   * Замечание CodeRabbit (кусок 3, PR №42). Порт слушает локальный адрес, и
   * написать на него мог любой процесс машины: поддельный пакет уходил в
   * состояние, в подсказки и в оверлей — окно с полным доступом к системе.
   */
  let свой: Receiver | undefined;
  afterEach(async () => {
    await свой?.stop();
    свой = undefined;
  });

  it('пакет без пароля не принимается', async () => {
    const пришли: unknown[] = [];
    свой = await startReceiver({ port: 0, token: 'секрет', onPacket: (п) => пришли.push(п) });

    await послать(свой.port, JSON.stringify({ map: { clock_time: 600 } }));
    expect(пришли).toEqual([]);
  });

  it('пакет с чужим паролем не принимается', async () => {
    const пришли: unknown[] = [];
    свой = await startReceiver({ port: 0, token: 'секрет', onPacket: (п) => пришли.push(п) });

    await послать(свой.port, JSON.stringify({ auth: { token: 'чужой' }, map: { clock_time: 600 } }));
    expect(пришли).toEqual([]);
  });

  it('пакет со своим паролем проходит', async () => {
    const пришли: unknown[] = [];
    свой = await startReceiver({ port: 0, token: 'секрет', onPacket: (п) => пришли.push(п) });

    await послать(свой.port, JSON.stringify({ auth: { token: 'секрет' }, map: { clock_time: 600 } }));
    expect(пришли.length).toBe(1);
  });
});
