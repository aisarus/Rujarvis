/**
 * The MVP acceptance scenarios, driven through the real Jarvis pipeline.
 *
 * Backends are fakes — there is no Windows desktop, no microphone and no
 * Claude/Codex subscription here — but everything between the utterance and
 * the backend call is the production code path: control words, routing,
 * normalisation, the risk gate, context selection, task orchestration and the
 * spoken reply.
 */

import { describe, expect, it, vi } from 'vitest';
import { BackendManager } from './backends/manager';
import { EventChannel } from './backends/process';
import type {
  AgentBackend,
  BackendEvent,
  BackendId,
  BackendRequest,
  BackendResult,
  BackendRun,
} from './backends/types';
import { WorldStateStore } from './context/worldState';
import { JarvisCore, DEFAULT_JARVIS_SETTINGS, type JarvisSettings } from './core';
import { JarvisMemory } from './memory/store';
import { TaskManager } from './tasks/manager';
import { READ_ONLY_PERMISSIONS } from './types';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Recorded {
  backend: BackendId;
  request: BackendRequest;
}

/** A backend that records what it was asked and answers however the test says. */
function fakeBackend(
  id: BackendId,
  recorded: Recorded[],
  respond: (request: BackendRequest) => Partial<BackendResult> | 'hang' = () => ({}),
): AgentBackend {
  return {
    id,
    name: id,
    capabilities: new Set(),
    checkAvailability: async () => ({
      id,
      installed: true,
      authenticated: true,
      ready: true,
      checkedAt: 0,
    }),
    run: (request: BackendRequest): BackendRun => {
      recorded.push({ backend: id, request });
      const channel = new EventChannel<BackendEvent>();
      const answer = respond(request);
      const result: BackendResult = {
        ok: true,
        backend: id,
        text: 'Готово.',
        durationMs: 1,
        filesChanged: [],
        commands: [],
        ...(answer === 'hang' ? {} : answer),
      };

      if (answer === 'hang') {
        return {
          id: `${id}-run`,
          backend: id,
          events: channel,
          cancel: () => {
            channel.push({
              type: 'completed',
              backend: id,
              result: { ...result, ok: false, cancelled: true, text: '', error: 'Отменено' },
            });
            channel.close();
          },
          result: () =>
            Promise.resolve({ ...result, ok: false, cancelled: true, text: '', error: 'Отменено' }),
        };
      }

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
  } as unknown as AgentBackend;
}

interface Harness {
  core: JarvisCore;
  tasks: TaskManager;
  memory: JarvisMemory;
  world: WorldStateStore;
  recorded: Recorded[];
  spoken: string[];
  settings: JarvisSettings;
  approvals: Array<{ summary: string }>;
  approve: { value: boolean };
}

function harness(options: {
  settings?: Partial<JarvisSettings>;
  respond?: Partial<Record<BackendId, (request: BackendRequest) => Partial<BackendResult> | 'hang'>>;
} = {}): Harness {
  const recorded: Recorded[] = [];
  const spoken: string[] = [];
  const approvals: Array<{ summary: string }> = [];
  const approve = { value: true };

  const backends = new BackendManager();
  for (const id of ['interpreter', 'claude-code', 'codex'] as const) {
    backends.register(fakeBackend(id, recorded, options.respond?.[id]));
  }

  const tasks = new TaskManager({ backends });
  const memory = new JarvisMemory();
  const world = new WorldStateStore();
  const settings: JarvisSettings = { ...DEFAULT_JARVIS_SETTINGS, ...options.settings };

  const core = new JarvisCore({
    backends,
    tasks,
    memory,
    world,
    settings: () => settings,
    speak: (text) => {
      if (text) spoken.push(text);
    },
    approve: async (request) => {
      approvals.push({ summary: request.summary });
      return approve.value;
    },
  });

  return { core, tasks, memory, world, recorded, spoken, settings, approvals, approve };
}

describe('Test A — «Открой Chrome»', () => {
  it('routes to the computer runtime and acknowledges immediately', async () => {
    const h = harness();
    const turn = await h.core.handleUtterance('Открой Chrome');

    expect(turn.kind).toBe('task');
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.backend).toBe('interpreter');
    // The acknowledgement was spoken before the backend produced anything.
    expect(h.spoken[0]).toBeTruthy();
    expect(h.spoken[0]?.toLowerCase()).not.toContain('готово');
    // The user's own words reach the backend verbatim.
    expect(h.recorded[0]?.request.utterance).toBe('Открой Chrome');
  });
});

