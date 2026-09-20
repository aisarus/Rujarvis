/**
 * Живая сессия Claude Code: один процесс на много реплик.
 *
 * ## Зачем
 *
 * Каждая фраза, дошедшая до агента, поднимала новый процесс. Замер
 * 20.09.2026: 4.4 секунды до подключения MCP-сервера, ещё пара на запуск
 * самого CLI. Для голосового помощника это плата за каждое слово.
 *
 * Замер живой сессии на том же дне, три хода подряд в одном процессе:
 *
 *     ход 1   MCP подключён за 4.4 с
 *     ход 2   MCP подключён за 0.1 с, контекст первого хода на месте
 *     ход 3   MCP подключён за 0.1 с
 *
 * То есть холодный старт платится один раз за разговор. И это работает на
 * подписке, без единого ключа — проверено тем же прогоном.
 *
 * ## Чем сессия ограничена
 *
 * Папка, список инструментов и режим разрешений задаются при запуске процесса
 * и потом не меняются. Значит одна сессия обслуживает только задачи с теми же
 * тремя вещами; на несовпадении заводится новая. В разговоре подряд идущие
 * реплики обычно совпадают, и это тот случай, ради которого всё затевалось.
 *
 * Ходы идут строго по одному. CLI обрабатывает сообщения последовательно, и
 * послать второе, не дождавшись `result` первого, — это гонка с непонятным
 * исходом. Здесь второй ход просто ждёт своей очереди.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { EventChannel } from './process';
import type { BackendEvent, BackendResult, BackendRun } from './types';

const BACKEND_ID = 'claude-code' as const;
const NL = String.fromCharCode(10);

/**
 * Чем одна сессия отличается от другой.
 *
 * Всё, что нельзя поменять у живого процесса. Совпало — можно переиспользовать,
 * не совпало — нужен новый.
 */
export interface SessionKey {
  cwd?: string;
  /** Список разрешённых инструментов, как он уходит в командную строку. */
  tools: string;
  permissionMode: string;
  mcpConfig?: string;
  model?: string;
}

export function sameSession(a: SessionKey, b: SessionKey): boolean {
  return (
    (a.cwd ?? '') === (b.cwd ?? '') &&
    a.tools === b.tools &&
    a.permissionMode === b.permissionMode &&
    (a.mcpConfig ?? '') === (b.mcpConfig ?? '') &&
    (a.model ?? '') === (b.model ?? '')
  );
}

/**
 * Аргументы запуска живой сессии.
 *
 * Отличие от разового прогона одно и важное: `--input-format stream-json`.
 * `--verbose` обязателен — без него CLI отказывается отдавать поток.
 */
export function buildLiveArgs(key: SessionKey, extra: readonly string[] = []): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    key.permissionMode,
  ];
  if (key.model) args.push('--model', key.model);
  if (key.mcpConfig) {
    args.push('--mcp-config', key.mcpConfig, '--strict-mcp-config');
    args.push('--allowedTools', key.tools);
  }
  return [...args, ...extra];
}

