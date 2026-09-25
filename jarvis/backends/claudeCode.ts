/**
 * Claude Code backend.
 *
 * Jarvis holds no Anthropic API key, never reads Claude's OAuth tokens and
 * does not re-implement the agent. It runs the official `claude` CLI in
 * headless mode and consumes its stream-json output. The user signs in the
 * normal Claude Code way; Jarvis only checks that the CLI is installed,
 * authenticated and reachable.
 */

import type { AuthState } from './authHints';
import type { JarvisCapability } from '../types';
import { buildBackendPrompt, buildFollowUpPrompt } from './prompt';
import { looksUsageLimited } from './process';
import {
  createCliRun,
  createStreamState,
  type SpawnCli,
  type StreamState,
  SILENCE_LIMIT_MS,
  WORK_CEILING_MS,
} from './cliRunner';
import { LiveSession, type SessionKey } from './liveSession';
import type { SessionPool } from './sessionPool';
import { agentEnv } from './subscriptionEnv';
import {
  unavailable,
  type AgentBackend,
  type BackendAvailability,
  type BackendEvent,
  type BackendFileChange,
  type BackendRequest,
  type BackendRun,
} from './types';

const BACKEND_ID = 'claude-code' as const;

const AUTH_UNKNOWN_REASON =
  // Отказ говорится ВСЛУХ, и человек на том конце может не знать слов
  // «CLI», «аккаунт» и «Claude Code» вовсе. Поэтому просьба обращена не к
  // нему, а к тому, кто ставил, — и названа простыми словами.
  'Похоже, я не могу связаться с тем, кто выполняет работу. Попросите того, кто меня ставил, открыть программу Claude и войти.';

const CAPABILITIES: ReadonlySet<JarvisCapability> = new Set<JarvisCapability>([
  'reasoning',
  'coding',
  'files',
  'shell',
  'web',
]);

/** The Claude Code permission modes Jarvis is willing to select. */
export type ClaudePermissionMode = 'plan' | 'acceptEdits' | 'default' | 'bypassPermissions';

/**
 * What the adapter needs from the host.
 *
 * The Workstation already knows how to locate and probe the CLI (see
 * `server/handlers/providers.ts`), so the production wiring delegates there
 * rather than duplicating the path search.
 */
export interface ClaudeCliProbe {
  status(): Promise<{
    installed: boolean;
    /** `'unknown'` means "no proof either way" — see `authHints.ts`. */
    loggedIn: AuthState;
    version?: string;
    path?: string;
    error?: string;
  }>;
}

export interface ClaudeCodeBackendOptions {
  probe: ClaudeCliProbe;
  /** Model override, e.g. "opus". Omitted means the CLI's own default. */
  model?: string;
  /**
   * Permits `--permission-mode bypassPermissions`. Off by default and never
   * derived from model output: only an explicit user setting turns it on.
   */
  allowBypassPermissions?: boolean;
  /** Enables computer use by handing the agent the desktop MCP server. */
  desktopMcpConfig?: string;
  /**
   * Настройки Claude Code с хуком красных линий (`risk/gateHook.ts`).
   *
   * Без него агент не получает инструментов, которыми красную линию можно
   * перейти молча: оболочки, записи навыков и своей папки на запись.
   */
  gateSettings?: string;
  /**
   * Папка, в которой Джарвис живёт.
   *
   * Даётся агенту на чтение всегда, чтобы он знал о себе: свой код, свои
   * настройки, свой журнал, свои навыки.
   */
  homeDir?: string;
  defaultTimeoutMs?: number;
  availabilityTtlMs?: number;
  spawnCli?: SpawnCli;
  /**
   * Склад живых сессий. Без него каждая реплика поднимает новый процесс.
   *
   * Необязателен нарочно: проверки подставляют свой запуск процесса и живых
   * сессий не хотят.
   */
  sessions?: SessionPool;
  now?: () => number;
}

/**
 * Maps the task's permission envelope onto a CLI permission mode.
 *
 * Deterministic policy: the mode is decided before the model starts, so no
 * amount of model text can widen it.
 */
