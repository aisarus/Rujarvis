/**
 * Кто разбирает документ: выбранный агент, а не только Claude Code.
 *
 * Конвейер (`pipeline.ts`) звал `claude -p` напрямую, и у студента с одним
 * Google-аккаунтом документ не разбирался вовсе. Здесь — те же права для
 * Gemini и Codex, что у Claude Code: читать папку задачи, писать только в
 * `out/`, без оболочки там, где её проверку не удержать, и без сети.
 *
 * - Gemini — политикой его же движка (`geminiPolicy.ts`): чтение и поиск,
 *   запись только в `out/`, ни оболочки, ни веба, ни MCP-серверов.
 * - Codex — песочница `workspace-write` в папке задачи (запись только туда,
 *   сети нет), руки в мир и плагины выключены, как в работе.
 * - Claude Code — как было (`createClaudeDocumentAgent`).
 *
 * Агент выбирается так же, как для конспекта лекции: выбранный во вкладке
 * «Агенты», иначе первый готовый; сильнейшая модель, не ответила — быстрая.
 */

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { createCliRun, type SpawnCli } from '../backends/cliRunner';
import { buildCodexArgs, codexOwnerChoices, createCodexLineConsumer, readCodexUserConfig, WORK_DISABLED_FEATURES } from '../backends/codex';
import { buildGeminiArgs, createGeminiLineConsumer, explainGeminiFailure, policyFailed, writePolicy } from '../backends/gemini';
import { adminPoliciesPresent, ensureGeminiHome, geminiEnv } from '../backends/geminiHome';
import { geminiPolicy } from '../backends/geminiPolicy';
import type { AgentChoice, AgentId, BackendResult } from '../backends/types';
import { cachedAgentStatuses, pickTextAgent, type AgentStatuses, type TextAgent } from '../lecture/summarize';
import { tr } from '../locale/language';
import { jarvisPaths } from '../setup/paths';
import { createClaudeDocumentAgent, type AgentJob, type DocumentAgent } from './pipeline';

/** Чтение и поиск — да; веб — нет: документ разбирается по документу. */
export const GEMINI_DOCUMENT_TOOLS = ['read_file', 'read_many_files', 'list_directory', 'glob', 'grep_search', 'write_todos'] as const;

/** Политика разбора документа у Gemini: читать папку задачи, писать только в `out/`. */
export function geminiDocumentPolicy(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return geminiPolicy({
    builtins: GEMINI_DOCUMENT_TOOLS,
    writes: { roots: [path.join(cwd, 'out')], protectedRoots: [], cwd, relativeUnder: 'out' },
    platform,
  });
}

/**
 * Подсказка Gemini поверх общего задания: в нём инструменты названы по-клодовски
 * (Read и его pages), а у Gemini они свои.
 */
const ПОДСКАЗКА_GEMINI =
  'Инструменты у тебя такие: read_file читает и текст, и PDF, и картинки; write_file и replace пишут файлы — только в out/. ' +
  'Где в задании сказано «Read» и «pages» — это read_file (большой текстовый файл читай частями через start_line и end_line).\n\n';

export interface CliDocumentAgentOptions {
  command: string;
  model?: string;
  timeoutMs?: number;
  spawnCli?: SpawnCli;
  log?(line: string): void;
}

function итог(result: BackendResult, кто: string, log?: (line: string) => void): void {
  log?.(`${кто} закончил: ${result.ok ? 'да' : `нет — ${result.error ?? '?'}`}${result.text ? ` — ${result.text.trim().slice(-300)}` : ''}`);
  if (!result.ok) throw new Error(`${кто}: ${result.error ?? tr('не справился', 'failed')}`);
}

export function createGeminiDocumentAgent(options: CliDocumentAgentOptions & { home?: string; adminPolicies?: () => boolean }): DocumentAgent {
  return async (job: AgentJob) => {
    if ((options.adminPolicies ?? adminPoliciesPresent)()) {
      throw new Error(tr('Gemini: политики на этом компьютере задаёт администратор', 'Gemini: an administrator sets the policies on this computer'));
    }
    const home = options.home ?? jarvisPaths().geminiHome;
    const run = createCliRun({
      backend: 'gemini',
      availability: async () => ({ id: 'gemini', installed: true, authenticated: true, ready: true, path: options.command, checkedAt: Date.now() }),
      buildArgs: () => {
        ensureGeminiHome(home);
        return buildGeminiArgs({ policyFile: writePolicy(home, geminiDocumentPolicy(job.cwd)), approval: 'auto_edit', model: options.model });
      },
      env: geminiEnv(home),
      cwd: job.cwd,
      timeoutMs: options.timeoutMs ?? 45 * 60_000,
      stdin: ПОДСКАЗКА_GEMINI + job.prompt,
      consumeLine: createGeminiLineConsumer(),
      watchStderr: (chunk, state) => {
        if (policyFailed(chunk)) state.fatalMessage = 'Gemini не прочитал правила Джарвиса';
      },
      describeFailure: explainGeminiFailure,
      messages: {
        unavailable: 'Gemini недоступен',
        spawnFailed: (detail) => `Не удалось запустить Gemini: ${detail}`,
        timedOut: 'Gemini не закончил вовремя',
        failed: 'Gemini завершился с ошибкой',
      },
      spawnCli: options.spawnCli,
    });
    итог(await run.result(), 'Gemini', options.log);
  };
}

