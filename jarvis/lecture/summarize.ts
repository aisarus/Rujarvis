/**
 * Раздел конспекта — Claude Code или Codex по подписке, одним ответом.
 *
 * Не задача и не разговор: кусок расшифровки на входе, текст раздела на
 * выходе. Поэтому `claude -p` с ответом текстом, промпт через stdin (лекция —
 * это десятки тысяч знаков, в командную строку они не лезут), без MCP-серверов:
 * у владельца в общих настройках два мёртвых, и каждый вызов платил бы за их
 * ожидание. Модель — Sonnet: раздел конспекта ей по силам, а лимиты подписки
 * за полуторачасовую лекцию (15–20 вызовов) она бережёт.
 *
 * Codex — для тех, у кого ChatGPT, а не Claude (первые тестеры на маке,
 * 26.10.2026). Кто пишет, решает настройка `brain`; «сам» — кто установлен,
 * Claude Code первым, а не ответил один — спрашивается второй.
 *
 * Окружение — то же, что у задач (`agentEnv`): только подписка, ключи API
 * вычищены.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCodexArgs, codexOwnerChoices, readCodexUserConfig, WORK_DISABLED_FEATURES, type CodexOwnerChoices } from '../backends/codex';
import { resolveCli } from '../backends/cliProbes';
import { cliLaunch } from '../backends/spawnCli';
import { agentEnv } from '../backends/subscriptionEnv';
import type { Brain } from '../setup/settings';

export type { Brain };

export function claudeSummaryArgs(model = 'sonnet'): string[] {
  // В режиме -p разрешения спросить не у кого: всё, что их просит, получает
  // отказ, — а разделу конспекта инструменты и не нужны.
  return ['-p', '--output-format', 'text', '--model', model, '--strict-mcp-config', '--permission-mode', 'default'];
}

/**
 * Аргументы Codex для раздела или итога.
 *
 * Песочница «только чтение» в пустой временной папке: писать и ходить в сеть
 * нечем, а разделу и не нужно. Без настроек человека (`--ignore-user-config`)
 * — иначе с ними приедут его плагины и MCP-серверы, и каждый из 15–20
 * вызовов за лекцию ждал бы их запуска; модель и тариф при этом его
 * (`codexOwnerChoices`). Свои руки Codex выключены, как и в работе. Сессия не
 * сохраняется (`--ephemeral`): двадцать разделов лекции — не двадцать
 * разговоров в его истории. Ответ — последним сообщением в файл (`-o`): в
 * потоке событий его пришлось бы выковыривать.
 */
export function codexSummaryArgs(outFile: string, options: { effort?: string; choices?: CodexOwnerChoices } = {}): string[] {
  const args = buildCodexArgs(
    {},
    { sandbox: 'read-only', ownerChoices: options.choices ?? codexOwnerChoices(readCodexUserConfig()), disabledFeatures: WORK_DISABLED_FEATURES },
  );
  const свои = ['--ephemeral', '-o', outFile];
  if (options.effort) свои.push('-c', `model_reasoning_effort="${options.effort}"`);
  // Последний аргумент — `-`: промпт из stdin. Свои — перед ним.
  args.splice(args.length - 1, 0, ...свои);
  return args;
}

export interface SummarizerOptions {
  /** Чем звать — по умолчанию найденный CLI. Подменяется в проверках. */
  command?: string;
  args?: string[];
  model?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

let выборМозга: () => Brain = () => 'auto';

/** Мост задаёт выбор из настроек при старте; без него — кто установлен. */
export function setBrain(get: () => Brain): void {
  выборМозга = get;
}

/** Выбор сейчас — для тех, кто зовёт модель не через `createSummarizer` (разбор документов). */
export function currentBrain(): Brain {
  return выборМозга();
}

/** `--brain=codex` в командной строке скрипта — поверх настроек: проверить второй мозг, не трогая выбор человека. */
export function brainFromArgs(argv: readonly string[], fallback: Brain): Brain {
  const raw = argv.find((a) => a.startsWith('--brain='))?.slice('--brain='.length);
  return raw === 'claude' || raw === 'codex' || raw === 'auto' ? raw : fallback;
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

/** Кого спрашивать и в каком порядке. «Сам» — установленные, Claude Code первым. */
export function brainOrder(choice: Brain, installed: (cli: 'claude' | 'codex') => boolean = (cli) => resolveCli(cli) !== null): Array<'claude' | 'codex'> {
  if (choice !== 'auto') return [choice];
  return (['claude', 'codex'] as const).filter((cli) => installed(cli));
}

const ИМЯ = { claude: 'Claude Code', codex: 'Codex' } as const;

/**
 * Раздел (или итог — `final`) тем мозгом, что выбран в настройках.
 *
 * Выбор читается при каждом вызове: сменил человек Claude на Codex посреди
 * семестра — следующий раздел пишет уже Codex, без перезапуска.
 */
export function createSummarizer(options: SummarizerOptions & { final?: boolean; log?(line: string): void } = {}): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const порядок = brainOrder(выборМозга());
    if (порядок.length === 0) throw new Error('Ни Claude Code, ни Codex не найдены — конспект писать нечем');
    let ошибка: unknown;
    for (const [i, мозг] of порядок.entries()) {
      try {
        if (мозг === 'codex') return await createCodexSummarizer({ timeoutMs: options.timeoutMs, env: options.env, effort: options.final ? undefined : 'low' })(prompt);
        return await (options.final ? createClaudeFinalSummarizer(options) : createClaudeSummarizer(options))(prompt);
      } catch (error) {
        ошибка = error;
        const следующий = порядок[i + 1];
        if (следующий) options.log?.(`${ИМЯ[мозг]} не ответил (${error instanceof Error ? error.message : String(error)}) — спрашиваю ${ИМЯ[следующий]}`);
      }
    }
    throw ошибка;
  };
}