export function selectPermissionMode(
  request: BackendRequest,
  allowBypass: boolean,
): ClaudePermissionMode {
  if (!request.permissions.edit) {
    // Plan mode investigates and reports without modifying anything.
    return 'plan';
  }
  if (allowBypass && request.risk === 'safe') {
    return 'bypassPermissions';
  }
  if (request.risk === 'safe' || request.risk === 'normal') {
    return 'acceptEdits';
  }

  // Человек уже сказал «да» — значит работу надо делать, а не спрашивать снова.
  //
  // Режим `default` в безголовом запуске не спрашивает: спрашивать некого. Он
  // молча отклоняет каждую запись, и задача идёт до конца, тратит время и не
  // оставляет ничего. Подтверждение, которое ничего не разрешает, — не
  // осторожность, а театр.
  //
  // Спрашивает Джарвис сам и голосом (`core.ts`, шаг 4), и спрашивает ДО
  // запуска. Второй раз спрашивать некому и незачем.
  if (request.approved === true) {
    return 'acceptEdits';
  }

  // Без подтверждения опасное остаётся спрашивающим — и в безголовом запуске
  // это означает отказ. Так и задумано: несогласованную опасную работу лучше не
  // сделать, чем сделать.
  return 'default';
}

export function buildClaudeArgs(
  request: BackendRequest,
  options: {
    model?: string;
    permissionMode: ClaudePermissionMode;
    /** Path to the MCP config that gives the agent the screen and the mouse. */
    desktopMcpConfig?: string;
    /** Папка, в которой Джарвис живёт: его код, настройки, журнал, навыки. */
    homeDir?: string;
    /** Настройки с хуком красных линий. */
    gateSettings?: string;
  },
): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-mode', options.permissionMode);
  if (options.model) {
    args.push('--model', options.model);
  }
  if (request.sessionId) {
    args.push('--resume', request.sessionId);
  }
  args.push(...gateArgs(options.gateSettings));

  // Собственная папка — в любой работе, если стоит хук красных линий.
  //
  // Человек попросил прямо: «дай ему права свободно читать собственную папку,
  // чтоб он всё знал о себе». Без этого агент заперт в папке задачи, и на
  // вопросы вроде «почему ты так ответил», «что у тебя в настройках», «какие у
  // тебя навыки» он может только гадать — притом что ответ лежит на диске в
  // двух шагах.
  //
  // Это доступ на чтение к своему же коду и своим же данным, а не к чужим
  // файлам: папка одна и известна заранее.
  //
  // В режиме acceptEdits добавленная папка доступна и на запись, поэтому
  // даётся только вместе с хуком: он спрашивает человека о правке там.
  args.push(...homeArgs(options.homeDir, request.cwd, options.gateSettings));

  // Passed per run rather than registered once for the whole machine. A tool
  // that moves the mouse and types should reach the assistant's own agent, not
  // every Claude Code session the user opens for unrelated work — and the
  // narrower grant is also the one worth asking for.
  if (options.desktopMcpConfig && needsDesktopTools(request.capabilities)) {
    args.push('--mcp-config', options.desktopMcpConfig);
    // Только наш сервер, и ничей больше.
    //
    // Без этого к каждой задаче добавляются MCP-серверы из глобальных
    // настроек человека. У него там два мёртвых: obsidian отказывает в
    // соединении, colab-mcp ждёт таймаута тридцать секунд. Эта плата берётся
    // с каждой задачи, и голосовой помощник от неё перестаёт быть быстрым.
    args.push('--strict-mcp-config');
    // Headless Claude Code withholds the web tools and anything that runs
    // commands unless they are named. Naming them is the difference between an
    // agent that can look something up mid-task and one that can only guess.
    args.push('--allowedTools', toolsFor(request.capabilities, Boolean(options.gateSettings)).join(','));
  }
  return args;
}

function gateArgs(gateSettings: string | undefined): string[] {
  return gateSettings ? ['--settings', gateSettings] : [];
}

