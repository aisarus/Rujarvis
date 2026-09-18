import { describe, expect, it, vi } from 'vitest';
import {
  createInterpreterRuntimeDriver,
  toRuntimeEvents,
} from './interpreterRuntimeDriver';
import { InterpreterBackend } from '../../jarvis/backends/interpreter';
import type { AgentTaskProgressEvent } from '../agentTaskService';
import type { AgentTaskResult } from '../agentTaskService';
import type { BackendRequest } from '../../jarvis/backends/types';
import { DEFAULT_PERMISSIONS } from '../../jarvis/types';

function request(overrides: Partial<BackendRequest> = {}): BackendRequest {
  return {
    utterance: 'закрой это окно',
    capabilities: ['computer'],
    risk: 'safe',
    permissions: DEFAULT_PERMISSIONS,
    ...overrides,
  };
}

describe('toRuntimeEvents', () => {
  it('reports the thread so a task can be resumed later', () => {
    expect(toRuntimeEvents({ kind: 'thread', threadId: 'th-1' })).toEqual([
      { kind: 'thread', threadId: 'th-1' },
    ]);
  });

  it('ignores turn bookkeeping, which carries nothing to show', () => {
    expect(
      toRuntimeEvents({
        kind: 'turn',
        threadId: 'th-1',
        turnId: 't-1',
        status: 'completed',
      } as AgentTaskProgressEvent),
    ).toEqual([]);
  });

  it('takes the final answer', () => {
    expect(
      toRuntimeEvents({
        kind: 'ui',
        event: { event: 'final', payload: { text: 'Закрыл окно Блокнота.' } },
      } as AgentTaskProgressEvent),
    ).toEqual([{ kind: 'text', text: 'Закрыл окно Блокнота.' }]);
  });

  it('drops streaming deltas — progress shows actions, not typing', () => {
    expect(
      toRuntimeEvents({
        kind: 'ui',
        event: { event: 'delta', payload: { text: 'Сей' } },
      } as AgentTaskProgressEvent),
    ).toEqual([]);
  });

  it('turns a started command tool call into a command event', () => {
    expect(
      toRuntimeEvents({
        kind: 'ui',
        event: {
          event: 'tool',
          payload: {
            phase: 'started',
            type: 'commandExecution',
            item: { command: 'pnpm build' },
          },
        },
      } as unknown as AgentTaskProgressEvent),
    ).toEqual([{ kind: 'command', command: 'pnpm build' }]);
  });

  it('ignores the completion half so the list is not doubled', () => {
    expect(
      toRuntimeEvents({
        kind: 'ui',
        event: {
          event: 'tool',
          payload: {
            phase: 'completed',
            type: 'commandExecution',
            item: { command: 'pnpm build' },
          },
        },
      } as unknown as AgentTaskProgressEvent),
    ).toEqual([]);
  });

  it('maps file changes with their kind', () => {
    expect(
      toRuntimeEvents({
        kind: 'ui',
        event: {
          event: 'tool',
          payload: {
            phase: 'started',
            type: 'fileChange',
            item: {
              changes: [
                { path: 'a.ts', kind: 'update' },
                { path: 'b.ts', kind: 'add' },
                { path: 'c.ts', kind: 'delete' },
              ],
            },
          },
        },
      } as unknown as AgentTaskProgressEvent),
    ).toEqual([
      { kind: 'file', path: 'a.ts', action: 'modified' },
      { kind: 'file', path: 'b.ts', action: 'created' },
      { kind: 'file', path: 'c.ts', action: 'deleted' },
    ]);
  });

  it('surfaces an error with its text', () => {
    expect(
      toRuntimeEvents({
        kind: 'ui',
        event: {
          event: 'error',
          payload: { errorInfo: { kind: 'raw', text: 'Окно не найдено' } },
        },
      } as unknown as AgentTaskProgressEvent),
    ).toEqual([{ kind: 'error', message: 'Окно не найдено' }]);
  });
});

