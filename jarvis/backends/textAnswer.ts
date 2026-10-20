/**
 * Ответ текстом — без инструментов, одним запуском CLI.
 *
 * Конспекту лекции и заготовке учёбы не нужны ни файлы, ни экран: кусок
 * текста на входе, текст на выходе. Раньше это умел только Claude Code
 * (`lecture/summarize.ts`), и у студента с одним Gemini или одним Codex
 * конспект молча не собирался. Здесь — то же для Codex и Gemini: тот же
 * безголовый запуск, что у задач, но без единого инструмента.
 */

import os from 'node:os';

import { tr } from '../locale/language';
import { createCliRun, type SpawnCli } from './cliRunner';
import { buildCodexArgs, codexOwnerChoices, createCodexLineConsumer, readCodexUserConfig } from './codex';
import { buildGeminiArgs, createGeminiLineConsumer, explainGeminiFailure, policyFailed, writePolicy } from './gemini';
import { adminPoliciesPresent, ensureGeminiHome, geminiEnv } from './geminiHome';
import { geminiPolicy } from './geminiPolicy';
import type { BackendResult } from './types';

export interface TextAnswerOptions {
  model?: string;
  timeoutMs?: number;
  spawnCli?: SpawnCli;
}

/**
 * Возможности Codex, выключенные для ответа текстом: оболочка и все руки в
 * мир. Тот же набор, что у разговора (`dialogue/codexTalk.ts`), — здесь
 * отдельной строкой, чтобы бэкенды не зависели от разговора.
 */
export const CODEX_TEXT_DISABLED = [
  'shell_tool',
  'unified_exec',
  'computer_use',
  'browser_use',
  'browser_use_external',
  'in_app_browser',
  'apps',
  'plugins',
  'image_generation',
] as const;

function итог(result: BackendResult, кто: string): string {
  if (result.ok && result.text.trim()) return result.text.trim();
  throw new Error(`${кто}: ${result.error ?? (result.ok ? 'пустой ответ' : 'не ответил')}`);
}

/** Codex: песочница «только чтение», оболочка и руки выключены. */
export async function answerWithCodex(command: string, prompt: string, options: TextAnswerOptions = {}): Promise<string> {
  const cwd = os.tmpdir();
  const run = createCliRun({
    backend: 'codex',
    availability: async () => ({ id: 'codex', installed: true, authenticated: true, ready: true, path: command, checkedAt: Date.now() }),
    buildArgs: () =>
      buildCodexArgs(
        { cwd },
        {
          model: options.model,
          sandbox: 'read-only',
          ownerChoices: codexOwnerChoices(readCodexUserConfig()),
          disabledFeatures: CODEX_TEXT_DISABLED,
        },
      ),
    cwd,
    timeoutMs: options.timeoutMs ?? 180_000,
    stdin: prompt,
    consumeLine: createCodexLineConsumer(),
    messages: {
      unavailable: 'Codex недоступен',
      spawnFailed: (detail) => `Не удалось запустить Codex: ${detail}`,
      timedOut: 'Codex не ответил вовремя',
      failed: 'Codex завершился с ошибкой',
    },
    spawnCli: options.spawnCli,
  });
  return итог(await run.result(), 'Codex');
}

/** Политика ответа текстом: не разрешено ничего. */
export const GEMINI_TEXT_POLICY = geminiPolicy({ builtins: [] });

/** Gemini: ни одного инструмента и ни одного MCP-сервера. */
export async function answerWithGemini(
  command: string,
  home: string,
  prompt: string,
  options: TextAnswerOptions & { adminPolicies?: () => boolean } = {},
): Promise<string> {
  if ((options.adminPolicies ?? adminPoliciesPresent)()) {
    throw new Error(
      tr(
        'Gemini: политики на этом компьютере задаёт администратор, правила Джарвиса не применятся',
        'Gemini: an administrator sets the policies on this computer, Jarvis rules would not apply',
      ),
    );
  }
  // Нейтральная папка: в папке проекта Gemini прочитал бы чужие правила.
  const cwd = os.tmpdir();
  const run = createCliRun({
    backend: 'gemini',
    availability: async () => ({ id: 'gemini', installed: true, authenticated: true, ready: true, path: command, checkedAt: Date.now() }),
    buildArgs: () => {
      ensureGeminiHome(home);
      return buildGeminiArgs({ policyFile: writePolicy(home, GEMINI_TEXT_POLICY), approval: 'default', model: options.model });
    },
    env: geminiEnv(home),
    cwd,
    timeoutMs: options.timeoutMs ?? 180_000,
    stdin: prompt,
    consumeLine: createGeminiLineConsumer(),
    watchStderr: (chunk, state) => {
      if (policyFailed(chunk)) state.fatalMessage = 'Gemini не прочитал правила Джарвиса';
    },
    describeFailure: explainGeminiFailure,
    messages: {
      unavailable: 'Gemini недоступен',
      spawnFailed: (detail) => `Не удалось запустить Gemini: ${detail}`,
      timedOut: 'Gemini не ответил вовремя',
      failed: 'Gemini завершился с ошибкой',
    },
    spawnCli: options.spawnCli,
  });
  return итог(await run.result(), 'Gemini');
}
