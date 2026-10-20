/**
 * Раздел конспекта — агентом по подписке человека, одним ответом.
 *
 * Не задача и не разговор: кусок расшифровки на входе, текст раздела на
 * выходе. Промпт через stdin (лекция — это десятки тысяч знаков, в командную
 * строку они не лезут), без инструментов и MCP-серверов.
 *
 * Отвечает выбранный в настройках агент, а если его нет — первый готовый:
 * Claude Code, Codex, Gemini. Раньше звался только Claude Code, и у студента
 * с одним Google-аккаунтом конспект молча не собирался.
 *
 * У Claude Code — `claude -p` с ответом текстом: в общих настройках владельца
 * два мёртвых MCP-сервера, и `--strict-mcp-config` не даёт за них платить.
 * Модель раздела — Sonnet: ему по силам, а лимиты подписки за полуторачасовую
 * лекцию (15–20 вызовов) он бережёт. У Gemini то же место занимает Flash, у
 * Codex — модель, выбранная человеком в его настройках.
 *
 * Окружение — то же, что у задач (`agentEnv`): только подписка, ключи API
 * вычищены.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

import type { AuthState } from '../backends/authHints';
import { createClaudeProbe, createCodexProbe, createGeminiProbe, resolveCli } from '../backends/cliProbes';
import { cliLaunch } from '../backends/spawnCli';
import { agentEnv } from '../backends/subscriptionEnv';
import { answerWithCodex, answerWithGemini } from '../backends/textAnswer';
import { AGENT_IDS, isAgentId, type AgentChoice, type AgentId } from '../backends/types';
import { tr } from '../locale/language';
import { jarvisPaths } from '../setup/paths';

export function claudeSummaryArgs(model = 'sonnet'): string[] {
  // В режиме -p разрешения спросить не у кого: всё, что их просит, получает
  // отказ, — а разделу конспекта инструменты и не нужны.
  return ['-p', '--output-format', 'text', '--model', model, '--strict-mcp-config', '--permission-mode', 'default'];
}

export interface SummarizerOptions {
  /** Чем звать — по умолчанию найденный Claude Code. Подменяется в проверках. */
  command?: string;
  args?: string[];
  model?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Не ответил первый — спросить второго: итог лекции не должен пропасть из-за лимита одной модели. */
export function withFallback(
  first: (prompt: string) => Promise<string>,
  second: (prompt: string) => Promise<string>,
  log?: (line: string) => void,
): (prompt: string) => Promise<string> {
  return async (prompt) => {
    try {
      return await first(prompt);
    } catch (error) {
      log?.(`итог: первая модель не ответила (${error instanceof Error ? error.message : String(error)}) — беру запасную`);
      return second(prompt);
    }
  };
}

/**
 * Итог лекции — Opus, с Sonnet в запасе (только Claude Code).
 *
 * Итог один на всю лекцию: он сводит шумную расшифровку (на иврите — с ошибкой
 * в каждом седьмом слове даже в тихой комнате) в связный текст на другом
 * языке и выбирает курс и тему. Это работа для сильнейшей модели, а лимиты
 * подписки один вызов за лекцию не съест. Разделы — 15–20 вызовов — остаются
 * на Sonnet. Для любого агента — `createAgentFinalSummarizer`.
 */
export function createFinalSummarizer(options: SummarizerOptions & { log?(line: string): void } = {}): (prompt: string) => Promise<string> {
  return withFallback(
    createClaudeSummarizer({ ...options, model: 'opus' }),
    createClaudeSummarizer({ ...options, model: 'sonnet' }),
    options.log,
  );
}

export function createClaudeSummarizer(options: SummarizerOptions = {}): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const command = options.command ?? resolveCli('claude');
    if (!command) throw new Error('Claude Code не найден — раздел конспекта собрать нечем');
    const launch = cliLaunch(command, options.args ?? claudeSummaryArgs(options.model));
    const срок = options.timeoutMs ?? 180_000;

    return new Promise<string>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        shell: launch.shell,
        env: options.env ?? agentEnv(),
        // Нейтральная папка: в папке проекта CLI прочитал бы чужие правила.
        cwd: os.tmpdir(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let вывод = '';
      let ошибки = '';
      const таймер = setTimeout(() => {
        child.kill();
        reject(new Error(`Claude Code не ответил за ${Math.round(срок / 1000)} с`));
      }, срок);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (кусок: string) => {
        вывод += кусок;
      });
      child.stderr?.on('data', (кусок: string) => {
        ошибки += кусок;
      });
      child.on('error', (error) => {
        clearTimeout(таймер);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(таймер);
        if (code === 0 && вывод.trim()) resolve(вывод.trim());
        else reject(new Error(`Claude Code вышел с кодом ${code}: ${(ошибки.trim() || вывод.trim()).slice(0, 200)}`));
      });
      child.stdin?.end(prompt, 'utf8');
    });
  };
}

/** Кто ответит текстом и где его найти. */
export interface TextAgent {
  id: AgentId;
  path: string;
}

/** Что пробы знают об агентах: установлен ли, вошёл ли, где лежит. */
export interface AgentStatus {
  installed: boolean;
  loggedIn: AuthState;
  path?: string;
}
export type AgentStatuses = () => Promise<Partial<Record<AgentId, AgentStatus>>>;

/**
 * Можно ли звать агента. Claude Code и Codex с «вход не подтверждён» —
 * можно: их CLI сам скажет, если входа нет. Gemini — только с входом: вход
 * лежит в доме Джарвиса, и его отсутствие известно точно.
 */
function годится(id: AgentId, статус: AgentStatus | undefined): статус is AgentStatus & { path: string } {
  if (!статус?.installed || !статус.path) return false;
  return id === 'gemini' ? статус.loggedIn === true : статус.loggedIn !== false;
}

