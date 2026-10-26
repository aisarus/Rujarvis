/**
 * Поставить Claude Code или Codex кнопкой в мастере — без Терминала.
 *
 * Кнопка «Страница установки» открывала npm, а дальше нужен был Терминал и
 * команда — для студентки не из IT (первые тестеры на маке, 26.10.2026) это
 * тупик на втором шаге. Здесь тот же `npm install -g`, что пишут в
 * инструкциях, но кнопкой. Нет прав на общую папку npm (Node с nodejs.org
 * ставит её под root) — в папку Джарвиса: её находит `resolveCli`, а на маке
 * ярлык ещё и кладёт её в PATH.
 *
 * Модуль не знает про Электрон.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { jarvisCliPath, resolveCli } from '../backends/cliProbes';
import { cliLaunch } from '../backends/spawnCli';
import { tr } from '../locale/language';

export const CLI_PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' } as const;

export type AgentCli = keyof typeof CLI_PACKAGES;

/** npm: в PATH, иначе там, где его кладут установщики Node. */
export function findNpm(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): string | null {
  const names = platform === 'win32' ? ['npm.cmd', 'npm.exe'] : ['npm'];
  const обычные =
    platform === 'win32'
      ? [path.join(env.ProgramFiles || 'C:\\Program Files', 'nodejs')]
      : platform === 'darwin'
        ? ['/opt/homebrew/bin', '/usr/local/bin']
        : ['/usr/local/bin', '/usr/bin'];
  const папки = [...(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':'), ...обычные];
  for (const папка of папки) {
    if (!папка) continue;
    for (const имя of names) {
      const файл = path.join(папка, имя);
      if (exists(файл)) return файл;
    }
  }
  return null;
}

export interface RunResult {
  code: number | null;
  output: string;
}

export type Runner = (command: string, args: string[]) => Promise<RunResult>;

const runNpm: Runner = (command, args) =>
  new Promise((resolve) => {
    const launch = cliLaunch(command, args);
    const child = spawn(launch.command, launch.args, { shell: launch.shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const копить = (кусок: Buffer) => {
      output = (output + кусок.toString('utf8')).slice(-4000);
    };
    child.stdout?.on('data', копить);
    child.stderr?.on('data', копить);
    // Пакет — десятки мегабайт; на медленной сети это минуты, но не вечность.
    const таймер = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('error', (error) => {
      clearTimeout(таймер);
      resolve({ code: null, output: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(таймер);
      resolve({ code, output });
    });
  });

export type CliInstallResult = { ok: true; path: string; where: 'npm' | 'jarvis' } | { ok: false; message: string };

/** Что сказать человеку про отказ npm: сеть, права или как есть. */
export function npmFailure(output: string): string {
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/iu.test(output)) {
    return tr('нет связи с npm — проверьте интернет и нажмите ещё раз', 'cannot reach npm — check the internet connection and try again');
  }
  const хвост = output.trim().split(/\r?\n/u).filter(Boolean).slice(-3).join(' ').slice(0, 240);
  return хвост || tr('npm завершился без объяснений', 'npm exited without saying why');
}

export async function installCli(
  cli: AgentCli,
  options: { home: string; npm?: string | null; run?: Runner; found?: () => string | null; exists?: (file: string) => boolean; log?(line: string): void },
): Promise<CliInstallResult> {
  const npm = options.npm === undefined ? findNpm() : options.npm;
  if (!npm) {
    return {
      ok: false,
      message: tr(
        'не найден npm — он ставится вместе с Node.js. Запустите установщик Джарвиса ещё раз: он поставит Node.',
        'npm was not found — it comes with Node.js. Run the Jarvis installer again: it installs Node.',
      ),
    };
  }
  const run = options.run ?? runNpm;
  const found = options.found ?? (() => resolveCli(cli));
  const exists = options.exists ?? existsSync;
  const пакет = CLI_PACKAGES[cli];

  options.log?.(`ставлю ${пакет}: ${npm} install -g`);
  const общий = await run(npm, ['install', '-g', пакет]);
  const там = found();
  if (общий.code === 0 && там) return { ok: true, path: там, where: 'npm' };

  // Общая папка npm закрыта (EACCES) или CLI там не нашёлся — своя папка.
  const своя = path.join(options.home, 'node');
  options.log?.(`общая папка npm не подошла (код ${общий.code}) — ставлю в ${своя}`);
  const вСвою = await run(npm, ['install', '-g', пакет, '--prefix', своя]);
  const файл = jarvisCliPath(cli, options.home);
  if (вСвою.code === 0 && exists(файл)) return { ok: true, path: файл, where: 'jarvis' };
  return { ok: false, message: npmFailure(вСвою.output || общий.output) };
}
