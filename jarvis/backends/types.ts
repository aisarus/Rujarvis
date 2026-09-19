/**
 * The `AgentBackend` abstraction.
 *
 * Jarvis core never talks to a model vendor directly. It talks to a backend,
 * and a backend is whatever can turn a request into a stream of events and a
 * result: the Workstation's own Open Interpreter runtime, an installed Claude
 * Code CLI, an installed Codex CLI, or an OpenAI-compatible endpoint.
 *
 * Adding a vendor means adding an adapter here, never touching Jarvis core.
 */

import type {
  JarvisCapability,
  RiskLevel,
  TaskPermissions,
} from '../types';

export const BACKEND_IDS = [
  'interpreter',
  'claude-code',
  'codex',
  'openai-compatible',
  'local',
] as const;

export type BackendId = (typeof BACKEND_IDS)[number];

/** Backends that are coding agents driven through their own official CLI. */
export const CODING_BACKEND_IDS: readonly BackendId[] = ['claude-code', 'codex'];

export interface BackendAvailability {
  id: BackendId;
  /** The CLI or runtime exists on this machine. */
  installed: boolean;
  /** The user has completed the vendor's own sign-in flow. */
  authenticated: boolean;
  /** Ready to accept work right now. */
  ready: boolean;
  version?: string;
  /** Resolved executable path. Never a token, never a credential. */
  path?: string;
  /** Russian, user-facing explanation when `ready` is false. */
  reason?: string;
  /** Set when the vendor reported an exhausted quota rather than a failure. */
  usageLimited?: boolean;
  checkedAt: number;
}

/**
 * A unit of work handed to a backend.
 *
 * `utterance` is always the user's own words. `goal` and `constraints` are the
 * router's normalisation and are additional context, never a replacement:
 * a strong backend always receives the original utterance too.
 */
export interface BackendRequest {
  /**
   * Куда класть готовые файлы.
   *
   * Без этого агент сохраняет результаты во временные каталоги, и человек их
   * потом не находит. Одна известная папка лучше, чем угадывание.
   */
  outputDir?: string;
  /**
   * Папка, в которой ассистент живёт.
   *
   * Даётся на чтение всегда. Без неё на вопрос о себе — «почему ты так
   * ответил», «какие у тебя навыки», «что у тебя в настройках» — он может
   * только гадать, притом что ответ лежит на диске в двух шагах.
   */
  homeDir?: string;
  /**
   * На чём уже спотыкались — собранное из журнала и прошлых планов.
   *
   * Самонаращивающийся кусок промпта: ничего не обучается, неудача просто
   * становится строкой следующего поручения. Стоит ноль вызовов модели.
   */
  lessons?: string;
  /**
   * Человек уже подтвердил эту работу голосом.
   *
   * Без этого подтверждение не значит ничего: задача всё равно запускается в
   * режиме, где безголовый Claude Code молча отклоняет каждую запись. Так был
   * потерян час работы — агент перевёл все тексты и не смог положить ни одного
   * файла, отчитавшись об этом уже постфактум.
   */
  approved?: boolean;
  /**
   * Работать на виду или в фоне.
   *
   * «На виду» — открывать окна и показывать сделанное. «В фоне» — та же работа
   * молча: человек занят своим, и окна, лезущие ему под руки, мешают больше,
   * чем помогают. Переключается голосом.
   */
  showWork?: boolean;
  /**
   * Постоянные указания человека — его собственный системный промпт.
   *
   * Читается из файла при каждом запросе, поэтому правка действует сразу, без
   * пересборки. Идёт выше всего остального: это то, что человек хочет от
   * ассистента всегда, а не в этой задаче.
   */
  instructions?: string;

  utterance: string;
  goal?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  /** Working directory for a coding backend. */
  cwd?: string;
  /** Resolved project name, when one was identified. */
  project?: string;
  /** Selected, relevance-limited memory and world-state lines. */
  context?: string[];
  capabilities: JarvisCapability[];
  risk: RiskLevel;
  permissions: TaskPermissions;
  /** Continue a previous backend session instead of starting a new one. */
  sessionId?: string;
  timeoutMs?: number;
  /** Language the answer should be written in. Jarvis defaults to Russian. */
  language?: string;
}

export interface BackendFileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
}

/**
 * Progress events. These describe what the backend actually did — files,
 * commands, status — not its chain of thought.
 */
export type BackendEvent =
  | { type: 'started'; backend: BackendId; sessionId?: string }
  | { type: 'status'; backend: BackendId; text: string }
  | { type: 'assistant-text'; backend: BackendId; text: string }
  | { type: 'tool'; backend: BackendId; name: string; detail?: string }
  | { type: 'file-changed'; backend: BackendId; change: BackendFileChange }
  | { type: 'command'; backend: BackendId; command: string; exitCode?: number | null }
  | { type: 'error'; backend: BackendId; message: string; retryable: boolean }
  | { type: 'completed'; backend: BackendId; result: BackendResult };

export interface BackendResult {
  ok: boolean;
  backend: BackendId;
  /** The complete answer. The UI shows this. */
  text: string;
  sessionId?: string;
  exitCode?: number | null;
  durationMs: number;
  filesChanged: BackendFileChange[];
  commands: string[];
  error?: string;
  cancelled?: boolean;
  timedOut?: boolean;
  /**
   * The vendor refused because a subscription quota is exhausted. This is the
   * signal the manager uses to fall back to another backend rather than
   * reporting a failure.
   */
  usageLimited?: boolean;
}

export interface BackendRun {
  readonly id: string;
  readonly backend: BackendId;
  /** Events until, and including, exactly one terminal `completed` event. */
  events: AsyncIterable<BackendEvent>;
  /** Stops the run as fast as the backend allows. Safe to call repeatedly. */
  cancel(reason?: string): void;
  /** Resolves with the same result carried by the terminal event. */
  result(): Promise<BackendResult>;
}

export interface AgentBackend {
  readonly id: BackendId;
  /** Display name, e.g. "Claude Code". */
  readonly name: string;
  readonly capabilities: ReadonlySet<JarvisCapability>;
  /** Cheap, cached probe. Must never throw. */
  checkAvailability(force?: boolean): Promise<BackendAvailability>;
  run(request: BackendRequest): BackendRun;
}

export function unavailable(
  id: BackendId,
  reason: string,
  extra: Partial<BackendAvailability> = {},
): BackendAvailability {
  return {
    id,
    installed: false,
    authenticated: false,
    ready: false,
    reason,
    checkedAt: Date.now(),
    ...extra,
  };
}
