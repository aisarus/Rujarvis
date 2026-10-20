/**
 * Разговор вторым потоком через Gemini — для тех, у кого из агентов только он.
 *
 * Устроен как разговор через Codex (`codexTalk.ts`): у Gemini нет живой
 * сессии с потоком ходов на входе, каждый ход — отдельный безголовый запуск.
 * Нить держит сам Gemini: первый ход её заводит (номер приходит в событии
 * `init`), следующие идут `--resume <номер>` в той же папке.
 *
 * Руки у разговора — только глаголы сервера `jarvis-talk`: политика запуска
 * запрещает всё, кроме них, — ни чтения файлов, ни записи, ни поиска.
 * Глаголы исполняет сам Джарвис через мост, с теми же отказами модели в
 * покупке, отправке и Enter, что у Claude Code и Codex.
 */

import { readFileSync } from 'node:fs';

import { createCliRun, type SpawnCli } from '../backends/cliRunner';
import { readDesktopMcpServers } from '../backends/codex';
import {
  buildGeminiArgs,
  createGeminiLineConsumer,
  explainGeminiFailure,
  policyFailed,
  serverEnv,
  writePolicy,
} from '../backends/gemini';
import { ensureGeminiHome, geminiEnv, GEMINI_TALK_SERVER } from '../backends/geminiHome';
import { geminiPolicy } from '../backends/geminiPolicy';
import type { BackendResult } from '../backends/types';
import type { TalkLive } from './talkSession';
import { TALK_SERVER, TALK_TOOLS } from './talkTools';

export interface GeminiTalkOptions {
  /** Путь к `gemini`. */
  command: string;
  /** Папка разговора — дом Джарвиса. */
  cwd: string;
  /** Дом Gemini под Джарвисом (`GEMINI_CLI_HOME`). */
  home: string;
  /** Конфиг MCP разговора в формате Claude Code (`talk.json`). */
  mcpConfig?: string;
  model?: string;
  /** Сколько ход может молчать, прежде чем считаться зависшим. */
  silenceMs: number;
  spawnCli?: SpawnCli;
}

/** Политика хода разговора: только глаголы разговора и больше ничего. */
export function geminiTalkPolicy(withServer: boolean): string {
  return geminiPolicy({
    builtins: [],
    server: withServer ? { name: GEMINI_TALK_SERVER, tools: TALK_TOOLS } : undefined,
  });
}

/** Окружение сервера разговора — или `null`, если его нет. */
export function geminiTalkServerEnv(mcpConfig: string | undefined): Record<string, string> | null {
  if (!mcpConfig) return null;
  const сервер = readDesktopMcpServers(readFileSync(mcpConfig, 'utf8'))[TALK_SERVER];
  return сервер ? serverEnv(сервер) : null;
}

export class GeminiTalkLive implements TalkLive {
  /** Номер нити у Gemini; до первого удачного хода его нет. */
  private thread: string | null = null;
  private спрошено = false;
  private закрыт = false;
  private очередь: Promise<unknown> = Promise.resolve();
  private идёт: { cancel(reason?: string): void } | null = null;

  constructor(private readonly options: GeminiTalkOptions) {}

  isAlive(): boolean {
    return !this.закрыт;
  }

  hasSpoken(): boolean {
    return this.спрошено;
  }

  ask(prompt: string): { result(): Promise<BackendResult> } {
    this.спрошено = true;
    const ход = this.очередь.then(() => this.ход(prompt));
    this.очередь = ход.catch(() => undefined);
    return { result: () => ход };
  }

  dispose(why = 'Разговор закрыт'): void {
    this.закрыт = true;
    this.идёт?.cancel(why);
  }

  private async ход(prompt: string): Promise<BackendResult> {
    if (this.закрыт) {
      return { backend: 'gemini', ok: false, cancelled: true, error: 'Отменено', text: '', durationMs: 0, filesChanged: [], commands: [] };
    }
    const путь = this.options.command;
    const сервер = geminiTalkServerEnv(this.options.mcpConfig);
    const run = createCliRun({
      backend: 'gemini',
      availability: async () => ({ id: 'gemini', installed: true, authenticated: true, ready: true, path: путь, checkedAt: Date.now() }),
      buildArgs: () => {
        ensureGeminiHome(this.options.home);
        return buildGeminiArgs({
          policyFile: writePolicy(this.options.home, geminiTalkPolicy(Boolean(сервер))),
          server: сервер ? GEMINI_TALK_SERVER : undefined,
          approval: 'default',
          model: this.options.model,
          sessionId: this.thread ?? undefined,
        });
      },
      env: { ...geminiEnv(this.options.home), ...(сервер ?? {}) },
      cwd: this.options.cwd,
      // Потолка нет нарочно, как у живой сессии: граница — молчание.
      idleTimeoutMs: this.options.silenceMs,
      stdin: prompt,
      consumeLine: createGeminiLineConsumer(),
      watchStderr: (chunk, state) => {
        if (policyFailed(chunk)) state.fatalMessage = 'Gemini не прочитал правила разговора — ход остановлен.';
      },
      describeFailure: explainGeminiFailure,
      messages: {
        unavailable: 'Gemini недоступен',
        spawnFailed: (detail) => `Не удалось запустить Gemini: ${detail}`,
        timedOut: 'Gemini молчал слишком долго',
        failed: 'Gemini завершился с ошибкой',
      },
      spawnCli: this.options.spawnCli,
    });
    this.идёт = run;
    try {
      const итог = await run.result();
      if (итог.sessionId) this.thread = итог.sessionId;
      // Нить не завелась — следующий ход снова первый: с вступлением, а не
      // с «что изменилось» к разговору, которого у Gemini нет.
      else if (!this.thread) this.спрошено = false;
      return итог;
    } finally {
      this.идёт = null;
    }
  }
}
