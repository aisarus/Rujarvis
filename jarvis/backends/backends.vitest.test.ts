import { describe, expect, it, vi } from 'vitest';
import {
  EventChannel,
  LineSplitter,
  looksUsageLimited,
  parseJsonLine,
  type CliHandle,
  type CliProcessOptions,
  type CliProcessOutcome,
} from './process';
import {
  ClaudeCodeBackend,
  buildClaudeArgs,
  consumeClaudeStreamLine,
  selectPermissionMode,
} from './claudeCode';
import {
  CodexBackend,
  buildCodexArgs,
  consumeCodexStreamLine,
  selectSandbox,
} from './codex';
import { createStreamState } from './cliRunner';
import { BackendManager, isBackendLevelFailure } from './manager';
import { buildBackendPrompt } from './prompt';
import { DEFAULT_PERMISSIONS, READ_ONLY_PERMISSIONS } from '../types';
import type {
  AgentBackend,
  BackendEvent,
  BackendRequest,
  BackendResult,
  BackendRun,
} from './types';

function request(overrides: Partial<BackendRequest> = {}): BackendRequest {
  return {
    utterance: 'посмотри почему билд отъебнулся',
    capabilities: ['coding', 'files'],
    risk: 'normal',
    permissions: DEFAULT_PERMISSIONS,
    ...overrides,
  };
}

/** Collects every event a run emits, terminal event included. */
async function drain(run: BackendRun): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
  }
  return events;
}

interface FakeCli extends CliHandle {
  options: CliProcessOptions;
}

/** Replays canned stdout lines, then exits with the given outcome. */
function fakeSpawn(
  lines: string[],
  outcome: Partial<CliProcessOutcome> = {},
): { spawn: (options: CliProcessOptions) => CliHandle; calls: FakeCli[] } {
  const calls: FakeCli[] = [];
  const spawn = (options: CliProcessOptions): CliHandle => {
    let cancelled = false;
    const handle: FakeCli = {
      options,
      cancel: () => {
        cancelled = true;
      },
      wait: async () => {
        for (const line of lines) options.onStdoutLine(line);
        return {
          exitCode: 0,
          signal: null,
          stderr: '',
          cancelled,
          timedOut: false,
          ...outcome,
        };
      },
    };
    calls.push(handle);
    return handle;
  };
  return { spawn, calls };
}

const readyProbe = {
  status: async () => ({ installed: true, loggedIn: true, version: '1.0.0', path: '/usr/bin/fake' }),
};

