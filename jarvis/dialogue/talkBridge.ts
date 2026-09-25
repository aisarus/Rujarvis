/**
 * Мост между разговором и главным процессом.
 *
 * ## Зачем он нужен
 *
 * Разговор живёт в CLI, его рычаги — в MCP-сервере, а это отдельный процесс.
 * Три рычага из пяти сервер делает сам: ящик правок, план и журнал — обычные
 * файлы, которые он и так читает и пишет. Но «заведи работу» и «останови
 * работу» живут в менеджере задач внутри Электрона, и дотянуться туда из
 * чужого процесса нечем.
 *
 * ## Почему по файлу на запрос
 *
 * Общий список пришлось бы писать обоим, и появилась бы гонка ровно того рода,
 * из-за которой в ящике правок теряются реплики. Отдельный файл на запрос и
 * отдельный на ответ убирают её целиком: у каждого файла один писатель.
 *
 * Тот же приём, что у оверлея Доты и живых сессий Блендера — и его видно
 * глазами, когда что-то пойдёт не так.
 *
 * ## Почему имена файлов латиницей
 *
 * Кириллица в именах, которые проходят через `cmd`, консоль и чужие процессы,
 * уже ломала здесь механику не раз. Русский остаётся в содержимом, где его
 * читает только `JSON.parse`.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Что разговор просит сделать руками рабочего потока. */
export type TalkCommandKind = 'start' | 'stop' | 'pause' | 'resume';

const ВИДЫ = new Set<TalkCommandKind>(['start', 'stop', 'pause', 'resume']);

export interface TalkRequest {
  id: string;
  kind: TalkCommandKind;
  /** Задача для `start`. У остальных пусто. */
  text?: string;
  at: number;
}

export interface TalkAnswer {
  ok: boolean;
  /** Что сказать разговору. Он это перескажет человеку. */
  text: string;
}

export type TalkHandler = (request: TalkRequest) => Promise<TalkAnswer> | TalkAnswer;

export interface TalkBridgeOptions {
  /** Сколько ждать ответа, прежде чем признать, что его не будет. */
  waitMs?: number;
  /** Как часто заглядывать в папку. */
  stepMs?: number;
  now?: () => number;
}

/**
 * Сколько ждать ответа моста.
 *
 * Пять секунд: завести задачу — это записать её в менеджер, а не выполнить.
 * Если за пять секунд не ответили, главный процесс занят настолько, что
 * честнее сказать об этом, чем держать разговор в тишине.
 */
const WAIT_MS = 5_000;
const STEP_MS = 50;

/** Ответы старше этого — мусор от запросов, которых никто не дождался. */
const STALE_MS = 60_000;

export class TalkBridge {
  private readonly waitMs: number;
  private readonly stepMs: number;
  private readonly now: () => number;

  constructor(private readonly dir: string, options: TalkBridgeOptions = {}) {
    this.waitMs = options.waitMs ?? WAIT_MS;
    this.stepMs = options.stepMs ?? STEP_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Сторона сервера: попросить и дождаться.
   *
   * Отказ — такой же ответ, как согласие. Молчание в инструменте читается
   * моделью как успех, и разговор скажет человеку «запустил» про незапущенное.
   */
  async ask(kind: TalkCommandKind, text?: string): Promise<TalkAnswer> {
    const id = randomUUID();
    const request: TalkRequest = { id, kind, text, at: this.now() };

    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file('req', id), JSON.stringify(request), 'utf8');
    } catch (error) {
      return { ok: false, text: `Не смог передать: ${message(error)}` };
    }

    const deadline = this.now() + this.waitMs;
    while (this.now() < deadline) {
      const answer = this.readAnswer(id);
      if (answer) return answer;
      await pause(this.stepMs);
    }

