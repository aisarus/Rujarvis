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

/** То же окружение, но без всего, чем можно случайно заплатить. */
export function subscriptionEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of KEY_VARS) delete clean[name];
  return clean;
}

/** Что именно убрали — для журнала, чтобы это не выяснялось второй раз. */
export function strippedKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return KEY_VARS.filter((name) => (env[name] ?? '').trim().length > 0);
}
