/**
 * Interpreter backend — the Workstation's own Open Interpreter runtime.
 *
 * This is the general-purpose backend: computer-use, browser, files, shell,
 * vision and skills all live there already. Jarvis does not reimplement any of
 * it; the adapter only translates between the Workstation's programmatic task
 * stream and the Jarvis event vocabulary.
 *
 * The runtime itself is injected (`InterpreterRuntimeDriver`) so Jarvis core
 * stays testable and so the Workstation's own service, not a copy of it,
 * remains the single implementation.
 */

import type { JarvisCapability } from '../types';
import { createManagedRun } from './managedRun';
import type {
  AgentBackend,
  BackendAvailability,
  BackendEvent,
  BackendRequest,
  BackendRun,
} from './types';

const BACKEND_ID = 'interpreter' as const;

const CAPABILITIES: ReadonlySet<JarvisCapability> = new Set<JarvisCapability>([
  'reasoning',
  'coding',
  'files',
  'shell',
  'computer',
  'browser',
  'vision',
  'web',
  'memory',
  'communication',
  'system',
  'creative',
]);

/** A progress event from the Workstation runtime, already narrowed. */
export type InterpreterRuntimeEvent =
  | { kind: 'thread'; threadId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail?: string }
  | { kind: 'command'; command: string }
  | { kind: 'file'; path: string; action: 'created' | 'modified' | 'deleted' }
  | { kind: 'status'; text: string }
  | { kind: 'error'; message: string };

export interface InterpreterRuntimeHandle {
  events: AsyncIterable<InterpreterRuntimeEvent>;
  /** Resolves once the turn is finished, with the final assistant text. */
  done: Promise<{ ok: boolean; text: string; threadId?: string; error?: string }>;
  cancel(): void;
}

export interface InterpreterRuntimeDriver {
  /** True when the Workstation runtime is installed and configured. */
  isReady(): Promise<{ ready: boolean; reason?: string; version?: string }>;
  start(input: {
    message: string;
    system?: string;
    workspace?: string;
    threadId?: string;
    timeoutMs?: number;
  }): InterpreterRuntimeHandle;
}

export interface InterpreterBackendOptions {
  driver: InterpreterRuntimeDriver;
  availabilityTtlMs?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
}

/**
 * The system prompt Jarvis prepends for the general runtime.
 *
 * It states the language contract and the permission envelope; the envelope
 * itself is still enforced by the Workstation's own permission layer, this
 * text only keeps the model from trying.
 */
export function buildInterpreterSystemPrompt(request: BackendRequest): string {
  const lines = [
    'Ты — исполнительный слой ассистента Джарвис на компьютере пользователя.',
    'Отвечай по-русски, коротко и по делу. Не пересказывай свои рассуждения — сообщай действия и результат.',
  ];
  if (!request.permissions.edit) {
    lines.push('Не изменяй и не создавай файлы. Только осмотри и доложи.');
  }
  if (!request.permissions.execute) {
    lines.push('Не выполняй команды, меняющие состояние системы.');
  }
  if (request.risk === 'sensitive' || request.risk === 'dangerous') {
    lines.push('Не выполняй действия наружу (отправка сообщений, публикация, оплата) без прямой просьбы.');
  }
  if (request.context && request.context.length > 0) {
    lines.push('Контекст:', ...request.context.map((line) => `- ${line}`));
  }
  return lines.join('\n');
}

export class InterpreterBackend implements AgentBackend {
  readonly id = BACKEND_ID;
  readonly name = 'Interpreter';
  readonly capabilities = CAPABILITIES;

  private cached: BackendAvailability | null = null;
  private readonly now: () => number;

  constructor(private readonly options: InterpreterBackendOptions) {
    this.now = options.now ?? Date.now;
  }

  async checkAvailability(force = false): Promise<BackendAvailability> {
    const ttl = this.options.availabilityTtlMs ?? 30_000;
    if (!force && this.cached && this.now() - this.cached.checkedAt < ttl) {
      return this.cached;
    }
    let availability: BackendAvailability;
    try {
      const status = await this.options.driver.isReady();
      availability = {
        id: BACKEND_ID,
        installed: true,
        authenticated: status.ready,
        ready: status.ready,
        version: status.version,
        reason: status.ready ? undefined : (status.reason ?? 'Runtime Interpreter не готов'),
        checkedAt: this.now(),
      };
    } catch (error) {
      availability = {
        id: BACKEND_ID,
        installed: false,
        authenticated: false,
        ready: false,
        reason: `Не удалось проверить Interpreter: ${error instanceof Error ? error.message : String(error)}`,
        checkedAt: this.now(),
      };
    }
    this.cached = availability;
    return availability;
  }

  invalidate(): void {
    this.cached = null;
  }

  run(request: BackendRequest): BackendRun {
    return createManagedRun({
      backend: BACKEND_ID,
      now: this.now,
      availability: () => this.checkAvailability(),
      execute: ({ emit, onCancel }) => {
        const handle = this.options.driver.start({
          message: request.utterance,
          system: buildInterpreterSystemPrompt(request),
          workspace: request.cwd,
          threadId: request.sessionId,
          timeoutMs: request.timeoutMs ?? this.options.defaultTimeoutMs,
        });
        onCancel(() => handle.cancel());

        const pump = (async () => {
          for await (const event of handle.events) {
            emit(toBackendEvent(event));
          }
        })();

        return handle.done.then(async (outcome) => {
          await pump.catch(() => undefined);
          return {
            ok: outcome.ok,
            text: outcome.text,
            sessionId: outcome.threadId,
            error: outcome.error,
          };
        });
      },
    });
  }
}

function toBackendEvent(event: InterpreterRuntimeEvent): BackendEvent {
  switch (event.kind) {
    case 'thread':
      return { type: 'status', backend: BACKEND_ID, text: 'Interpreter запущен' };
    case 'text':
      return { type: 'assistant-text', backend: BACKEND_ID, text: event.text };
    case 'tool':
      return { type: 'tool', backend: BACKEND_ID, name: event.name, detail: event.detail };
    case 'command':
      return { type: 'command', backend: BACKEND_ID, command: event.command };
    case 'file':
      return {
        type: 'file-changed',
        backend: BACKEND_ID,
        change: { path: event.path, action: event.action },
      };
    case 'status':
      return { type: 'status', backend: BACKEND_ID, text: event.text };
    case 'error':
      return { type: 'error', backend: BACKEND_ID, message: event.message, retryable: true };
  }
}
