/**
 * Дом Gemini CLI под Джарвисом: его вход, настройки и окружение запуска.
 *
 * ## Почему свой дом, а не `~/.gemini` человека
 *
 * У Gemini CLI нет флага `--settings`, как у Claude Code, а файл системных
 * настроек (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`) он молча пропускает, если
 * папку с ним может править обычный пользователь — замер на 0.64.0: «Skipping
 * system settings file … is not owned by a trusted administrator». Править
 * `~/.gemini/settings.json` человека ради своей задачи нельзя: он ставил Gemini
 * не для нас. Остаётся `GEMINI_CLI_HOME` — Gemini кладёт всё своё (вход через
 * Google, настройки, историю) в `<дом>/.gemini`. Дом лежит в папке Джарвиса,
 * как и всё остальное, и уходит вместе с ней при удалении.
 *
 * ## Почему настройки постоянные
 *
 * Работа и разговор могут идти одновременно, а файл настроек один. Поэтому
 * в нём нет ничего, что меняется от запуска к запуску: сервер Джарвиса
 * описан через переменные (`$JARVIS_GEMINI_MCP_COMMAND`), которые Gemini
 * подставляет из своего окружения, а всё, что разрешено именно этой задаче, —
 * в политике запуска (`geminiPolicy.ts`, флаг `--admin-policy`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { agentEnv } from './subscriptionEnv';

/**
 * Встроенные инструменты, которые вообще существуют для Джарвиса.
 *
 * Список разрешённых, а не запрещённых (`tools.core`): инструмент, который
 * появится в следующей версии Gemini, сюда сам не попадёт. Оболочки
 * (`run_shell_command`) нет — красная линия на ней держится только надёжным
 * хуком, а хук Gemini на своём сбое пропускает вызов (`gemini.ts`). Навыков,
 * подагентов и памяти Gemini нет тоже: это руки и записи мимо проверки.
 */
export const GEMINI_CORE_TOOLS = [
  'read_file',
  'read_many_files',
  'list_directory',
  'glob',
  'grep_search',
  'google_web_search',
  'web_fetch',
  'write_file',
  'replace',
  'write_todos',
] as const;

/** Серверы Джарвиса в настройках Gemini. Какой запущен — решает `--allowed-mcp-server-names`. */
export const GEMINI_DESKTOP_SERVER = 'jarvis-desktop';
export const GEMINI_TALK_SERVER = 'jarvis-talk';

/** Переменные, из которых Gemini собирает запуск сервера Джарвиса. */
export const GEMINI_MCP_COMMAND_VAR = 'JARVIS_GEMINI_MCP_COMMAND';
export const GEMINI_MCP_SCRIPT_VAR = 'JARVIS_GEMINI_MCP_SCRIPT';

/** Имя «ни одного сервера»: так запуск остаётся вовсе без MCP. */
export const GEMINI_NO_SERVERS = 'none';

/** Запуск сервера: обе роли — один сервер, роль приходит в окружении. */
function серверДжарвиса(): Record<string, unknown> {
  return {
    command: `$${GEMINI_MCP_COMMAND_VAR}`,
    args: [`$${GEMINI_MCP_SCRIPT_VAR}`],
    // Вопрос человеку голосом ждёт до минуты, Blender считает дольше: десять
    // минут — потолок на один вызов, а не на работу.
    timeout: 600_000,
  };
}

/**
 * Настройки Gemini под Джарвисом. Каждая строка — запрет или защита.
 */
export function geminiSettings(): Record<string, unknown> {
  return {
    security: {
      // Только вход через Google: ни ключа API, ни Vertex. Ключ — это деньги
      // и чужой аккаунт, а Джарвис живёт на подписке человека.
      auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal' },
    },
    // Кончилась бесплатная квота — не тратить «кредиты» Google: это деньги
    // без вопроса. По умолчанию Gemini спрашивает, а безголовому спросить некого.
    billing: { overageStrategy: 'never' },
    // Своей телеметрии у Джарвиса нет, и чужой через него тоже.
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    general: {
      // Обновление — дело установщика: само по себе посреди задачи оно
      // запустило бы npm.
      enableAutoUpdate: false,
      enableAutoUpdateNotification: false,
      checkpointing: { enabled: false },
    },
    // `.env` из папки задачи не читается: там бывает чужой GEMINI_API_KEY.
    advanced: { ignoreLocalEnv: true },
    experimental: { enableAgents: false },
    skills: { enabled: false },
    tools: { core: [...GEMINI_CORE_TOOLS], exclude: ['run_shell_command'] },
    mcpServers: {
      [GEMINI_DESKTOP_SERVER]: серверДжарвиса(),
      [GEMINI_TALK_SERVER]: серверДжарвиса(),
    },
  };
}

