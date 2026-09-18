/**
 * BackendManager — the single place that decides which backend does the work.
 *
 * Jarvis core asks for capabilities; the manager turns that into an ordered
 * list of candidates and runs them until one of them actually gets to do the
 * job. A backend that is missing, unauthenticated or out of quota costs the
 * user a sentence of explanation, never a dead end.
 *
 *      Jarvis Core → BackendManager → { ClaudeCode | Codex | Interpreter | … }
 */

import { randomUUID } from 'node:crypto';
import type { JarvisCapability } from '../types';
import { EventChannel } from './process';
import {
  CODING_BACKEND_IDS,
  type AgentBackend,
  type BackendAvailability,
  type BackendEvent,
  type BackendId,
  type BackendRequest,
  type BackendResult,
  type BackendRun,
} from './types';

/** Which backend the user wants, from settings and from what they just said. */
export interface BackendPreference {
  /** The "Coding" selector in settings. */
  codingPreference?: 'auto' | BackendId;
  /** The "Main brain" selector in settings. */
  mainPreference?: 'auto' | BackendId;
  /** Named in this utterance: «сделай это через Клод Код». */
  requested?: BackendId;
  /** Ruled out in this utterance: «не используй Клод». */
  excluded?: BackendId[];
}

export interface BackendPlan {
  /** Candidates in the order they will be tried. */
  order: BackendId[];
  /** Why the head of the order was chosen — shown in logs and the UI. */
  rationale: string;
}

/**
 * A failure of the backend itself, as opposed to an honest answer of "I could
 * not do it". Only this kind of failure triggers a fallback: if Claude Code
 * ran and reported that the build is broken for a reason it cannot fix, asking
 * Codex the same question is not an improvement.
 */
export function isBackendLevelFailure(result: BackendResult): boolean {
  if (result.ok || result.cancelled) return false;
  if (result.usageLimited) return true;
  // The run never produced any output: it could not start, or the CLI died.
  return result.text.trim().length === 0 && result.timedOut !== true;
}

const CODING_CAPABILITIES: readonly JarvisCapability[] = ['coding'];

function needsCoding(capabilities: readonly JarvisCapability[]): boolean {
  return CODING_CAPABILITIES.some((capability) => capabilities.includes(capability));
}

/** Capabilities only the Workstation runtime can serve. */
const COMPUTER_CAPABILITIES: readonly JarvisCapability[] = [
  'computer',
  'browser',
  'vision',
  'communication',
  'system',
];

function needsComputer(capabilities: readonly JarvisCapability[]): boolean {
  return COMPUTER_CAPABILITIES.some((capability) => capabilities.includes(capability));
}

export class BackendManager {
  private readonly backends = new Map<BackendId, AgentBackend>();

  register(backend: AgentBackend): void {
    this.backends.set(backend.id, backend);
  }

  get(id: BackendId): AgentBackend | undefined {
    return this.backends.get(id);
  }

  list(): AgentBackend[] {
    return [...this.backends.values()];
  }

  /** Probes every registered backend. Never rejects. */
  async availability(force = false): Promise<BackendAvailability[]> {
    return Promise.all(
      this.list().map(async (backend) => {
        try {
          return await backend.checkAvailability(force);
        } catch (error) {
          return {
            id: backend.id,
            installed: false,
            authenticated: false,
            ready: false,
            reason: error instanceof Error ? error.message : String(error),
            checkedAt: Date.now(),
          } satisfies BackendAvailability;
        }
      }),
    );
  }

