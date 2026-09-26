/**
 * Управление компьютером через cua-driver — тот самый открытый драйвер,
 * на котором работает компьютер-юз у Кодекса.
 *
 * Голова у нас своя: Клод по подписке, без единого API-ключа. От драйвера
 * нужен не его цикл, а его глаза и руки — дерево доступности Windows и клики
 * по номеру элемента, а не по угаданным координатам.
 *
 * Порядок работы взят из замеров 20.09.2026 и держится на трёх числах:
 *
 *   снимок окна 1199×674        1 078 токенов   видно всё нарисованное
 *   поиск по имени                190–410       попадание 9 из 9
 *   полное дерево окна            6 877         то же самое, вдесятеро дороже
 *
 * Отсюда цикл: оглядеться снимком, действовать поиском по имени, нажимать по
 * номеру. Полное дерево наружу не выставлено намеренно — задача в двадцать
 * шагов стоит по нему 137 540 токенов вместо 7 078.
 *
 * Драйвер поднимается один раз и живёт: рукопожатие 116–181 мс, первый вызов
 * около двух секунд на прогрев, дальше 40–800 мс. Поднимать его под каждое
 * действие — терять две секунды на ровном месте.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { jarvisPaths } from '../setup/paths';

import {
  countedElements,
  windowsFromAnswer,
  matchingAmong,
  matchingElements,
  snapshotFromStructured,
  type CuaElement,
  type CuaSnapshot,
  type CuaWindow,
} from './cuaProtocol';

export type { CuaElement, CuaWindow };

/** Дерево схлопывается, когда окно не отрисовано. Меньше этого — не окно. */
const TREE_IS_ALIVE = 8;

/** Снимки помним по окну, а не по программе: окон у программы много. */
function ключСнимка(pid: number, windowId: number): string {
  return `${pid}:${windowId}`;
}

/**
 * Сколько ждать, пока Chromium достроит дерево доступности.
 *
 * Не пауза наугад, а предел ожидания: спрашиваем, пока дерево растёт.
 */
const ДЕРЕВО_ЖДЁМ_МС = 3_000;

/**
 * Отказ ли это «в фон нельзя, отдай переднему плану».
 *
 * Отличать обязательно: на этот отказ пробуют иначе, на любой другой —
 * падают. Иначе настоящая поломка тихо превратилась бы в увод фокуса.
 */
export function нуженПереднийПлан(беда: unknown): boolean {
  const текст = беда instanceof Error ? беда.message : String(беда);
  return /background delivery is not available/iu.test(текст) || /delivery_mode/iu.test(текст);
}

/** Первый вызов греет драйвер около двух секунд; остальные укладываются много быстрее. */
const ANSWER_MS = 30_000;

/**
 * Где лежит драйвер.
 *
 * Папка распаковки названа по версии сборки, поэтому точный путь не
 * прописывается: ищем исполняемый файл внутри. Переменная окружения
 * перекрывает поиск — ею же подменяют драйвер в проверках.
 */
