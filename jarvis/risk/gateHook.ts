/**
 * Хук PreToolUse: красные линии на каждом вызове инструмента.
 *
 * Claude Code запускает его перед каждым инструментом агента и передаёт вызов
 * в stdin. Хук оценивает действие политикой (`toolGate.ts`) и, если оно
 * чувствительное или опасное, спрашивает человека голосом через мост.
 *
 * Любая неясность — отказ: непрочитанный вызов, сломанный конфиг, молчание
 * человека. Хук, который при сбое пропускает, красную линию не держит.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';

import { setLanguage, type Language } from '../locale/language';
import { riskRank } from '../types';
import { GateBridge, type ГолосЧеловека } from './gateBridge';
import { classifyToolUse, type GateContext } from './toolGate';

export interface GateConfig {
  bridgeDir: string;
  /**
   * Язык вопросов. Хук — отдельный процесс, запущенный Claude Code, и
   * выбранного в настройках языка не знает: без этого поля англоязычного
   * человека спрашивали бы по-русски.
   */
  language?: Language;
  outputDir?: string;
  homeDir?: string;
}

export interface HookInput {
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason: string;
  };
}

type Ask = (summary: string, level: 'sensitive' | 'dangerous') => Promise<ГолосЧеловека>;

/** Решение по одному вызову. `null` — вмешиваться незачем. */
export async function decideToolUse(
  input: HookInput,
  config: Omit<GateConfig, 'bridgeDir'>,
  ask: Ask,
): Promise<HookOutput | null> {
  if (typeof input.tool_name !== 'string') return deny('Не удалось прочитать вызов инструмента.');
  const toolInput =
    input.tool_input && typeof input.tool_input === 'object' ? (input.tool_input as Record<string, unknown>) : {};
  const context: GateContext = {
    cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    outputDir: config.outputDir,
    homeDir: config.homeDir,
    tempDir: os.tmpdir(),
    userHome: os.homedir(),
  };

  const risk = classifyToolUse(input.tool_name, toolInput, context);
  if (riskRank(risk.level) < riskRank('sensitive')) return null;

  const ответ = await ask(risk.summary, risk.level as 'sensitive' | 'dangerous');
  if (ответ === 'allow') return decision('allow', `Человек разрешил голосом: ${risk.summary}`);

  // Не пускаем во всех трёх случаях, но называем причину как есть: «мост
  // сломан» и «человек отказал» — разные вещи, и первое надо чинить, а не
  // обходить.
  const причина =
    ответ === 'deny'
      ? `Человек не разрешил: ${risk.summary}`
      : ответ === 'timeout'
        ? `Человек не ответил на вопрос: ${risk.summary}`
        : `Не удалось спросить человека (мост разрешений не работает): ${risk.summary}`;
  return deny(
    `${причина} Не пытайся сделать это обходным путём — ` +
      'скажи, что это действие требует разрешения, и продолжай остальную работу.',
  );
}

/** Точка входа процесса хука. */
export async function runGateHook(configPath: string | undefined): Promise<void> {
  let output: HookOutput | null;
  try {
    const config = JSON.parse(readFileSync(configPath ?? '', 'utf8')) as GateConfig;
    setLanguage(config.language === 'en' ? 'en' : 'ru');
    const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
    const bridge = new GateBridge(config.bridgeDir);
    output = await decideToolUse(input, config, (summary, level) => bridge.ask(summary, level));
  } catch (error) {
    output = deny(`Проверка разрешений не сработала: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (output) process.stdout.write(JSON.stringify(output));
}

/**
 * Настройки Claude Code, подключающие хук: передаются через `--settings`.
 *
 * `timeout` — в секундах и с запасом над ожиданием ответа человека.
 */
export function gateSettings(command: string): object {
  return {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 90 }] }],
    },
  };
}

function deny(reason: string): HookOutput {
  return decision('deny', reason);
}

function decision(permissionDecision: 'allow' | 'deny', reason: string): HookOutput {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: reason },
  };
}
