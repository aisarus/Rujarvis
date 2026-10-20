/**
 * Gemini CLI backend.
 *
 * Запускает официальный `gemini` (`@google/gemini-cli`) безголовым, с
 * потоком `stream-json`. Вход — Google-аккаунт самого человека через OAuth
 * самого CLI (`oauth-personal`): у аккаунта есть бесплатный уровень, и
 * студенту не нужна подписка, чтобы начать. Ключ API Джарвис не берёт и не
 * пропускает: `GEMINI_API_KEY`, `GOOGLE_API_KEY` и обходы через Vertex
 * вычищены из окружения (`subscriptionEnv.ts`, `geminiHome.ts`), а вход по
 * ключу запрещён настройкой (`enforcedType`). Токены входа Джарвис не читает.
 *
 * Красные линии — путь «Б», как у Codex (`geminiPolicy.ts`): оболочки нет,
 * запись только в папки задачи, экран и браузер — через MCP-сервер Джарвиса,
 * где каждый вызов проверяет `risk/serverGate.ts`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AuthState } from './authHints';
import type { JarvisCapability } from '../types';
import { tr } from '../locale/language';
import { allowedToolsFor, asFastRequest } from './claudeCode';
import { createCliRun, createFailedRun, type SpawnCli, type StreamState, SILENCE_LIMIT_MS, WORK_CEILING_MS } from './cliRunner';
import { readDesktopMcpServers, type DesktopMcpServer } from './codex';
import {
  adminPoliciesPresent,
  ensureGeminiHome,
  geminiEnv,
  GEMINI_DESKTOP_SERVER,
  GEMINI_MCP_COMMAND_VAR,
  GEMINI_MCP_SCRIPT_VAR,
  GEMINI_NO_SERVERS,
  GEMINI_TALK_SERVER,
} from './geminiHome';
import { geminiPolicy, GEMINI_WRITE_TOOLS, type GeminiPolicyOptions } from './geminiPolicy';
import { buildBackendPrompt } from './prompt';
import { looksUsageLimited } from './process';
import {
  unavailable,
  type AgentBackend,
  type BackendAvailability,
  type BackendEvent,
  type BackendFileChange,
  type BackendRequest,
  type BackendRun,
} from './types';

const BACKEND_ID = 'gemini' as const;

/** Модель коротких дел: Flash отвечает быстрее и бережёт дневную квоту. */
export const GEMINI_FAST_MODEL = 'flash';

const CAPABILITIES: ReadonlySet<JarvisCapability> = new Set<JarvisCapability>([
  'reasoning',
  'coding',
  'files',
  'web',
]);

/** Встроенные инструменты чтения и поиска: работают только внутри папок задачи. */
export const GEMINI_READ_TOOLS = [
  'read_file',
  'read_many_files',
  'list_directory',
  'glob',
  'grep_search',
  'google_web_search',
  'web_fetch',
  'write_todos',
] as const;

export interface GeminiCliProbe {
  status(): Promise<{
    installed: boolean;
    loggedIn: AuthState;
    version?: string;
    path?: string;
    error?: string;
  }>;
}

export interface GeminiBackendOptions {
  probe: GeminiCliProbe;
  /** Дом Gemini под Джарвисом (`GEMINI_CLI_HOME`). */
  home: string;
  model?: string;
  /** Тот же MCP-конфиг рабочего стола, что у Claude Code и Codex. */
  desktopMcpConfig?: string;
  /** gate.json: красные линии внутри сервера (путь «Б»). Без него экрана у Gemini нет. */
  gateConfig?: string;
  /** Папка результатов: в неё Gemini можно писать. */
  outputDir?: string;
  /** Папка Джарвиса: в неё Gemini писать нельзя никогда. */
  homeDir?: string;
  defaultTimeoutMs?: number;
  availabilityTtlMs?: number;
  spawnCli?: SpawnCli;
  now?: () => number;
  /** Есть ли на машине политики администратора Gemini (подменяется в проверках). */
  adminPolicies?: () => boolean;
}

export interface GeminiRunPlan {
  args: string[];
  /** Текст политики `--admin-policy`. */
  policy: string;
  /** Что добавить в окружение запуска: сервер Джарвиса и его переменные. */
  env: Record<string, string>;
}