/** Одна реплика человека в том виде, в каком её ждёт CLI. */
export function userMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}${NL}`;
}

/** Разбор одной строки потока в события. Тот же, что у разового прогона. */
export type ConsumeLine = (
  raw: Record<string, unknown>,
  emit: (event: BackendEvent) => void,
) => void;

export interface LiveSessionOptions {
  key: SessionKey;
  command: string;
  extraArgs?: readonly string[];
  consumeLine: ConsumeLine;
  env?: NodeJS.ProcessEnv;
  /** Сколько ждать `result` одного хода, прежде чем считать сессию мёртвой. */
  turnTimeoutMs?: number;
  now?: () => number;
  spawnProcess?: typeof spawn;
}

/**
 * Сколько ходу позволено молчать.
 *
 * Тот же замер, что у CLI-пути: самая длинная пауза живой работы — 590 секунд.
 * Пятнадцать минут дают полуторный запас и ловят именно зависание.
 */
const TURN_TIMEOUT_MS = 15 * 60_000;

interface Turn {
  channel: EventChannel<BackendEvent>;
  settle: (result: BackendResult) => void;
  startedAt: number;
  text: string;
  sessionId?: string;
  /** Счётчик молчания. Перевзводится на каждом признаке жизни. */
  timer: NodeJS.Timeout;
}

export class LiveSession {
  private child: ChildProcess | null = null;
  private buffer = '';
  private turn: Turn | null = null;
  private readonly queue: Array<() => void> = [];
  private dead = false;
  private spoken = false;

  constructor(private readonly options: LiveSessionOptions) {}

  get key(): SessionKey {
    return this.options.key;
  }

  /** Жива ли. Мёртвую переиспользовать нельзя. */
  isAlive(): boolean {
    return !this.dead && this.child !== null && this.child.exitCode === null;
  }

  /** Занята ли ходом прямо сейчас. */
  isBusy(): boolean {
    return this.turn !== null;
  }

  /**
   * Был ли уже ход.
   *
   * По этому решают, слать полный промпт или короткий: правила и устройство
   * работы агент прочитал первым ходом и помнит.
   */
  hasSpoken(): boolean {
    return this.spoken;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private start(): void {
    if (this.child) return;
    const spawnIt = this.options.spawnProcess ?? spawn;
    const child = spawnIt(this.options.command, buildLiveArgs(this.options.key, this.options.extraArgs), {
      cwd: this.options.key.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => this.take(chunk));
    child.on('exit', () => this.die('Сессия закрылась'));
    child.on('error', (error) => this.die(error.message));
  }

  /**
   * Сессия кончилась — и незавершённый ход обязан получить ответ.
   *
   * Молча оставить вызывающего ждать хуже, чем сказать «не вышло»: задача
   * повиснет навсегда, и человек будет смотреть на пустой экран.
   */
  private die(why: string): void {
    this.dead = true;
    const turn = this.turn;
    this.turn = null;
    this.child = null;
    if (turn) {
      clearTimeout(turn.timer);
      const result: BackendResult = {
        ok: false,
        backend: BACKEND_ID,
        text: '',
        durationMs: this.now() - turn.startedAt,
        filesChanged: [],
        commands: [],
        error: why,
      };
      turn.channel.push({ type: 'completed', backend: BACKEND_ID, result });
      turn.channel.close();
      turn.settle(result);
    }
    for (const waiting of this.queue.splice(0)) waiting();
  }

  /**
   * Ход подал признак жизни: счётчик молчания начинается заново.
   *
   * Таймер назывался «сессия молчит», а считал ВСЁ время хода. Длинная работа
   * упиралась в него посреди дела: прогон «3D-модель по 2D-видео» убит на
   * 1200-й секунде при живом потоке событий. Теперь считается именно молчание,
   * а величина взята из замера настоящих пауз — см. SILENCE_LIMIT_MS.
   */
  private touch(): void {
    const turn = this.turn;
    if (!turn) return;
    clearTimeout(turn.timer);
    turn.timer = setTimeout(
      () => this.die('Сессия молчит слишком долго'),
      this.options.turnTimeoutMs ?? TURN_TIMEOUT_MS,
    );
    turn.timer.unref?.();
  }

  private take(chunk: string): void {
    // До разбора: даже нечитаемая строка доказывает, что процесс жив.
    this.touch();
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf(NL)) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line.startsWith('{')) continue;

      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.consume(raw);
    }
  }

  private consume(raw: Record<string, unknown>): void {
    const turn = this.turn;
    if (!turn) return;

    this.options.consumeLine(raw, (event) => {
      if (event.type === 'started' && event.sessionId) turn.sessionId = event.sessionId;
      if (event.type === 'assistant-text') turn.text += event.text;
      turn.channel.push(event);
    });

    if (raw.type !== 'result') return;

    // Ход кончился. Только теперь можно пускать следующий.
    clearTimeout(turn.timer);
    this.turn = null;

    const failed = raw.is_error === true || raw.subtype !== 'success';
    const result: BackendResult = {
      ok: !failed,
      backend: BACKEND_ID,
      text: typeof raw.result === 'string' && raw.result ? raw.result : turn.text,
      sessionId: turn.sessionId,
      durationMs: this.now() - turn.startedAt,
      filesChanged: [],
      commands: [],
      error: failed ? String(raw.subtype ?? 'не вышло') : undefined,
    };
    turn.channel.push({ type: 'completed', backend: BACKEND_ID, result });
    turn.channel.close();
    turn.settle(result);

    const next = this.queue.shift();
    if (next) next();
  }

  /** Спросить. Ход встаёт в очередь, если сессия занята. */
  ask(prompt: string): BackendRun {
    const channel = new EventChannel<BackendEvent>();
    let settle: (result: BackendResult) => void = () => {};
    const done = new Promise<BackendResult>((resolve) => {
      settle = resolve;
    });

    const begin = (): void => {
      if (this.dead) {
        const result: BackendResult = {
          ok: false,
          backend: BACKEND_ID,
          text: '',
          durationMs: 0,
          filesChanged: [],
          commands: [],
          error: 'Сессия закрылась',
        };
        channel.push({ type: 'completed', backend: BACKEND_ID, result });
        channel.close();
        settle(result);
        return;
      }

      this.start();
      const timer = setTimeout(
        () => this.die('Сессия молчит слишком долго'),
        this.options.turnTimeoutMs ?? TURN_TIMEOUT_MS,
      );
      timer.unref?.();

      this.turn = { channel, settle, startedAt: this.now(), text: '', timer };
      this.spoken = true;
      channel.push({ type: 'started', backend: BACKEND_ID });
      this.child?.stdin?.write(userMessage(prompt));
    };

    if (this.turn) this.queue.push(begin);
    else begin();

    return {
      id: randomUUID(),
      backend: BACKEND_ID,
      events: channel,
      // Прервать ход нечем: у CLI нет отмены посреди хода. Значит закрываем
      // сессию целиком — «стоп» обязан срабатывать, а лишний холодный старт
      // потом дешевле невыполненной команды остановки.
      cancel: () => this.dispose('Отменено'),
      result: () => done,
    };
  }

  /** Закрыть сессию. Незавершённый ход получит ответ, а не повиснет. */
  dispose(why = 'Сессия закрыта'): void {
    const child = this.child;
    this.die(why);
    child?.kill();
  }
}
