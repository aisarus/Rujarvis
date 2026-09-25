/**
 * Task manager.
 *
 * A five-minute coding task must not make Jarvis deaf. One task is in the
 * foreground; anything else keeps running in the background, and «а пока
 * открой Spotify» starts a new foreground task without disturbing it.
 *
 * Pause is honest about what it can do. There is no portable way to freeze a
 * coding agent's process tree on Windows, so pausing stops the run and keeps
 * the backend session id; «продолжай» resumes the vendor's own session with
 * `claude --resume` / `codex exec resume` rather than starting over.
 */

import { randomUUID } from 'node:crypto';
import type { BackendManager, BackendPreference } from '../backends/manager';
import type {
  BackendEvent,
  BackendRequest,
  BackendResult,
  BackendRun,
} from '../backends/types';

export type TaskState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface JarvisTask {
  id: string;
  /** Short Russian label for the UI: «Починить билд Aegis». */
  title: string;
  state: TaskState;
  foreground: boolean;
  request: BackendRequest;
  preference: BackendPreference;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Set once a backend reports one, so the task can be resumed later. */
  sessionId?: string;
  result?: BackendResult;
  /** Events seen so far, bounded so a long task does not grow without limit. */
  events: BackendEvent[];
}

export type TaskManagerEvent =
  | { type: 'task-created'; task: JarvisTask }
  | { type: 'task-state'; task: JarvisTask }
  | { type: 'task-event'; task: JarvisTask; event: BackendEvent }
  | { type: 'task-finished'; task: JarvisTask };

export interface TaskSpec {
  title: string;
  request: BackendRequest;
  preference?: BackendPreference;
  /** Defaults to true: what the user just asked for is the foreground task. */
  foreground?: boolean;
}

export interface TaskManagerOptions {
  backends: BackendManager;
  /** How many events to retain per task. */
  eventLimit?: number;
  now?: () => number;
}

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'failed',
  'cancelled',
]);

export class TaskManager {
  private readonly tasks = new Map<string, JarvisTask>();
  private readonly runs = new Map<string, BackendRun>();
  private readonly listeners = new Set<(event: TaskManagerEvent) => void>();
  private foregroundId: string | null = null;
  private readonly now: () => number;

