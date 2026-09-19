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
import { BACKEND_IDS } from './backends/types';
import type {
  BackendId,
  BackendRequest,
  BackendResult,
} from './backends/types';
import { WorldStateStore, selectWorldStateLines } from './context/worldState';
import { JarvisMemory, type TaskMemory } from './memory/store';

/**
 * Сколько задача остаётся «той самой».
 *
 * Пять минут — столько человек помнит, чем только что занимался, и столько
 * фраза вроде «поменяй цвет» ещё относится к сделанному.
 */
const CONTINUATION_WINDOW_MS = 5 * 60_000;

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
import {
  continuesConversation,
  openConversation,
  type OpenConversation,
} from './dialogue/conversation';
import { acknowledgementFor, clarificationFor } from './voice/acknowledgement';
import { isPleasantry } from './voice/noise';
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
  /** Папка, куда складывать готовые файлы. Показывается агенту в запросе. */
  outputDir?: string;
  /**
   * Что Джарвис делал в последнее время — свежее дословно, старое сводкой.
   *
   * Пассивная память, в отличие от `memory`: та хранит выводы, которые агент
   * записал сам, а эта — события, случившиеся без его участия. Без неё «а где
   * он?» и «переделай» повисают в пустоте.
   */
  recentActions?(): string[];
  /**
   * Постоянные указания человека — его собственный системный промпт.
   *
   * Функцией, а не строкой: файл читается на каждую задачу, поэтому правка
   * действует сразу, без перезапуска.
   */
  instructions?(): string | undefined;
  /**
   * На чём уже спотыкались. Функцией по той же причине, что и указания:
   * собирается из журнала на каждую задачу, поэтому свежая неудача учитывается
   * в следующей же.
   */
  lessons?(): string | undefined;
  /** Работать на виду или в фоне. Человек переключает это голосом. */
  showWork?(): boolean;
  now?: () => number;
}

export type JarvisTurn =
  | { kind: 'control'; outcome: ControlOutcome; spoken: string }
  | { kind: 'clarify'; spoken: string; decision: RoutingDecision }
  | { kind: 'chat'; spoken: string }
  | { kind: 'refused'; spoken: string; decision: RoutingDecision }
  | {
      kind: 'task';
      spoken: string;
      decision: RoutingDecision;
      task: JarvisTask;
      normalized: NormalizedTask;
    };

/**
 * Продолжение разговора идёт к тому, у кого лежит сессия.
 *
 * Иначе получается бессмыслица: сессия со сферой у Claude Code, а «сделай её
 * зелёной» сама по себе маршрутизируется в интерпретатор — и продолжать там
 * нечего. Бэкенд записан вместе с сессией; если в памяти оказалось незнакомое
 * имя, решение остаётся как было.
 */
function withConversationBackend(
  decision: RoutingDecision,
  conversation: OpenConversation,
): RoutingDecision {
  const backend = BACKEND_IDS.find((id) => id === conversation.backend);
  if (!backend) return decision;
  return { ...decision, target: backend, requestedBackend: backend };
}

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

  /** Идёт ли сейчас разговор: голосовому слою это нужно, чтобы не глушить его. */
  hasOpenConversation(): boolean {
    return openConversation(this.options.memory.lastTask(), this.now()) !== null;
  }

  /**
   * Задача, которую человек, скорее всего, имеет в виду.
   *
   * Только свежая: через час «поменяй цвет» относится уже к чему-то другому, и
   * цепляться за вчерашнее хуже, чем переспросить.
   */
  private recentTask(): TaskMemory | null {
    const last = this.options.memory.lastTask();
    if (!last) return null;
    return this.now() - last.finishedAt <= CONTINUATION_WINDOW_MS ? last : null;
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
    let approvedByHuman = false;
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
      approvedByHuman = true;
    }

    // 5. Вежливость — не поручение.
    //
    // Без этой проверки «спасибо» после сделанной сферы уходило в шаг 6: там
    // маршрут пересчитывался по обеим фразам сразу, «Создай в блендере
    // красную сферу. Спасибо» получало высокую уверенность — и Джарвис делал
    // вторую сферу в ответ на благодарность.
    if (isPleasantry(utterance)) {
      const spoken = 'Пожалуйста.';
      this.say(spoken, settings);
      return { kind: 'chat', spoken };
    }

    // 6. Фраза, опирающаяся на сказанное раньше.
    //
    // «Поменяй цвет сферы на зелёный» само по себе не значит ничего: ни одной
    // capability, уверенность 0.35, и ассистент честно отвечал «не понял». Но
    // после «создай в блендере красную сферу» оно значит всё.
    //
    // Поэтому маршрут пересчитывается по обеим фразам сразу, а агенту
    // передаётся его же прошлая сессия — там он помнит, какую сферу сделал, и
    // объяснять ему это заново не нужно.
    const conversation = openConversation(this.options.memory.lastTask(), this.now());
    const continuesTalk = continuesConversation(utterance, decision, conversation);

    let clarification = clarificationFor(decision);
    let continuing: TaskMemory | null = null;

    if (clarification || continuesTalk) {
      const recent = this.recentTask();
      if (recent) {
        continuing = recent;
        decision = route(`${recent.utterance}. ${utterance}`, {
          basePermissions: settings.basePermissions,
          context: {
            knownProjects: this.options.memory.knownProjects(),
            currentProject: this.options.world.snapshot().currentProject,
            hasRunningTask: this.options.tasks.active().length > 0,
            codingPreference: settings.codingPreference,
            mainPreference: settings.mainPreference,
          },
        });
        clarification = clarificationFor(decision);
      }
    }

    // Пока разговор открыт, переспрашивать некого.
    //
    // Непонятную фразу понимает не человек, а тот, кто эту работу делал: у
    // него в сессии лежит всё, что уже было сказано. Спрашивать «уточни?» в
    // разговоре — то же самое, что переспрашивать собеседника на каждой
    // второй реплике.
    if (continuesTalk && conversation) {
      clarification = null;
      decision = withConversationBackend(decision, conversation);
    }

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
      ...(this.options.recentActions?.() ?? []),
      ...(continuing ? [`Это продолжение: «${continuing.utterance}» — ${continuing.outcome}`] : []),
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
      // Та же сессия агента: продолжая свою работу, он помнит её без пересказа.
      sessionId: resumable?.sessionId ?? continuing?.sessionId ?? conversation?.sessionId,
      language: 'ru',
      outputDir: this.options.outputDir,
      instructions: this.options.instructions?.(),
      lessons: this.options.lessons?.(),
      showWork: this.options.showWork?.() ?? true,
      // Согласие человека едет с задачей: иначе бэкенд запустится в режиме, где
      // каждая запись отклоняется, и согласие не купит ничего.
      approved: approvedByHuman,
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
