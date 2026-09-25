/**
 * `pnpm run jarvis:try` — Jarvis without the microphone.
 *
 * The voice front end is not wired into the desktop app yet, but everything
 * behind it is: routing, normalisation, the risk gate, memory, world state,
 * task orchestration, the backends and the spoken-answer split. This drives
 * exactly that pipeline from typed Russian, so the whole thing can be tried
 * and judged before a single microphone is involved.
 *
 *   pnpm run jarvis:try                          # интерактивно
 *   pnpm run jarvis:try -- "открой хром"         # одна реплика
 *   pnpm run jarvis:try -- --dry "почини билд"   # только разбор, без запуска
 */

import readline from 'node:readline/promises';
import process from 'node:process';
import { DEFAULT_JARVIS_SETTINGS, type JarvisSettings } from '../jarvis/core';
import type { BackendResult } from '../jarvis/backends/types';
import { buildProgress, renderProgress } from '../jarvis/tasks/progress';
import { route } from '../jarvis/router/router';
import { createJarvis } from '../jarvis/createJarvis';

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

export interface TryArgs {
  dry: boolean;
  utterance?: string;
  workspace: string;
}

export function parseArgs(argv: readonly string[], cwd: string): TryArgs {
  const dry = argv.includes('--dry');
  const workspaceFlag = argv.indexOf('--workspace');
  const hasWorkspace = workspaceFlag !== -1;
  const workspace = hasWorkspace ? (argv[workspaceFlag + 1] ?? cwd) : cwd;

  // Guard the index: with no --workspace flag indexOf gives -1, and -1 + 1
  // is 0 — which would silently drop the first word of every utterance.
  const workspaceValueIndex = hasWorkspace ? workspaceFlag + 1 : -1;
  const rest = argv.filter(
    (arg, index) =>
      arg !== '--dry' && arg !== '--workspace' && index !== workspaceValueIndex,
  );
  return { dry, utterance: rest.join(' ').trim() || undefined, workspace };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.cwd());
  const settings: JarvisSettings = { ...DEFAULT_JARVIS_SETTINGS };

  // Один интерфейс чтения на весь процесс.
  //
  // Подтверждение открывало ВТОРОЙ интерфейс на том же `stdin`, а его
  // `close()` зовёт `input.pause()`. Флаг «приостановлено» при этом ставился
  // только второму, поэтому `question('> ')` основного цикла уже не поднимал
  // ввод: после первой чувствительной задачи разговор намертво вис на
  // приглашении. Пока оба интерфейса открыты, каждый символ ещё и двоился.
  const консоль: { открытая: readline.Interface | null } = { открытая: null };
  const спросить = (вопрос: string): Promise<string> => {
    консоль.открытая ??= readline.createInterface({ input: process.stdin, output: process.stdout });
    return консоль.открытая.question(вопрос);
  };

  const jarvis = createJarvis({
    workspace: args.workspace,
    settings: () => settings,
    speak: (text) => {
      if (text) console.log(`${GREEN}[голос] ${text}${RESET}`);
    },
    // Sensitive work still asks. Typing instead of speaking is not a reason
    // to skip the gate.
    approve: async (request) => {
      const answer = await спросить(`${YELLOW}! ${request.summary} [y/N] ${RESET}`);
      return answer.trim().toLowerCase().startsWith('y');
    },
  });
  await jarvis.ready();

  console.log(`\n${BOLD}Jarvis${RESET} ${DIM}— русская речь, разобранная и выполненная, только с клавиатуры${RESET}`);
  console.log(`${DIM}Рабочая папка: ${args.workspace}${RESET}\n`);

  for (const entry of await jarvis.backends.availability(true)) {
    const mark = entry.ready ? `${GREEN}+${RESET}` : `${RED}-${RESET}`;
    const detail = entry.ready ? (entry.version ?? 'готов') : (entry.reason ?? 'недоступен');
    console.log(`  ${mark} ${entry.id.padEnd(13)} ${DIM}${detail}${RESET}`);
  }
  console.log('');

  const runOne = async (utterance: string): Promise<BackendResult | undefined> => {
    if (args.dry) {
      const decision = route(utterance, {
        basePermissions: settings.basePermissions,
        context: {
          knownProjects: jarvis.memory.knownProjects(),
          codingPreference: settings.codingPreference,
          mainPreference: settings.mainPreference,
        },
      });
      console.log(`${DIM}intent      ${RESET}${decision.intent}`);
      console.log(`${DIM}capabilities${RESET} ${decision.needs.join(', ')}`);
      console.log(`${DIM}backend     ${RESET}${decision.target}`);
      console.log(`${DIM}риск        ${RESET}${decision.risk}`);
      console.log(`${DIM}права       ${RESET}${JSON.stringify(decision.permissions)}`);
      if (decision.project) console.log(`${DIM}проект      ${RESET}${decision.project}`);
      if (decision.constraints.length > 0) {
        console.log(`${DIM}ограничения ${RESET}${decision.constraints.join(' | ')}`);
      }
      console.log(`${DIM}уверенность ${RESET}${decision.confidence}`);
      return;
    }

    const turn = await jarvis.core.handleUtterance(utterance);

    if (turn.kind !== 'task') {
      console.log(`${DIM}(${turn.kind})${RESET}`);
      return undefined;
    }

    console.log(
      `${DIM}-> ${turn.decision.target} | ${turn.decision.needs.join(', ')} | риск ${turn.decision.risk} | права ${JSON.stringify(turn.normalized.permissions)}${RESET}`,
    );

    let shown = 0;
    const unsubscribe = jarvis.tasks.subscribe((event) => {
      if (event.task.id !== turn.task.id || event.type !== 'task-event') return;
      const steps = buildProgress(event.task.events, event.task.state);
      if (steps.length > shown) {
        console.log(`${DIM}${renderProgress(steps.slice(shown))}${RESET}`);
        shown = steps.length;
      }
    });

    await new Promise<void>((resolve) => {
      const stop = jarvis.tasks.subscribe((event) => {
        if (event.type === 'task-finished' && event.task.id === turn.task.id) {
          stop();
          resolve();
        }
      });
    });
    unsubscribe();

    const result = turn.task.result;
    if (result?.text) {
      // Only the full answer here: the core already speaks the short version
      // through the `speak` callback above.
      console.log(`\n${result.text}\n`);
    }
    if (result?.error) {
      console.log(`${RED}x ${result.error}${RESET}`);
    }
    return result;
  };

  if (args.utterance) {
    // Код возврата — по итогу задачи, а не по факту, что она кончилась.
    // Скрипт, запущенный из другого скрипта, отдавал 0 на упавшей работе.
    const result = await runOne(args.utterance);
    if (!result) console.log(`${DIM}(результата нет)${RESET}`);
    if (result?.ok !== true) process.exitCode = 1;
    консоль.открытая?.close();
    return;
  }

  console.log(`${DIM}Пиши обычными словами. Пустая строка или Ctrl+C — выход.${RESET}`);
  console.log(`${DIM}Например: «открой хром», «что на экране», «почини билд через Клод Код».${RESET}\n`);

  for (;;) {
    const line = (await спросить('> ')).trim();
    if (!line) break;
    try {
      await runOne(line);
    } catch (error) {
      console.log(`${RED}x ${error instanceof Error ? error.message : String(error)}${RESET}`);
    }
    console.log('');
  }
  консоль.открытая?.close();
}

if (process.env.JARVIS_TRY_IMPORT_ONLY !== '1') {
  void main().catch((error: unknown) => {
    console.error('Не удалось запустить:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
