import { describe, expect, it, vi } from 'vitest';
import { BackendManager } from '../backends/manager';
import { EventChannel } from '../backends/process';
import type {
  AgentBackend,
  BackendEvent,
  BackendId,
  BackendRequest,
  BackendResult,
  BackendRun,
} from '../backends/types';
import { DEFAULT_PERMISSIONS } from '../types';
import { TaskManager, type TaskManagerEvent } from './manager';
import {
  buildProgress,
  describeTaskState,
  renderProgress,
  summarizeCodingTask,
} from './progress';

function request(overrides: Partial<BackendRequest> = {}): BackendRequest {
  return {
    utterance: 'почини билд',
    capabilities: ['coding'],
    risk: 'normal',
    permissions: DEFAULT_PERMISSIONS,
    ...overrides,
  };
}

/**
 * A backend the test drives by hand: it emits what the test pushes and only
 * finishes when the test says so, or when the run is cancelled.
 */
function controllableBackend(id: BackendId = 'claude-code') {
  const channel = new EventChannel<BackendEvent>();
  let settle: (result: BackendResult) => void = () => {};
  let cancelled = false;
  const finished = new Promise<BackendResult>((resolve) => {
    settle = resolve;
  });

  const base: BackendResult = {
    ok: true,
    backend: id,
    text: 'Готово.',
    durationMs: 1,
    filesChanged: [],
    commands: [],
  };

  const controls = {
    emit(event: BackendEvent) {
      channel.push(event);
    },
    finish(result: Partial<BackendResult> = {}) {
      const value = { ...base, ...result };
      channel.push({ type: 'completed', backend: id, result: value });
      channel.close();
      settle(value);
    },
    get cancelled() {
      return cancelled;
    },
  };

  const backend = {
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
    run: (): BackendRun => ({
      id: `${id}-run`,
      backend: id,
      events: channel,
      cancel: () => {
        cancelled = true;
        controls.finish({ ok: false, cancelled: true, text: '', error: 'Отменено' });
      },
      result: () => finished,
    }),
  } as unknown as AgentBackend;

  return { backend, controls };
}

function managerWith(backend: AgentBackend): TaskManager {
  const backends = new BackendManager();
  backends.register(backend);
  return new TaskManager({ backends });
}