export function driverPath(): string | null {
  const explicit = process.env.JARVIS_CUA_DRIVER?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  // Сюда его кладёт установщик (Install-CuaDriver); папка — общая для всего
  // Джарвиса, поэтому `JARVIS_HOME` переносит и драйвер.
  const root = jarvisPaths().cuaDriver;
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    const candidate = path.join(root, entry, 'cua-driver.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Ответ драйвера целиком: человеческий текст и структурная часть.
 *
 * Раньше брали только текст, и этого хватало для всего, кроме нажатий:
 * опознавательный знак элемента драйвер кладёт ИСКЛЮЧИТЕЛЬНО в структурную
 * часть, а без знака отказывает и `click`, и `type_text`.
 */
interface Ответ {
  текст: string;
  структура: unknown;
}

interface Pending {
  resolve: (ответ: Ответ) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Последний снимок дерева окна: чем адресовать его элементы. */
interface ПамятьСнимка {
  snapshotId: string | null;
  /** Номер элемента → его знак в этом снимке. */
  знаки: Map<number, string>;
}

export class CuaDriver {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private buffer = '';
  private nextId = 10;
  private readonly waiting = new Map<number, Pending>();
  /** Последний показанный снимок по каждому окну — для перевода номера в знак. */
  private readonly снимки = new Map<string, ПамятьСнимка>();

  /** Поднят ли драйвер. Для проверки здоровья, чтобы она не лгала. */
  isUp(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = (async () => {
      const exe = driverPath();
      if (!exe) {
        throw new Error(
          'Драйвер компьютер-юза не найден. Поставь cua-driver или укажи путь в JARVIS_CUA_DRIVER.',
        );
      }

      // detached ломает stdin на Windows — тот же капкан, что уже съел
      // проверку здоровья MCP-сервера. Процесс остаётся нашим ребёнком.
      const child = spawn(exe, ['mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.child = child;

      // Без слушателя `error` не запустившийся драйвер (нет прав, антивирус)
      // ронял весь процесс MCP-сервера.
      child.on('error', (беда: Error) => {
        this.child = null;
        this.ready = null;
        for (const [id, seat] of this.waiting) {
          clearTimeout(seat.timer);
          seat.reject(new Error(`Драйвер не запустился: ${беда.message}`));
          this.waiting.delete(id);
        }
      });
      child.stdin?.on('error', () => undefined);

      child.stdout?.on('data', (chunk: Buffer) => this.take(chunk.toString('utf8')));
      child.on('exit', () => {
        this.child = null;
        this.ready = null;
        for (const [id, seat] of this.waiting) {
          clearTimeout(seat.timer);
          seat.reject(new Error('Драйвер закрылся посреди работы'));
          this.waiting.delete(id);
        }
      });

      try {
        await this.ask('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'jarvis', version: '1' },
        });
      } catch (беда) {
        // Отклонённое обещание оставалось в `ready` НАВСЕГДА: один неудачный
        // запуск (драйвера нет, `initialize` не ответил за тридцать секунд на
        // холодном старте) ломал компьютер-юз до перезапуска приложения. Это
        // ровно та «смерть глаз и рук», о которой предупреждает комментарий к
        // `call`. Заодно гасим повисший процесс.
        this.ready = null;
        const ушедший = this.child;
        this.child = null;
        try {
          ушедший?.kill();
        } catch {
          // Уже мёртв — и хорошо.
        }
        throw беда;
      }
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })();

    return this.ready;
  }

  private send(message: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private take(text: string): void {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('{')) continue;

      let message: {
        id?: number;
        result?: {
          content?: { text?: string }[];
          isError?: boolean;
          structuredContent?: unknown;
        };
        error?: unknown;
      };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const seat = message.id === undefined ? undefined : this.waiting.get(message.id);
      if (!seat) continue;
      this.waiting.delete(message.id as number);
      clearTimeout(seat.timer);

      if (message.error) {
        seat.reject(new Error(JSON.stringify(message.error)));
        continue;
      }

      const текст = (message.result?.content ?? []).map((c) => c.text ?? '').join('');

      // Отказ ИНСТРУМЕНТА приходит не ошибкой протокола, а полем `isError` в
      // ответе. Смотрели только на ошибку протокола, поэтому «element not
      // found» и «session has ended» доезжали как успешная строка — и
      // `window_press`, `window_write`, `window_key` бодро отвечали
      // «Нажал», ничего не нажав.
      if (message.result?.isError === true) {
        seat.reject(new Error(текст || 'драйвер отказал без объяснения'));
        continue;
      }

      // Вместе со структурной частью, а не только текст. Знак элемента живёт
      // ТОЛЬКО там, и без него драйвер отказывает и нажимать, и печатать.
      seat.resolve({ текст, структура: message.result?.structuredContent });
    }
  }

  private ask(method: string, params: unknown): Promise<Ответ> {
    const id = this.nextId++;
    return new Promise<Ответ>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`Драйвер молчит дольше ${Math.round(ANSWER_MS / 1000)} с`));
      }, ANSWER_MS);
      this.waiting.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Позвать инструмент драйвера, подняв сессию, если она кончилась.
   *
   * У драйвера своя жизнь сессии, и он заканчивает её сам — по простою или
   * после собственной ошибки. Дальше он отвечает на ВСЁ одной фразой: «this
   * session has ended; call start_session explicitly to reuse its label».
   * Управления этим здесь не было вовсе, и глаза с руками Джарвиса умирали
   * молча до перезапуска приложения.
   *
   * Молча — потому что для списка окон эта фраза не разбиралась, и пустота
   * уходила человеку бодрым «Открытых окон нет». Поймано живым прогоном
   * 25.09.2026: на экране стояли Блендер, Клод и браузер.
   */
  private async call(name: string, args: Record<string, unknown>, ещёРаз = true): Promise<string> {
    return (await this.callFull(name, args, ещёРаз)).текст;
  }

  /** То же, но с структурной частью — нужна там, где важны знаки элементов. */
  private async callFull(
    name: string,
    args: Record<string, unknown>,
    ещёРаз = true,
  ): Promise<Ответ> {
    await this.start();
    const ответ = await this.ask('tools/call', { name, arguments: args });

    if (ещёРаз && /session has ended|call start_session/iu.test(ответ.текст)) {
      await this.ask('tools/call', { name: 'start_session', arguments: {} }).catch(() => undefined);
      return this.callFull(name, args, false);
    }
    return ответ;
  }

  /**
   * Запомнить снимок, который МОДЕЛЬ сейчас увидит.
   *
   * Номера элементов человек и модель берут из показанного дерева, а драйверу
   * нужен знак. Перевод между ними возможен только по тому самому снимку, из
   * которого номера и взяты, — поэтому помним его здесь, а не спрашиваем
   * заново перед нажатием: свежий снимок мог бы перенумеровать элементы, и
   * нажатие ушло бы не туда, о чём никто бы не узнал.
   */
  private запомнитьСнимок(pid: number, windowId: number, структура: unknown): CuaSnapshot {
    const снимок = snapshotFromStructured(структура);
    const знаки = new Map<number, string>();
    for (const э of снимок.elements) {
      if (э.token) знаки.set(э.index, э.token);
    }
    // Пустой снимок не запоминаем: он стёр бы годный и превратил бы нажатие в
    // отказ там, где оно работало.
    if (снимок.snapshotId || знаки.size > 0) {
      this.снимки.set(ключСнимка(pid, windowId), { snapshotId: снимок.snapshotId, знаки });
    }
    return снимок;
  }

  /** Чем адресовать элемент по его номеру: знаком, снимком или ничем. */
  private адрес(pid: number, windowId: number, index: number): Record<string, unknown> {
    const память = this.снимки.get(ключСнимка(pid, windowId));
    const знак = память?.знаки.get(index);
    if (знак) return { element_token: знак };
    if (память?.snapshotId) return { snapshot_id: память.snapshotId, element_index: index };
    // Честный отказ вместо запроса, который драйвер всё равно отклонит фразой
    // про element_token — она человеку не говорит ничего.
    throw new Error(
      `Элемент ${index} не из последнего снимка окна. Посмотри окно заново и повтори.`,
    );
  }

  /** Окна, с которыми можно работать. Своё наложение и рабочий стол отсеяны. */
  async windows(): Promise<CuaWindow[]> {
    return windowsFromAnswer(await this.call('list_windows', { on_screen_only: true }));
  }

  /**
   * Снять окно в файл.
   *
   * Перед снимком окно выводится вперёд: дерево и отрисовка у неактивного окна
   * схлопываются, и снимок выходит пустым или устаревшим.
   */
  async look(
    pid: number,
    windowId: number,
    file: string,
  ): Promise<{ width: number; height: number; path: string }> {
    await this.call('bring_to_front', { pid, window_id: windowId });
    const answer = await this.call('get_window_state', {
      pid,
      window_id: windowId,
      include_accessibility_tree: false,
      include_screenshot: true,
      screenshot_out_file: file,
      max_dimension: 1200,
    });
    const size = /size=(\d+)x(\d+)/.exec(answer);
    if (!size) throw new Error(`Снимок не сделан: ${answer.slice(0, 200)}`);
    return { width: Number(size[1]), height: Number(size[2]), path: file };
  }

  /**
   * Найти в окне элементы по имени.
   *
   * Отдаёт только то, у чего есть номер: элемент без номера нажать нечем, и
   * показывать его модели — значит обещать действие, которого нет.
   */
  /**
   * Дерево окна — спросив столько раз, сколько нужно, чтобы оно достроилось.
   *
   * Chromium (Edge, Chrome, Electron, VS Code, Slack, Discord) держит дерево
   * доступности не всегда: оно стоит памяти, и строится оно ПО ПЕРВОМУ
   * запросу вспомогательной программы. То есть первый вопрос его заводит, а
   * видит уже второй.
   *
   * Замер на живом Edge 26.09.2026, окно с кнопкой «Нажми меня» и полем:
   *
   *   1-й запрос  33 элемента  95 мс  кнопки нет
   *   2-й запрос  36 элементов 76 мс  кнопка ЕСТЬ, поле ЕСТЬ
   *   3..6-й      36 элементов        кнопка ЕСТЬ
   *
   * Порядок проверен нарочно однообразным: если дело в пределах обхода,
   * кнопка появилась бы только у опытов с пределом. Она появилась у всех
   * поздних — значит дело во времени. До этого `find` спрашивал один раз,
   * получал раму окна и отвечал «окно не отрисовано»: нажать в окне Chromium
   * было нельзя ни по чему.
   *
   * Спрашиваем, пока дерево РАСТЁТ, и останавливаемся, когда два ответа
   * подряд дали одинаковую длину. Обычно это один лишний вопрос на восемьдесят
   * миллисекунд, а не фиксированная пауза наугад.
   */
  private async деревоОкна(pid: number, windowId: number, wanted: string): Promise<Ответ> {
    let ответ: Ответ = { текст: '', структура: undefined };
    let прежде = -1;
    let росло = false;
    const конец = Date.now() + ДЕРЕВО_ЖДЁМ_МС;
    do {
      ответ = await this.callFull('get_window_state', {
        pid,
        window_id: windowId,
        include_accessibility_tree: true,
        include_screenshot: false,
        query: wanted,
      });
      const сейчас = countedElements(ответ.текст);
      if (сейчас === null) break;
      // Выходим только после того, как дерево ХОТЬ РАЗ выросло: пока Chromium
      // его не построил, оно одинаково коротко, и «две подряд совпали»
      // означает не готовность, а раму окна. Та же гонка поймана на маке
      // 26.09.2026 — там она и вскрылась.
      if (сейчас > прежде && прежде >= 0) росло = true;
      if (росло && сейчас === прежде) break;
      прежде = сейчас;
    } while (Date.now() < конец);
    return ответ;
  }

  async find(pid: number, windowId: number, wanted: string): Promise<CuaElement[]> {
    const answer = await this.деревоОкна(pid, windowId, wanted);
    const counted = countedElements(answer.текст);
    if (counted !== null && counted < TREE_IS_ALIVE) {
      throw new Error(
        `Окно отдало всего ${counted} элементов — похоже, оно не отрисовано. Сделай снимок окна и повтори.`,
      );
    }
    const снимок = this.запомнитьСнимок(pid, windowId, answer.структура);
    // Только совпавшие по имени, точное вперёд: рядом живут «Terminal» и
    // «Run in terminal», а предков драйвер подмешивает для наглядности.
    //
    // Структурная часть впереди разметки: правило отбора у них одно
    // (`matchingAmong`), но только структура несёт знаки элементов. Разметка
    // остаётся запасом — драйвер старее нашего может её и не прислать.
    if (снимок.elements.length > 0) return matchingAmong(снимок.elements, wanted);
    return matchingElements(answer.текст, wanted);
  }

  /**
   * Нажать по элементу, а не по угаданным координатам.
   *
   * Голый номер драйвер отклоняет: «bare element_index is not accepted; pass
   * element_token, or snapshot_id together with element_index». Знак берём из
   * снимка, по которому номер и был назван.
   *
   * Переднему плану, как и клавиши, не отдаём сразу: окна Chromium драйвер
   * отказывается трогать в фоне и говорит об этом прямо, вот тогда и
   * поднимаем. Платить фокусом человека заранее незачем.
   */
  async press(pid: number, windowId: number, index: number): Promise<string> {
    const адрес = this.адрес(pid, windowId, index);
    try {
      return await this.call('click', { pid, window_id: windowId, ...адрес });
    } catch (беда) {
      if (!нуженПереднийПлан(беда)) throw беда;
      return this.call('click', {
        pid,
        window_id: windowId,
        ...адрес,
        delivery_mode: 'foreground',
      });
    }
  }

  /** Напечатать в элемент. Адресация и передний план — как у нажатия. */
  async writeInto(pid: number, windowId: number, index: number, text: string): Promise<string> {
    const адрес = this.адрес(pid, windowId, index);
    try {
      return await this.call('type_text', { pid, window_id: windowId, ...адрес, text });
    } catch (беда) {
      if (!нуженПереднийПлан(беда)) throw беда;
      return this.call('type_text', {
        pid,
        window_id: windowId,
        ...адрес,
        text,
        delivery_mode: 'foreground',
      });
    }
  }

  /**
   * Нажать клавишу в окне: Enter, Escape, Tab и прочее.
   *
   * Окнам Chromium драйвер отказывается посылать клавиши «в фон» и прямо
   * говорит, чем это лечится: `delivery_mode: "foreground"` — он сам выведет
   * окно вперёд и вернёт передний план прежнему хозяину. Замер 26.09.2026:
   * «Background delivery is not available for target window class
   * 'Chrome_WidgetWin_1' on this event kind (keystroke)».
   *
   * Сразу переднему плану не отдаём: он отнимает фокус у того, в чём человек
   * печатает, и платить этим на каждой клавише незачем.
   */
  async key(pid: number, windowId: number, key: string): Promise<string> {
    try {
      return await this.call('press_key', { pid, window_id: windowId, key });
    } catch (беда) {
      if (!нуженПереднийПлан(беда)) throw беда;
      return this.call('press_key', { pid, window_id: windowId, key, delivery_mode: 'foreground' });
    }
  }

  /** Закрыть драйвер. Вызывается, когда уходит тот, кто его поднял. */
  dispose(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.kill();
  }
}
