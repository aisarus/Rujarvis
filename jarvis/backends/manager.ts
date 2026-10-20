/**
 * BackendManager — the single place that decides which backend does the work.
 *
 * Jarvis core asks for capabilities; the manager turns that into an ordered
 * list of candidates and runs them until one of them actually gets to do the
 * job. A backend that is missing, unauthenticated or out of quota costs the
 * user a sentence of explanation, never a dead end.
 *
 *      Jarvis Core → BackendManager → { ClaudeCode | Codex | Gemini | … }
 */

import { randomUUID } from 'node:crypto';
import type { JarvisCapability } from '../types';
import { tr } from '../locale/language';
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

/**
 * Работа с машиной: экран, мышь, окна, файлы, браузер, 3D.
 *
 * Раньше всё это уходило в рантайм Workstation. Так больше нельзя: инструменты
 * рабочего стола — снимок экрана, клик, браузер, Blender, папка для готовых
 * файлов — живут в MCP-сервере, который отвечает только Claude Code, и там же
 * лежат скиллы под каждую программу. Рантайм ни того ни другого не видит,
 * поэтому задача «сделай модель в блендере», попав к нему, была обречена ещё
 * до того, как началась.
 *
 * Рантайм остаётся следующим в очереди: он умеет то, чего нет у Claude Code, и
 * подхватит работу, если тот не установлен или исчерпал лимит.
 */
const SCREEN_CAPABILITIES: readonly JarvisCapability[] = [
  'computer',
  'browser',
  'vision',
  'files',
  'system',
];

/**
 * Мессенджеры и почта — наоборот.
 *
 * У рантайма для них настоящие интеграции с живыми учётными записями, а у
 * агента только мышь и клавиатура. Здесь порядок обратный.
 */
const COMMUNICATION_CAPABILITIES: readonly JarvisCapability[] = ['communication'];

function needsScreen(capabilities: readonly JarvisCapability[]): boolean {
  return SCREEN_CAPABILITIES.some((capability) => capabilities.includes(capability));
}