describe('EventChannel', () => {
  it('buffers events pushed before a consumer attaches', async () => {
    const channel = new EventChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.close();

    const seen: number[] = [];
    for await (const value of channel) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });

  it('delivers to a waiting consumer and ends on close', async () => {
    const channel = new EventChannel<string>();
    const iterator = channel[Symbol.asyncIterator]();
    const pending = iterator.next();
    channel.push('a');
    await expect(pending).resolves.toEqual({ value: 'a', done: false });
    channel.close();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('ignores pushes after close instead of throwing', () => {
    const channel = new EventChannel<number>();
    channel.close();
    expect(() => channel.push(1)).not.toThrow();
  });
});

describe('LineSplitter', () => {
  it('holds an incomplete trailing line until it is finished', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\n')).toEqual(['{"b":2}']);
    expect(splitter.flush()).toEqual([]);
  });

  it('flushes a final line that never got a newline', () => {
    const splitter = new LineSplitter();
    splitter.push('{"a":1}');
    expect(splitter.flush()).toEqual(['{"a":1}']);
  });
});

describe('parseJsonLine', () => {
  it('returns null for interleaved human-readable output', () => {
    expect(parseJsonLine('Starting up...')).toBeNull();
    expect(parseJsonLine('{ broken')).toBeNull();
    expect(parseJsonLine('{"type":"x"}')).toEqual({ type: 'x' });
  });
});

describe('looksUsageLimited', () => {
  it('recognises quota refusals but not ordinary failures', () => {
    expect(looksUsageLimited('You have hit your usage limit')).toBe(true);
    expect(looksUsageLimited('429 Too Many Requests')).toBe(true);
    expect(looksUsageLimited('TypeError: cannot read property')).toBe(false);
  });
});

describe('buildBackendPrompt', () => {
  it('passes the raw utterance through verbatim, ahead of the normalised goal', () => {
    const prompt = buildBackendPrompt(
      request({ utterance: 'глянь чё с билдом', goal: 'Diagnose the failing build' }),
    );
    expect(prompt).toContain('глянь чё с билдом');
    expect(prompt.indexOf('глянь чё с билдом')).toBeLessThan(
      prompt.indexOf('Diagnose the failing build'),
    );
  });

  it('states the read-only envelope when editing is not permitted', () => {
    const prompt = buildBackendPrompt(request({ permissions: READ_ONLY_PERMISSIONS }));
    expect(prompt).toContain('Do NOT modify, create or delete any file');
  });

  it('asks for a Russian answer by default', () => {
    expect(buildBackendPrompt(request())).toContain('Write the final answer in Russian');
  });
});

describe('Claude Code adapter', () => {
  it('maps the permission envelope onto a CLI permission mode', () => {
    expect(selectPermissionMode(request({ permissions: READ_ONLY_PERMISSIONS }), false)).toBe('plan');
    expect(selectPermissionMode(request({ risk: 'normal' }), false)).toBe('acceptEdits');
    expect(selectPermissionMode(request({ risk: 'sensitive' }), false)).toBe('default');
    expect(selectPermissionMode(request({ risk: 'dangerous' }), true)).toBe('default');
  });

  it('never selects bypassPermissions unless it was explicitly enabled', () => {
    expect(selectPermissionMode(request({ risk: 'safe' }), false)).toBe('acceptEdits');
    expect(selectPermissionMode(request({ risk: 'safe' }), true)).toBe('bypassPermissions');
  });

  it('builds headless arguments and resumes a session when one is given', () => {
    const args = buildClaudeArgs(request({ sessionId: 'sess-1' }), {
      permissionMode: 'acceptEdits',
      model: 'opus',
    });
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus']));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
  });

  it('turns the stream into files, commands and a final answer', () => {
    const state = createStreamState();
    const events: BackendEvent[] = [];
    const emit = (event: BackendEvent): void => {
      events.push(event);
    };

    consumeClaudeStreamLine(
      { type: 'system', subtype: 'init', session_id: 'abc' },
      state,
      emit,
    );
    consumeClaudeStreamLine(
      {
        type: 'assistant',
        session_id: 'abc',
        message: {
          content: [
            { type: 'text', text: 'Смотрю конфигурацию.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'pnpm build' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/p/vite.config.ts' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/p/new.ts' } },
          ],
        },
      },
      state,
      emit,
    );
    consumeClaudeStreamLine(
      { type: 'result', subtype: 'success', result: 'Починил конфиг запуска.', session_id: 'abc' },
      state,
      emit,
    );

    expect(state.sessionId).toBe('abc');
    expect(state.text).toBe('Починил конфиг запуска.');
    expect(state.commands).toEqual(['pnpm build']);
    expect(state.filesChanged).toEqual([
      { path: '/p/vite.config.ts', action: 'modified' },
      { path: '/p/new.ts', action: 'created' },
    ]);
    expect(state.errorMessage).toBeUndefined();
    expect(events.filter((event) => event.type === 'command')).toHaveLength(1);
  });

  it('flags a quota refusal so the manager can fall back', () => {
    const state = createStreamState();
    consumeClaudeStreamLine(
      { type: 'result', subtype: 'error_during_execution', result: 'Claude usage limit reached', is_error: true },
      state,
      () => {},
    );
    expect(state.usageLimited).toBe(true);
    expect(state.errorMessage).toContain('usage limit');
  });

  it('runs end to end against a fake CLI', async () => {
    const { spawn, calls } = fakeSpawn([
      '{"type":"system","subtype":"init","session_id":"s1"}',
      'Some non-JSON noise',
      '{"type":"result","subtype":"success","result":"Готово.","session_id":"s1"}',
    ]);
    const backend = new ClaudeCodeBackend({ probe: readyProbe, spawnCli: spawn });

    const run = backend.run(request());
    const events = await drain(run);
    const result = await run.result();

    expect(result.ok).toBe(true);
    expect(result.text).toBe('Готово.');
    expect(result.sessionId).toBe('s1');
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    expect(calls[0]?.options.args).toContain('stream-json');
    // The prompt reaches the CLI over stdin, not on the command line.
    expect(calls[0]?.options.stdin).toContain('посмотри почему билд отъебнулся');
    expect(calls[0]?.options.args.join(' ')).not.toContain('посмотри');
  });

  it('reports an unavailable CLI as a result instead of throwing', async () => {
    const backend = new ClaudeCodeBackend({
      probe: { status: async () => ({ installed: false, loggedIn: false }) },
      spawnCli: () => {
        throw new Error('should not spawn');
      },
    });

    const result = await backend.run(request()).result();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('не установлен');
  });

  it('survives a probe that rejects', async () => {
    const backend = new ClaudeCodeBackend({
      probe: {
        status: async () => {
          throw new Error('keychain locked');
        },
      },
    });
    const availability = await backend.checkAvailability();
    expect(availability.ready).toBe(false);
    expect(availability.reason).toContain('keychain locked');
  });

  it('caches availability until the TTL expires or it is invalidated', async () => {
    const status = vi.fn(async () => ({ installed: true, loggedIn: true }));
    let clock = 1_000;
    const backend = new ClaudeCodeBackend({
      probe: { status },
      availabilityTtlMs: 5_000,
      now: () => clock,
    });

    await backend.checkAvailability();
    await backend.checkAvailability();
    expect(status).toHaveBeenCalledTimes(1);

    clock += 6_000;
    await backend.checkAvailability();
    expect(status).toHaveBeenCalledTimes(2);

    backend.invalidate();
    await backend.checkAvailability();
    expect(status).toHaveBeenCalledTimes(3);
  });
});

describe('Codex adapter', () => {
  it('maps the permission envelope onto a sandbox level', () => {
    expect(selectSandbox(request({ permissions: READ_ONLY_PERMISSIONS }), true)).toBe('read-only');
    expect(selectSandbox(request({ risk: 'normal' }), false)).toBe('workspace-write');
    expect(selectSandbox(request({ risk: 'safe' }), false)).toBe('workspace-write');
    expect(selectSandbox(request({ risk: 'safe' }), true)).toBe('danger-full-access');
  });

  it('builds exec arguments, resumes a thread and reads the prompt from stdin', () => {
    const args = buildCodexArgs(request({ sessionId: 'thread-9', cwd: 'D:\\Projects\\aegis' }), {
      sandbox: 'workspace-write',
    });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9']);
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(args).toEqual(expect.arrayContaining(['--cd', 'D:\\Projects\\aegis']));
    expect(args.at(-1)).toBe('-');
  });

  it('reads the thread-event schema', () => {
    const state = createStreamState();
    const events: BackendEvent[] = [];
    const emit = (event: BackendEvent): void => {
      events.push(event);
    };

    consumeCodexStreamLine({ type: 'thread.started', thread_id: 't1' }, state, emit);
    consumeCodexStreamLine(
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } },
      state,
      emit,
    );
    consumeCodexStreamLine(
      {
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] },
      },
      state,
      emit,
    );
    consumeCodexStreamLine(
      { type: 'item.completed', item: { type: 'assistant_message', text: 'Готово.' } },
      state,
      emit,
    );

    expect(state.sessionId).toBe('t1');
    expect(state.commands).toEqual(['npm test']);
    expect(state.filesChanged).toEqual([
      { path: 'src/a.ts', action: 'modified' },
      { path: 'src/b.ts', action: 'created' },
    ]);
    expect(state.text).toBe('Готово.');
  });

  it('also reads the older msg envelope', () => {
    const state = createStreamState();
    consumeCodexStreamLine(
      { id: '0', msg: { type: 'session_configured', session_id: 'legacy-1' } },
      state,
      () => {},
    );
    consumeCodexStreamLine(
      { id: '1', msg: { type: 'exec_command_begin', command: ['pnpm', 'build'] } },
      state,
      () => {},
    );
    consumeCodexStreamLine(
      { id: '2', msg: { type: 'agent_message', message: 'Собрал.' } },
      state,
      () => {},
    );

    expect(state.sessionId).toBe('legacy-1');
    expect(state.commands).toEqual(['pnpm build']);
    expect(state.text).toBe('Собрал.');
  });

  it('marks a failed turn as an error and detects a quota refusal', () => {
    const state = createStreamState();
    consumeCodexStreamLine(
      { type: 'turn.failed', error: { message: 'You have reached your usage limit' } },
      state,
      () => {},
    );
    expect(state.errorMessage).toContain('usage limit');
    expect(state.usageLimited).toBe(true);
  });

  it('runs end to end against a fake CLI', async () => {
    const { spawn } = fakeSpawn([
      '{"type":"thread.started","thread_id":"t7"}',
      '{"type":"item.completed","item":{"type":"assistant_message","text":"Сделал."}}',
      '{"type":"turn.completed"}',
    ]);
    const backend = new CodexBackend({ probe: readyProbe, spawnCli: spawn });

    const result = await backend.run(request()).result();
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Сделал.');
    expect(result.sessionId).toBe('t7');
  });

  it('reports a missing sign-in without spawning', async () => {
    const backend = new CodexBackend({
      probe: { status: async () => ({ installed: true, loggedIn: false }) },
    });
    const result = await backend.run(request()).result();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('codex login');
  });
});

