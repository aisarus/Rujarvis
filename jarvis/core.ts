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
  /**
   * Обрывает речь на полуслове.
   *
   * Отдельно от `speak`, и это не мелочь: заглушение раньше вызывало
   * `speak('')`, а `speak` на пустой строке сразу выходит, ничего не
   * остановив. Команда «тишина» срабатывала и не делала ровно ничего —
   * человек просил замолчать, и его не слушались.
   *
   * Замолчать — красная линия. Оно обязано работать всегда и мгновенно.
   */
  stopSpeaking?(): void;
  /**
   * Сказать, чем Джарвис сейчас занят.
   *
   * Нужно ровно для одного: человек попросил видеть с одного взгляда, поняли
   * его как разговор или как поручение. Жёлтый — разговор.
   */
  showIndicator?(what: 'chatting'): void;
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
  /**
   * Чем занята работа прямо сейчас: план и последние действия.
   *
   * Нужно ровно для одного случая, и он оказался самым больным. Человек
   * спрашивает во время работы — «ты понял что надо делать?», «что ты сейчас
   * делаешь?» — и ответить на это можно только зная, что идёт. Состояния мира
   * для этого мало: план живёт в отдельном файле, который пишет другой процесс.
   */
  workNow?(): string[];
  /** Работать на виду или в фоне. Человек переключает это голосом. */
  showWork?(): boolean;
  now?: () => number;
}

/**
 * Разговор ли это, а не поручение.
 *
 * Два признака разом, и оба нужны. Намерение «разговор» — потому что роутер
 * уже отличил вопрос от приказа. Ни одного умения — потому что «что у меня в
 * папке загрузки» тоже вопрос, но ответить на него без доступа к файлам
 * нельзя, и такое обязано остаться работой.
 */
export function isTalk(decision: RoutingDecision): boolean {
  // «Размышление» не требует ничего: ни экрана, ни файлов, ни сети.
  //
  // «Память» — тоже разговор, и это не послабление. «А почему не получилось?»
  // и «это правильно?» опираются на только что сказанное и сделанное, а оно
  // уже лежит в состоянии мира: предыдущая реплика, предыдущий результат,
  // недавние окна. Чтобы ответить, не нужен ни агент, ни инструменты — нужны
  // шесть строк в запросе. Без этого любой вопрос с «это» становился работой,
  // и человек получал двадцать секунд вместо ответа.
  //
  // Всё остальное — требует доступа, и тогда это работа, даже если прозвучало
  // вопросом.
  return (
    decision.intent === 'chat' &&
    decision.needs.every((need) => need === 'reasoning' || need === 'memory')
  );
}

/** Дольше этого человек уже не ждёт ответа на простой вопрос. */
const CHAT_TIMEOUT_MS = 60_000;

