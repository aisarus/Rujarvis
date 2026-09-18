/**
 * Child-process plumbing shared by the CLI-backed adapters.
 *
 * Both Claude Code and Codex are driven the same way: spawn the vendor's own
 * CLI in headless mode, read newline-delimited JSON from stdout, keep stderr
 * for diagnostics, and be able to stop immediately when the user says "стоп".
 */

import { spawn, type ChildProcess } from 'node:child_process';

/**
 * An async queue that turns callback-style progress into an `AsyncIterable`.
 *
 * Producers push with {@link push} and finish with {@link close}; consumers use
 * `for await`. Values pushed before a consumer attaches are buffered, so no
 * event is lost between spawning a run and iterating it.
 */
export class EventChannel<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

/** Splits a byte stream into lines, holding an incomplete trailing line. */
export class LineSplitter {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split(/\r?\n/);
    this.pending = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }

  flush(): string[] {
    const rest = this.pending.trim();
    this.pending = '';
    return rest.length > 0 ? [rest] : [];
  }
}

export interface CliProcessOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
  onStdoutLine(line: string): void;
  onStderrChunk?(chunk: string): void;
}

export interface CliProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  cancelled: boolean;
  timedOut: boolean;
  /** Set when the process could not be spawned at all. */
  spawnError?: string;
}

/**
 * A run in flight, from the caller's point of view. Adapters depend on this
 * interface rather than on {@link CliProcess} so a test can substitute a fake
 * without spawning anything.
 */
export interface CliHandle {
  cancel(): void;
  wait(): Promise<CliProcessOutcome>;
}

/**
 * A running CLI. `cancel()` terminates the whole process group where the
 * platform supports it, so a coding agent's own child processes go with it.
 */
export class CliProcess implements CliHandle {
  private child: ChildProcess | null = null;
  private cancelled = false;
  private timedOut = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly done: Promise<CliProcessOutcome>;

  constructor(private readonly options: CliProcessOptions) {
    this.done = this.start();
  }

  private start(): Promise<CliProcessOutcome> {
    return new Promise<CliProcessOutcome>((resolve) => {
      const stdoutSplitter = new LineSplitter();
      let stderr = '';
      let settled = false;

      const settle = (outcome: CliProcessOutcome): void => {
        if (settled) return;
        settled = true;
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        resolve(outcome);
      };

      let child: ChildProcess;
      try {
        child = spawn(this.options.command, this.options.args, {
          cwd: this.options.cwd,
          env: this.options.env ?? process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          // A detached group lets cancellation reach grandchildren (a build,
          // a test runner) instead of orphaning them.
          detached: process.platform !== 'win32',
          windowsHide: true,
        });
      } catch (error) {
        settle({
          exitCode: null,
          signal: null,
          stderr: '',
          cancelled: false,
          timedOut: false,
          spawnError: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      this.child = child;

      child.stdout?.setEncoding('utf-8');
      child.stdout?.on('data', (chunk: string) => {
        for (const line of stdoutSplitter.push(chunk)) {
          try {
            this.options.onStdoutLine(line);
          } catch {
            // A malformed line must never take the run down.
          }
        }
      });

      child.stderr?.setEncoding('utf-8');
      child.stderr?.on('data', (chunk: string) => {
        // Bound the buffer: a chatty CLI should not grow memory without limit.
        stderr = (stderr + chunk).slice(-64_000);
        this.options.onStderrChunk?.(chunk);
      });

      child.on('error', (error) => {
        settle({
          exitCode: null,
          signal: null,
          stderr,
          cancelled: this.cancelled,
          timedOut: this.timedOut,
          spawnError: error.message,
        });
      });

      child.on('close', (code, signal) => {
        for (const line of stdoutSplitter.flush()) {
          try {
            this.options.onStdoutLine(line);
          } catch {
            // Ignore trailing garbage.
          }
        }
        settle({
          exitCode: code,
          signal,
          stderr,
          cancelled: this.cancelled,
          timedOut: this.timedOut,
        });
      });

      if (this.options.stdin !== undefined) {
        child.stdin?.end(this.options.stdin);
      } else {
        child.stdin?.end();
      }

      if (this.options.timeoutMs && this.options.timeoutMs > 0) {
        this.timer = setTimeout(() => {
          this.timedOut = true;
          this.kill();
        }, this.options.timeoutMs);
        this.timer.unref?.();
      }
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.kill();
  }

  private kill(): void {
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) return;
    try {
      if (process.platform === 'win32') {
        child.kill();
      } else if (typeof child.pid === 'number') {
        // Negative pid targets the detached group created above.
        process.kill(-child.pid, 'SIGTERM');
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process is already gone.
      }
    }
  }

  wait(): Promise<CliProcessOutcome> {
    return this.done;
  }
}

/** Parses one NDJSON line, returning null instead of throwing. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Vendors interleave human-readable lines with JSON; skip those.
  }
  return null;
}

const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /quota/i,
  /limit reached/i,
  /too many requests/i,
  /429/,
  /insufficient[_ ]quota/i,
  /upgrade to (?:pro|max|plus)/i,
];

/** Heuristic: did the vendor refuse because a subscription quota ran out? */
export function looksUsageLimited(text: string): boolean {
  if (!text) return false;
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}