  constructor(private readonly options: TaskManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: (event: TaskManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TaskManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not break task execution.
      }
    }
  }

  list(): JarvisTask[] {
    return [...this.tasks.values()];
  }

  get(id: string): JarvisTask | undefined {
    return this.tasks.get(id);
  }

  foreground(): JarvisTask | null {
    return this.foregroundId ? (this.tasks.get(this.foregroundId) ?? null) : null;
  }

  background(): JarvisTask[] {
    return this.list().filter((task) => !task.foreground && task.state === 'running');
  }

  active(): JarvisTask[] {
    return this.list().filter((task) => task.state === 'running' || task.state === 'paused');
  }

  /**
   * Starts a task.
   *
   * A new foreground task pushes the previous one into the background — it
   * keeps running, it just stops being what «стоп» refers to.
   */
  start(spec: TaskSpec): JarvisTask {
    const foreground = spec.foreground !== false;
    if (foreground) {
      const previous = this.foreground();
      if (previous && !TERMINAL_STATES.has(previous.state)) {
        previous.foreground = false;
        this.emit({ type: 'task-state', task: previous });
      }
    }

    const task: JarvisTask = {
      id: randomUUID(),
      title: spec.title,
      state: 'queued',
      foreground,
      request: spec.request,
      preference: spec.preference ?? {},
      createdAt: this.now(),
      sessionId: spec.request.sessionId,
      events: [],
    };

    this.tasks.set(task.id, task);
    if (foreground) this.foregroundId = task.id;
    this.emit({ type: 'task-created', task });

    this.launch(task);
    return task;
  }

  private launch(task: JarvisTask): void {
    const run = this.options.backends.run(task.request, task.preference);
    this.runs.set(task.id, run);
    task.state = 'running';
    task.startedAt = this.now();
    this.emit({ type: 'task-state', task });

    void (async () => {
      const limit = this.options.eventLimit ?? 200;
      for await (const event of run.events) {
        if (event.type === 'completed') break;
        // Id сессии приходит в событии начала — без него «продолжай» начнёт
        // работу с нуля, а обещание паузы было другим.
        if (event.type === 'started' && event.sessionId) task.sessionId = event.sessionId;
        task.events.push(event);
        if (task.events.length > limit) task.events.splice(0, task.events.length - limit);
        this.emit({ type: 'task-event', task, event });
      }

      const result = await run.result();

      // Этот ли запуск сейчас текущий.
      //
      // Человек говорит «пауза», потом «продолжай» раньше, чем настоящий
      // процесс успел закончиться. Старый цикл просыпался и выбрасывал из
      // `runs` НОВЫЙ запуск, писал в задачу старый результат и ставил
      // «Отменено». Человек видел «Отменено», агент при этом продолжал
      // работать и писать файлы, а «стоп» его уже не доставал: записи в
      // `runs` не было.
      if (this.runs.get(task.id) !== run) {
        this.emit({ type: 'task-state', task });
        return;
      }

      this.runs.delete(task.id);
      task.result = result;
      task.finishedAt = this.now();
      if (result.sessionId) task.sessionId = result.sessionId;

      if (task.state === 'paused') {
        // The pause already moved the task; the cancelled run is expected.
        this.emit({ type: 'task-state', task });
        return;
      }

      task.state = result.cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed';
      if (this.foregroundId === task.id) this.foregroundId = null;
      this.emit({ type: 'task-state', task });
      this.emit({ type: 'task-finished', task });
    })().catch((error: unknown) => {
      // Чужую беду на новый запуск не переносим.
      if (this.runs.get(task.id) !== run) return;
      this.runs.delete(task.id);

      // Причину не теряем: без неё человек слышит «не получилось» без единого
      // слова о том, что случилось, и в журнал прогона тоже ничего не идёт.
      const причина = error instanceof Error ? error.message : String(error);
      task.result = {
        ok: false,
        backend: run.backend,
        text: '',
        durationMs: this.now() - (task.startedAt ?? this.now()),
        filesChanged: [],
        commands: [],
        error: причина,
      };
      console.error(`[jarvis] задача «${task.title}» оборвалась: ${причина}`);

      // И сам процесс агента гасим: иначе он остаётся работать, а остановить
      // его уже нечем — записи в `runs` больше нет.
      try {
        run.cancel('user');
      } catch {
        // Гасить уже мёртвый запуск — не новость.
      }

      task.state = 'failed';
      task.finishedAt = this.now();
      if (this.foregroundId === task.id) this.foregroundId = null;
      this.emit({ type: 'task-state', task });
      this.emit({ type: 'task-finished', task });
    });
  }

  /** Stops a task immediately. This is what «стоп» reaches. */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || TERMINAL_STATES.has(task.state)) return false;

    const run = this.runs.get(id);
    if (run) {
      run.cancel('user');
      return true;
    }

    // Запуска уже нет — так бывает у задачи на паузе: её цикл завершился и
    // убрал запись. Раньше `cancel` в этом случае молча отвечал успехом, и
    // задача навсегда оставалась на паузе: Джарвис говорил «остановил», а
    // потом сам же предлагал её продолжить.
    task.state = 'cancelled';
    task.finishedAt = this.now();
    if (this.foregroundId === task.id) this.foregroundId = null;
    this.emit({ type: 'task-state', task });
    this.emit({ type: 'task-finished', task });
    return true;
  }

  /** Stops the foreground task only, leaving background work alone. */
  cancelForeground(): boolean {
    const task = this.foreground();
    return task ? this.cancel(task.id) : false;
  }

  cancelAll(): number {
    let stopped = 0;
    for (const task of this.active()) {
      if (this.cancel(task.id)) stopped += 1;
    }
    return stopped;
  }

  /**
   * Pauses a task: stops the run, keeps the backend session.
   *
   * Returns false when there is nothing to resume from — a task with no
   * session id cannot be continued, only restarted, and pretending otherwise
   * would lose work silently.
   */
  pause(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.state !== 'running') return false;
    // Без id сессии продолжить нельзя — только начать заново. Обещать паузу в
    // этом случае значит потерять работу молча, о чём сказано прямо выше.
    if (!task.sessionId && !task.request.sessionId) return false;
    task.state = 'paused';
    this.runs.get(id)?.cancel('pause');
    this.emit({ type: 'task-state', task });
    return true;
  }

  /** Resumes a paused task, continuing the vendor session where possible. */
  resume(id: string): JarvisTask | null {
    const task = this.tasks.get(id);
    if (!task || task.state !== 'paused') return null;
    task.request = { ...task.request, sessionId: task.sessionId ?? task.request.sessionId };
    task.result = undefined;
    task.finishedAt = undefined;
    this.launch(task);
    return task;
  }

  /** The task «продолжай» refers to: the paused one, else the most recent. */
  resumableTask(): JarvisTask | null {
    const paused = this.list()
      .filter((task) => task.state === 'paused')
      .sort((a, b) => b.createdAt - a.createdAt);
    if (paused.length > 0) return paused[0] as JarvisTask;

    const finished = this.list()
      .filter((task) => TERMINAL_STATES.has(task.state) && task.sessionId)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    return finished[0] ?? null;
  }

  /** Demotes a running task so a new request can take the foreground. */
  moveToBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || TERMINAL_STATES.has(task.state)) return false;
    task.foreground = false;
    if (this.foregroundId === id) this.foregroundId = null;
    this.emit({ type: 'task-state', task });
    return true;
  }

  /** Drops finished tasks, keeping the newest `keep` for history. */
  prune(keep = 20): void {
    const finished = this.list()
      .filter((task) => TERMINAL_STATES.has(task.state))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    for (const task of finished.slice(keep)) {
      this.tasks.delete(task.id);
    }
  }
}
