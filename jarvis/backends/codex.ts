/**
 * Codex backend.
 *
 * Runs the official `codex` CLI as a child process. Authentication is the
 * user's own "Sign in with ChatGPT" through Codex — Jarvis never scrapes the
 * ChatGPT web app and never reads or reuses ChatGPT credentials itself.
 */

import type { AuthState } from './authHints';
import type { JarvisCapability } from '../types';
import { buildBackendPrompt } from './prompt';
import { looksUsageLimited } from './process';
import { createCliRun, type SpawnCli, type StreamState } from './cliRunner';
import {
  unavailable,
  type AgentBackend,
  type BackendAvailability,
  type BackendEvent,
  type BackendFileChange,
  type BackendRequest,
  type BackendRun,
} from './types';

const BACKEND_ID = 'codex' as const;

const AUTH_UNKNOWN_REASON =
  'Codex установлен, но вход не подтверждён. Пробую запустить — если вход не выполнен, выполните codex login.';

const CAPABILITIES: ReadonlySet<JarvisCapability> = new Set<JarvisCapability>([
  'reasoning',
  'coding',
  'files',
  'shell',
  'web',
]);

/** Codex sandbox levels, from most to least restricted. */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexCliProbe {
  status(): Promise<{
    installed: boolean;
    /** `'unknown'` means "no proof either way" — see `authHints.ts`. */
    loggedIn: AuthState;
    version?: string;
    path?: string;
    error?: string;
  }>;
}

export interface CodexBackendOptions {
  probe: CodexCliProbe;
  model?: string;
  /**
   * Permits `--sandbox danger-full-access`. Off by default; only an explicit
   * user setting turns it on, never model output.
   */
  allowFullAccess?: boolean;
  defaultTimeoutMs?: number;
  availabilityTtlMs?: number;
  spawnCli?: SpawnCli;
  now?: () => number;
}

/** Deterministic mapping from the task envelope onto a Codex sandbox level. */
export function selectSandbox(request: BackendRequest, allowFullAccess: boolean): CodexSandbox {
  if (!request.permissions.edit) return 'read-only';
  if (allowFullAccess && request.risk === 'safe') return 'danger-full-access';
  return 'workspace-write';
}