/** Lets the task manager's async pump run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('TaskManager', () => {
  it('runs a task to completion and reports it', async () => {
    const { backend, controls } = controllableBackend();
    const tasks = managerWith(backend);
    const seen: TaskManagerEvent[] = [];
    tasks.subscribe((event) => seen.push(event));

    const task = tasks.start({ title: 'Починить билд', request: request() });
    await tick();
    expect(task.state).toBe('running');

    controls.finish({ text: 'Починил конфиг.', sessionId: 's1' });
    await tick();

    expect(task.state).toBe('completed');
    expect(task.result?.text).toBe('Починил конфиг.');
    expect(task.sessionId).toBe('s1');
    expect(seen.some((event) => event.type === 'task-finished')).toBe(true);
  });

  it('keeps a long task running in the background when a new one arrives', async () => {
    const coding = controllableBackend('claude-code');
    const desktop = controllableBackend('codex');
    const backends = new BackendManager();
    backends.register(coding.backend);
    backends.register(desktop.backend);
    const tasks = new TaskManager({ backends });

    const build = tasks.start({
      title: 'Починить билд Aegis',
      request: request(),
      preference: { codingPreference: 'claude-code' },
    });
    await tick();

    // «А пока открой мне Spotify.»
    const spotify = tasks.start({
      title: 'Открыть Spotify',
      request: request({ utterance: 'открой спотифай', capabilities: ['computer'] }),
      preference: { requested: 'codex' },
    });
    await tick();

    expect(build.state).toBe('running');
    expect(build.foreground).toBe(false);
    expect(tasks.foreground()?.id).toBe(spotify.id);
    expect(tasks.background().map((task) => task.id)).toContain(build.id);
    expect(coding.controls.cancelled).toBe(false);

    desktop.controls.finish({ backend: 'codex', text: 'Открыл.' });
    await tick();
    expect(build.state).toBe('running');
  });

  it('stops only the foreground task when the user says стоп', async () => {
    const coding = controllableBackend('claude-code');
    const desktop = controllableBackend('codex');
    const backends = new BackendManager();
    backends.register(coding.backend);
    backends.register(desktop.backend);
    const tasks = new TaskManager({ backends });

    tasks.start({ title: 'фон', request: request(), preference: { codingPreference: 'claude-code' } });
    await tick();
    const front = tasks.start({
      title: 'перед',
      // Два разных backend, как и задумано в проверке: отмена одной задачи не
      // должна задеть процесс другой.
      request: request({ capabilities: ['communication'] }),
      preference: { requested: 'codex' },
    });
    await tick();

    expect(tasks.cancelForeground()).toBe(true);
    await tick();

    expect(front.state).toBe('cancelled');
    expect(coding.controls.cancelled).toBe(false);
  });

  it('pauses by stopping the run and keeping the backend session', async () => {
    const { backend, controls } = controllableBackend();
    const tasks = managerWith(backend);

    const task = tasks.start({ title: 'Долгая задача', request: request() });
    await tick();
    controls.emit({ type: 'started', backend: 'claude-code', sessionId: 'sess-42' });
    await tick();

    expect(tasks.pause(task.id)).toBe(true);
    await tick();

    expect(task.state).toBe('paused');
    expect(controls.cancelled).toBe(true);
    // Пауза без id сессии — обещание, которого не сдержать: продолжить будет
    // нечем, только начать заново.
    expect(task.sessionId).toBe('sess-42');
  });

  it('пауза без сессии не обещает продолжения', async () => {
    const { backend } = controllableBackend();
    const tasks = managerWith(backend);

    const task = tasks.start({ title: 'Долгая задача', request: request() });
    await tick();
    // События `started` не было — id сессии взяться неоткуда.
    expect(tasks.pause(task.id)).toBe(false);
    expect(task.state).toBe('running');
  });

  it('«стоп» на задаче в паузе правда её останавливает', async () => {
    const { backend, controls } = controllableBackend();
    const tasks = managerWith(backend);

    const task = tasks.start({ title: 'Долгая задача', request: request() });
    await tick();
    controls.emit({ type: 'started', backend: 'claude-code', sessionId: 'sess-42' });
    await tick();
    expect(tasks.pause(task.id)).toBe(true);
    await tick();

    // Запуска в списке уже нет: его цикл закончился. Раньше `cancel` в этом
    // случае молча отвечал успехом, задача навсегда оставалась на паузе, и
    // Джарвис сам же предлагал её продолжить после «остановил».
    expect(tasks.cancel(task.id)).toBe(true);
    expect(task.state).toBe('cancelled');
    // На паузе её больше нет. Продолжить законченную работу по её сессии
    // по-прежнему можно — это другое обещание.
    expect(tasks.list().some((t) => t.state === 'paused')).toBe(false);
  });

  it('resumes a paused task through the vendor session rather than starting over', async () => {
    const runs: BackendRequest[] = [];
    const backend = {
      id: 'claude-code' as const,
      name: 'claude-code',
      capabilities: new Set(),
      checkAvailability: async () => ({
        id: 'claude-code' as const,
        installed: true,
        authenticated: true,
        ready: true,
        checkedAt: 0,
      }),
      run: (backendRequest: BackendRequest): BackendRun => {
        runs.push(backendRequest);
        const channel = new EventChannel<BackendEvent>();
        // Id сессии приезжает СОБЫТИЕМ, как у настоящего бэкенда. Раньше тест
        // подставлял его руками, и то, что менеджер его не читает, не было
        // видно: «продолжай» начал бы работу с нуля.
        channel.push({ type: 'started', backend: 'claude-code', sessionId: 'sess-7' });
        const result: BackendResult = {
          ok: true,
          backend: 'claude-code',
          text: 'ок',
          sessionId: 'sess-7',
          durationMs: 1,
          filesChanged: [],
          commands: [],
        };
        // Stays open until cancelled, so the task can be paused.
        return {
          id: 'r',
          backend: 'claude-code',
          events: channel,
          cancel: () => {
            channel.push({ type: 'completed', backend: 'claude-code', result });
            channel.close();
          },
          result: () => Promise.resolve(result),
        };
      },
    } as unknown as AgentBackend;

    const tasks = managerWith(backend);
    const task = tasks.start({ title: 'Задача', request: request() });
    await tick();
    expect(task.sessionId).toBe('sess-7');

    tasks.pause(task.id);
    await tick();
    expect(tasks.resumableTask()?.id).toBe(task.id);

    const resumed = tasks.resume(task.id);
    await tick();

    expect(resumed?.state).toBe('running');
    expect(runs).toHaveLength(2);
    expect(runs[1]?.sessionId).toBe('sess-7');
  });

  it('refuses to resume a task that was never paused', async () => {
    const { backend, controls } = controllableBackend();
    const tasks = managerWith(backend);
    const task = tasks.start({ title: 'Задача', request: request() });
    await tick();
    expect(tasks.resume(task.id)).toBeNull();
    controls.finish();
    await tick();
  });

  it('cancels everything when asked to', async () => {
    const coding = controllableBackend('claude-code');
    const desktop = controllableBackend('codex');
    const backends = new BackendManager();
    backends.register(coding.backend);
    backends.register(desktop.backend);
    const tasks = new TaskManager({ backends });

    tasks.start({ title: 'a', request: request(), preference: { codingPreference: 'claude-code' } });
    await tick();
    tasks.start({ title: 'b', request: request({ capabilities: ['computer'] }) });
    await tick();

    expect(tasks.cancelAll()).toBe(2);
    await tick();
    expect(tasks.active()).toHaveLength(0);
  });

  it('bounds retained events so a long task cannot grow without limit', async () => {
    const { backend, controls } = controllableBackend();
    const backends = new BackendManager();
    backends.register(backend);
    const tasks = new TaskManager({ backends, eventLimit: 5 });

    const task = tasks.start({ title: 'Шумная задача', request: request() });
    await tick();
    for (let index = 0; index < 20; index += 1) {
      controls.emit({ type: 'status', backend: 'claude-code', text: `шаг ${index}` });
    }
    await tick();

    // Точное число и ПОСЛЕДНИЕ события.
    //
    // «Не больше пяти» проходило и на пустом списке, и когда предел отрезал
    // не тот конец: человек увидел бы первые шаги вместо свежих.
    expect(task.events).toHaveLength(5);
    expect(task.events.at(-1)).toMatchObject({ type: 'status', text: 'шаг 19' });
    expect(task.events.at(0)).toMatchObject({ type: 'status', text: 'шаг 15' });
    controls.finish();
    await tick();
  });

  it('survives a subscriber that throws', async () => {
    const { backend, controls } = controllableBackend();
    const tasks = managerWith(backend);
    tasks.subscribe(() => {
      throw new Error('broken listener');
    });

    const task = tasks.start({ title: 'Задача', request: request() });
    await tick();
    controls.finish();
    await tick();
    expect(task.state).toBe('completed');
  });

  it('prunes old finished tasks but keeps the recent ones', async () => {
    const { backend, controls } = controllableBackend();
    const tasks = managerWith(backend);
    const task = tasks.start({ title: 'Задача', request: request() });
    await tick();
    controls.finish();
    await tick();

    tasks.prune(0);
    expect(tasks.get(task.id)).toBeUndefined();
  });
});

describe('progress', () => {
  const events: BackendEvent[] = [
    { type: 'started', backend: 'claude-code' },
    { type: 'status', backend: 'claude-code', text: 'Нашёл проект Aegis' },
    { type: 'command', backend: 'claude-code', command: 'pnpm build', exitCode: 1 },
    { type: 'tool', backend: 'claude-code', name: 'Read', detail: 'vite.config.ts' },
    { type: 'file-changed', backend: 'claude-code', change: { path: 'vite.config.ts', action: 'modified' } },
  ];

  it('shows what happened, not what the model was thinking', () => {
    const steps = buildProgress(events, 'running');
    expect(steps.map((step) => step.label)).toEqual([
      'Запускаю',
      'Нашёл проект Aegis',
      'Команда: pnpm build',
      'Читаю файл: vite.config.ts',
      'Изменён файл: vite.config.ts',
    ]);
    expect(steps.at(-1)?.status).toBe('active');
    expect(steps[2]?.status).toBe('failed');
  });

  it('shows a shell call once, not twice', () => {
    // Claude Code emits a tool event and a command event for the same Bash
    // call; rendering both doubled every shell line in the real pipeline.
    const steps = buildProgress(
      [
        { type: 'tool', backend: 'claude-code', name: 'Bash', detail: 'pnpm build' },
        { type: 'command', backend: 'claude-code', command: 'pnpm build' },
      ],
      'completed',
    );
    expect(steps.map((step) => step.label)).toEqual(['Команда: pnpm build']);
  });

  it('still shows non-shell tools', () => {
    const steps = buildProgress(
      [{ type: 'tool', backend: 'claude-code', name: 'Read', detail: 'a.ts' }],
      'completed',
    );
    expect(steps).toHaveLength(1);
  });

  it('omits streamed assistant text from the step list', () => {
    const steps = buildProgress(
      [{ type: 'assistant-text', backend: 'codex', text: 'Сейчас посмотрю конфигурацию…' }],
      'running',
    );
    expect(steps).toHaveLength(0);
  });

  it('marks the final step done once the task finishes', () => {
    const steps = buildProgress(events, 'completed');
    expect(steps.at(-1)?.status).toBe('done');
  });

  it('renders the list the way the overlay shows it', () => {
    const rendered = renderProgress(buildProgress(events.slice(0, 2), 'running'));
    expect(rendered).toBe('✓ Запускаю\n→ Нашёл проект Aegis');
  });

  it('summarises a coding task from both events and the final result', async () => {
    const { backend, controls } = controllableBackend();
    const tasks = managerWith(backend);
    const task = tasks.start({ title: 'Починить билд', request: request() });
    await tick();
    controls.emit({
      type: 'file-changed',
      backend: 'claude-code',
      change: { path: 'a.ts', action: 'modified' },
    });
    await tick();
    controls.finish({
      filesChanged: [{ path: 'b.ts', action: 'created' }],
      commands: ['pnpm build'],
    });
    await tick();

    const summary = summarizeCodingTask(task);
    expect(summary.filesChanged.sort()).toEqual(['a.ts', 'b.ts']);
    expect(summary.commands).toEqual(['pnpm build']);
    expect(summary.status).toBe('completed');
  });

  it('describes task state in Russian', async () => {
    const { backend, controls } = controllableBackend();
    const tasks = managerWith(backend);
    const task = tasks.start({ title: 'Починить билд Aegis', request: request() });
    await tick();
    expect(describeTaskState(task)).toBe('Работаю: Починить билд Aegis');
    controls.finish();
    await tick();
    expect(describeTaskState(task)).toBe('Готово: Починить билд Aegis');
  });
});

describe('TaskManager timing', () => {
  it('uses the injected clock so timestamps are testable', async () => {
    // Часы должны ИДТИ: с постоянным значением проверка `finishedAt`
    // проходила бы, даже если туда попадёт время создания или начала.
    let тик = 1_000;
    const clock = vi.fn(() => тик++);
    const { backend, controls } = controllableBackend();
    const backends = new BackendManager();
    backends.register(backend);
    const tasks = new TaskManager({ backends, now: clock });

    const task = tasks.start({ title: 'Задача', request: request() });
    await tick();
    expect(task.createdAt).toBe(1_000);
    controls.finish();
    await tick();
    expect(task.finishedAt).toBeGreaterThan(task.startedAt ?? 0);
    expect(task.startedAt).toBeGreaterThan(task.createdAt);
  });
});