/**
 * Итог лекции — сильнейшей моделью.
 *
 * Итог один на всю лекцию: он сводит шумную расшифровку (на иврите — с ошибкой
 * в каждом седьмом слове даже в тихой комнате) в связный текст на другом
 * языке и выбирает курс и тему. Это работа для сильнейшей модели, а лимиты
 * подписки один вызов за лекцию не съест. Разделы — 15–20 вызовов — остаются
 * на модели попроще.
 */
export function createFinalSummarizer(options: SummarizerOptions & { log?(line: string): void } = {}): (prompt: string) => Promise<string> {
  return createSummarizer({ ...options, final: true });
}

/** Итог через Claude Code: Opus, с Sonnet в запасе. */
export function createClaudeFinalSummarizer(options: SummarizerOptions & { log?(line: string): void } = {}): (prompt: string) => Promise<string> {
  return withFallback(
    createClaudeSummarizer({ ...options, model: 'opus' }),
    createClaudeSummarizer({ ...options, model: 'sonnet' }),
    options.log,
  );
}

export interface Ответ {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Запустить CLI с промптом в stdin и дождаться выхода. */
export function runCli(command: string, args: string[], prompt: string, options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; имя: string }): Promise<Ответ> {
  const launch = cliLaunch(command, args);
  return new Promise<Ответ>((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      shell: launch.shell,
      env: options.env,
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const таймер = setTimeout(() => {
      child.kill();
      reject(new Error(`${options.имя} не ответил за ${Math.round(options.timeoutMs / 1000)} с`));
    }, options.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (кусок: string) => {
      stdout += кусок;
    });
    child.stderr?.on('data', (кусок: string) => {
      stderr += кусок;
    });
    child.on('error', (error) => {
      clearTimeout(таймер);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(таймер);
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(prompt, 'utf8');
  });
}

export function createClaudeSummarizer(options: SummarizerOptions = {}): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const command = options.command ?? resolveCli('claude');
    if (!command) throw new Error('Claude Code не найден — раздел конспекта собрать нечем');
    const { code, stdout, stderr } = await runCli(command, options.args ?? claudeSummaryArgs(options.model), prompt, {
      // Нейтральная папка: в папке проекта CLI прочитал бы чужие правила.
      cwd: os.tmpdir(),
      timeoutMs: options.timeoutMs ?? 180_000,
      env: options.env ?? agentEnv(),
      имя: 'Claude Code',
    });
    if (code === 0 && stdout.trim()) return stdout.trim();
    throw new Error(`Claude Code вышел с кодом ${code}: ${(stderr.trim() || stdout.trim()).slice(0, 200)}`);
  };
}

/**
 * Причина отказа Codex — из потока событий.
 *
 * В stderr Codex пишет ход работы, а отказ («model is not supported when
 * using Codex with a ChatGPT account», лимит) — событием `error` или
 * `turn.failed` в stdout. Последнее такое событие и есть причина.
 */
export function codexFailure(stdout: string, stderr: string): string {
  let причина = '';
  for (const строка of stdout.split(/\r?\n/u)) {
    if (!строка.trim().startsWith('{')) continue;
    try {
      const событие = JSON.parse(строка) as { type?: string; message?: string; error?: { message?: string } };
      if (событие.type === 'error' && событие.message) причина = событие.message;
      if (событие.type === 'turn.failed' && событие.error?.message) причина = событие.error.message;
    } catch {
      // Не JSON — не событие.
    }
  }
  return (причина || stderr.trim().split(/\r?\n/u).slice(-3).join(' ') || stdout.trim()).slice(0, 200);
}

/**
 * Раздел через Codex.
 *
 * Срок длиннее, чем у Claude Code: Codex думает дольше, а раздел пишется,
 * пока лекция идёт дальше, — его никто не ждёт с секундомером.
 */
export function createCodexSummarizer(
  options: Omit<SummarizerOptions, 'args' | 'model'> & { args?(outFile: string): string[]; effort?: string } = {},
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const command = options.command ?? resolveCli('codex');
    if (!command) throw new Error('Codex не найден — раздел конспекта собрать нечем');
    // Своя пустая папка на вызов: Codex читает правила папки (AGENTS.md) и
    // смотрит вокруг, а здесь смотреть не на что.
    const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-'));
    const файл = path.join(папка, 'answer.md');
    try {
      const { code, stdout, stderr } = await runCli(command, options.args?.(файл) ?? codexSummaryArgs(файл, { effort: options.effort }), prompt, {
        cwd: папка,
        timeoutMs: options.timeoutMs ?? 420_000,
        env: options.env ?? agentEnv(),
        имя: 'Codex',
      });
      const ответ = existsSync(файл) ? readFileSync(файл, 'utf8').trim() : '';
      if (code === 0 && ответ) return ответ;
      throw new Error(`Codex вышел с кодом ${code}: ${codexFailure(stdout, stderr)}`);
    } finally {
      rmSync(папка, { recursive: true, force: true });
    }
  };
}
