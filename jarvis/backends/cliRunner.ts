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
import { agentEnv, strippedKeys } from './subscriptionEnv';
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
  /**
   * Set by an adapter that has concluded, mid-stream, that the run cannot
   * succeed — a CLI stuck retrying an unreachable network, for instance. The
   * runner stops the process and reports this instead of waiting out the
   * timeout, so the manager can fall back to another backend promptly.
   */
  fatalMessage?: string;
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

/**
 * Сколько работе позволено молчать.
 *
 * Не угадано, а замерено по 1108 промежуткам между событиями настоящих
 * прогонов 20.09.2026: медиана 3.9 с, девяносто процентов укладываются в
 * 13.7 с, девяносто девять — в 47.7 с. Но самая длинная пауза ЖИВОЙ работы —
 * 590 секунд, почти десять минут на одном шаге (сборка анимации в 3D).
 *
 * Значит трёхминутный предел убивал бы настоящую работу. Пятнадцать минут —
 * полуторный запас над измеренным максимумом: застрявший процесс это поймает,
 * работающий — нет.
 */
export const SILENCE_LIMIT_MS = 15 * 60_000;

/**
 * Потолок по общему времени.
 *
 * Был двадцать минут, и этого хватало ровно до первой настоящей задачи:
 * прогон «сделать 3D-модель по 2D-видео» убит на 1200.1 секунде посреди
 * правки файла — двадцать минут работы выброшены, человеку сказано «превысил
 * отведённое время».
 *
 * Теперь от бесконечной работы защищает предел молчания, а это — только
 * страховка от зацикливания, которое исправно шумит. Отсюда и величина:
 * полтора часа, а не расписание рабочего дня.
 */
export const WORK_CEILING_MS = 90 * 60_000;

export interface CliRunSpec {
  backend: BackendId;
  /** Probe result; a run on a non-ready backend fails fast with its reason. */
  availability: () => Promise<BackendAvailability>;
  /** Built once the executable path is known. */
  buildArgs: (executablePath: string) => string[];
  cwd?: string;
  timeoutMs?: number;
  /** Сколько можно молчать. Обрывает застрявшую работу, но не долгую. */
  idleTimeoutMs?: number;
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
  /** True once the adapter's own fatal condition stopped the process. */
  let stoppedEarly = false;
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

    // Ключи из окружения убираются всегда: Джарвис работает на подписках, а
    // случайно оставшийся ключ перебивает вход по подписке и даёт «401 API key
    // is invalid» — сообщение, которое полдня выглядело как поломка всего.
    const dropped = strippedKeys();
    if (dropped.length > 0) {
      channel.push({
        type: 'status',
        backend: spec.backend,
        text: `Работаю по подписке; убрал из окружения: ${dropped.join(', ')}`,
      });
    }

    child = spawnCli({
      command: availability.path,
      args: spec.buildArgs(availability.path),
      cwd: spec.cwd,
      env: agentEnv(),
      timeoutMs: spec.timeoutMs,
      idleTimeoutMs: spec.idleTimeoutMs,
      stdin: spec.stdin,
      onStdoutLine: (line) => {
        const parsed = parseJsonLine(line);
        if (!parsed) return;
        spec.consumeLine(parsed, state, (event) => channel.push(event));
        if (state.fatalMessage && !stoppedEarly) {
          stoppedEarly = true;
          child?.cancel();
        }
      },
    });

    const outcome = await child.wait();
    const usageLimited = state.usageLimited || looksUsageLimited(outcome.stderr);
    const exitFailed = outcome.exitCode !== 0 && outcome.exitCode !== null;
    const failed =
      outcome.spawnError !== undefined ||
      state.fatalMessage !== undefined ||
      outcome.cancelled ||
      outcome.timedOut ||
      exitFailed ||
      state.errorMessage !== undefined;

    let error: string | undefined;
    if (outcome.spawnError !== undefined) {
      error = spec.messages.spawnFailed(outcome.spawnError);
    } else if (state.fatalMessage !== undefined) {
      // The adapter stopped this run itself. That is a failure with a reason,
      // not a user cancellation, and the reason is what the user needs.
      error = state.fatalMessage;
    } else if (outcome.cancelled) {
      error = 'Отменено';
    } else if (outcome.timedOut) {
      error = spec.messages.timedOut;
    } else if (state.errorMessage !== undefined) {
      error = state.errorMessage;
    } else if (failed) {
      error = outcome.stderr.trim().slice(-2000) || spec.messages.failed;
    }

    // stderr — в журнал всегда, когда что-то пошло не так, даже если причина
    // уже записана из потока. Именно так была потеряна настоящая причина
    // трёхминутного молчания, окончившегося ложным «401 API key is invalid».
    const diagnostics = failed ? outcome.stderr.trim().slice(-4_000) || undefined : undefined;

    finish({
      ...baseResult(),
      diagnostics,
      ok: !failed,
      exitCode: outcome.exitCode,
      cancelled: (outcome.cancelled && !stoppedEarly) || undefined,
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
