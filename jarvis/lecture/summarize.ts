/**
 * Раздел конспекта — Claude Code по подписке, одним ответом.
 *
 * Не задача и не разговор: кусок расшифровки на входе, текст раздела на
 * выходе. Поэтому `claude -p` с ответом текстом, промпт через stdin (лекция —
 * это десятки тысяч знаков, в командную строку они не лезут), без MCP-серверов:
 * у владельца в общих настройках два мёртвых, и каждый вызов платил бы за их
 * ожидание. Модель — Sonnet: раздел конспекта ей по силам, а лимиты подписки
 * за полуторачасовую лекцию (15–20 вызовов) она бережёт.
 *
 * Окружение — то же, что у задач (`agentEnv`): только подписка, ключи API
 * вычищены.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';

import { resolveCli } from '../backends/cliProbes';
import { cliLaunch } from '../backends/spawnCli';
import { agentEnv } from '../backends/subscriptionEnv';

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
 * Итог лекции — Opus, с Sonnet в запасе.
 *
 * Итог один на всю лекцию: он сводит шумную расшифровку (на иврите — с ошибкой
 * в каждом седьмом слове даже в тихой комнате) в связный текст на другом
 * языке и выбирает курс и тему. Это работа для сильнейшей модели, а лимиты
 * подписки один вызов за лекцию не съест. Разделы — 15–20 вызовов — остаются
 * на Sonnet.
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
