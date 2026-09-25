/**
 * Окружение для агентских CLI: только подписка, никаких ключей.
 *
 * ## Живой случай 20.09.2026
 *
 * В переменных окружения пользователя лежал старый `ANTHROPIC_API_KEY`.
 * Claude Code предпочитает ключ входу по подписке — и на каждой задаче три
 * минуты бился в него, а потом отвечал:
 *
 *   ⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another
 *     auth source is set and takes precedence over your claude.ai login
 *   Failed to authenticate. API Error: 401 API key is invalid.
 *
 * Человек слышал «неверный ключ» от системы, у которой ключей нет вовсе, и
 * полдня считал, что сломано всё подряд. Отладку это пережило только потому,
 * что в оболочке разработчика ключ перебивался переменными десктопного
 * клиента — то есть проверки проходили именно там, где проблемы не было.
 *
 * ## Почему это правило, а не заплатка
 *
 * Джарвис по замыслу работает на подписках, которые человек уже оплатил, и ни
 * на одном платном API. Ключ, случайно оказавшийся в окружении, — это не
 * запасной путь, а тихий счёт и чужая учётная запись. Поэтому он убирается
 * всегда, а не только когда мешает.
 */

import { localModel, localModelEnv } from './localModel';

/**
 * Переменные, которыми CLI входит по ключу вместо подписки.
 *
 * `*_BASE_URL` тоже здесь: он уводит запросы на чужой шлюз, и подписка снова
 * оказывается ни при чём.
 */
const KEY_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
];

/**
 * Совпадает ли имя переменной с одним из ключевых — БЕЗ УЧЁТА РЕГИСТРА.
 *
 * На Windows имена переменных регистронезависимы, а обычный объект в
 * JavaScript — нет. Удалялись только точные `ANTHROPIC_API_KEY` и прочие в
 * верхнем регистре, а `anthropic_api_key` доезжал до дочернего процесса
 * целым: Claude Code мог войти по чужому ключу вместо подписки, то есть за
 * деньги — ровно то, чего в этом проекте быть не должно. И `strippedKeys`
 * такой ключ не показывал, поэтому в журнале всё выглядело чисто.
 */
function ключевое(name: string): boolean {
  const верх = name.toUpperCase();
  return KEY_VARS.includes(верх);
}

/** То же окружение, но без всего, чем можно случайно заплатить. */
export function subscriptionEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(clean)) {
    if (ключевое(name)) delete clean[name];
  }
  return clean;
}

/** Что именно убрали — для журнала, чтобы это не выяснялось второй раз. */
export function strippedKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((name) => ключевое(name) && (env[name] ?? '').trim().length > 0);
}

/**
 * Окружение для запуска агента: подписка — или своя модель, если человек её
 * указал в настройках.
 *
 * Чужие ключи из окружения убираются всегда, и только потом, поверх, кладётся
 * адрес своего сервера: он задан явно в настройках Джарвиса, а не просочился
 * из переменных системы.
 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = subscriptionEnv(env);
  const own = localModel();
  if (!own) return clean;
  // Токен подписки своему серверу ни к чему. Замер показал, что Claude Code и
  // так шлёт заглушку, но сервер в домашней сети — это чужая машина, и
  // проверять, не передумает ли CLI в следующей версии, незачем.
  delete clean.CLAUDE_CODE_OAUTH_TOKEN;
  return { ...clean, ...localModelEnv(own) };
}
