/**
 * Progress rendering.
 *
 * What the user sees while a task runs is a list of things that actually
 * happened — not the model's reasoning:
 *
 *     ✓ Нашёл проект Aegis
 *     ✓ Воспроизвёл ошибку
 *     → Проверяю зависимости
 *     ○ Запустить тесты
 *
 * This module turns the backend event stream into that list, plus the summary
 * a coding backend deserves: files changed, commands run, final status.
 */

import type { BackendEvent, BackendResult } from '../backends/types';
import type { JarvisTask, TaskState } from './manager';

export type ProgressStatus = 'done' | 'active' | 'pending' | 'failed';

export interface ProgressStep {
  id: string;
  label: string;
  status: ProgressStatus;
  detail?: string;
}

export const PROGRESS_MARKS: Record<ProgressStatus, string> = {
  done: '✓',
  active: '→',
  pending: '○',
  failed: '✗',
};

/**
 * Tools that always arrive alongside a dedicated `command` event.
 *
 * Rendering both produced every shell call twice in the progress list — once
 * as "Выполняю команду: …" and once as "Команда: …". The command event carries
 * the exit status, so it is the one worth keeping.
 */
const COMMAND_TOOL_NAMES = new Set(['Bash', 'local_shell_call', 'shell']);

/** Russian labels for the tools a coding backend uses most. */
const TOOL_LABELS: Record<string, string> = {
  Read: 'Читаю файл',
  Glob: 'Ищу файлы',
  Grep: 'Ищу по коду',
  Edit: 'Правлю файл',
  Write: 'Пишу файл',
  MultiEdit: 'Правлю файлы',
  NotebookEdit: 'Правлю ноутбук',
  Bash: 'Выполняю команду',
  WebSearch: 'Ищу в интернете',
  WebFetch: 'Открываю страницу',
  Task: 'Запускаю подзадачу',
  web_search: 'Ищу в интернете',
};

function labelForTool(name: string, detail?: string): string {
  const base = TOOL_LABELS[name] ?? `Инструмент ${name}`;
  if (!detail) return base;
  const short = detail.length > 60 ? `${detail.slice(0, 57)}…` : detail;
  return `${base}: ${short}`;
}

/** Collapses consecutive identical labels, which read as noise in a list. */
function pushStep(steps: ProgressStep[], step: ProgressStep): void {
  const last = steps[steps.length - 1];
  if (last && last.label === step.label) return;
  steps.push(step);
}

/**
 * Builds the visible step list from the events a task has produced.
 *
 * `state` decides how the last step reads: while the task runs it is the
 * active one, once it finishes it is done or failed.
 */
export function buildProgress(
  events: readonly BackendEvent[],
  state: TaskState = 'running',
): ProgressStep[] {
  const steps: ProgressStep[] = [];

  for (const [index, event] of events.entries()) {
    const id = `${index}`;
    switch (event.type) {
      case 'started':
        pushStep(steps, { id, label: 'Запускаю', status: 'done' });
        break;
      case 'status':
        pushStep(steps, { id, label: event.text, status: 'done' });
        break;
      case 'tool':
        if (COMMAND_TOOL_NAMES.has(event.name)) break;
        pushStep(steps, {
          id,
          label: labelForTool(event.name, event.detail),
          status: 'done',
        });
        break;
      case 'command':
        pushStep(steps, {
          id,
          label: `Команда: ${event.command.length > 60 ? `${event.command.slice(0, 57)}…` : event.command}`,
          status: event.exitCode !== undefined && event.exitCode !== 0 ? 'failed' : 'done',
        });
        break;
      case 'file-changed':
        pushStep(steps, {
          id,
          label: `${fileActionLabel(event.change.action)}: ${event.change.path}`,
          status: 'done',
        });
        break;
      case 'error':
        pushStep(steps, { id, label: event.message, status: 'failed' });
        break;
      case 'assistant-text':
      case 'completed':
        break;
    }
  }

  const last = steps[steps.length - 1];
  if (last && state === 'running' && last.status === 'done') {
    last.status = 'active';
  }
  if (last && state === 'failed' && last.status === 'done') {
    last.status = 'failed';
  }
  return steps;
}

function fileActionLabel(action: 'created' | 'modified' | 'deleted'): string {
  switch (action) {
    case 'created':
      return 'Создан файл';
    case 'deleted':
      return 'Удалён файл';
    case 'modified':
      return 'Изменён файл';
  }
}

export interface CodingSummary {
  status: TaskState;
  filesChanged: string[];
  commands: string[];
  backend?: string;
  error?: string;
}

/** The status block a coding backend deserves: files, commands, outcome. */
export function summarizeCodingTask(task: JarvisTask): CodingSummary {
  const fromEvents = task.events.filter(
    (event): event is Extract<BackendEvent, { type: 'file-changed' }> => event.type === 'file-changed',
  );
  const commandEvents = task.events.filter(
    (event): event is Extract<BackendEvent, { type: 'command' }> => event.type === 'command',
  );

  const files = new Set<string>([
    ...fromEvents.map((event) => event.change.path),
    ...(task.result?.filesChanged ?? []).map((change) => change.path),
  ]);
  const commands = new Set<string>([
    ...commandEvents.map((event) => event.command),
    ...(task.result?.commands ?? []),
  ]);

  return {
    status: task.state,
    filesChanged: [...files],
    commands: [...commands],
    backend: task.result?.backend,
    error: task.result?.error,
  };
}

/** Renders the step list the way the overlay shows it. */
export function renderProgress(steps: readonly ProgressStep[]): string {
  return steps.map((step) => `${PROGRESS_MARKS[step.status]} ${step.label}`).join('\n');
}

/** One short Russian line describing where a task stands. */
export function describeTaskState(task: JarvisTask): string {
  switch (task.state) {
    case 'queued':
      return `В очереди: ${task.title}`;
    case 'running':
      return `Работаю: ${task.title}`;
    case 'paused':
      return `На паузе: ${task.title}`;
    case 'completed':
      return `Готово: ${task.title}`;
    case 'failed':
      return `Не получилось: ${task.title}`;
    case 'cancelled':
      return `Отменено: ${task.title}`;
  }
}

/** True when a result is worth speaking rather than only showing. */
export function shouldSpeakResult(result: BackendResult | undefined): boolean {
  return Boolean(result && (result.text.trim().length > 0 || result.error));
}