describe('BackendManager', () => {
  function stubBackend(
    id: AgentBackend['id'],
    results: BackendResult | (() => BackendResult),
    ready = true,
  ): AgentBackend & { runs: number } {
    const backend = {
      id,
      name: id,
      runs: 0,
      capabilities: new Set<never>(),
      checkAvailability: async () => ({
        id,
        installed: ready,
        authenticated: ready,
        ready,
        checkedAt: 0,
      }),
      run: (): BackendRun => {
        backend.runs += 1;
        const result = typeof results === 'function' ? results() : results;
        const channel = new EventChannel<BackendEvent>();
        channel.push({ type: 'completed', backend: id, result });
        channel.close();
        return {
          id: `${id}-run`,
          backend: id,
          events: channel,
          cancel: () => {},
          result: () => Promise.resolve(result),
        };
      },
    } as unknown as AgentBackend & { runs: number };
    return backend;
  }

  function result(overrides: Partial<BackendResult>): BackendResult {
    return {
      ok: false,
      backend: 'claude-code',
      text: '',
      durationMs: 1,
      filesChanged: [],
      commands: [],
      ...overrides,
    };
  }

  function managerWith(...backends: AgentBackend[]): BackendManager {
    const manager = new BackendManager();
    for (const backend of backends) manager.register(backend);
    return manager;
  }

  it('sends screen and browser work to the Workstation runtime', () => {
    const manager = managerWith(
      stubBackend('interpreter', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
    );
    const plan = manager.plan(request({ capabilities: ['computer', 'vision'] }));
    expect(plan.order[0]).toBe('interpreter');
  });

  it('sends coding work to the preferred coding backend first', () => {
    const manager = managerWith(
      stubBackend('interpreter', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
      stubBackend('codex', result({ ok: true })),
    );
    expect(manager.plan(request(), { codingPreference: 'codex' }).order[0]).toBe('codex');
    expect(manager.plan(request(), { codingPreference: 'auto' }).order[0]).toBe('claude-code');
  });

  it('honours a backend named in the utterance', () => {
    const manager = managerWith(
      stubBackend('interpreter', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
      stubBackend('codex', result({ ok: true })),
    );
    const plan = manager.plan(request({ capabilities: ['computer'] }), { requested: 'codex' });
    expect(plan.order[0]).toBe('codex');
    expect(plan.rationale).toContain('codex');
  });

  it('drops an excluded backend from the whole chain', () => {
    const manager = managerWith(
      stubBackend('interpreter', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
      stubBackend('codex', result({ ok: true })),
    );
    const plan = manager.plan(request(), { excluded: ['claude-code'] });
    expect(plan.order).not.toContain('claude-code');
  });

  it('falls back to the next backend when a quota is exhausted', async () => {
    const claude = stubBackend('claude-code', result({ usageLimited: true, error: 'limit' }));
    const codex = stubBackend('codex', result({ ok: true, backend: 'codex', text: 'Готово.' }));
    const manager = managerWith(claude, codex, stubBackend('interpreter', result({ ok: true })));

    const run = manager.run(request(), { codingPreference: 'claude-code' });
    const events = await drain(run);
    const final = await run.result();

    expect(claude.runs).toBe(1);
    expect(codex.runs).toBe(1);
    expect(final.ok).toBe(true);
    expect(final.backend).toBe('codex');
    expect(events.some((event) => event.type === 'status' && event.text.includes('codex'))).toBe(true);
  });

  it('does not second-guess an honest failure from a backend that ran', async () => {
    const claude = stubBackend(
      'claude-code',
      result({ ok: false, text: 'Не смог починить: нужен доступ к приватному пакету.' }),
    );
    const codex = stubBackend('codex', result({ ok: true, text: 'Готово.' }));
    const manager = managerWith(claude, codex);

    const final = await manager.run(request(), { codingPreference: 'claude-code' }).result();
    expect(codex.runs).toBe(0);
    expect(final.ok).toBe(false);
  });

  it('reports every failure when nothing works, without throwing', async () => {
    const manager = managerWith(
      stubBackend('claude-code', result({ error: 'нет CLI' })),
      stubBackend('codex', result({ backend: 'codex', error: 'нет входа' })),
    );
    const final = await manager.run(request()).result();
    expect(final.ok).toBe(false);
    expect(final.error).toContain('нет CLI');
    expect(final.error).toContain('нет входа');
  });

  it('survives a backend whose run() throws synchronously', async () => {
    const exploding = {
      id: 'claude-code',
      name: 'boom',
      capabilities: new Set(),
      checkAvailability: async () => ({
        id: 'claude-code' as const,
        installed: true,
        authenticated: true,
        ready: true,
        checkedAt: 0,
      }),
      run: () => {
        throw new Error('adapter exploded');
      },
    } as unknown as AgentBackend;

    const manager = managerWith(exploding, stubBackend('codex', result({ ok: true, backend: 'codex', text: 'ок' })));
    const final = await manager.run(request(), { codingPreference: 'claude-code' }).result();
    expect(final.ok).toBe(true);
    expect(final.backend).toBe('codex');
  });

  it('reports no backends at all as a result, not an exception', async () => {
    const final = await new BackendManager().run(request()).result();
    expect(final.ok).toBe(false);
    expect(final.error).toContain('Нет доступных backend');
  });
});

describe('isBackendLevelFailure', () => {
  const base: BackendResult = {
    ok: false,
    backend: 'claude-code',
    text: '',
    durationMs: 0,
    filesChanged: [],
    commands: [],
  };

  it('treats a quota refusal and a silent death as backend-level', () => {
    expect(isBackendLevelFailure({ ...base, usageLimited: true, text: 'anything' })).toBe(true);
    expect(isBackendLevelFailure({ ...base, error: 'spawn ENOENT' })).toBe(true);
  });

  it('treats an answered failure, a cancellation and a timeout as final', () => {
    expect(isBackendLevelFailure({ ...base, text: 'не получилось, вот почему' })).toBe(false);
    expect(isBackendLevelFailure({ ...base, cancelled: true })).toBe(false);
    expect(isBackendLevelFailure({ ...base, timedOut: true })).toBe(false);
    expect(isBackendLevelFailure({ ...base, ok: true })).toBe(false);
  });
});
