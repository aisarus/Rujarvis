/**
 * Run scaffolding for backends that are not a child process — the Workstation
 * runtime, an HTTP endpoint, a local model server.
 *
 * It provides the same guarantees as the CLI runner: an availability gate,
 * working cancellation, accumulated files/commands, and exactly one terminal
 * result that is produced even when the backend throws.
 */

import { randomUUID } from 'node:crypto';
import { EventChannel } from './process';
import type {
  BackendAvailability,
  BackendEvent,
  BackendFileChange,
  BackendId,
  BackendResult,
  BackendRun,
} from './types';

export interface ManagedRunContext {
  emit(event: BackendEvent): void;
  /** Registers the callback that stops the underlying work. */
  onCancel(handler: () => void): void;
  /** True once cancellation has been requested. */
  isCancelled(): boolean;
}

export interface ManagedRunOutcome {
  ok: boolean;
  text: string;
  sessionId?: string;
  error?: string;
  usageLimited?: boolean;
}

export interface ManagedRunSpec {
  backend: BackendId;
  availability: () => Promise<BackendAvailability>;
  execute: (context: ManagedRunContext) => Promise<ManagedRunOutcome>;
  now?: () => number;
}

export function createManagedRun(spec: ManagedRunSpec): BackendRun {
  const now = spec.now ?? Date.now;
  const channel = new EventChannel<BackendEvent>();
  const startedAt = now();
  const filesChanged: BackendFileChange[] = [];
  const commands: string[] = [];

  let cancelled = false;
  let cancelHandler: (() => void) | null = null;
  let settle: (result: BackendResult) => void = () => {};
  const resultPromise = new Promise<BackendResult>((resolve) => {
    settle = resolve;
  });

  const finish = (result: BackendResult): void => {
    channel.push({ type: 'completed', backend: spec.backend, result });
    channel.close();
    settle(result);
  };

  const emit = (event: BackendEvent): void => {
    if (event.type === 'file-changed') filesChanged.push(event.change);
    if (event.type === 'command') commands.push(event.command);
    channel.push(event);
  };

  void (async () => {
    const availability = await spec.availability();
    if (!availability.ready) {
      finish({
        ok: false,
        backend: spec.backend,
        text: '',
        durationMs: now() - startedAt,
        filesChanged,
        commands,
        error: availability.reason ?? 'Backend недоступен',
      });
      return;
    }
    if (cancelled) {
      finish({
        ok: false,
        backend: spec.backend,
        text: '',
        durationMs: now() - startedAt,
        filesChanged,
        commands,
        cancelled: true,
        error: 'Отменено',
      });
      return;
    }

    channel.push({ type: 'started', backend: spec.backend });

    const outcome = await spec.execute({
      emit,
      onCancel: (handler) => {
        cancelHandler = handler;
        if (cancelled) handler();
      },
      isCancelled: () => cancelled,
    });

    finish({
      ok: outcome.ok && !cancelled,
      backend: spec.backend,
      text: outcome.text,
      sessionId: outcome.sessionId,
      durationMs: now() - startedAt,
      filesChanged,
      commands,
      cancelled: cancelled || undefined,
      usageLimited: outcome.usageLimited || undefined,
      error: cancelled ? 'Отменено' : outcome.error,
    });
  })().catch((error: unknown) => {
    finish({
      ok: false,
      backend: spec.backend,
      text: '',
      durationMs: now() - startedAt,
      filesChanged,
      commands,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return {
    id: randomUUID(),
    backend: spec.backend,
    events: channel,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      cancelHandler?.();
    },
    result: () => resultPromise,
  };
}