export function buildCodexArgs(
  request: BackendRequest,
  options: { model?: string; sandbox: CodexSandbox },
): string[] {
  const args = ['exec'];
  if (request.sessionId) {
    args.push('resume', request.sessionId);
  }
  args.push('--json', '--skip-git-repo-check', '--sandbox', options.sandbox);
  if (request.cwd) {
    args.push('--cd', request.cwd);
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  // `-` makes Codex read the prompt from stdin, which keeps long Russian
  // prompts off the Windows command line and its length limit.
  args.push('-');
  return args;
}

/**
 * Notices Codex emits while it retries a connection.
 *
 * These are progress, not failures: reporting each one as an error filled the
 * event stream with red lines for a request that was still perfectly alive.
 */
const RETRY_NOTICE_PATTERNS = [
  /^reconnecting/i,
  /waiting for network/i,
  /falling back from websockets/i,
  /stream disconnected before completion/i,
];

export function isRetryNotice(message: string): boolean {
  return RETRY_NOTICE_PATTERNS.some((pattern) => pattern.test(message.trim()));
}

/**
 * How many retry notices in a row mean the network is simply unavailable.
 *
 * Observed against the real CLI with a blocked endpoint: it retries five
 * times, falls back to another transport, then waits for a network that never
 * arrives — with no terminal event of its own. Without this the run sat until
 * its timeout, which is both a long silence for the user and a fallback that
 * never happens.
 */
export const MAX_CONSECUTIVE_RETRY_NOTICES = 6;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordFileChanges(
  item: Record<string, unknown>,
  state: StreamState,
  emit: (event: BackendEvent) => void,
): void {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  for (const entry of changes) {
    const record = asRecord(entry);
    if (!record) continue;
    const path = typeof record.path === 'string' ? record.path : undefined;
    if (!path) continue;
    const kind = typeof record.kind === 'string' ? record.kind : 'update';
    const action: BackendFileChange['action'] =
      kind === 'add' || kind === 'create' ? 'created' : kind === 'delete' ? 'deleted' : 'modified';
    const change: BackendFileChange = { path, action };
    state.filesChanged.push(change);
    emit({ type: 'file-changed', backend: BACKEND_ID, change });
  }
}

function consumeCodexItem(
  item: Record<string, unknown>,
  state: StreamState,
  emit: (event: BackendEvent) => void,
): void {
  const itemType = typeof item.type === 'string' ? item.type : '';

  if (itemType === 'assistant_message' || itemType === 'agent_message') {
    const text = typeof item.text === 'string' ? item.text : '';
    if (text.trim()) {
      state.text = text;
      emit({ type: 'assistant-text', backend: BACKEND_ID, text });
    }
    return;
  }

  if (itemType === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    if (command) {
      state.commands.push(command);
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
      emit({ type: 'command', backend: BACKEND_ID, command, exitCode });
    }
    return;
  }

  if (itemType === 'file_change' || itemType === 'patch_apply') {
    recordFileChanges(item, state, emit);
    return;
  }

  if (itemType === 'mcp_tool_call' || itemType === 'web_search') {
    const name = typeof item.tool === 'string' ? item.tool : itemType;
    const detail = typeof item.query === 'string' ? item.query : undefined;
    emit({ type: 'tool', backend: BACKEND_ID, name, detail });
    return;
  }

  if (itemType === 'error') {
    const message = typeof item.message === 'string' ? item.message : 'Ошибка Codex';
    if (isRetryNotice(message)) {
      emit({ type: 'status', backend: BACKEND_ID, text: 'Переподключаюсь…' });
      return;
    }
    state.errorMessage = message;
    if (looksUsageLimited(message)) state.usageLimited = true;
    emit({ type: 'error', backend: BACKEND_ID, message, retryable: true });
  }
}

/**
 * Translates one Codex JSONL line into Jarvis events.
 *
 * Handles both the thread-event schema (`thread.started`, `item.completed`)
 * and the older `{"msg": {...}}` envelope, because which one a machine emits
 * depends on the installed CLI version.
 */
export function consumeCodexStreamLine(
  raw: Record<string, unknown>,
  state: StreamState,
  emit: (event: BackendEvent) => void,
): void {
  const type = typeof raw.type === 'string' ? raw.type : '';

  if (type === 'thread.started') {
    const threadId = typeof raw.thread_id === 'string' ? raw.thread_id : undefined;
    if (threadId) state.sessionId = threadId;
    emit({ type: 'status', backend: BACKEND_ID, text: 'Codex запущен' });
    return;
  }

  if (type === 'item.completed' || type === 'item.started' || type === 'item.updated') {
    const item = asRecord(raw.item);
    if (item && type === 'item.completed') {
      consumeCodexItem(item, state, emit);
    }
    return;
  }

  if (type === 'turn.failed' || type === 'error') {
    const nested = asRecord(raw.error);
    const message =
      (typeof raw.message === 'string' ? raw.message : undefined) ??
      (nested && typeof nested.message === 'string' ? nested.message : undefined) ??
      'Ошибка Codex';

    if (isRetryNotice(message)) {
      emit({ type: 'status', backend: BACKEND_ID, text: 'Переподключаюсь…' });
      return;
    }

    state.errorMessage = message;
    if (looksUsageLimited(message)) state.usageLimited = true;
    emit({ type: 'error', backend: BACKEND_ID, message, retryable: true });
    return;
  }

  if (type === 'turn.completed') {
    return;
  }

  // Legacy envelope: {"id":"0","msg":{"type":"agent_message","message":"..."}}
  const msg = asRecord(raw.msg);
  if (!msg) return;
  const msgType = typeof msg.type === 'string' ? msg.type : '';

  if (msgType === 'session_configured') {
    const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
    if (sessionId) state.sessionId = sessionId;
    emit({ type: 'status', backend: BACKEND_ID, text: 'Codex запущен' });
    return;
  }
  if (msgType === 'agent_message') {
    const text = typeof msg.message === 'string' ? msg.message : '';
    if (text.trim()) {
      state.text = text;
      emit({ type: 'assistant-text', backend: BACKEND_ID, text });
    }
    return;
  }
  if (msgType === 'exec_command_begin') {
    const command = Array.isArray(msg.command) ? msg.command.join(' ') : String(msg.command ?? '');
    if (command.trim()) {
      state.commands.push(command);
      emit({ type: 'command', backend: BACKEND_ID, command });
    }
    return;
  }
  if (msgType === 'patch_apply_begin') {
    const changes = asRecord(msg.changes);
    if (changes) {
      for (const path of Object.keys(changes)) {
        const change: BackendFileChange = { path, action: 'modified' };
        state.filesChanged.push(change);
        emit({ type: 'file-changed', backend: BACKEND_ID, change });
      }
    }
    return;
  }
  if (msgType === 'error') {
    const message = typeof msg.message === 'string' ? msg.message : 'Ошибка Codex';
    if (isRetryNotice(message)) {
      emit({ type: 'status', backend: BACKEND_ID, text: 'Переподключаюсь…' });
      return;
    }
    state.errorMessage = message;
    if (looksUsageLimited(message)) state.usageLimited = true;
    emit({ type: 'error', backend: BACKEND_ID, message, retryable: true });
  }
}

/**
 * Wraps the line consumer with the connectivity check.
 *
 * Counts consecutive retry notices and, once they pass the threshold with no
 * real progress in between, declares the run fatally stuck so the runner can
 * stop it and the manager can try another backend.
 */
export function createCodexLineConsumer(): (
  raw: Record<string, unknown>,
  state: StreamState,
  emit: (event: BackendEvent) => void,
) => void {
  let consecutiveRetries = 0;

  return (raw, state, emit) => {
    consumeCodexStreamLine(raw, state, (event) => {
      if (event.type === 'status' && event.text === 'Переподключаюсь…') {
        consecutiveRetries += 1;
      } else if (event.type !== 'started') {
        // Any real progress means the connection is alive after all.
        consecutiveRetries = 0;
      }
      emit(event);
    });

    if (consecutiveRetries >= MAX_CONSECUTIVE_RETRY_NOTICES && !state.fatalMessage) {
      state.fatalMessage =
        'Codex не может подключиться к сети. Проверьте интернет или вход через ChatGPT.';
    }
  };
}

export class CodexBackend implements AgentBackend {
  readonly id = BACKEND_ID;
  readonly name = 'Codex';
  readonly capabilities = CAPABILITIES;

  private cached: BackendAvailability | null = null;
  private readonly now: () => number;

  constructor(private readonly options: CodexBackendOptions) {
    this.now = options.now ?? Date.now;
  }

  async checkAvailability(force = false): Promise<BackendAvailability> {
    const ttl = this.options.availabilityTtlMs ?? 30_000;
    if (!force && this.cached && this.now() - this.cached.checkedAt < ttl) {
      return this.cached;
    }

    let availability: BackendAvailability;
    try {
      const status = await this.options.probe.status();
      if (!status.installed) {
        availability = unavailable(
          BACKEND_ID,
          status.error ?? 'Codex CLI не установлен. Установите его и войдите через ChatGPT.',
          { checkedAt: this.now() },
        );
      } else if (status.loggedIn === 'unknown') {
        // No proof either way. Running and letting the CLI object is better
        // than refusing a backend that very likely works.
        availability = {
          id: BACKEND_ID,
          installed: true,
          authenticated: false,
          ready: true,
          version: status.version,
          path: status.path,
          reason: AUTH_UNKNOWN_REASON,
          checkedAt: this.now(),
        };
      } else if (!status.loggedIn) {
        availability = {
          id: BACKEND_ID,
          installed: true,
          authenticated: false,
          ready: false,
          version: status.version,
          path: status.path,
          reason: 'Codex установлен, но вход не выполнен. Запустите codex login и войдите через ChatGPT.',
          checkedAt: this.now(),
        };
      } else {
        availability = {
          id: BACKEND_ID,
          installed: true,
          authenticated: true,
          ready: true,
          version: status.version,
          path: status.path,
          checkedAt: this.now(),
        };
      }
    } catch (error) {
      availability = unavailable(
        BACKEND_ID,
        `Не удалось проверить Codex: ${error instanceof Error ? error.message : String(error)}`,
        { checkedAt: this.now() },
      );
    }

    this.cached = availability;
    return availability;
  }

  invalidate(): void {
    this.cached = null;
  }

  run(request: BackendRequest): BackendRun {
    const sandbox = selectSandbox(request, this.options.allowFullAccess === true);

    return createCliRun({
      backend: BACKEND_ID,
      availability: () => this.checkAvailability(),
      buildArgs: () => buildCodexArgs(request, { model: this.options.model, sandbox }),
      cwd: request.cwd,
      timeoutMs: request.timeoutMs ?? this.options.defaultTimeoutMs ?? 20 * 60_000,
      stdin: buildBackendPrompt(request),
      consumeLine: createCodexLineConsumer(),
      messages: {
        unavailable: 'Codex недоступен',
        spawnFailed: (detail) => `Не удалось запустить Codex: ${detail}`,
        timedOut: 'Codex превысил отведённое время',
        failed: 'Codex завершился с ошибкой',
      },
      spawnCli: this.options.spawnCli,
      now: this.now,
    });
  }
}
