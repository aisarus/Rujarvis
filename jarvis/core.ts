/**
 * Jarvis core — the seam the desktop app talks to.
 *
 * One utterance comes in; everything else is orchestration:
 *
 *   реплика
 *     → локальная проверка команд управления  (мгновенно, без модели)
 *     → маршрутизация                          (какие capabilities, какой backend)
 *     → нормализация                           (только сужает разрешения)
 *     → политика риска                         (код, а не текст модели)
 *     → отбор контекста                        (память + состояние мира)
 *     → задача                                 (передний план / фон)
 *     → подтверждение голосом                  (~1 c, ещё до модели)
 *     → прогресс                               (действия, не рассуждения)
 *     → короткий устный ответ
 *
 * Everything the core depends on is injected, so this whole pipeline is
 * testable without a microphone, a desktop or a model.
 */

import { BackendManager, type BackendPreference } from './backends/manager';
import type {
  BackendId,
  BackendRequest,
  BackendResult,
} from './backends/types';
import { WorldStateStore, selectWorldStateLines } from './context/worldState';
import { JarvisMemory } from './memory/store';
import {
  DEFAULT_RISK_POLICY,
  reconcileModelRiskClaim,
  type RiskPolicy,
} from './risk/policy';
import type { LocalRouterModel } from './router/localModel';
import { mergeRouterCapabilities } from './router/localModel';
import {
  applyModelNormalization,
  assertNormalizationIsSafe,
  normalizeRuleBased,
  type NormalizedTask,
} from './router/normalize';
import {
  route,
  toBackendPreference,
  type RoutingDecision,
} from './router/router';
import { TaskManager, type JarvisTask } from './tasks/manager';
import { DEFAULT_PERMISSIONS, riskRank, type TaskPermissions } from './types';
import { acknowledgementFor, clarificationFor } from './voice/acknowledgement';
import {
  applyVoiceControl,
  matchVoiceControl,
  type ControlOutcome,
} from './voice/interrupts';
import { spokenFailure, toSpokenResponse } from './voice/spokenResponse';

export interface JarvisSettings {
  /** The "Coding" selector. */
  codingPreference: 'auto' | BackendId;
  /** The "Main brain" selector. */
  mainPreference: 'auto' | BackendId;
  /** The permission ceiling. Everything downstream can only narrow it. */
  basePermissions: TaskPermissions;
  riskPolicy: RiskPolicy;
  /** Spoken answers on or off; the screen always gets the full answer. */
  speakResponses: boolean;
}

export const DEFAULT_JARVIS_SETTINGS: JarvisSettings = {
  codingPreference: 'auto',
  mainPreference: 'auto',
  basePermissions: DEFAULT_PERMISSIONS,
  riskPolicy: DEFAULT_RISK_POLICY,
  speakResponses: true,
};

export interface ApprovalRequest {
  utterance: string;
  decision: RoutingDecision;
  /** Russian explanation of what is about to happen. */
  summary: string;
}

export interface JarvisCoreOptions {
  backends: BackendManager;
  tasks: TaskManager;
  memory: JarvisMemory;
  world: WorldStateStore;
  settings(): JarvisSettings;
  /** Optional small local model that refines routing. */
  localRouter?: LocalRouterModel;
  /** Speaks a line. Called for acknowledgements and short results. */
  speak?(text: string): void;
  /** Asks the user to approve sensitive or dangerous work. */
  approve?(request: ApprovalRequest): Promise<boolean>;
  now?: () => number;
}

export type JarvisTurn =
  | { kind: 'control'; outcome: ControlOutcome; spoken: string }
  | { kind: 'clarify'; spoken: string; decision: RoutingDecision }
  | { kind: 'refused'; spoken: string; decision: RoutingDecision }
  | {
      kind: 'task';
      spoken: string;
      decision: RoutingDecision;
      task: JarvisTask;
      normalized: NormalizedTask;
    };

/** Short Russian label for the task list, built from the request itself. */
export function taskTitle(decision: RoutingDecision, utterance: string): string {
  const trimmed = utterance.trim().replace(/\s+/g, ' ');
  const short = trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
  return decision.project ? `${short} (${decision.project})` : short;
}

function describeForApproval(decision: RoutingDecision, utterance: string): string {
  const what = decision.project ? `в проекте ${decision.project}` : 'на этом компьютере';
  const level = decision.risk === 'dangerous' ? 'опасное' : 'чувствительное';
  return `Запрос «${utterance.trim()}» ${what} классифицирован как ${level}. Выполнять?`;
}

export class JarvisCore {
  private readonly now: () => number;