    // Никто не забрал. Запрос убираем за собой: исполненный через минуту после
    // разговора он был бы неожиданностью, а не помощью.
    //
    // Но «убрал» и «не успел убрать» — разные ответы. Если файла уже нет,
    // значит его ЗАБРАЛИ и, возможно, исполняют прямо сейчас. Сказать в этом
    // случае «не ответил» значит соврать: разговор передаст человеку, что
    // ничего не запущено, тот повторит просьбу — и работа заведётся дважды.
    const был = existsSync(this.file('req', id));
    drop(this.file('req', id));
    if (был) return { ok: false, text: 'Джарвис не ответил.' };
    return { ok: false, text: 'Джарвис взял просьбу, но не ответил вовремя — исход неизвестен.' };
  }

  /**
   * Выбросить всё, что осталось от прошлого запуска.
   *
   * Просьба, пережившая перезапуск, — это не память, а неожиданность: человек
   * сказал «заведи работу» вчера, Джарвис упал, а сегодня на старте завёл бы
   * её молча. Тот же довод, что у ящика правок, который тоже чистится на входе.
   */
  clear(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const name of readdirSync(this.dir)) {
        if (name.startsWith('req-') || name.startsWith('ans-')) drop(path.join(this.dir, name));
      }
    } catch {
      // Папки нет — значит и чистить нечего.
    }
  }

  /**
   * Сторона главного процесса: исполнять приходящее.
   *
   * Возвращает «перестать», и это не формальность: мост переживёт разговор,
   * если его не остановить, и будет заводить задачи после его смерти.
   */
  serve(handler: TalkHandler): () => void {
    mkdirSync(this.dir, { recursive: true });
    let busy = false;

    const tick = (): void => {
      if (busy) return;
      busy = true;
      void this.round(handler).finally(() => {
        busy = false;
      });
    };

    const timer = setInterval(tick, this.stepMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Один заход по папке. Отдельно от таймера — чтобы его можно было позвать в тесте. */
  async round(handler: TalkHandler): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }

    for (const name of names) {
      if (name.startsWith('ans-')) {
        this.forgetStale(name);
        continue;
      }
      if (!name.startsWith('req-') || !name.endsWith('.json')) continue;

      const file = path.join(this.dir, name);
      const request = readRequest(file);
      // Забираем до исполнения: упавший обработчик не должен получить тот же
      // запрос на следующем заходе и завести вторую такую же задачу.
      drop(file);
      if (!request) continue;

      let answer: TalkAnswer;
      try {
        answer = await handler(request);
      } catch (error) {
        answer = { ok: false, text: `Не вышло: ${message(error)}` };
      }
      this.writeAnswer(request.id, answer);
    }
  }

  private file(kind: 'req' | 'ans', id: string): string {
    return path.join(this.dir, `${kind}-${id}.json`);
  }

  private readAnswer(id: string): TalkAnswer | null {
    const file = this.file('ans', id);
    if (!existsSync(file)) return null;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      drop(file);
      if (!parsed || typeof parsed !== 'object') return null;
      const answer = parsed as Partial<TalkAnswer>;
      if (typeof answer.ok !== 'boolean' || typeof answer.text !== 'string') return null;
      return { ok: answer.ok, text: answer.text };
    } catch {
      // Файл мог быть пойман наполовину записанным. Следующий заход прочтёт
      // его целиком.
      return null;
    }
  }

  private writeAnswer(id: string, answer: TalkAnswer): void {
    try {
      // Через переименование: спрашивающий опрашивает папку каждые сто
      // миллисекунд и успевал заглянуть в ещё пустой файл, не разобрать его —
      // и удалить. Ответ пропадал совсем.
      const черновик = `${this.file('ans', id)}.tmp`;
      writeFileSync(черновик, JSON.stringify(answer), 'utf8');
      renameSync(черновик, this.file('ans', id));
    } catch {
      // Диск занят. Спрашивающий уйдёт по сроку и скажет об этом честно.
    }
  }

  /** Ответ, которого никто не дождался, лежал бы в папке до перезапуска. */
  private forgetStale(name: string): void {
    const file = path.join(this.dir, name);
    try {
      if (this.now() - statSync(file).mtimeMs > STALE_MS) drop(file);
    } catch {
      // Файла уже нет или он нечитаем. Мусор дешевле падения уборщика.
    }
  }
}

function readRequest(file: string): TalkRequest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const request = parsed as Partial<TalkRequest>;
    // id идёт в имя файла ответа: из чужого процесса мог прийти и «../../x».
    if (typeof request.id !== 'string' || !/^[a-z0-9-]{1,64}$/iu.test(request.id)) return null;
    if (!ВИДЫ.has(request.kind as TalkCommandKind)) return null;
    return {
      id: request.id,
      kind: request.kind as TalkCommandKind,
      text: typeof request.text === 'string' ? request.text : undefined,
      at: typeof request.at === 'number' ? request.at : 0,
    };
  } catch {
    return null;
  }
}

function drop(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* уже нет — и хорошо */
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
