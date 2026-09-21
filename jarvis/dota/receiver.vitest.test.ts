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
