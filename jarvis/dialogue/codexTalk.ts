/**
 * Разговор вторым потоком через Codex — для тех, у кого нет Claude Code.
 *
 * ## Почему ход — отдельный запуск
 *
 * У Codex нет живой сессии с потоком ходов на входе, как у Claude Code:
 * `codex exec` отвечает один раз и выходит. Нить держится иначе — номером
 * сессии: первый ход её заводит, следующие идут `exec resume <номер>`. Codex
 * хранит нить сам, и «а почему?» во втором ходу понимает, о чём речь.
 * Прогреть здесь нечего: процесса между ходами нет.
 *
 * ## Почему у разговора нет рук и здесь
 *
 * У Claude Code руки отнимает список разрешённых инструментов. У Codex
 * списка нет, а оболочка есть всегда — её выключают возможностями:
 * `shell_tool` и `unified_exec`. Замер 27.09.2026, codex-cli 0.153.4: без них
 * «выполни echo» — «NO SHELL», с ними — команда выполнена. Поверх —
 * песочница «только чтение»: ни записи, ни сети, даже если оболочка
 * вернётся в новой версии. Свой компьютер-юз, браузер, приложения и плагины
 * Codex выключены тоже: это руки мимо красных линий Джарвиса, а приложения
 * ChatGPT умеют писать людям.
 *
 * Глаголы разговора — MCP-сервер `jarvis-talk`, одобренные без вопроса, как
 * у Claude Code по `--allowedTools`: «заведи работу» идёт через мост в
 * обычный путь задачи со всеми красными линиями, а остановить, отложить и
 * продолжить — безопасно.
 *
 * ## Почему ходы по очереди
 *
 * Два `resume` одной нити одновременно — два процесса, пишущих одну
 * историю. Живая сессия Claude Code ставит ходы в очередь сама; здесь это
 * делает `ask`.
 */

import { readFileSync } from 'node:fs';

import { createCliRun, type SpawnCli } from '../backends/cliRunner';
import {
  buildCodexArgs,
  codexMcpOverride,
  codexOwnerChoices,
  createCodexLineConsumer,
  readCodexUserConfig,
  readDesktopMcpServers,
} from '../backends/codex';
import type { BackendResult } from '../backends/types';
import type { TalkLive } from './talkSession';
import { TALK_SERVER, TALK_TOOLS } from './talkTools';

/**
 * Возможности Codex, которые у разговора выключены.
 *
 * Оболочка — две: `shell_tool` и `unified_exec` (замер: одной мало). Остальное —
 * руки в мир мимо сервера Джарвиса. Незнакомое имя Codex пропускает молча,
 * поэтому список не ломается от новой версии CLI.
 */
export const TALK_DISABLED_FEATURES = [
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

export interface CodexTalkOptions {
  /** Путь к `codex`. */
  command: string;
  /** Папка разговора — дом Джарвиса. */
  cwd: string;
  /** Конфиг MCP разговора в формате Claude Code (`talk.json`). */
  mcpConfig?: string;
  model?: string;
  /** Сколько ход может молчать, прежде чем считаться зависшим. */
  silenceMs: number;
  /** Настройки Codex человека; по умолчанию — с диска. */
  userConfig?: () => string | null;
  spawnCli?: SpawnCli;
}

/** Аргументы хода разговора: первого (`thread` нет) или продолжения. */
export function codexTalkArgs(options: CodexTalkOptions, thread: string | null): string[] {
  const серверы = options.mcpConfig ? readDesktopMcpServers(readFileSync(options.mcpConfig, 'utf8')) : {};
  const разговор = серверы[TALK_SERVER];
  return buildCodexArgs(
    { sessionId: thread ?? undefined, cwd: options.cwd },
    {
      model: options.model,
      sandbox: 'read-only',
      mcpOverrides: разговор ? [codexMcpOverride(TALK_SERVER, разговор, true, TALK_TOOLS)] : [],
      ownerChoices: codexOwnerChoices((options.userConfig ?? readCodexUserConfig)()),
      disabledFeatures: TALK_DISABLED_FEATURES,
    },
  );
}

export class CodexTalkLive implements TalkLive {
  /** Номер нити у Codex; до первого удачного хода его нет. */
  private thread: string | null = null;
  private спрошено = false;
  private закрыт = false;
  private очередь: Promise<unknown> = Promise.resolve();
  private идёт: { cancel(reason?: string): void } | null = null;

  constructor(private readonly options: CodexTalkOptions) {}

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
      return { backend: 'codex', ok: false, cancelled: true, error: 'Отменено', text: '', durationMs: 0, filesChanged: [], commands: [] };
    }
    const путь = this.options.command;
    const run = createCliRun({
      backend: 'codex',
      availability: async () => ({ id: 'codex', installed: true, authenticated: true, ready: true, path: путь, checkedAt: Date.now() }),
      buildArgs: () => codexTalkArgs(this.options, this.thread),
      cwd: this.options.cwd,
      // Потолка нет нарочно, как у живой сессии: граница — молчание.
      idleTimeoutMs: this.options.silenceMs,
      stdin: prompt,
      consumeLine: createCodexLineConsumer(),
      messages: {
        unavailable: 'Codex недоступен',
        spawnFailed: (detail) => `Не удалось запустить Codex: ${detail}`,
        timedOut: 'Codex молчал слишком долго',
        failed: 'Codex завершился с ошибкой',
      },
      spawnCli: this.options.spawnCli,
    });
    this.идёт = run;
    try {
      const итог = await run.result();
      if (итог.sessionId) this.thread = итог.sessionId;
      // Нить не завелась — следующий ход снова первый: с вступлением, а не
      // с «что изменилось» к разговору, которого у Codex нет.
      else if (!this.thread) this.спрошено = false;
      return итог;
    } finally {
      this.идёт = null;
    }
  }
}