/** Чем подписан ответ в разговоре, если бэкенд не назвался. */
const BACKEND_OF_TALK = 'разговор';

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
        stopSpeaking: () => this.options.stopSpeaking?.(),
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

    // Вопрос — не непонятный приказ.
    //
    // Уточнение вешается на низкую уверенность разбора, а у вопроса она низкая
    // всегда: «кто написал войну и мир» не набирает ни одного умения, потому
    // что делать ничего и не надо. Через всё ядро это давало «Не понял, что
    // именно сделать. Уточни?» — на вопрос о книге.
    //
    // Человек назвал это прямо: «он не понимает концепцию вопроса и не может
    // на него по факту отвечать». Переспрашивать в ответ на вопрос — худшее из
    // возможного: спрашивал-то он.
    if (decision.asks && isTalk(decision)) clarification = null;

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

    // 6.5. Вопрос и разговор — это ответ словами, а не работа.
    //
    // Человек сказал прямо: «он не понимает концепцию вопросов и не может на
    // них по факту отвечать». Так и было: намерение «разговор» доходило сюда и
    // превращалось в задачу с агентом и инструментами. «Кто написал войну и
    // мир» стоило двадцати секунд, окна работы и записи в план.
    //
    // Здесь такая фраза уходит отдельным коротким путём: ни инструментов, ни
    // плана, ни окна — только ответ вслух. Задача при этом не заводится, и
    // индикатор жёлтый, чтобы человек с одного взгляда видел, что его поняли
    // как разговор.
    if (isTalk(decision)) {
      const spoken = await this.answerAloud(utterance, settings, decision.needs.includes('memory'));
      return { kind: 'chat', spoken };
    }

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

  /**
   * Ответить словами и ничего не делать.
   *
   * Запрос нарочно голый: ни инструментов, ни рабочей папки, ни задачи. Вопрос
   * «сколько будет двести на триста» не требует доступа к экрану, а всё лишнее
   * в запросе — это лишние секунды ожидания у человека, который просто спросил.
   *
   * Исключение одно: вопрос, опирающийся на только что случившееся. «А почему
   * не получилось?» без контекста — это уверенный ответ ни о чём, что хуже
   * молчания. Такому вопросу даётся состояние мира — предыдущая реплика,
   * предыдущий результат, недавние окна, — и по-прежнему ни одного
   * инструмента: несколько строк в запросе, а не работа агента.
   *
   * Отказ не роняет разговор: человек услышит честное «не знаю», а не тишину.
   */
  /**
   * Ответить на вопрос словами и ничего не делать.
   *
   * Отдельный вход, а не `handleUtterance`, и это важно. Пока идёт работа,
   * голосовой мост перехватывает речь раньше ядра: всё сказанное ложится в
   * ящик поправок с ответом «Учту». Для поправки это верно, для вопроса — нет.
   * Человек спросил «ты понял что надо делать?» и получил «Учту» и тишину.
   *
   * Через `handleUtterance` вести сюда нельзя: там вопрос сольётся с идущей
   * задачей как продолжение разговора и снова станет работой.
   */
  async answerQuestion(utterance: string): Promise<string> {
    this.options.world.noteUtterance(utterance);
    return this.answerAloud(utterance, this.options.settings(), true);
  }

  private async answerAloud(
    utterance: string,
    settings: JarvisSettings,
    needsContext = false,
  ): Promise<string> {
    this.options.showIndicator?.('chatting');

    // Чем занята работа — всегда, когда есть. Вопрос, заданный во время
    // работы, почти всегда про неё: «ты понял что надо делать?» без плана
    // перед глазами превращается в уверенный ответ ни о чём.
    const working = this.options.workNow?.() ?? [];
    const context = [
      ...working,
      ...(needsContext
        ? selectWorldStateLines(this.options.world.snapshot(), {
            needsWorldState: true,
            limit: 6,
          })
        : []),
    ];
    const asked =
      context.length > 0
        ? `${context.join('\n')}\n\nВопрос: ${utterance}`
        : utterance;

    const run = this.options.backends.run(
      {
        utterance: asked,
        capabilities: ['reasoning'],
        risk: 'safe',
        permissions: { read: false, edit: false, execute: false, network: false },
        language: 'ru',
        timeoutMs: CHAT_TIMEOUT_MS,
      },
      {},
    );

    let spoken: string;
    let backend = BACKEND_OF_TALK;
    try {
      const result = await run.result();
      spoken = result.ok && result.text.trim() ? result.text.trim() : 'Не знаю.';
      backend = result.backend || BACKEND_OF_TALK;
    } catch {
      spoken = 'Не смог ответить.';
    }

    const short = toSpokenResponse(spoken, { fallback: 'Не знаю.' }).spoken;

    // Разговор обязан помнить свой же ответ.
    //
    // Записывался только итог ЗАДАЧИ, а сказанное в разговоре — нет. Поэтому
    // «кто написал войну и мир» получало ответ, а следующее «а сколько ему
    // было лет» спрашивать было не о ком: в состоянии мира лежал вопрос и
    // ничего больше. Это и есть «нет нормального режима разговора» — реплики
    // не складывались в разговор.
    this.options.world.noteResult({ text: short, ok: true, backend });

    this.say(short, settings);
    return short;
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
