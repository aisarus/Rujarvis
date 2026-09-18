/**
 * Shared run scaffolding for CLI-backed adapters.
 *
 * Claude Code and Codex differ in their arguments and in their event stream,
 * but the surrounding lifecycle is identical: probe availability, spawn,
 * translate NDJSON into Jarvis events, survive cancellation and timeouts, and
 * always end with exactly one terminal result — never a thrown error.
 */

import { randomUUID } from 'node:crypto';
import {
  CliProcess,
  EventChannel,
  looksUsageLimited,
  parseJsonLine,
  type CliHandle,
  type CliProcessOptions,
} from './process';
import type {
  BackendAvailability,
  BackendEvent,
  BackendFileChange,
  BackendId,
  BackendResult,
  BackendRun,
} from './types';

/** Mutable accumulation of everything a run produced. */
export interface StreamState {
  sessionId?: string;
  text: string;
  filesChanged: BackendFileChange[];
  commands: string[];
  errorMessage?: string;
  usageLimited: boolean;
}

export function createStreamState(sessionId?: string): StreamState {
  return {
    sessionId,
    text: '',
    filesChanged: [],
    commands: [],
    usageLimited: false,
  };
}

export type SpawnCli = (options: CliProcessOptions) => CliHandle;

export const defaultSpawnCli: SpawnCli = (options) => new CliProcess(options);

export interface CliRunSpec {
  backend: BackendId;
  /** Probe result; a run on a non-ready backend fails fast with its reason. */
  availability: () => Promise<BackendAvailability>;
  /** Built once the executable path is known. */
  buildArgs: (executablePath: string) => string[];
  cwd?: string;
  timeoutMs?: number;
  stdin: string;
  /** Translates one parsed NDJSON object into events. */
  consumeLine: (
    raw: Record<string, unknown>,
    state: StreamState,
    emit: (event: BackendEvent) => void,
  ) => void;
  /** Russian phrasing for the failure cases. */
  messages: {
    unavailable: string;
    spawnFailed: (detail: string) => string;
    timedOut: string;
    failed: string;
  };
  spawnCli?: SpawnCli;
  now?: () => number;
}

export function createCliRun(spec: CliRunSpec): BackendRun {
  const now = spec.now ?? Date.now;
  const spawnCli = spec.spawnCli ?? defaultSpawnCli;
  const runId = randomUUID();
  const channel = new EventChannel<BackendEvent>();
  const startedAt = now();
  const state = createStreamState();

  let cancelled = false;
  let child: CliHandle | null = null;
  let settle: (result: BackendResult) => void = () => {};
  const resultPromise = new Promise<BackendResult>((resolve) => {
    settle = resolve;
  });

  const finish = (result: BackendResult): void => {
    channel.push({ type: 'completed', backend: spec.backend, result });
    channel.close();
    settle(result);
  };

  const baseResult = (): Omit<BackendResult, 'ok'> => ({
    backend: spec.backend,
    text: state.text,
    sessionId: state.sessionId,
    durationMs: now() - startedAt,
    filesChanged: state.filesChanged,
    commands: state.commands,
  });

  void (async () => {
    const availability = await spec.availability();
    if (!availability.ready || !availability.path) {
      finish({
        ...baseResult(),
        ok: false,
        error: availability.reason ?? spec.messages.unavailable,
      });
      return;
    }
    if (cancelled) {
      finish({ ...baseResult(), ok: false, cancelled: true, error: 'Отменено' });
      return;
    }

    channel.push({ type: 'started', backend: spec.backend, sessionId: state.sessionId });

    child = spawnCli({
      command: availability.path,
      args: spec.buildArgs(availability.path),
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      stdin: spec.stdin,
      onStdoutLine: (line) => {
        const parsed = parseJsonLine(line);
        if (!parsed) return;
        spec.consumeLine(parsed, state, (event) => channel.push(event));
      },
    });

    const outcome = await child.wait();
    const usageLimited = state.usageLimited || looksUsageLimited(outcome.stderr);
    const exitFailed = outcome.exitCode !== 0 && outcome.exitCode !== null;
    const failed =
      outcome.spawnError !== undefined ||
      outcome.cancelled ||
      outcome.timedOut ||
      exitFailed ||
      state.errorMessage !== undefined;

    let error: string | undefined;
    if (outcome.spawnError !== undefined) {
      error = spec.messages.spawnFailed(outcome.spawnError);
    } else if (outcome.cancelled) {
      error = 'Отменено';
    } else if (outcome.timedOut) {
      error = spec.messages.timedOut;
    } else if (state.errorMessage !== undefined) {
      error = state.errorMessage;
    } else if (failed) {
      error = outcome.stderr.trim().slice(-2000) || spec.messages.failed;
    }

    finish({
      ...baseResult(),
      ok: !failed,
      exitCode: outcome.exitCode,
      cancelled: outcome.cancelled || undefined,
      timedOut: outcome.timedOut || undefined,
      usageLimited: usageLimited || undefined,
      error,
    });
  })().catch((error: unknown) => {
    // A backend failure is reported as a result, never thrown: an adapter
    // must not be able to take the Jarvis process down.
    finish({
      ...baseResult(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return {
    id: runId,
    backend: spec.backend,
    events: channel,
    cancel: () => {
      cancelled = true;
      child?.cancel();
    },
    result: () => resultPromise,
  };
}

/** A run that failed before it could start, shaped like any other run. */
export function createFailedRun(backend: BackendId, error: string): BackendRun {
  const channel = new EventChannel<BackendEvent>();
  const result: BackendResult = {
    ok: false,
    backend,
    text: '',
    durationMs: 0,
    filesChanged: [],
    commands: [],
    error,
  };
  channel.push({ type: 'completed', backend, result });
  channel.close();
  return {
    id: randomUUID(),
    backend,
    events: channel,
    cancel: () => {},
    result: () => Promise.resolve(result),
  };
}