function homeArgs(homeDir: string | undefined, cwd: string | undefined, gateSettings: string | undefined): string[] {
  if (!homeDir || !gateSettings || sameFolder(homeDir, cwd)) return [];
  return ['--add-dir', homeDir];
}

/**
 * Одна ли это папка.
 *
 * Рабочая папка задачи часто и есть папка Джарвиса — тогда называть её второй
 * раз незачем. Windows не различает регистр и пишет пути обоими видами косой
 * черты, поэтому сравнение не строковое.
 */
function sameFolder(a: string, b: string | undefined): boolean {
  if (!b) return false;
  const norm = (value: string): string =>
    value.split(/[\\/]+/u).filter(Boolean).join('/').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Когда агенту нужны инструменты рабочего стола.
 *
 * Условие было «capability computer», и это оказалось слишком узко до
 * бесполезности. «Нарисуй картинку» роутер относит к `vision`, «положи файл в
 * папку» — к `files`, задача про Blender — к `computer` только если в ней
 * прозвучало слово вроде «открой». Во всех остальных случаях агент получал
 * ноль инструментов рабочего стола и честно не мог сделать ровно то, о чём его
 * попросили: ни файл положить, ни сцену собрать.
 */
function needsDesktopTools(capabilities: readonly JarvisCapability[]): boolean {
  return DESKTOP_CAPABILITIES.some((capability) => capabilities.includes(capability));
}

const DESKTOP_CAPABILITIES: readonly JarvisCapability[] = [
  'computer',
  'vision',
  'browser',
  'files',
  'system',
];

/**
 * What the agent may use while working on the screen.
 *
 * The desktop tools, the web, and the ordinary file and shell tools it needs to
 * finish a job it started — a task that begins with a click often ends with a
 * file.
 */
/**
 * Инструменты — по делу задачи, а не все сразу.
 *
 * Список из пятидесяти трёх имён стоил дважды. Во-первых, Клод Код при таком
 * числе подгружает инструменты лениво, и агент тратил три круга `ToolSearch`
 * посреди работы. Во-вторых, лишний инструмент — это ловушка: на просьбе
 * выбрать вкладку в Edge агент семнадцать секунд возился с `browser_tabs`,
 * который управляет НАШИМ браузером Playwright, а не окном человека.
 *
 * Замер 20.09.2026, «выбери вторую вкладку»: 103 секунды, из них семь снимков
 * экрана, три захода `ToolSearch` и семнадцать секунд не в то окно.
 */

/** Всегда: память, план, правки на ходу, файлы результата. */
const ALWAYS = [
  'mcp__jarvis-desktop__recall',
  'mcp__jarvis-desktop__remember',
  'mcp__jarvis-desktop__forget',
  'mcp__jarvis-desktop__check_notes',
  'mcp__jarvis-desktop__set_plan',
  'mcp__jarvis-desktop__mark_step',
  'mcp__jarvis-desktop__show_plan',
  'mcp__jarvis-desktop__recent_actions',
  'mcp__jarvis-desktop__output_folder',
  'mcp__jarvis-desktop__move_to_output',
  'mcp__jarvis-desktop__show_file',
  'mcp__jarvis-desktop__list_files',
  'mcp__jarvis-desktop__tidy_folder',
  'mcp__jarvis-desktop__list_skills',
  'mcp__jarvis-desktop__write_skill',
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite',
  // Поиск в вебе — всегда: посреди работы на экране может понадобиться
  // посмотреть, как называется нужная кнопка или что значит ошибка.
  'WebSearch', 'WebFetch',
  // Blender тоже всегда: «нарисуй» и «положи файл» приходят без capability
  // computer, а сделать сцену без этих трёх инструментов нечем.
  'mcp__jarvis-desktop__blender_live_start',
  'mcp__jarvis-desktop__blender_live',
  'mcp__jarvis-desktop__krita_live_start',
  'mcp__jarvis-desktop__krita_live',
  'mcp__jarvis-desktop__draw_image',
  'mcp__jarvis-desktop__animate_sequence',
  'mcp__jarvis-desktop__blender_python',
];

/** Чужое окно: смотреть, искать по имени, нажимать по номеру. */
const WINDOW_TOOLS = [
  'mcp__jarvis-desktop__window_list',
  'mcp__jarvis-desktop__window_look',
  'mcp__jarvis-desktop__window_find',
  'mcp__jarvis-desktop__window_press',
  'mcp__jarvis-desktop__window_write',
  'mcp__jarvis-desktop__window_key',
  'mcp__jarvis-desktop__focus_window',
  'mcp__jarvis-desktop__list_windows',
  'mcp__jarvis-desktop__screenshot',
  'mcp__jarvis-desktop__click',
  'mcp__jarvis-desktop__type_text',
  'mcp__jarvis-desktop__press_key',
  'mcp__jarvis-desktop__scroll',
];

/** Наш собственный браузер. Не путать с окном человека. */
const BROWSER_TOOLS = [
  'mcp__jarvis-desktop__browser_open',
  'mcp__jarvis-desktop__browser_read',
  'mcp__jarvis-desktop__browser_click',
  'mcp__jarvis-desktop__browser_fill',
  'mcp__jarvis-desktop__browser_key',
  'mcp__jarvis-desktop__browser_tabs',
  'mcp__jarvis-desktop__browser_controls',
  'mcp__jarvis-desktop__browser_download',
  'mcp__jarvis-desktop__browser_wait_for',
  'mcp__jarvis-desktop__page_ride',
  'mcp__jarvis-desktop__page_depth',
];

/**
 * Инструменты, которыми красную линию можно перейти, не назвав её: оболочка
 * выполняет что угодно, навык ложится во все сессии Claude Code человека.
 * Без хука красных линий (`risk/gateHook.ts`) они не выдаются.
 */
const UNGATED_FORBIDDEN = new Set(['Bash', 'mcp__jarvis-desktop__write_skill']);

/** Что агенту дать под эту задачу. */
export function toolsFor(capabilities: readonly JarvisCapability[], gated = true): string[] {
  const wanted = new Set(ALWAYS);
  const has = (name: JarvisCapability): boolean => capabilities.includes(name);

  if (has('computer') || has('vision')) for (const t of WINDOW_TOOLS) wanted.add(t);
  if (has('browser')) for (const t of BROWSER_TOOLS) wanted.add(t);
  if (has('coding')) wanted.add('MultiEdit').add('NotebookEdit');
  // Ни одного признака — значит разговор; хватает памяти и чтения.
  if (wanted.size === ALWAYS.length) for (const t of WINDOW_TOOLS) wanted.add(t);

  return [...wanted].filter((tool) => gated || !UNGATED_FORBIDDEN.has(tool));
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/**
 * Paths belonging to the CLI's own state rather than to the user's work.
 *
 * Plan mode writes its plan into `~/.claude/plans/…`. Reporting that as a
 * file change made a run the user had explicitly asked not to change anything
 * announce "Создан файл" — technically true, and exactly the wrong thing to
 * tell someone who said «ничего не меняй».
 */
const VENDOR_STATE_SEGMENTS = ['/.claude/', '\\.claude\\', '/.codex/', '\\.codex\\'];

export function isVendorInternalPath(filePath: string): boolean {
  return VENDOR_STATE_SEGMENTS.some((segment) => filePath.includes(segment));
}

function describeToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'command', 'pattern', 'url', 'description'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

/**
 * Translates one stream-json line into Jarvis events.
 *
 * Exported for tests: the stream shape is the part most likely to drift with a
 * CLI upgrade, so it is covered directly instead of only through a spawn.
 */
export function consumeClaudeStreamLine(
  raw: Record<string, unknown>,
  state: StreamState,
  emit: (event: BackendEvent) => void,
): void {
  const type = typeof raw.type === 'string' ? raw.type : '';
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (sessionId) state.sessionId = sessionId;

  if (type === 'system') {
    if (raw.subtype === 'init') {
      emit({ type: 'status', backend: BACKEND_ID, text: 'Claude Code запущен' });
    }
    return;
  }

  if (type === 'assistant') {
    const message = raw.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const blockRaw of content) {
      if (!blockRaw || typeof blockRaw !== 'object') continue;
      const block = blockRaw as Record<string, unknown>;

      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        state.text = block.text;
        emit({ type: 'assistant-text', backend: BACKEND_ID, text: block.text });
        continue;
      }

      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = (block.input as Record<string, unknown> | undefined) ?? {};
        const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;

        // The CLI's own bookkeeping is not work the user asked for.
        if (filePath && isVendorInternalPath(filePath)) continue;

        emit({
          type: 'tool',
          backend: BACKEND_ID,
          name: block.name,
          detail: describeToolInput(input),
        });

        if (block.name === 'Bash' && typeof input.command === 'string') {
          state.commands.push(input.command);
          emit({ type: 'command', backend: BACKEND_ID, command: input.command });
        }
        if (EDIT_TOOLS.has(block.name) && filePath) {
          const change: BackendFileChange = {
            path: filePath,
            action: block.name === 'Write' ? 'created' : 'modified',
          };
          state.filesChanged.push(change);
          emit({ type: 'file-changed', backend: BACKEND_ID, change });
        }
      }
    }
    return;
  }

  if (type === 'result') {
    const subtype = typeof raw.subtype === 'string' ? raw.subtype : '';
    const resultText = typeof raw.result === 'string' ? raw.result : '';
    if (resultText) state.text = resultText;
    if (raw.is_error === true || (subtype !== '' && subtype !== 'success')) {
      state.errorMessage = resultText || subtype || 'Claude Code завершился с ошибкой';
    }
    if (looksUsageLimited(resultText) || looksUsageLimited(subtype)) {
      state.usageLimited = true;
    }
    return;
  }

  if (type === 'error') {
    const message = typeof raw.message === 'string' ? raw.message : 'Ошибка Claude Code';
    state.errorMessage = message;
    if (looksUsageLimited(message)) state.usageLimited = true;
    emit({ type: 'error', backend: BACKEND_ID, message, retryable: true });
  }
}

