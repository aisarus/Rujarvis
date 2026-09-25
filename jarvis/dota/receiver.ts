/**
 * Приём пакетов Game State Integration.
 *
 * ## Почему свой сервер, а не готовая обвязка
 *
 * Работы здесь на тридцать строк: Дота шлёт POST с JSON на локальный адрес,
 * ответ ей безразличен. Зависимость ради этого — лишний повод сломаться.
 *
 * ## Почему обработчик обёрнут в try
 *
 * Пакеты идут по два-три в секунду и никого не ждут. Исключение в пороге,
 * если его не поймать, оборвёт приём до конца матча — и человек этого даже не
 * заметит, потому что молчащий помощник выглядит в точности как спокойный.
 * Это ровно тот вид поломки, на который ушёл весь день 20 сентября.
 *
 * ## Настройка со стороны игры
 *
 * Файл `gamestate_integration_jarvis.cfg` в `game/dota/cfg/gamestate_integration/`
 * и ключ запуска `-gamestateintegration`. Без ключа игра молчит и никак об
 * этом не сообщает — молчание на порту значит именно это, а не «нет матча».
 */
import { createServer, type Server } from 'node:http';

import { readPacket, type DotaPacket } from './packet';

/** Порт из конфига разведки. Занят — значит уже кто-то слушает. */
export const DEFAULT_PORT = 39847;

export interface ReceiverOptions {
  /** 0 — просить свободный у системы; так работают тесты. */
  port?: number;
  onPacket(packet: DotaPacket): void;
  /** Нечитаемое тело. Молчать о нём нельзя: это признак беды на той стороне. */
  onJunk?(raw: string): void;
  /**
   * Сырое тело до разбора — для записи.
   *
   * Разобранный снимок теряет всё, чего мы сегодня не читаем: предметы,
   * способности, здания, чат-события целиком. Запись нужна именно сырой:
   * завтрашний порог будет смотреть на то, о чём сегодня никто не думал, и
   * переигрывать матч заново не выйдет.
   */
  onRaw?(raw: string): void;
}

export interface Receiver {
  port: number;
  stop(): Promise<void>;
}

export async function startReceiver(options: ReceiverOptions): Promise<Receiver> {
  const сервер: Server = createServer((запрос, ответ) => {
    let тело = '';
    запрос.on('data', (кусок) => { тело += кусок; });
    запрос.on('end', () => {
      ответ.writeHead(200, { 'Content-Type': 'text/plain' });
      ответ.end('ok');

      try { options.onRaw?.(тело); } catch { /* запись не должна ронять приём */ }

      let сырой: unknown;
      try { сырой = JSON.parse(тело); } catch { options.onJunk?.(тело); return; }

      const пакет = readPacket(сырой);
      if (!пакет) { options.onJunk?.(тело); return; }

      try { options.onPacket(пакет); } catch (беда) {
        // Приём важнее любого одного потребителя.
        console.error('[dota] обработчик пакета бросил:', беда);
      }
    });
  });

  // Ошибку `listen` надо превратить в отказ обещания. Без этого занятый порт
  // вылетал необработанным событием сервера: стек вызовов в консоль и смерть
  // процесса мимо всякой обработки — а занятый порт самая частая беда запуска.
  await new Promise<void>((готово, беда) => {
    const наОшибку = (ошибка: Error) => { сервер.off('listening', наУспех); беда(ошибка); };
    const наУспех = () => { сервер.off('error', наОшибку); готово(); };
    сервер.once('error', наОшибку);
    сервер.once('listening', наУспех);
    сервер.listen(options.port ?? DEFAULT_PORT, '127.0.0.1');
  });

  const адрес = сервер.address();
  const порт = typeof адрес === 'object' && адрес ? адрес.port : (options.port ?? DEFAULT_PORT);

  return {
    port: порт,
    stop: () => new Promise<void>((готово) => { сервер.close(() => готово()); }),
  };
}