  constructor(private readonly options: JarvisCoreOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Handles one utterance.
   *
   * Returns as soon as the task has been started — it does not wait for the
   * task to finish, because a five-minute coding task must not block the next
   * thing the user says.
   */
  async handleUtterance(utterance: string): Promise<JarvisTurn> {
    const settings = this.options.settings();

    // 1. Control words never wait on a model. «Стоп» must stop things now.
    const control = matchVoiceControl(utterance);
    if (control) {
      const outcome = applyVoiceControl(control, {
        cancelForeground: () => this.options.tasks.cancelForeground(),
        pauseForeground: () => {
          const foreground = this.options.tasks.foreground();
          return foreground ? this.options.tasks.pause(foreground.id) : false;
        },
        resumeLast: () => {
          const resumable = this.options.tasks.resumableTask();
          return resumable ? this.options.tasks.resume(resumable.id) !== null : false;
        },
        stopSpeaking: () => this.options.speak?.(''),
      });
      if (outcome.spoken) this.say(outcome.spoken, settings);
      return { kind: 'control', outcome, spoken: outcome.spoken };
    }

    this.options.world.noteUtterance(utterance);

    // 2. Route. Deterministic, then optionally refined by a small local model.
    let decision = route(utterance, {
      basePermissions: settings.basePermissions,
      context: {
        knownProjects: this.options.memory.knownProjects(),
        currentProject: this.options.world.snapshot().currentProject,
        hasRunningTask: this.options.tasks.active().length > 0,
        codingPreference: settings.codingPreference,
        mainPreference: settings.mainPreference,
      },
    });

    const refinement = this.options.localRouter
      ? await this.options.localRouter.refine(utterance)
      : null;
    decision = mergeRouterCapabilities(decision, refinement);

    // 3. Normalise. The invariants live in `normalize.ts`; asserting them here
    //    means a future regression fails loudly instead of quietly granting a
    //    coding agent more access than the user allowed.
    const base = normalizeRuleBased(utterance, decision);
    const normalized = applyModelNormalization(base, refinement?.normalization);
    assertNormalizationIsSafe(base, normalized);

    // 4. Ask before anything sensitive. A model's own risk claim can raise the
    //    class but never lower it.
    const risk = reconcileModelRiskClaim(decision.risk, undefined);
    if (riskRank(risk) >= riskRank(settings.riskPolicy.approvalFrom)) {
      const approved = this.options.approve
        ? await this.options.approve({
            utterance,
            decision,
            summary: describeForApproval(decision, utterance),
          })
        : false;
      if (!approved) {
        const spoken = 'Не стал делать — нужно твоё подтверждение.';
        this.say(spoken, settings);
        return { kind: 'refused', spoken, decision };
      }
    }

    // 5. Ask rather than guess when the words carried almost nothing.
    const clarification = clarificationFor(decision);
    if (clarification) {
      this.say(clarification, settings);
      return { kind: 'clarify', spoken: clarification, decision };
    }

    // 6. Only the context this request actually touches.
    const context = [
      ...this.options.memory.selectRelevant(utterance, 4),
      ...selectWorldStateLines(this.options.world.snapshot(), {
        needsWorldState: decision.needsWorldState,
        limit: 5,
      }),
    ];

    const resumable =
      decision.intent === 'continue' ? this.options.tasks.resumableTask() : null;

    const request: BackendRequest = {
      utterance,
      goal: normalized.goal,
      constraints: normalized.constraints,
      acceptanceCriteria: normalized.acceptanceCriteria,
      cwd: decision.projectPath ?? this.options.world.snapshot().currentProjectPath,
      project: decision.project,
      context,
      capabilities: decision.needs,
      risk,
      permissions: normalized.permissions,
      sessionId: resumable?.sessionId,
      language: 'ru',
    };

    const preference: BackendPreference = toBackendPreference(decision, {
      codingPreference: settings.codingPreference,
      mainPreference: settings.mainPreference,
    });

    // 7. Start the task, and answer immediately — the acknowledgement is
    //    produced from the routing decision, before any model has run.
    const task = this.options.tasks.start({
      title: taskTitle(decision, utterance),
      request,
      preference,
    });
    this.trackCompletion(task, settings);

    const spoken = acknowledgementFor(decision);
    this.say(spoken, settings);

    return { kind: 'task', spoken, decision, task, normalized };
  }

  private say(text: string, settings: JarvisSettings): void {
    if (!settings.speakResponses || !text) return;
    this.options.speak?.(text);
  }

  /** Records the outcome and speaks a short summary once a task finishes. */
  private trackCompletion(task: JarvisTask, settings: JarvisSettings): void {
    const unsubscribe = this.options.tasks.subscribe((event) => {
      if (event.type !== 'task-finished' || event.task.id !== task.id) return;
      unsubscribe();
      void this.finishTask(event.task, settings);
    });
  }

  private async finishTask(task: JarvisTask, settings: JarvisSettings): Promise<void> {
    const result = task.result;
    if (!result) return;

    this.options.world.noteResult({
      text: result.text,
      ok: result.ok,
      backend: result.backend,
    });
    for (const change of result.filesChanged) {
      this.options.world.noteFile(change.path);
    }

    await this.options.memory.recordTask({
      id: task.id,
      utterance: task.request.utterance,
      outcome: summarizeOutcome(result),
      ok: result.ok,
      backend: result.backend,
      project: task.request.project,
      sessionId: result.sessionId,
    });

    if (task.state === 'cancelled') return;

    const spoken = result.ok
      ? toSpokenResponse(result.text).spoken
      : spokenFailure(result.error);
    this.say(spoken, settings);
  }
}

function summarizeOutcome(result: BackendResult): string {
  if (!result.ok) return result.error ?? 'ошибка';
  const parts: string[] = [];
  if (result.filesChanged.length > 0) parts.push(`файлов: ${result.filesChanged.length}`);
  if (result.commands.length > 0) parts.push(`команд: ${result.commands.length}`);
  const firstLine = result.text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'готово';
  return parts.length > 0 ? `${firstLine} (${parts.join(', ')})` : firstLine;
}