/** Выбранный, если готов, иначе первый готовый: Claude Code, Codex, Gemini. */
export function pickTextAgent(статусы: Partial<Record<AgentId, AgentStatus>>, prefer: AgentChoice = 'auto'): TextAgent | null {
  const порядок = prefer === 'auto' ? AGENT_IDS : [prefer, ...AGENT_IDS.filter((id) => id !== prefer)];
  for (const id of порядок) {
    const статус = статусы[id];
    if (годится(id, статус)) return { id, path: статус.path };
  }
  return null;
}

/**
 * Пробы всех трёх агентов — с памятью на минуту. Лекция — это два десятка
 * вызовов подряд, и пробовать перед каждым незачем: проба — это запуск CLI.
 */
export function cachedAgentStatuses(ttlMs = 60_000, geminiHome = jarvisPaths().geminiHome): AgentStatuses {
  let память: { at: number; value: Promise<Partial<Record<AgentId, AgentStatus>>> } | null = null;
  return () => {
    if (память && Date.now() - память.at < ttlMs) return память.value;
    const тихо = (проба: Promise<AgentStatus>): Promise<AgentStatus | undefined> => проба.catch(() => undefined);
    const value = Promise.all([
      тихо(createClaudeProbe().status()),
      тихо(createCodexProbe().status()),
      тихо(createGeminiProbe(geminiHome).status()),
    ]).then(([claude, codex, gemini]) => ({ 'claude-code': claude, codex, gemini }));
    память = { at: Date.now(), value };
    return value;
  };
}

/**
 * Модели под работу. Раздел — быстрая и бережливая; итог — сильнейшая, с
 * запасной на случай лимита. `undefined` — модель, выбранная человеком в
 * самом CLI.
 */
export const TEXT_MODELS: Record<AgentId, { section: string | undefined; final: (string | undefined)[] }> = {
  'claude-code': { section: 'sonnet', final: ['opus', 'sonnet'] },
  codex: { section: undefined, final: [undefined] },
  gemini: { section: 'flash', final: ['pro', 'flash'] },
};

export interface AgentSummarizerOptions {
  /** Выбор в настройках. По умолчанию — `JARVIS_AGENT` из окружения или «авто». */
  prefer?: () => AgentChoice;
  statuses?: AgentStatuses;
  geminiHome?: string;
  timeoutMs?: number;
  log?(line: string): void;
  /** Ответ агента — подменяется в проверках. */
  answer?: (agent: TextAgent, model: string | undefined, prompt: string) => Promise<string>;
}

function выборИзОкружения(): AgentChoice {
  const значение = process.env.JARVIS_AGENT?.trim();
  return isAgentId(значение) ? значение : 'auto';
}

/** Спросить агента: у каждого свой безголовый запуск без инструментов. */
export function answerWithAgent(
  agent: TextAgent,
  model: string | undefined,
  prompt: string,
  options: { geminiHome?: string; timeoutMs?: number } = {},
): Promise<string> {
  if (agent.id === 'claude-code') return createClaudeSummarizer({ command: agent.path, model, timeoutMs: options.timeoutMs })(prompt);
  if (agent.id === 'codex') return answerWithCodex(agent.path, prompt, { model, timeoutMs: options.timeoutMs });
  return answerWithGemini(agent.path, options.geminiHome ?? jarvisPaths().geminiHome, prompt, { model, timeoutMs: options.timeoutMs });
}

const ИМЯ: Record<AgentId, string> = { 'claude-code': 'Claude Code', codex: 'Codex', gemini: 'Gemini' };

function собрать(
  options: AgentSummarizerOptions,
  модели: (agent: TextAgent) => (string | undefined)[],
): (prompt: string) => Promise<string> {
  const статусы = options.statuses ?? cachedAgentStatuses(60_000, options.geminiHome);
  const ответ =
    options.answer ??
    ((agent: TextAgent, model: string | undefined, prompt: string) =>
      answerWithAgent(agent, model, prompt, { geminiHome: options.geminiHome, timeoutMs: options.timeoutMs }));
  return async (prompt) => {
    const агент = pickTextAgent(await статусы(), (options.prefer ?? выборИзОкружения)());
    if (!агент) {
      throw new Error(
        tr(
          'Конспект собрать некому: войдите в Claude Code, Codex или Gemini (настройки, вкладка «Агенты»)',
          'Nobody to write the notes: sign in to Claude Code, Codex or Gemini (settings, the Agents tab)',
        ),
      );
    }
    const очередь = модели(агент);
    let последняя: unknown;
    for (const [номер, модель] of очередь.entries()) {
      try {
        return await ответ(агент, модель, prompt);
      } catch (error) {
        последняя = error;
        if (номер < очередь.length - 1) {
          options.log?.(
            `${ИМЯ[агент.id]}${модель ? ` (${модель})` : ''} не ответил (${error instanceof Error ? error.message : String(error)}) — беру запасную`,
          );
        }
      }
    }
    throw последняя instanceof Error ? последняя : new Error(String(последняя));
  };
}

/** Раздел конспекта, заготовка учёбы — выбранным или первым готовым агентом. */
export function createAgentSummarizer(options: AgentSummarizerOptions = {}): (prompt: string) => Promise<string> {
  return собрать(options, (агент) => [TEXT_MODELS[агент.id].section]);
}

/** Итог лекции — сильнейшей моделью агента, с запасной. */
export function createAgentFinalSummarizer(options: AgentSummarizerOptions = {}): (prompt: string) => Promise<string> {
  return собрать(options, (агент) => TEXT_MODELS[агент.id].final);
}