describe('createInterpreterRuntimeDriver', () => {
  function taskResult(overrides: Partial<AgentTaskResult> = {}): AgentTaskResult {
    return {
      mode: 'headless',
      completed: true,
      timestamp: new Date().toISOString(),
      messageCount: 0,
      messages: [],
      ...overrides,
    };
  }

  it('reports plainly when there is no workspace to work in', async () => {
    const driver = createInterpreterRuntimeDriver({});
    const ready = await driver.isReady();
    expect(ready.ready).toBe(false);
    expect(ready.reason).toContain('рабочая папка');
  });

  it('runs headless so a voice request does not open a new agent tab', async () => {
    const start = vi.fn(async () => taskResult({ threadId: 'th-9' }));
    const driver = createInterpreterRuntimeDriver({
      defaultWorkspace: 'D:\\Work',
      start: start as never,
    });

    const handle = driver.start({ message: 'закрой это окно' });
    const outcome = await handle.done;

    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[0]).toMatchObject({
      mode: 'headless',
      message: 'закрой это окно',
      workspace: 'D:\\Work',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.threadId).toBe('th-9');
  });

  it('streams progress and carries the final answer through', async () => {
    const start = vi.fn(async (options: { onProgress?: (event: AgentTaskProgressEvent) => void }) => {
      options.onProgress?.({ kind: 'thread', threadId: 'th-2' });
      options.onProgress?.({
        kind: 'ui',
        event: {
          event: 'tool',
          payload: { phase: 'started', type: 'commandExecution', item: { command: 'taskkill' } },
        },
      } as AgentTaskProgressEvent);
      options.onProgress?.({
        kind: 'ui',
        event: { event: 'final', payload: { text: 'Закрыл.' } },
      } as AgentTaskProgressEvent);
      return taskResult({ threadId: 'th-2' });
    });

    const driver = createInterpreterRuntimeDriver({
      defaultWorkspace: 'D:\\Work',
      start: start as never,
    });

    const handle = driver.start({ message: 'закрой окно' });
    const seen: string[] = [];
    const pump = (async () => {
      for await (const event of handle.events) seen.push(event.kind);
    })();

    const outcome = await handle.done;
    await pump;

    expect(seen).toEqual(['thread', 'command', 'text']);
    expect(outcome.text).toBe('Закрыл.');
  });

  it('aborts the run on cancel and calls it a cancellation, not a failure', async () => {
    let seenSignal: AbortSignal | undefined;
    const start = vi.fn(
      (options: { abortSignal?: AbortSignal }) =>
        new Promise<AgentTaskResult>((_, reject) => {
          seenSignal = options.abortSignal;
          options.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const driver = createInterpreterRuntimeDriver({
      defaultWorkspace: 'D:\\Work',
      start: start as never,
    });

    const handle = driver.start({ message: 'долгая задача' });
    handle.cancel();
    const outcome = await handle.done;

    expect(seenSignal?.aborted).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('Отменено');
  });

  it('falls back to the transcript when no final event carried the answer', async () => {
    const start = vi.fn(async () =>
      taskResult({
        messages: [
          { role: 'user', text: 'закрой окно' },
          { role: 'assistant', text: 'Окно закрыто.' },
        ],
      }),
    );
    const driver = createInterpreterRuntimeDriver({
      defaultWorkspace: 'D:\\Work',
      start: start as never,
    });

    expect((await driver.start({ message: 'закрой окно' }).done).text).toBe('Окно закрыто.');
  });

  it('drives a full InterpreterBackend run', async () => {
    const start = vi.fn(async (options: { onProgress?: (event: AgentTaskProgressEvent) => void }) => {
      options.onProgress?.({
        kind: 'ui',
        event: { event: 'final', payload: { text: 'Открыл Chrome.' } },
      } as AgentTaskProgressEvent);
      return taskResult({ threadId: 'th-3' });
    });

    const backend = new InterpreterBackend({
      driver: createInterpreterRuntimeDriver({
        defaultWorkspace: 'D:\\Work',
        start: start as never,
      }),
    });

    const result = await backend.run(request({ utterance: 'Открой Chrome' })).result();

    expect(result.ok).toBe(true);
    expect(result.text).toBe('Открыл Chrome.');
    expect(result.sessionId).toBe('th-3');
    // The system prompt states the language contract and the envelope.
    expect(start.mock.calls[0]?.[0]).toMatchObject({ mode: 'headless' });
  });

  it('tells the backend why it cannot run when there is no workspace', async () => {
    const backend = new InterpreterBackend({ driver: createInterpreterRuntimeDriver({}) });
    const result = await backend.run(request()).result();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('рабочая папка');
  });
});
