/**
 * Connects the Jarvis `InterpreterBackend` to the Workstation's own runtime.
 *
 * This is the only place that knows both vocabularies. Jarvis core stays free
 * of Workstation internals, and the Workstation keeps exactly one agent
 * implementation — this file translates between them and nothing else.
 */

import { randomUUID } from 'node:crypto';

import { startAgentTask, type AgentTaskProgressEvent } from '../agentTaskService';
import { agentTabManager } from '../agentTabManager';
import { EventChannel } from '../../jarvis/backends/process';
import type {
  InterpreterRuntimeDriver,
  InterpreterRuntimeEvent,
  InterpreterRuntimeHandle,
} from '../../jarvis/backends/interpreter';

/** Tool item types that are really a shell command. */
const COMMAND_ITEM_TYPES = new Set(['commandExecution', 'localShellCall', 'exec']);
/** Tool item types that change files. */
const FILE_ITEM_TYPES = new Set(['fileChange', 'patchApply']);

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Translates one Workstation progress event into Jarvis events.
 *
 * Exported for tests: this mapping is the part that drifts when the upstream
 * event schema changes, so it is covered directly.
 */
export function toRuntimeEvents(progress: AgentTaskProgressEvent): InterpreterRuntimeEvent[] {
  if (progress.kind === 'thread') {
    return [{ kind: 'thread', threadId: progress.threadId }];
  }
  if (progress.kind === 'turn') {
    return [];
  }

  const { event } = progress;

  if (event.event === 'final') {
    const text = textOf(event.payload.text);
    return text ? [{ kind: 'text', text }] : [];
  }

  if (event.event === 'error') {
    const info = asRecord(event.payload.errorInfo);
    const message =
      textOf(info?.text) ??
      textOf(event.payload.additionalDetails) ??
      'Ошибка выполнения';
    return [{ kind: 'error', message }];
  }

  if (event.event === 'tool') {
    // Only the start of a tool call is worth showing: the completion arrives
    // as its own event and would double every line of the progress list.
    if (event.payload.phase !== 'started') return [];

    const item = asRecord(event.payload.item) ?? {};
    const type = event.payload.type;

    if (COMMAND_ITEM_TYPES.has(type)) {
      const command =
        textOf(item.command) ??
        (Array.isArray(item.command) ? item.command.join(' ') : undefined);
      return command ? [{ kind: 'command', command }] : [];
    }

    if (FILE_ITEM_TYPES.has(type)) {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const events: InterpreterRuntimeEvent[] = [];
      for (const entry of changes) {
        const change = asRecord(entry);
        const path = textOf(change?.path);
        if (!path) continue;
        const kind = textOf(change?.kind) ?? 'update';
        events.push({
          kind: 'file',
          path,
          action: kind === 'add' || kind === 'create'
            ? 'created'
            : kind === 'delete'
              ? 'deleted'
              : 'modified',
        });
      }
      return events;
    }

    return [{ kind: 'tool', name: type, detail: textOf(item.title) ?? textOf(item.query) }];
  }

  if (event.event === 'planUpdated') {
    const explanation = textOf(event.payload.explanation);
    return explanation ? [{ kind: 'status', text: explanation }] : [];
  }

  // Deltas, user messages, compaction and turn completion carry nothing the
  // progress list should show.
  return [];
}

export interface InterpreterRuntimeDriverOptions {
  /** Workspace used when a request names no project. */
  defaultWorkspace?: string;
  /** Overridable for tests. */
  start?: typeof startAgentTask;
}

/**
 * Builds the driver the `InterpreterBackend` consumes.
 *
 * Headless mode is deliberate: Jarvis owns the conversation surface, so a
 * voice request should not open a new agent tab every time someone says
 * «открой хром».
 */
export function createInterpreterRuntimeDriver(
  options: InterpreterRuntimeDriverOptions = {},
): InterpreterRuntimeDriver {
  const start = options.start ?? startAgentTask;

  // The desktop tools — launching apps, clicking, typing, reading the screen —
  // check who is calling them and refuse an unregistered caller with "Unknown
  // interpreter caller token". Jarvis is a real caller, so it registers once
  // and signs every task it starts. Without this the model plans the action
  // correctly and the runtime rejects it at the last step.
  const agentId = `agent-jarvis-${randomUUID()}`;
  const callerToken = `agtok_${randomUUID()}`;
  agentTabManager.registerAgentRuntime({
    agentId,
    callerToken,
    workspacePath: options.defaultWorkspace,
  });

  return {
    async isReady() {
      // The runtime ships with the app. A missing workspace is the one
      // condition that makes a headless task impossible, and it is worth
      // reporting precisely rather than as a generic failure later.
      if (!options.defaultWorkspace) {
        return {
          ready: false,
          reason: 'Не выбрана рабочая папка. Откройте workspace в приложении.',
        };
      }
      return { ready: true };
    },

    start(input): InterpreterRuntimeHandle {
      const channel = new EventChannel<InterpreterRuntimeEvent>();
      const controller = new AbortController();
      let finalText = '';
      let threadId: string | undefined;
      let errorMessage: string | undefined;

      const done = start({
        mode: 'headless',
        message: input.message,
        system: input.system,
        workspace: input.workspace ?? options.defaultWorkspace,
        callerToken,
        threadId: input.threadId,
        timeoutMs: input.timeoutMs,
        abortSignal: controller.signal,
        onProgress: (progress) => {
          for (const event of toRuntimeEvents(progress)) {
            if (event.kind === 'text') finalText = event.text;
            if (event.kind === 'thread') threadId = event.threadId;
            if (event.kind === 'error') errorMessage = event.message;
            channel.push(event);
          }
        },
      })
        .then((result) => {
          channel.close();
          return {
            ok: result.completed && !result.error,
            text: finalText || lastAssistantText(result.messages) || '',
            threadId: result.threadId ?? threadId,
            error: result.error ?? errorMessage,
          };
        })
        .catch((error: unknown) => {
          channel.close();
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            text: finalText,
            threadId,
            // An abort is a cancellation, not a failure worth reporting as one.
            error: controller.signal.aborted ? 'Отменено' : message,
          };
        });

      return {
        events: channel,
        done,
        cancel: () => controller.abort(),
      };
    },
  };
}

/** Falls back to the transcript when no `final` event carried the answer. */
function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message) continue;
    if (message.role !== 'assistant' && message.type !== 'agentMessage') continue;
    const text = textOf(message.text) ?? textOf(message.content);
    if (text) return text;
  }
  return '';
}