export class ClaudeCodeBackend implements AgentBackend {
  readonly id = BACKEND_ID;
  readonly name = 'Claude Code';
  readonly capabilities = CAPABILITIES;

  private cached: BackendAvailability | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ClaudeCodeBackendOptions) {
    this.now = options.now ?? Date.now;
  }

  async checkAvailability(force = false): Promise<BackendAvailability> {
    const ttl = this.options.availabilityTtlMs ?? 30_000;
    if (!force && this.cached && this.now() - this.cached.checkedAt < ttl) {
      return this.cached;
    }

    let availability: BackendAvailability;
    try {
      const status = await this.options.probe.status();
      if (!status.installed) {
        availability = unavailable(
          BACKEND_ID,
          status.error ??
            'У меня нет помощника, который делает работу. Попросите того, кто меня ставил, ' +
              'установить Claude Code и войти.',
          { checkedAt: this.now() },
        );
      } else if (status.loggedIn === 'unknown') {
        // No proof either way. Running and letting the CLI object is better
        // than refusing a backend that very likely works.
        availability = {
          id: BACKEND_ID,
          installed: true,
          authenticated: false,
          ready: true,
          version: status.version,
          path: status.path,
          reason: AUTH_UNKNOWN_REASON,
          checkedAt: this.now(),
        };
      } else if (!status.loggedIn) {
        availability = {
          id: BACKEND_ID,
          installed: true,
          authenticated: false,
          ready: false,
          version: status.version,
          path: status.path,
          reason: 'Claude Code установлен, но вход не выполнен. Запустите claude и войдите в аккаунт.',
          checkedAt: this.now(),
        };
      } else {
        availability = {
          id: BACKEND_ID,
          installed: true,
          authenticated: true,
          ready: true,
          version: status.version,
          path: status.path,
          checkedAt: this.now(),
        };
      }
    } catch (error) {
      availability = unavailable(
        BACKEND_ID,
        `Не удалось проверить Claude Code: ${error instanceof Error ? error.message : String(error)}`,
        { checkedAt: this.now() },
      );
    }

    this.cached = availability;
    return availability;
  }

  /** Drops the cached probe result, e.g. right after the user signs in. */
  invalidate(): void {
    this.cached = null;
  }

  run(request: BackendRequest): BackendRun {
    const permissionMode = selectPermissionMode(
      request,
      this.options.allowBypassPermissions === true,
    );

    const живая = this.liveRun(request, permissionMode);
    if (живая) return живая;

    return createCliRun({
      backend: BACKEND_ID,
      availability: () => this.checkAvailability(),
      buildArgs: () =>
        buildClaudeArgs(request, {
          model: this.options.model,
          permissionMode,
          desktopMcpConfig: this.options.desktopMcpConfig,
          homeDir: this.options.homeDir,
          gateSettings: this.options.gateSettings,
        }),
      cwd: request.cwd,
      timeoutMs: request.timeoutMs ?? this.options.defaultTimeoutMs ?? WORK_CEILING_MS,
      // Предел на молчание, а не на работу: долгий шаг — это не зависание.
      idleTimeoutMs: request.timeoutMs ? undefined : SILENCE_LIMIT_MS,
      // Собственная папка — свойство ассистента, а не отдельной просьбы,
      // поэтому подставляется здесь, а не тащится через всё ядро.
      stdin: buildBackendPrompt({ ...request, homeDir: this.options.homeDir }),
      consumeLine: consumeClaudeStreamLine,
      messages: {
        unavailable: 'Claude Code недоступен',
        spawnFailed: (detail) => `Не удалось запустить Claude Code: ${detail}`,
        timedOut: 'Claude Code превысил отведённое время',
        failed: 'Claude Code завершился с ошибкой',
      },
      spawnCli: this.options.spawnCli,
      now: this.now,
    });
  }

  /**
   * Ход в уже прогретой сессии, если он тут уместен.
   *
   * Замер 20.09.2026: первый ход 28.5 секунды, второй 5.4, третий 3.2.
   * Холодный старт платится один раз за разговор.
   *
   * `null` значит «этой задаче живая сессия не подходит» — тогда работает
   * обычный разовый прогон, как раньше.
   */
  private liveRun(request: BackendRequest, permissionMode: ClaudePermissionMode): BackendRun | null {
    const pool = this.options.sessions;
    if (!pool || this.options.spawnCli) return null;

    // Продолжение чужой сессии агента живой сессией не выражается: `--resume`
    // задаётся при запуске процесса, а процесс уже идёт.
    if (request.sessionId) return null;

    const path = this.cached?.path;
    if (!path) return null;

    const key: SessionKey = {
      cwd: request.cwd,
      tools: toolsFor(request.capabilities, Boolean(this.options.gateSettings)).join(','),
      permissionMode,
      mcpConfig: needsDesktopTools(request.capabilities) ? this.options.desktopMcpConfig : undefined,
      model: this.options.model,
    };

    const готовая = pool.find(key);
    if (готовая) {
      // Правила и устройство работы агент прочитал первым ходом и помнит.
      // Слать их заново — платить временем человека за уже известное.
      return готовая.ask(
        готовая.hasSpoken()
          ? buildFollowUpPrompt(request)
          : buildBackendPrompt({ ...request, homeDir: this.options.homeDir }),
      );
    }

    const свежая = new LiveSession({
      key,
      command: path,
      extraArgs: [
        ...gateArgs(this.options.gateSettings),
        ...homeArgs(this.options.homeDir, request.cwd, this.options.gateSettings),
      ],
      consumeLine: (raw, emit) => consumeClaudeStreamLine(raw, createStreamState(), emit),
      env: agentEnv(),
      // Молчание — предел работы, потолок — предел ожидания. Короткий запрос
      // с явным сроком (вопрос в разговоре) получает и то, и другое.
      turnTimeoutMs: request.timeoutMs ?? this.options.defaultTimeoutMs,
      turnCeilingMs: request.timeoutMs,
      now: this.now,
    });
    pool.keep(свежая);
    return свежая.ask(buildBackendPrompt({ ...request, homeDir: this.options.homeDir }));
  }
}
