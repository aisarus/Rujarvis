import { describe, expect, it } from 'vitest';

import { decideLogin, loginFromCli } from './cliProbes';

/**
 * Вход — по ответу самого CLI.
 *
 * Проба по файлу отвечала «не знаю» там, где CLI знает точно, а на маке —
 * всегда: вход Claude там в Связке ключей. Ответы сняты с живых CLI 26 и
 * 27.09.2026.
 */
describe('что CLI говорит о входе', () => {
  it('claude: JSON с loggedIn — да и нет', () => {
    expect(loginFromCli('claude', '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}')).toBe(true);
    expect(loginFromCli('claude', '{ "loggedIn": false }')).toBe(false);
  });

  it('claude: предупреждение перед JSON не мешает', () => {
    expect(loginFromCli('claude', 'Warning: something\n{ "loggedIn": true }\n')).toBe(true);
  });

  it('codex: строка ответа — да и нет', () => {
    expect(loginFromCli('codex', 'Logged in using ChatGPT\n')).toBe(true);
    expect(loginFromCli('codex', 'Not logged in\n')).toBe(false);
  });

  it.each([
    ['claude', ''],
    ['claude', 'Unknown command: auth'],
    ['claude', '{ "authMethod": "claude.ai" }'],
    ['codex', ''],
    ['codex', "error: unrecognized subcommand 'status'"],
  ] as const)('%s молчит или говорит непонятное («%s») — ответа нет', (cli, вывод) => {
    expect(loginFromCli(cli, вывод)).toBeNull();
  });
});

describe('чей ответ главнее', () => {
  it('ответ CLI побеждает файл в обе стороны', () => {
    expect(decideLogin(false, true, false)).toBe(false);
    expect(decideLogin(true, false, false)).toBe(true);
  });

  it('CLI промолчал — прежний ответ: файл, окружение, иначе «не знаю»', () => {
    expect(decideLogin(null, true, false)).toBe(true);
    expect(decideLogin(null, false, true)).toBe(true);
    expect(decideLogin(null, false, false)).toBe('unknown');
  });
});