describe('Test B — browser work', () => {
  it('asks for browser and computer capabilities', async () => {
    const h = harness();
    await h.core.handleUtterance('Найди вкладку с GitHub и открой репозиторий Aegis');

    const request = h.recorded[0]?.request;
    expect(request?.capabilities).toEqual(expect.arrayContaining(['browser']));
    expect(h.recorded[0]?.backend).toBe('interpreter');
  });
});

describe('Test C — «Закрой это окно»', () => {
  it('passes the foreground window along so «это» can be resolved', async () => {
    const h = harness();
    h.world.setActiveWindow({ title: 'Блокнот — заметки.txt', app: 'notepad.exe' });

    await h.core.handleUtterance('Закрой это окно');

    const context = h.recorded[0]?.request.context ?? [];
    expect(context.some((line) => line.includes('Блокнот'))).toBe(true);
  });
});

describe('Test D — «Посмотри что сейчас на экране»', () => {
  it('asks for vision and answers in Russian', async () => {
    const h = harness({
      respond: {
        interpreter: () => ({ text: 'На экране открыт VS Code с ошибкой сборки.' }),
      },
    });

    await h.core.handleUtterance('Посмотри что сейчас на экране и объясни мне');
    await tick();
    await tick();

    expect(h.recorded[0]?.request.capabilities).toContain('vision');
    expect(h.recorded[0]?.request.language).toBe('ru');
    expect(h.spoken.at(-1)).toContain('На экране открыт VS Code');
  });
});