function needsCommunication(capabilities: readonly JarvisCapability[]): boolean {
  return COMMUNICATION_CAPABILITIES.some((capability) => capabilities.includes(capability));
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
  /**
   * Почему работать некому — словами, по которым понятно, что чинить.
   *
   * «Проверьте настройки AI-аккаунтов» на всё подряд отправляло чинить не
   * туда: у человека с одним Кодексом настройки В ПОРЯДКЕ, а экран ему
   * недоступен потому, что инструменты рабочего стола есть только у Claude
   * Code. Он открывал настройки, видел зелёный Кодекс и не понимал ничего.
   */
  /** Есть ли у этого агента руки прямо сейчас. */
  private умеетЭкран(id: BackendId): boolean {
    return this.backends.get(id)?.capabilities.has('computer') === true;
  }

  /** Установлен ли агент и выполнен ли вход — то есть пользователь ли это его. */
  private async готов(id: BackendId): Promise<boolean> {
    const агент = this.backends.get(id);
    if (!агент) return false;
    try {
      return (await агент.checkAvailability()).ready;
    } catch {
      return false;
    }
  }

  /**
   * Чью подписку этот агент не подменяет.
   *
   * Codex не запасной для того, у кого есть Claude Code (решение владельца
   * 29.09.2026), а Gemini — ни для того, ни для другого: исчерпанный лимит
   * одной подписки не повод жечь чужую. Названный голосом или в настройках
   * агент работает как раньше — он во главе очереди, а не подмена.
   */
  private static readonly НЕ_ПОДМЕНЯЕТ: Partial<Record<BackendId, readonly BackendId[]>> = {
    codex: ['claude-code'],
    gemini: ['claude-code', 'codex'],
  };

  private почемуНекому(request: BackendRequest): string {
    const экран = needsScreen(request.capabilities) || needsCommunication(request.capabilities);
    if (экран && !this.backends.has('claude-code')) {
      // Codex и Gemini с рабочим столом сюда не попадут: их бы уже взяли выше.
      return this.backends.has('codex') || this.backends.has('gemini')
        ? tr(
            'С окнами работает Claude Code, а Codex и Gemini — только через сервер Джарвиса с проверкой красных линий, и сейчас его у них нет. Войдите в Claude Code или перезапустите Джарвиса.',
            'Claude Code works with windows; Codex and Gemini only through the Jarvis server with the red-line check, which they do not have right now. Sign in to Claude Code or restart Jarvis.',
          )
        : tr('Нет доступных агентов. Проверьте вкладку «Агенты» в настройках.', 'No agents available. Check the Agents tab in settings.');
    }
    return tr('Нет доступных агентов. Проверьте вкладку «Агенты» в настройках.', 'No agents available. Check the Agents tab in settings.');
  }

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
      // A named coding backend still gets the other one behind it. «Отдай
      // Кодексу» plus an exhausted Codex should reach Claude Code before
      // giving up on coding entirely — that is what the fallback is for.
      if (
        CODING_BACKEND_IDS.includes(preference.requested) ||
        needsCoding(request.capabilities)
      ) {
        for (const id of CODING_BACKEND_IDS) push(id);
      }
    } else if (needsCoding(request.capabilities)) {
      // Код проверяется раньше экрана, и это не мелочь: почти у каждой задачи
      // по коду заодно есть capability «файлы», и экранная ветка перехватывала
      // её, отменяя выбор кодового backend в настройках.
      const preferred = preference.codingPreference;
      if (preferred && preferred !== 'auto') {
        push(preferred);
        rationale = `Coding backend выбран в настройках: ${preferred}`;
      } else {
        rationale = 'Задача по коду, backend выбран автоматически';
      }
      for (const id of CODING_BACKEND_IDS) push(id);
    } else if (needsScreen(request.capabilities) || needsCommunication(request.capabilities)) {
      // Экран, программы, переписка — только Claude Code: инструменты рабочего
      // стола есть только у него. Отката на того, кому работать нечем, нет —
      // помощник, который не может сделать работу, обязан это сказать, а не
      // изображать её другим способом. Работу без мыши (файлы, браузер без
      // окна человека) может подхватить Codex.
      // Выбранный в настройках — первым, если ему есть чем это сделать.
      const preferred = preference.mainPreference;
      if (preferred && preferred !== 'auto' && (!request.capabilities.includes('computer') || this.умеетЭкран(preferred))) {
        push(preferred);
      }
      push('claude-code');
      // Кодексу и Gemini — если им есть чем. Раньше Кодекс исключался из
      // задач про экран навсегда, и это было верно, пока рук у него не было
      // вовсе. Теперь рабочий стол даётся им тем же MCP-сервером, что и Клоду,
      // и спрашивать надо не платформу, а самого агента: есть у него
      // «computer» — берём, нет — не обещаем.
      for (const id of ['codex', 'gemini'] as const) {
        if (!request.capabilities.includes('computer') || this.умеетЭкран(id)) push(id);
      }
      rationale = 'Задача про экран, файлы, программы или переписку — там, где инструменты';
    } else {
      const preferred = preference.mainPreference;
      if (preferred && preferred !== 'auto') {
        push(preferred);
        rationale = `Main backend выбран в настройках: ${preferred}`;
      } else {
        rationale = 'Обычная задача';
      }
      for (const id of CODING_BACKEND_IDS) push(id);
    }

    // Без подписки — локальная модель, чтобы Джарвис хоть отвечал. Кроме
    // настоящего управления экраном: там откат означал бы обещание, которое
    // некому выполнить.
    // Откат на модель БЕЗ РУК запрещён обоим, а не одному.
    //
    // Условие покрывало только `openai-compatible`, а `local` добавлялся
    // всегда — хотя под этим именем зарегистрирован тот же бэкенд без
    // инструментов. Когда Claude Code недоступен, «открой Chrome» уходило
    // туда, модель отвечала «у меня нет доступа к компьютеру» с `ok: true`,
    // задача закрывалась успешной, и этот текст звучал как результат работы.
    if (!request.capabilities.includes('computer')) {
      push('openai-compatible');
      push('local');
    }

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

    const fallbackBackend: BackendId = plan.order[0] ?? 'claude-code';

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
          error: this.почемуНекому(request),
        });
        return;
      }

      const failures: string[] = [];

      for (const [номер, id] of plan.order.entries()) {
        if (cancelled) break;
        const backend = this.backends.get(id);
        if (!backend) continue;

        // Запасной — только тому, у кого нет своей подписки (см. НЕ_ПОДМЕНЯЕТ):
        // у пользователя Codex он заменяет Claude Code целиком, у пользователя
        // Claude — только Claude.
        const чьиНеПодменяет = BackendManager.НЕ_ПОДМЕНЯЕТ[id] ?? [];
        if (чьиНеПодменяет.length > 0 && номер > 0 && failures.length > 0) {
          let хозяин: BackendId | undefined;
          for (const другой of чьиНеПодменяет) {
            if (await this.готов(другой)) {
              хозяин = другой;
              break;
            }
          }
          // Проба доступности — до десяти секунд, и «стоп» за это время не
          // должен пропустить запуск следующего (ревью 29.09.2026).
          if (cancelled) break;
          if (хозяин) {
            failures.push(`${backend.name} не подменяет ${this.backends.get(хозяин)?.name ?? хозяин}, когда тот есть`);
            continue;
          }
        }

        if (failures.length > 0) {
          channel.push({
            type: 'status',
            backend: id,
            text: `Переключаюсь на ${backend.name}`,
          });
        }

        // Чужую сессию не поднять — этому бэкенду та же просьба без неё.
        const безЧужой =
          request.sessionId && request.sessionBackend && request.sessionBackend !== id
            ? { ...request, sessionId: undefined, sessionBackend: undefined }
            : request;
        // Названный агент не смог — следующему это сказано прямо. Иначе
        // «сделай это через Codex» он понимал буквально и минуту пытался сам
        // запустить Codex из оболочки (живая проверка 30.09.2026).
        const названный = preference.requested;
        const своя =
          названный && названный !== id && failures.length > 0
            ? {
                ...безЧужой,
                context: [
                  ...(безЧужой.context ?? []),
                  `Человек просил ${this.backends.get(названный)?.name ?? названный}, но он не смог (${failures.at(-1)}). ` +
                    `Сделай работу сам; запускать ${this.backends.get(названный)?.name ?? названный} не пытайся.`,
                ],
              }
            : безЧужой;

        let run: BackendRun;
        try {
          run = backend.run(своя);
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
      // Сессию знает тот запуск, что идёт сейчас: после перехода на другой
      // бэкенд — его, а не первого.
      sessionId: () => active?.sessionId?.(),
    };
  }
}