/**
 * Положить настройки в дом Gemini. Пишется, только если отличаются, и через
 * переименование: параллельный запуск не прочтёт половину файла.
 */
export function ensureGeminiHome(home: string): string {
  const dir = path.join(home, '.gemini');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const текст = `${JSON.stringify(geminiSettings(), null, 2)}\n`;
  let было: unknown = null;
  try {
    было = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Файла нет или он не читается — запишем.
  }
  // По смыслу, а не по тексту: Gemini сам пересохраняет файл (без последнего
  // перевода строки), и сравнение строкой переписывало бы его на каждом запуске.
  if (JSON.stringify(было) !== JSON.stringify(geminiSettings())) {
    const временный = `${file}.${process.pid}.tmp`;
    writeFileSync(временный, текст, 'utf8');
    renameSync(временный, file);
  }
  return file;
}

/**
 * Переменные, которые уводят Gemini мимо входа через Google или мимо его же
 * защит: в платный Vertex, в чужие учётные данные, в контейнер.
 */
const МИМО_ВХОДА = [
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_LOCATION',
  // Шифрованное хранилище кладёт вход в другое место, и проба по файлу
  // стала бы врать «не вошли».
  'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE',
  'GEMINI_FORCE_FILE_STORAGE',
  'GEMINI_SANDBOX',
  'GEMINI_CLI_HOME',
];

/**
 * Окружение Gemini под Джарвисом: подписка без ключей (`agentEnv`), свой дом
 * и никакого браузера — безголовый запуск без входа должен отказать словами,
 * а не открыть человеку окно Google посреди задачи.
 */
export function geminiEnv(home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const чистое = agentEnv(env);
  for (const имя of Object.keys(чистое)) {
    if (МИМО_ВХОДА.includes(имя.toUpperCase())) delete чистое[имя];
  }
  return { ...чистое, GEMINI_CLI_HOME: home, NO_BROWSER: 'true' };
}

/**
 * Окружение окна входа: тот же дом, доверие к папке на этот запуск и ни
 * одного ключа. Браузер здесь нужен — в нём человек и входит в Google.
 * Пустое значение окно входа понимает как «убрать переменную».
 */
export function geminiLoginEnv(home: string): Record<string, string> {
  const окружение: Record<string, string> = { GEMINI_CLI_HOME: home, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
  for (const имя of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE']) {
    окружение[имя] = '';
  }
  return окружение;
}

/**
 * Политики администратора Gemini на этой машине.
 *
 * Если они есть, Gemini игнорирует политику, переданную флагом
 * `--admin-policy` («Supplemental admin policies are ignored if any .toml
 * policy files are found in the standard system location»). А на ней держатся
 * красные линии Джарвиса — значит, работать здесь Gemini через Джарвиса не
 * должен: обещать проверку, которой не будет, нельзя.
 */
export function systemPolicyDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\policies';
  if (platform === 'darwin') return '/Library/Application Support/GeminiCli/policies';
  return '/etc/gemini-cli/policies';
}

export function adminPoliciesPresent(
  platform: NodeJS.Platform = process.platform,
  list: (dir: string) => string[] = (dir) => (existsSync(dir) ? readdirSync(dir) : []),
): boolean {
  try {
    return list(systemPolicyDir(platform)).some((name) => name.toLowerCase().endsWith('.toml'));
  } catch {
    // Не прочитали папку — не знаем, что там. Считаем, что политики есть:
    // молчание проверки здесь — отказ, а не разрешение.
    return true;
  }
}