describe('Test E — «В проекте Aegis ... почини через Claude Code»', () => {
  it('runs Claude Code in the project directory and speaks a short summary', async () => {
    const h = harness({
      respond: {
        'claude-code': () => ({
          text: [
            'Нашёл проблему.',
            'В vite.config.ts был алиас на удалённую папку; поправил и билд проходит.',
            'Дополнительно обновил lock-файл.',
            'Прогнал тесты, все зелёные.',
            'Ещё заметил устаревшую зависимость, но трогать не стал.',
          ].join(' '),
          filesChanged: [{ path: 'D:\\Projects\\aegis\\vite.config.ts', action: 'modified' }],
          commands: ['pnpm build'],
          sessionId: 'claude-session-1',
        }),
      },
    });
    await h.memory.rememberProject({
      name: 'aegis',
      path: 'D:\\Projects\\aegis',
      aliases: ['аегис'],
    });

    const turn = await h.core.handleUtterance(
      'В проекте Aegis посмотри почему не проходит билд и почини через Claude Code',
    );
    await tick();
    await tick();

    expect(turn.kind).toBe('task');
    expect(h.recorded[0]?.backend).toBe('claude-code');
    expect(h.recorded[0]?.request.cwd).toBe('D:\\Projects\\aegis');
    expect(h.recorded[0]?.request.project).toBe('aegis');

    // The screen gets everything; the voice gets one to three short sentences.
    const lastSpoken = h.spoken.at(-1) ?? '';
    expect(lastSpoken).toContain('Нашёл проблему.');
    expect(lastSpoken.split(/(?<=[.!?])\s+/).filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(lastSpoken).not.toContain('устаревшую зависимость');
    // …while the full text is what the task result carries for the UI.
    if (turn.kind === 'task') {
      expect(turn.task.result?.text).toContain('устаревшую зависимость');
    }

    // The result is remembered, session id included, so «продолжай» can resume.
    expect(h.memory.lastTask()?.sessionId).toBe('claude-session-1');
    expect(h.world.snapshot().recentFiles).toContain('D:\\Projects\\aegis\\vite.config.ts');
  });

  it('respects «только не ломай ничего» all the way to the backend', async () => {
    const h = harness();
    await h.memory.rememberProject({ name: 'aegis', path: 'D:\\Projects\\aegis', aliases: ['аегис'] });

    await h.core.handleUtterance(
      'Посмотри там в аегисе почему билд опять отъебнулся, только сначала не ломай ничего',
    );

    const request = h.recorded[0]?.request;
    expect(request?.permissions.edit).toBe(false);
    expect(request?.permissions.read).toBe(true);
    expect(request?.constraints).toContain('Сначала осмотреть, не менять');
  });
});

describe('Test F — «Теперь попробуй то же через Codex»', () => {
  it('switches backend on the spoken instruction alone', async () => {
    const h = harness();
    await h.core.handleUtterance('Теперь попробуй то же через Codex');
    expect(h.recorded[0]?.backend).toBe('codex');
  });

  it('honours «не используй Клод» by excluding it from the whole chain', async () => {
    const h = harness();
    await h.core.handleUtterance('почини билд, не используй Клод');
    expect(h.recorded[0]?.backend).toBe('codex');
  });
});

describe('Test G — «А пока открой Telegram» during a long coding task', () => {
  it('serves the new request without disturbing the running one', async () => {
    const h = harness({
      respond: { 'claude-code': () => 'hang' },
    });

    const first = await h.core.handleUtterance('Почини билд Aegis через Клод Код');
    await tick();
    expect(first.kind).toBe('task');
    if (first.kind !== 'task') return;
    expect(first.task.state).toBe('running');

    await h.core.handleUtterance('А пока открой мне Телеграм');
    await tick();

    expect(first.task.state).toBe('running');
    expect(first.task.foreground).toBe(false);
    expect(h.recorded.map((entry) => entry.backend)).toEqual(['claude-code', 'interpreter']);
  });
});

describe('Test H — «Стоп» during a running task', () => {
  it('stops immediately without waiting for a model', async () => {
    const h = harness({ respond: { interpreter: () => 'hang' } });

    const started = await h.core.handleUtterance('Открой Chrome и найди там документацию');
    await tick();
    expect(started.kind).toBe('task');
    if (started.kind !== 'task') return;

    const runsBefore = h.recorded.length;
    const turn = await h.core.handleUtterance('Стоп');
    await tick();

    expect(turn.kind).toBe('control');
    if (turn.kind === 'control') {
      expect(turn.outcome.action).toBe('stopped');
    }
    expect(started.task.state).toBe('cancelled');
    // The control word never reached a backend.
    expect(h.recorded).toHaveLength(runsBefore);
  });

  it('stops only the foreground task, leaving background work alone', async () => {
    const h = harness({
      respond: { 'claude-code': () => 'hang', interpreter: () => 'hang' },
    });

    const coding = await h.core.handleUtterance('Почини билд через Клод Код');
    await tick();
    const desktop = await h.core.handleUtterance('Открой Телеграм');
    await tick();

    await h.core.handleUtterance('Хватит');
    await tick();

    if (coding.kind !== 'task' || desktop.kind !== 'task') throw new Error('expected tasks');
    expect(desktop.task.state).toBe('cancelled');
    expect(coding.task.state).toBe('running');
  });
});

describe('pause and continue', () => {
  it('«пауза» then «продолжай» resumes the vendor session instead of restarting', async () => {
    const h = harness({ respond: { 'claude-code': () => 'hang' } });

    const started = await h.core.handleUtterance('Почини билд через Клод Код');
    await tick();
    if (started.kind !== 'task') throw new Error('expected a task');
    started.task.sessionId = 'claude-session-9';

    await h.core.handleUtterance('Пауза');
    await tick();
    expect(started.task.state).toBe('paused');

    await h.core.handleUtterance('Продолжай');
    await tick();

    expect(started.task.state).toBe('running');
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1]?.request.sessionId).toBe('claude-session-9');
  });
});

