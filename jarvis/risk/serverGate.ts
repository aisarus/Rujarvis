/**
 * Красные линии внутри самого MCP-сервера рабочего стола — путь «Б».
 *
 * У Claude Code каждый вызов инструмента проходит через хук PreToolUse
 * (`gateHook.ts`). У Codex такой опоры нет: его собственные хуки на сбое
 * пропускают — замер 27.09.2026: упавший, зависший, не запустившийся хук и
 * даже выход с кодом 2 команду не останавливают. А без одобрения Codex
 * вызовы инструментов Джарвиса отклоняет вовсе. Владелец выбрал «Б»:
 * проверка там, где инструменты исполняются, — в сервере, — одинаковая для
 * любого агента и от CLI не зависящая.
 *
 * Решение то же, что у хука: `decideToolUse` с политикой `toolGate.ts`,
 * вопрос голосом через тот же мост. И то же правило: любая неясность —
 * отказ. Непрочитанный конфиг, сломанный мост, молчание человека — инструмент
 * не исполняется.
 *
 * Включается переменной JARVIS_TOOL_GATE (путь к gate.json) — только в
 * конфиге сервера для Codex. У Claude Code его хук уже спрашивает, и второй
 * вопрос на тот же вызов был бы лишним.
 */
import { readFileSync } from 'node:fs';

import { GateBridge } from './gateBridge';
import { decideToolUse, type GateConfig } from './gateHook';

/** Проверка одного вызова: `null` — пускать, строка — причина отказа. */
export interface ServerGate {
  check(tool: string, args: unknown): Promise<string | null>;
}

/** Проверка по файлу gate.json — тому же, что читает хук Claude Code. */
export function gateFromConfigFile(configPath: string): ServerGate {
  return {
    async check(tool, args) {
      try {
        // Перечитывается на каждый вызов, как у хука: правка настроек
        // действует сразу, а сломанный файл — это отказ, а не «как раньше».
        const config = JSON.parse(readFileSync(configPath, 'utf8')) as GateConfig;
        const bridge = new GateBridge(config.bridgeDir);
        const решение = await decideToolUse(
          { tool_name: `mcp__jarvis-desktop__${tool}`, tool_input: args, cwd: process.cwd() },
          config,
          (summary, level) => bridge.ask(summary, level),
        );
        return решение?.hookSpecificOutput.permissionDecision === 'deny'
          ? решение.hookSpecificOutput.permissionDecisionReason
          : null;
      } catch (беда) {
        return `Проверка разрешений не сработала: ${беда instanceof Error ? беда.message : String(беда)}`;
      }
    },
  };
}

/** Проверка из окружения сервера; нет переменной — проверки нет. */
export function serverGateFromEnv(env: NodeJS.ProcessEnv = process.env): ServerGate | null {
  const файл = env.JARVIS_TOOL_GATE?.trim();
  return файл ? gateFromConfigFile(файл) : null;
}

type Handler = (args: unknown, extra: unknown) => unknown;
type RegisterTool = (name: string, config: unknown, handler: Handler) => unknown;

/**
 * Поставить проверку перед КАЖДЫМ инструментом сервера.
 *
 * Обёртка регистрации, как у доставки правок: инструмент, добавленный
 * завтра, проверяется так же, и забыть его нельзя. Ставится последней, чтобы
 * быть внешним слоем: отказ — раньше любой работы инструмента.
 */
export function guardEveryTool(server: object, gate: ServerGate): void {
  const сервер = server as { registerTool: RegisterTool };
  const original = сервер.registerTool.bind(server) as RegisterTool;
  сервер.registerTool = (name, config, handler) =>
    original(name, config, async (args: unknown, extra: unknown) => {
      const отказ = await gate.check(name, args);
      if (отказ !== null) {
        // isError — чтобы модель не приняла отказ за сделанное.
        return { content: [{ type: 'text' as const, text: отказ }], isError: true };
      }
      return handler(args, extra);
    });
}
