/**
 * Найти `claude` и `codex` на машине и понять, можно ли их запускать.
 *
 * Поиск: явный путь из окружения, обычные места установки, затем PATH.
 * Вход проверяется по наличию файла учётных данных, сами токены не читаются
 * (у Codex — только поле-признак в `auth.json`). Ответ о входе трёхзначный
 * (`authHints.ts`): «не нашёл файл» ещё не значит «не вошёл».
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { hasClaudeEnvironmentAuth, hasCodexEnvironmentAuth, resolveAuthState } from './authHints';
import type { ClaudeCliProbe } from './claudeCode';
import type { CodexCliProbe } from './codex';
import { localModel } from './localModel';
import { agentEnv } from './subscriptionEnv';

const run = promisify(execFile);

type Cli = 'claude' | 'codex';

export interface CliStatus {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  path?: string;
  error?: string;
}

/** Обычные места установки. Порядок — от самого вероятного. */
export function commonCliPaths(cli: Cli, home = os.homedir(), platform = process.platform): string[] {
  if (platform === 'win32') {
    const local = path.join(home, 'AppData', 'Local');
    const roaming = path.join(home, 'AppData', 'Roaming');
    return [
      path.join(home, '.local', 'bin', `${cli}.exe`),
      path.join(local, 'Programs', cli, `${cli}.exe`),
      path.join(roaming, 'npm', `${cli}.cmd`),
      path.join(local, 'pnpm', `${cli}.cmd`),
      path.join(local, 'Yarn', '.bin', `${cli}.cmd`),
      path.join(home, '.bun', 'bin', `${cli}.exe`),
      path.join(home, '.volta', 'bin', `${cli}.exe`),
      path.join(local, 'Volta', 'bin', `${cli}.exe`),
      path.join(local, 'mise', 'shims', `${cli}.exe`),
      path.join(local, 'mise', 'shims', `${cli}.cmd`),
    ];
  }
  return [
    path.join(home, '.claude', 'bin', cli),
    path.join(home, '.local', 'bin', cli),
    '/opt/homebrew/bin/' + cli,
    '/usr/local/bin/' + cli,
    path.join(home, '.npm-global', 'bin', cli),
    path.join(home, '.bun', 'bin', cli),
    path.join(home, '.volta', 'bin', cli),
    path.join(home, 'Library', 'pnpm', cli),
    path.join(home, '.local', 'share', 'pnpm', cli),
    path.join(home, '.local', 'share', 'mise', 'shims', cli),
    '/usr/bin/' + cli,
  ];
}

export function resolveCli(
  cli: Cli,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform = process.platform,
): string | null {
  const explicit = env[cli === 'claude' ? 'JARVIS_CLAUDE_PATH' : 'JARVIS_CODEX_PATH']?.trim();
  if (explicit && exists(explicit)) return explicit;

  for (const candidate of commonCliPaths(cli, os.homedir(), platform)) {
    if (exists(candidate)) return candidate;
  }

  const names = platform === 'win32' ? [`${cli}.exe`, `${cli}.cmd`, `${cli}.bat`] : [cli];
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':');
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

async function version(file: string): Promise<string | null> {
  const черезОболочку = /\.(cmd|bat)$/iu.test(file);
  try {
    // `.cmd` на Windows запускается только через оболочку — И ТОЛЬКО В
    // КАВЫЧКАХ.
    //
    // При `shell: true` Node склеивает путь и аргументы в одну строку, ничего
    // не экранируя: путь вида `C:\Users\Иван Петров\...\claude.cmd` доходил до
    // cmd.exe как команда `C:\Users\Иван`. Версия не читалась, и человек
    // получал «не установлен» на установленном CLI. Пути с пробелами здесь
    // обычное дело.
    const { stdout } = await run(черезОболочку ? `"${file}"` : file, ['--version'], {
      timeout: 10_000,
      encoding: 'utf8',
      windowsHide: true,
      shell: черезОболочку,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function cliStatus(cli: Cli, env: NodeJS.ProcessEnv = process.env): Promise<CliStatus> {
  const file = resolveCli(cli, env);
  if (!file) return { installed: false, loggedIn: false };
  const found = await version(file);
  if (found === null) {
    return { installed: false, loggedIn: false, path: file, error: `${file} не запускается` };
  }
  return { installed: true, loggedIn: hasCredentials(cli), version: found, path: file };
}

function hasCredentials(cli: Cli): boolean {
  const home = os.homedir();
  try {
    if (cli === 'claude') {
      const file = path.join(home, '.claude', '.credentials.json');
      return existsSync(file) && statSync(file).size > 2;
    }
    const file = path.join(home, '.codex', 'auth.json');
    if (!existsSync(file)) return false;
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Boolean(data.tokens || data.access_token || data.accessToken || data.OPENAI_API_KEY);
  } catch {
    return false;
  }
}

/**
 * Проба смотрит на то окружение, которое получит сам CLI.
 *
 * Иначе она ручалась за то, чего не будет: ANTHROPIC_API_KEY в системе
 * означал «вход выполнен», а `agentEnv()` этот ключ снимает НАРОЧНО — Джарвис
 * живёт на подписке и чужими ключами не платит. Получалось «готов» и отказ
 * авторизации на первой же задаче.
 */
export function createClaudeProbe(env: NodeJS.ProcessEnv = process.env): ClaudeCliProbe {
  return {
    async status() {
      const status = await cliStatus('claude', env);
      // Со своей моделью вход в аккаунт Anthropic не нужен: CLI идёт на сервер
      // человека. Нужен только сам установленный Claude Code.
      if (localModel()) return { ...status, loggedIn: status.installed };
      const какУCli = agentEnv(env);
      return { ...status, loggedIn: resolveAuthState(status.loggedIn, hasClaudeEnvironmentAuth(какУCli)) };
    },
  };
}

export function createCodexProbe(env: NodeJS.ProcessEnv = process.env): CodexCliProbe {
  return {
    async status() {
      const status = await cliStatus('codex', env);
      const какУCli = agentEnv(env);
      return { ...status, loggedIn: resolveAuthState(status.loggedIn, hasCodexEnvironmentAuth(какУCli)) };
    },
  };
}