describe('risk gate', () => {
  it('asks before anything sensitive and does nothing when refused', async () => {
    const h = harness();
    h.approve.value = false;

    const turn = await h.core.handleUtterance('найди файл и отправь его Максу в телеграм');

    expect(turn.kind).toBe('refused');
    expect(h.approvals).toHaveLength(1);
    expect(h.recorded).toHaveLength(0);
  });

  it('proceeds once the user approves', async () => {
    const h = harness();
    h.approve.value = true;

    const turn = await h.core.handleUtterance('найди файл и отправь его Максу в телеграм');

    expect(turn.kind).toBe('task');
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]?.request.risk).toBe('sensitive');
  });

  it('refuses sensitive work when there is no way to ask', async () => {
    const recorded: Recorded[] = [];
    const backends = new BackendManager();
    backends.register(fakeBackend('interpreter', recorded));
    const core = new JarvisCore({
      backends,
      tasks: new TaskManager({ backends }),
      memory: new JarvisMemory(),
      world: new WorldStateStore(),
      settings: () => DEFAULT_JARVIS_SETTINGS,
    });

    const turn = await core.handleUtterance('отправь это сообщение в телеграм');
    expect(turn.kind).toBe('refused');
    expect(recorded).toHaveLength(0);
  });

  it('never exceeds the configured permission ceiling', async () => {
    const h = harness({ settings: { basePermissions: READ_ONLY_PERMISSIONS } });
    await h.core.handleUtterance('почини билд и запусти тесты');

    expect(h.recorded[0]?.request.permissions).toEqual(READ_ONLY_PERMISSIONS);
  });
});

describe('clarification', () => {
  it('asks rather than guessing when the words carried almost nothing', async () => {
    const h = harness();
    const turn = await h.core.handleUtterance('ну это');

    expect(turn.kind).toBe('clarify');
    expect(h.recorded).toHaveLength(0);
    expect(h.spoken.at(-1)).toContain('Уточни');
  });
});

describe('memory and context selection', () => {
  it('sends only the memory the utterance touches', async () => {
    const h = harness();
    await h.memory.rememberProject({ name: 'aegis', path: 'D:\\Projects\\aegis', aliases: ['аегис'] });
    await h.memory.rememberProject({ name: 'rujarvis', path: 'D:\\Projects\\rujarvis' });

    await h.core.handleUtterance('в аегисе почини билд');

    const context = h.recorded[0]?.request.context ?? [];
    expect(context.some((line) => line.includes('D:\\Projects\\aegis'))).toBe(true);
    expect(context.some((line) => line.includes('rujarvis'))).toBe(false);
  });

  it('stays quiet about the desktop for a fully specified request', async () => {
    const h = harness();
    h.world.setActiveWindow({ title: 'Блокнот', app: 'notepad.exe' });
    h.world.noteUtterance('что-то раньше');

    await h.core.handleUtterance('Открой Chrome');

    const context = h.recorded[0]?.request.context ?? [];
    expect(context.some((line) => line.startsWith('Предыдущая реплика'))).toBe(false);
  });
});

describe('the local router model stays optional', () => {
  it('routes identically when the local model is unreachable', async () => {
    const h = harness();
    const withoutModel = await h.core.handleUtterance('Открой Chrome');

    const h2 = harness();
    const refine = vi.fn(async () => null);
    const backends = new BackendManager();
    for (const id of ['interpreter', 'claude-code', 'codex'] as const) {
      backends.register(fakeBackend(id, h2.recorded));
    }
    const core2 = new JarvisCore({
      backends,
      tasks: new TaskManager({ backends }),
      memory: h2.memory,
      world: h2.world,
      settings: () => h2.settings,
      localRouter: { refine } as never,
    });
    const withModel = await core2.handleUtterance('Открой Chrome');

    expect(refine).toHaveBeenCalledWith('Открой Chrome');

    expect(withoutModel.kind).toBe('task');
    expect(withModel.kind).toBe('task');
    if (withoutModel.kind === 'task' && withModel.kind === 'task') {
      expect(withModel.decision.target).toBe(withoutModel.decision.target);
      expect(withModel.decision.needs.sort()).toEqual(withoutModel.decision.needs.sort());
    }
  });
});

describe('failure reporting', () => {
  it('speaks a short failure line rather than a stack trace', async () => {
    const h = harness({
      respond: {
        interpreter: () => ({
          ok: false,
          text: '',
          error: 'Не удалось запустить: spawn ENOENT\n  at ChildProcess.handle',
        }),
      },
    });

    await h.core.handleUtterance('Открой Chrome');
    await tick();
    await tick();

    const last = h.spoken.at(-1) ?? '';
    expect(last).toContain('Не получилось');
    expect(last).not.toContain('ChildProcess');
  });
});
