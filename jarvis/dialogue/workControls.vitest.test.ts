import { describe, expect, it } from 'vitest';

import { BackendManager } from '../backends/manager';
import { EventChannel } from '../backends/process';
import type { AgentBackend, BackendEvent, BackendRequest, BackendResult, BackendRun } from '../backends/types';
import { TaskManager } from '../tasks/manager';
import { DEFAULT_PERMISSIONS } from '../types';
import { applyWorkControl } from './workControls';

/**
 * Бэкенд, который гасится не мгновенно — как настоящий CLI: отмена только
 * просит процесс выйти, а выходит он, когда тест скажет.
 */
function медленныйБэкенд() {
  const ждут: Array<() => void> = [];
  const backend = {
    id: 'claude-code',
    name: 'claude-code',
    capabilities: new Set(),
    checkAvailability: async () => ({ id: 'claude-code', installed: true, authenticated: true, ready: true, checkedAt: 0 }),
    run: (): BackendRun => {
      const channel = new EventChannel<BackendEvent>();
      let settle: (result: BackendResult) => void = () => {};
      const finished = new Promise<BackendResult>((resolve) => {
        settle = resolve;
      });
      return {
        id: 'run',
        backend: 'claude-code',
        events: channel,
        cancel: () => {
          ждут.push(() => {
            const result: BackendResult = {
              ok: false,
              backend: 'claude-code',
              text: '',
              durationMs: 1,
              filesChanged: [],
              commands: [],
              cancelled: true,
              error: 'Отменено',
            };
            channel.push({ type: 'completed', backend: 'claude-code', result });
            channel.close();
            settle(result);
          });
        },
        result: () => finished,
      };
    },
  } as unknown as AgentBackend;
  return { backend, выпустить: () => ждут.splice(0).forEach((f) => f()) };
}

const запрос = (utterance: string): BackendRequest => ({
  utterance,
  capabilities: ['coding'],
  risk: 'normal',
  permissions: DEFAULT_PERMISSIONS,
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('рычаги работы из разговора', () => {
  it('две остановки подряд: вторая не докладывает «остановил» про уже останавливаемую', async () => {
    const { backend, выпустить } = медленныйБэкенд();
    const backends = new BackendManager();
    backends.register(backend);
    const tasks = new TaskManager({ backends });
    const первая = tasks.start({ title: 'Первая', request: запрос('первая') });
    const вторая = tasks.start({ title: 'Вторая', request: запрос('вторая') });
    await tick();

    const раз = applyWorkControl('stop', tasks);
    const два = applyWorkControl('stop', tasks);

    expect(раз).toMatchObject({ ok: true, text: 'Остановил: Вторая' });
    // Процесс второй ещё не вышел — она по-прежнему передняя. Честный ответ,
    // а не второе «Остановил».
    expect(два.ok).toBe(false);
    expect(два.text).toMatch(/уже останавливается/u);
    expect(два.done).toBeUndefined();

    выпустить();
    await tick();
    await tick();
    expect(вторая.state).toBe('cancelled');
    expect(первая.state).toBe('running');
    expect(tasks.stopping(вторая.id)).toBe(false);
  });

  it('когда нечего останавливать — так и сказано', () => {
    const tasks = new TaskManager({ backends: new BackendManager() });
    expect(applyWorkControl('stop', tasks)).toEqual({ ok: false, text: 'Сейчас ничего не идёт.' });
  });
});