  /**
   * Builds the ordered candidate list.
   *
   * A task that needs the screen, the browser or the desktop goes to the
   * Workstation runtime regardless of coding preference — Claude Code and
   * Codex cannot click a window. A task that needs code goes to the preferred
   * coding backend first, with the other one behind it and the runtime last.
   */
  plan(request: BackendRequest, preference: BackendPreference = {}): BackendPlan {
    const excluded = new Set(preference.excluded ?? []);
    const order: BackendId[] = [];
    const push = (id: BackendId): void => {
      if (excluded.has(id)) return;
      if (!this.backends.has(id)) return;
      if (order.includes(id)) return;
      order.push(id);
    };

    let rationale: string;

    if (preference.requested && !excluded.has(preference.requested)) {
      push(preference.requested);
      rationale = `Пользователь попросил ${preference.requested}`;
    } else if (needsComputer(request.capabilities)) {
      push('interpreter');
      rationale = 'Задача требует управления компьютером или браузером';
    } else if (needsCoding(request.capabilities)) {
      const preferred = preference.codingPreference;
      if (preferred && preferred !== 'auto') {
        push(preferred);
        rationale = `Coding backend выбран в настройках: ${preferred}`;
      } else {
        rationale = 'Задача по коду, backend выбран автоматически';
      }
      for (const id of CODING_BACKEND_IDS) push(id);
      push('interpreter');
    } else {
      const preferred = preference.mainPreference;
      if (preferred && preferred !== 'auto') {
        push(preferred);
        rationale = `Main backend выбран в настройках: ${preferred}`;
      } else {
        rationale = 'Обычная задача, основной runtime';
      }
      push('interpreter');
    }

    // Everything falls back to the runtime, then to a plain reasoning backend,
    // so Jarvis keeps answering even with no cloud subscription at all.
    push('interpreter');
    push('openai-compatible');
    push('local');

    return { order, rationale };
  }

  /**
   * Runs `request` against the plan, falling through to the next candidate
   * when a backend fails at the backend level rather than at the task level.
   *
   * The returned run behaves like any single backend run: one event stream,
   * one terminal result, working cancellation.
   */
  run(request: BackendRequest, preference: BackendPreference = {}): BackendRun {
    const plan = this.plan(request, preference);
    const channel = new EventChannel<BackendEvent>();
    const startedAt = Date.now();

    let cancelled = false;
    let active: BackendRun | null = null;
    let settle: (result: BackendResult) => void = () => {};
    const resultPromise = new Promise<BackendResult>((resolve) => {
      settle = resolve;
    });

    const fallbackBackend: BackendId = plan.order[0] ?? 'interpreter';

    const finish = (result: BackendResult): void => {
      channel.push({ type: 'completed', backend: result.backend, result });
      channel.close();
      settle(result);
    };

    void (async () => {
      if (plan.order.length === 0) {
        finish({
          ok: false,
          backend: fallbackBackend,
          text: '',
          durationMs: Date.now() - startedAt,
          filesChanged: [],
          commands: [],
          error: 'Нет доступных backend. Проверьте настройки AI-аккаунтов.',
        });
        return;
      }

      const failures: string[] = [];

      for (const id of plan.order) {
        if (cancelled) break;
        const backend = this.backends.get(id);
        if (!backend) continue;

        if (failures.length > 0) {
          channel.push({
            type: 'status',
            backend: id,
            text: `Переключаюсь на ${backend.name}`,
          });
        }

        let run: BackendRun;
        try {
          run = backend.run(request);
        } catch (error) {
          failures.push(`${backend.name}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        active = run;

        for await (const event of run.events) {
          if (event.type === 'completed') break;
          channel.push(event);
        }

        const result = await run.result();
        active = null;

        if (result.cancelled || cancelled) {
          finish(result);
          return;
        }
        if (!isBackendLevelFailure(result)) {
          finish(result);
          return;
        }

        const reason = result.usageLimited
          ? `${backend.name}: исчерпан лимит подписки`
          : `${backend.name}: ${result.error ?? 'не удалось выполнить'}`;
        failures.push(reason);
        channel.push({ type: 'error', backend: id, message: reason, retryable: true });
      }

      finish({
        ok: false,
        backend: fallbackBackend,
        text: '',
        durationMs: Date.now() - startedAt,
        filesChanged: [],
        commands: [],
        cancelled: cancelled || undefined,
        error: cancelled
          ? 'Отменено'
          : `Ни один backend не смог выполнить задачу. ${failures.join('; ')}`,
      });
    })().catch((error: unknown) => {
      finish({
        ok: false,
        backend: fallbackBackend,
        text: '',
        durationMs: Date.now() - startedAt,
        filesChanged: [],
        commands: [],
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return {
      id: randomUUID(),
      backend: fallbackBackend,
      events: channel,
      cancel: (reason?: string) => {
        cancelled = true;
        active?.cancel(reason);
      },
      result: () => resultPromise,
    };
  }
}