/** Описание запуска: всё, что меняется от задачи к задаче. */
export interface GeminiLaunch {
  /** Путь к файлу политики — его кладёт `writePolicy`. */
  policyFile: string;
  /** Сервер Джарвиса этого запуска; нет — ни одного сервера. */
  server?: string;
  approval: 'default' | 'auto_edit';
  model?: string;
  sessionId?: string;
  /** Дополнительные папки задачи (папка результатов). */
  include?: readonly string[];
}

export function buildGeminiArgs(launch: GeminiLaunch): string[] {
  const args = ['--output-format', 'stream-json'];
  // Безголовый Gemini без доверия к папке не запускается вовсе («not running
  // in a trusted directory»). Доверие — на этот запуск, в файл доверенных
  // папок ничего не пишется.
  args.push('--skip-trust');
  args.push('--approval-mode', launch.approval);
  args.push('--admin-policy', launch.policyFile);
  // Только сервер Джарвиса — или ни одного. Чужие серверы из настроек папки
  // задачи не запускаются.
  args.push('--allowed-mcp-server-names', launch.server ?? GEMINI_NO_SERVERS);
  // Расширения человека — это его инструменты и его хуки, не наши.
  args.push('--extensions', 'none');
  for (const папка of launch.include ?? []) args.push('--include-directories', папка);
  if (launch.model) args.push('--model', launch.model);
  if (launch.sessionId) args.push('--resume', launch.sessionId);
  // Промпт — через stdin: длинная русская задача в командную строку Windows
  // не лезет. Без `-p` и с stdin не из терминала Gemini работает безголово.
  return args;
}

