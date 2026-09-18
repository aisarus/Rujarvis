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
