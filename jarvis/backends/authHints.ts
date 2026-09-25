/**
 * Detecting whether a subscription CLI is actually usable.
 *
 * The obvious check — does the vendor's credential file exist — is a false
 * negative in several real setups: host-managed deployments, an API key or
 * OAuth token supplied through the environment, a corporate gateway configured
 * with a custom base URL. In all of those the CLI works perfectly while the
 * file the check looks for never exists.
 *
 * This was not theoretical. Running the adapter against a real installed
 * `claude` returned an answer in four seconds while the file check reported
 * "not signed in", which would have made Jarvis refuse a working backend.
 *
 * So authentication is tri-state. The cost asymmetry decides the default:
 * wrongly reporting "not signed in" blocks a working backend permanently,
 * while wrongly trying costs one fast CLI error that Jarvis already turns into
 * a clear Russian message telling the user to log in.
 */

/** `true` signed in, `false` definitely not, `'unknown'` worth trying. */
export type AuthState = boolean | 'unknown';

/** Environment variables that mean Claude Code has credentials of its own. */
const CLAUDE_AUTH_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
];

/** Variables that mean the host, not the user, supplies the credentials. */
const CLAUDE_MANAGED_ENV = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

const CODEX_AUTH_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY'];

function hasAny(env: NodeJS.ProcessEnv, names: readonly string[]): boolean {
  return names.some((name) => {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * True when something other than the credential file could be authenticating
 * this CLI. A non-empty custom base URL counts: it means requests are being
 * routed through a gateway that usually carries its own credentials.
 */
export function hasClaudeEnvironmentAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  if (hasAny(env, CLAUDE_AUTH_ENV)) return true;
  if (hasAny(env, CLAUDE_MANAGED_ENV)) return true;
  return hasAny(env, ['ANTHROPIC_BASE_URL']);
}

export function hasCodexEnvironmentAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  if (hasAny(env, CODEX_AUTH_ENV)) return true;
  return hasAny(env, ['OPENAI_BASE_URL']);
}

/**
 * Сводит подсказку окружения с проверкой файла учётных данных.
 *
 * Положительной проверке файла верим. Отрицательная становится `'unknown'`, и
 * `false` отсюда не выходит НИКОГДА — это не упущение, а решение: ложное «не
 * вошёл» запирает работающий бэкенд навсегда, а ложная попытка стоит одной
 * быстрой ошибки CLI, которую Джарвис и так превращает в понятную фразу «зайди
 * в аккаунт». Цена ошибок несимметрична, поэтому и ответ несимметричен.
 *
 * Значение `false` в типе `AuthState` оставлено для тех, кто знает точно:
 * проба, у которой есть ответ самого CLI, а не догадка по файлу. Ветки
 * `!status.loggedIn` в `claudeCode.ts` и `codex.ts` живут ради них.
 */
export function resolveAuthState(fileCheckSaysLoggedIn: boolean, environmentAuth: boolean): AuthState {
  if (fileCheckSaysLoggedIn) return true;
  if (environmentAuth) return true;
  return 'unknown';
}

/** True when a backend in this auth state should be allowed to run. */
export function isUsable(state: AuthState): boolean {
  return state !== false;
}