/** Положить политику в дом Gemini: имя по содержимому, одинаковые не плодятся. */
export function writePolicy(home: string, policy: string): string {
  const dir = path.join(home, 'run-policies');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${createHash('sha256').update(policy).digest('hex').slice(0, 16)}.toml`);
  if (!existsSync(file)) writeFileSync(file, policy, 'utf8');
  return file;
}

/**
 * Окружение сервера Джарвиса для Gemini: команда и скрипт в переменных, на
 * которые ссылаются постоянные настройки (`geminiHome.ts`), плюс его
 * собственные переменные — журнал, план, папка результатов. Сервер получает
 * их, наследуя окружение Gemini (замер: доходят).
 */
export function serverEnv(server: DesktopMcpServer, extra: Record<string, string | undefined> = {}): Record<string, string> | null {
  const args = server.args ?? [];
  // Постоянные настройки описывают запуск ровно одним аргументом — путём к
  // сборке. Подменённый сервер без аргументов так не описать: тогда рабочего
  // стола у Gemini нет, а не «есть, но запускается мимо».
  if (args.length !== 1 || !args[0]) return null;
  const env: Record<string, string> = { [GEMINI_MCP_COMMAND_VAR]: server.command, [GEMINI_MCP_SCRIPT_VAR]: args[0] };
  for (const [ключ, значение] of Object.entries({ ...server.env, ...extra })) {
    if (typeof значение === 'string') env[ключ] = значение;
  }
  return env;
}

/**
 * Настройки папки задачи, которые переписывают сервер Джарвиса.
 *
 * Gemini читает `.gemini/settings.json` из рабочей папки поверх наших, и
 * сервер с тем же именем там подменил бы наш — без проверки красных линий.
 * Такая папка — не место для работы Gemini через Джарвиса.
 */
export function overridesJarvisServer(cwd: string | undefined, read: (file: string) => string | null = читатьФайл): boolean {
  if (!cwd) return false;
  const текст = read(path.join(cwd, '.gemini', 'settings.json'));
  if (!текст) return false;
  return текст.includes(GEMINI_DESKTOP_SERVER) || текст.includes(GEMINI_TALK_SERVER);
}

function читатьФайл(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Поле аргументов, по которому видно, что делает инструмент. */
function describeParameters(parameters: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'query', 'url', 'prompt', 'pattern', 'dir_path', 'text']) {
    const value = parameters[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Разбор потока `stream-json` Gemini CLI 0.64.0 — события сняты с живого CLI:
 * `init` (session_id), `message` (role, content, delta), `tool_use`,
 * `tool_result` (status), `error` (severity, message), `result` (status,
 * error, stats).
 *
 * Ответ приходит кусками (`delta`), а между ходами модели идут инструменты.
 * Итог — текст после последнего инструмента, как у Claude Code последний
 * текстовый блок.
 */
export function createGeminiLineConsumer(): (
  raw: Record<string, unknown>,
  state: StreamState,
  emit: (event: BackendEvent) => void,
) => void {
  let текст = '';
  let сказано = false;
  const вызовы = new Map<string, { name: string; parameters: Record<string, unknown> }>();

  const высказать = (emit: (event: BackendEvent) => void): void => {
    if (текст.trim() && !сказано) {
      emit({ type: 'assistant-text', backend: BACKEND_ID, text: текст });
      сказано = true;
    }
  };

  return (raw, state, emit) => {
    const type = typeof raw.type === 'string' ? raw.type : '';

    if (type === 'init') {
      if (typeof raw.session_id === 'string') state.sessionId = raw.session_id;
      emit({ type: 'status', backend: BACKEND_ID, text: 'Gemini запущен' });
      return;
    }

    if (type === 'message') {
      if (raw.role !== 'assistant' || typeof raw.content !== 'string') return;
      if (raw.delta === true) {
        if (сказано) {
          текст = '';
          сказано = false;
        }
        текст += raw.content;
      } else {
        текст = raw.content;
        сказано = false;
      }
      if (текст.trim()) state.text = текст;
      return;
    }

    if (type === 'tool_use') {
      высказать(emit);
      // Следующий текст модели — новый ход, а не продолжение прежнего.
      текст = '';
      сказано = false;
      const name = typeof raw.tool_name === 'string' ? raw.tool_name : 'tool';
      const parameters = asRecord(raw.parameters) ?? {};
      if (typeof raw.tool_id === 'string') вызовы.set(raw.tool_id, { name, parameters });
      emit({ type: 'tool', backend: BACKEND_ID, name, detail: describeParameters(parameters) });
      return;
    }

    if (type === 'tool_result') {
      // Файл меняется, только когда запись удалась: отказ политики — тоже
      // результат, но файла после него нет.
      const вызов = typeof raw.tool_id === 'string' ? вызовы.get(raw.tool_id) : undefined;
      if (!вызов || raw.status !== 'success') return;
      const file = вызов.parameters.file_path;
      if ((GEMINI_WRITE_TOOLS as readonly string[]).includes(вызов.name) && typeof file === 'string') {
        const change: BackendFileChange = { path: file, action: вызов.name === 'write_file' ? 'created' : 'modified' };
        state.filesChanged.push(change);
        emit({ type: 'file-changed', backend: BACKEND_ID, change });
      }
      return;
    }

    if (type === 'error') {
      const message = typeof raw.message === 'string' ? raw.message : 'Ошибка Gemini';
      if (looksUsageLimited(message)) state.usageLimited = true;
      if (raw.severity === 'error') {
        state.errorMessage = message;
        emit({ type: 'error', backend: BACKEND_ID, message, retryable: true });
      } else {
        emit({ type: 'status', backend: BACKEND_ID, text: message });
      }
      return;
    }

    if (type === 'result') {
      высказать(emit);
      const stats = asRecord(raw.stats);
      if (stats && typeof stats.input_tokens === 'number') {
        state.inputTokens = (state.inputTokens ?? 0) + stats.input_tokens;
      }
      if (raw.status !== 'success') {
        const error = asRecord(raw.error);
        const message = (error && typeof error.message === 'string' ? error.message : '') || 'Gemini завершился с ошибкой';
        state.errorMessage = message;
        if (looksUsageLimited(message)) state.usageLimited = true;
      }
    }
  };
}

/**
 * Что сказать человеку о сбое Gemini — словами, по которым ясно, что делать.
 *
 * Без входа Gemini пишет «provide a GEMINI_API_KEY» — совет, которому здесь
 * следовать нельзя: Джарвис работает только на входе через Google.
 */
export function explainGeminiFailure(stderr: string, exitCode: number | null): string | undefined {
  if (exitCode === 41 || /Manual authorization is required|Please set an Auth method|re-authenticate/iu.test(stderr)) {
    return tr(
      'Gemini: вход не выполнен. Откройте настройки Джарвиса, вкладку «Агенты», и войдите через Google.',
      'Gemini: not signed in. Open Jarvis settings, the Agents tab, and sign in with Google.',
    );
  }
  if (/not running in a trusted directory/iu.test(stderr)) {
    return tr('Gemini не доверяет рабочей папке.', 'Gemini does not trust the working folder.');
  }
  return undefined;
}

/**
 * Политика Gemini не прочиталась — красные линии не на месте.
 *
 * Gemini на сломанной политике не останавливается, а работает без неё
 * (замер: «[ADMIN] Policy file error…» и запись прошла). Поэтому такой
 * запуск останавливает сам Джарвис, едва увидит это в stderr.
 */
export function policyFailed(stderr: string): boolean {
  return /Policy file error|policy.{0,40}(?:failed|invalid)/iu.test(stderr);
}

/** Одна ли это папка или внутри: регистр и вид косой не важны. */
function внутри(папка: string, корень: string): boolean {
  const норм = (value: string): string => value.split(/[\\/]+/u).filter(Boolean).join('/').toLowerCase();
  const a = норм(папка);
  const b = норм(корень);
  return a === b || a.startsWith(`${b}/`);
}

/**
 * Куда этой задаче нельзя писать: папка Джарвиса — целиком, а если задача
 * идёт в его исходниках — его данные и «характер», как у хука Claude Code.
 */
export function protectedRootsFor(cwd: string | undefined, homeDir: string | undefined): string[] {
  if (!homeDir) return [];
  if (cwd && внутри(cwd, homeDir)) return [path.join(homeDir, 'data'), path.join(homeDir, 'характер.md')];
  return [homeDir];
}

export class GeminiBackend implements AgentBackend {
  readonly id = BACKEND_ID;
  readonly name = 'Gemini';

  /** Экран — только вместе с красными линиями в сервере, как у Codex. */
  get capabilities(): ReadonlySet<JarvisCapability> {
    if (!this.options.desktopMcpConfig || !this.options.gateConfig || !this.серверСтола()) return CAPABILITIES;
    return new Set<JarvisCapability>([...CAPABILITIES, 'computer', 'browser']);
  }

  private cached: BackendAvailability | null = null;
  private стол: DesktopMcpServer | null | undefined;
  private readonly now: () => number;

  constructor(private readonly options: GeminiBackendOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Сервер рабочего стола из конфига — один раз за жизнь процесса. */
  private серверСтола(): DesktopMcpServer | null {
    if (this.стол !== undefined) return this.стол;
    this.стол = null;
    const файл = this.options.desktopMcpConfig;
    if (!файл) return null;
    try {
      this.стол = readDesktopMcpServers(readFileSync(файл, 'utf8'))[GEMINI_DESKTOP_SERVER] ?? null;
    } catch (error) {
      console.error('[gemini] не удалось прочитать конфиг рабочего стола:', error);
    }
    return this.стол;
  }

  async checkAvailability(force = false): Promise<BackendAvailability> {
    const ttl = this.options.availabilityTtlMs ?? 30_000;
    if (!force && this.cached && this.now() - this.cached.checkedAt < ttl) return this.cached;

    let availability: BackendAvailability;
    try {
      const status = await this.options.probe.status();
      if (!status.installed) {
        availability = unavailable(
          BACKEND_ID,
          status.error ??
            tr(
              'Gemini CLI не установлен. Запустите установщик Джарвиса ещё раз — он поставит Gemini.',
              'Gemini CLI is not installed. Run the Jarvis installer again — it installs Gemini.',
            ),
          { checkedAt: this.now() },
        );
      } else if (status.loggedIn !== true) {
        // Вход лежит в доме Джарвиса, поэтому «нет файла» — точный ответ, а
        // не догадка: пробовать без входа значит получить отказ на каждой задаче.
        availability = {
          id: BACKEND_ID,
          installed: true,
          authenticated: false,
          ready: false,
          version: status.version,
          path: status.path,
          reason: tr(
            'Gemini установлен, но вход не выполнен. Войдите через Google в настройках, вкладка «Агенты»',
            'Gemini is installed but not signed in. Sign in with Google in settings, the Agents tab',
          ),
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
        `Не удалось проверить Gemini: ${error instanceof Error ? error.message : String(error)}`,
        { checkedAt: this.now() },
      );
    }
    this.cached = availability;
    return availability;
  }

  invalidate(): void {
    this.cached = null;
  }

  /** Политика и запуск этой задачи — без побочных действий, для проверок. */
  planRun(request: BackendRequest): { policy: GeminiPolicyOptions; server?: string; env: Record<string, string> } {
    const экран = this.capabilities.has('computer');
    const сервер = экран ? this.серверСтола() : null;
    const сторож = this.options.gateConfig;
    // Инструменты — под задачу, тем же списком, что у Claude Code: у задачи
    // «только посмотреть» пишущих нет и здесь.
    const инструменты = allowedToolsFor(request, true).flatMap((t) =>
      t.startsWith('mcp__jarvis-desktop__') ? [t.slice('mcp__jarvis-desktop__'.length)] : [],
    );
    const env = сервер && сторож ? serverEnv(сервер, { JARVIS_TOOL_GATE: сторож }) : null;
    const cwd = request.cwd ?? process.cwd();
    return {
      policy: {
        builtins: GEMINI_READ_TOOLS,
        server: env ? { name: GEMINI_DESKTOP_SERVER, tools: инструменты } : undefined,
        writes: request.permissions.edit
          ? {
              roots: [cwd, this.options.outputDir].filter((root): root is string => Boolean(root)),
              protectedRoots: protectedRootsFor(cwd, this.options.homeDir),
              cwd,
            }
          : undefined,
      },
      server: env ? GEMINI_DESKTOP_SERVER : undefined,
      env: env ?? {},
    };
  }

  run(исходный: BackendRequest): BackendRun {
    // Короткое дело — с общим набором возможностей, как у Claude Code: ему
    // всегда нужны окна, а разбор фразы мог их не назвать.
    const request = asFastRequest(исходный);
    if ((this.options.adminPolicies ?? adminPoliciesPresent)()) {
      return createFailedRun(
        BACKEND_ID,
        tr(
          'На этом компьютере политики Gemini задаёт администратор, и проверку Джарвиса Gemini здесь не примет. Работать через Gemini здесь нельзя.',
          'Gemini policies on this computer are set by an administrator, so Gemini would ignore Jarvis’s checks. Gemini cannot work here.',
        ),
      );
    }
    if (overridesJarvisServer(request.cwd)) {
      return createFailedRun(
        BACKEND_ID,
        tr(
          'В рабочей папке свои настройки Gemini переписывают сервер Джарвиса — здесь Gemini работать не будет.',
          'Gemini settings in the working folder override the Jarvis server — Gemini will not work here.',
        ),
      );
    }

    const план = this.planRun(request);
    const home = this.options.home;
    const fast = request.fast === true;

    return createCliRun({
      backend: BACKEND_ID,
      availability: () => this.checkAvailability(),
      buildArgs: () => {
        ensureGeminiHome(home);
        const cwd = request.cwd ?? process.cwd();
        const include = [this.options.outputDir].filter(
          (папка): папка is string => Boolean(папка) && !внутри(папка as string, cwd),
        );
        return buildGeminiArgs({
          policyFile: writePolicy(home, geminiPolicy(план.policy)),
          server: план.server,
          approval: request.permissions.edit ? 'auto_edit' : 'default',
          model: fast ? GEMINI_FAST_MODEL : this.options.model,
          sessionId: request.sessionId,
          include,
        });
      },
      env: { ...geminiEnv(home), ...план.env },
      cwd: request.cwd,
      timeoutMs: request.timeoutMs ?? this.options.defaultTimeoutMs ?? WORK_CEILING_MS,
      idleTimeoutMs: request.timeoutMs ? undefined : SILENCE_LIMIT_MS,
      stdin: buildBackendPrompt(request),
      consumeLine: createGeminiLineConsumer(),
      watchStderr: (chunk, state) => {
        if (policyFailed(chunk)) {
          state.fatalMessage = tr(
            'Gemini не прочитал правила Джарвиса — работу остановил, чтобы она не шла без проверки.',
            'Gemini could not read the Jarvis rules — stopped the work so it does not run unchecked.',
          );
        }
      },
      describeFailure: explainGeminiFailure,
      messages: {
        unavailable: 'Gemini недоступен',
        spawnFailed: (detail) => `Не удалось запустить Gemini: ${detail}`,
        timedOut: 'Gemini превысил отведённое время',
        failed: 'Gemini завершился с ошибкой',
      },
      spawnCli: this.options.spawnCli,
      now: this.now,
    });
  }
}