export function createCodexDocumentAgent(options: CliDocumentAgentOptions): DocumentAgent {
  return async (job: AgentJob) => {
    const run = createCliRun({
      backend: 'codex',
      availability: async () => ({ id: 'codex', installed: true, authenticated: true, ready: true, path: options.command, checkedAt: Date.now() }),
      buildArgs: () =>
        buildCodexArgs(
          { cwd: job.cwd },
          {
            model: options.model,
            // Запись — только в папку задачи; дальше `out/` её держит задание.
            sandbox: 'workspace-write',
            ownerChoices: codexOwnerChoices(readCodexUserConfig()),
            disabledFeatures: WORK_DISABLED_FEATURES,
          },
        ),
      cwd: job.cwd,
      timeoutMs: options.timeoutMs ?? 45 * 60_000,
      stdin: job.prompt,
      consumeLine: createCodexLineConsumer(),
      messages: {
        unavailable: 'Codex недоступен',
        spawnFailed: (detail) => `Не удалось запустить Codex: ${detail}`,
        timedOut: 'Codex не закончил вовремя',
        failed: 'Codex завершился с ошибкой',
      },
      spawnCli: options.spawnCli,
    });
    итог(await run.result(), 'Codex', options.log);
  };
}

/** Модели разбора: сильнейшая, потом быстрая. `undefined` — выбор самого CLI. */
export const DOCUMENT_MODELS: Record<AgentId, (string | undefined)[]> = {
  'claude-code': ['opus', 'sonnet'],
  codex: [undefined],
  gemini: ['pro', 'flash'],
};

export interface AgentDocumentOptions {
  prefer?: () => AgentChoice;
  statuses?: AgentStatuses;
  geminiHome?: string;
  log?(line: string): void;
  /** Агент под модель — подменяется в проверках. */
  agentFor?: (agent: TextAgent, model: string | undefined) => DocumentAgent;
}

/** Перед запасной моделью — пустая `out/`: прежняя могла оставить половину. */
function очиститьOut(job: AgentJob): void {
  rmSync(path.join(job.cwd, 'out'), { recursive: true, force: true });
  mkdirSync(path.join(job.cwd, 'out'), { recursive: true });
}

function агентПод(agent: TextAgent, model: string | undefined, options: AgentDocumentOptions): DocumentAgent {
  if (agent.id === 'claude-code') return createClaudeDocumentAgent({ command: agent.path, model, log: options.log });
  if (agent.id === 'codex') return createCodexDocumentAgent({ command: agent.path, model, log: options.log });
  return createGeminiDocumentAgent({ command: agent.path, model, home: options.geminiHome, log: options.log });
}

/** Разбор документа выбранным или первым готовым агентом. */
export function createAgentDocumentAgent(options: AgentDocumentOptions = {}): DocumentAgent {
  const статусы = options.statuses ?? cachedAgentStatuses(60_000, options.geminiHome);
  return async (job) => {
    const агент = pickTextAgent(await статусы(), options.prefer?.() ?? 'auto');
    if (!агент) {
      throw new Error(
        tr(
          'Документ разобрать некому: войдите в Claude Code, Codex или Gemini (настройки, вкладка «Агенты»)',
          'Nobody to read the document: sign in to Claude Code, Codex or Gemini (settings, the Agents tab)',
        ),
      );
    }
    const модели = DOCUMENT_MODELS[агент.id];
    let последняя: unknown;
    for (const [номер, модель] of модели.entries()) {
      try {
        await (options.agentFor ?? ((a, m) => агентПод(a, m, options)))(агент, модель)(job);
        return;
      } catch (error) {
        последняя = error;
        if (номер < модели.length - 1) {
          options.log?.(`первая модель не справилась (${error instanceof Error ? error.message : String(error)}) — беру запасную`);
          очиститьOut(job);
        }
      }
    }
    throw последняя instanceof Error ? последняя : new Error(String(последняя));
  };
}
