import { describe, expect, it } from 'vitest';

import { buildCodexArgs, codexMcpOverride, readDesktopMcpServers, selectSandbox } from './codex';
import { DEFAULT_PERMISSIONS } from '../types';
import type { BackendRequest } from './types';

/**
 * Рабочий стол для Кодекса.
 *
 * Кодекс берёт MCP-серверы из `~/.codex/config.toml`, но `-c ключ=значение`
 * перекрывает конфиг на ОДИН вызов, а значение разбирается как TOML. Это и
 * нужно: человек ставил Кодекс не для нас, и оставлять следы в его настройках
 * мы не вправе.
 *
 * Форма проверена настоящим `codex-cli 0.153.4` 26.09.2026: переданный так
 * сервер появляется в `codex mcp list` с распакованным путём и пропадает
 * после запуска.
 */
const БС = String.fromCharCode(92);

function запрос(overrides: Partial<BackendRequest> = {}): BackendRequest {
  return {
    utterance: 'открой блокнот',
    capabilities: ['computer'],
    risk: 'normal',
    permissions: DEFAULT_PERMISSIONS,
    ...overrides,
  };
}

describe('codexMcpOverride', () => {
  it('собирает строку, которую Кодекс разбирает как TOML', () => {
    const строка = codexMcpOverride('jarvis-desktop', {
      command: 'desktop-mcp.cmd',
      args: ['--role', 'desktop'],
      env: { JARVIS_LANGUAGE: 'ru' },
    });
    expect(строка).toBe(
      'mcp_servers.jarvis-desktop={command="desktop-mcp.cmd",args=["--role","desktop"],env={JARVIS_LANGUAGE="ru"}}',
    );
  });

  it('удваивает обратные косые: иначе путь Windows приезжает покалеченным', () => {
    // TOML разбирает обратную косую как начало escape-последовательности, и
    // `C:\Users\…` превращается в мусор. Замер на живом Кодексе: с удвоением
    // путь в `codex mcp list` показан правильным.
    const строка = codexMcpOverride('x', { command: `C:${БС}Users${БС}и${БС}mcp.cmd` });
    expect(строка).toContain(`C:${БС}${БС}Users${БС}${БС}и${БС}${БС}mcp.cmd`);
  });

  it('не роняет строку чужой кавычкой в значении', () => {
    const строка = codexMcpOverride('x', { command: 'a"b' });
    expect(строка).toContain(`a${БС}"b`);
  });

  it('не пишет пустые args и env: лишние ключи — лишний разбор', () => {
    const строка = codexMcpOverride('x', { command: 'mcp', args: [], env: {} });
    expect(строка).toBe('mcp_servers.x={command="mcp"}');
  });

  it('выбрасывает переменные без значения, а не пишет undefined', () => {
    const строка = codexMcpOverride('x', { command: 'mcp', env: { ЕСТЬ: 'да', НЕТУ: undefined } });
    expect(строка).toContain('ЕСТЬ="да"');
    expect(строка).not.toContain('НЕТУ');
  });
});

describe('readDesktopMcpServers', () => {
  it('читает тот же файл, что получает Claude Code', () => {
    // Второго описания одного сервера не заводим: два источника правды
    // однажды разойдутся, и разойдутся тихо.
    const серверы = readDesktopMcpServers(
      JSON.stringify({
        mcpServers: { 'jarvis-desktop': { type: 'stdio', command: 'mcp.cmd', env: { A: 'b' } } },
      }),
    );
    expect(Object.keys(серверы)).toEqual(['jarvis-desktop']);
    expect(серверы['jarvis-desktop'].command).toBe('mcp.cmd');
  });

  it('файл без серверов — это пусто, а не поломка', () => {
    expect(readDesktopMcpServers('{}')).toEqual({});
  });
});

describe('buildCodexArgs с рабочим столом', () => {
  it('кладёт перекрытия ключом -c, по одному на сервер', () => {
    const args = buildCodexArgs(запрос(), {
      sandbox: selectSandbox(запрос(), false),
      mcpOverrides: ['mcp_servers.a={command="x"}', 'mcp_servers.b={command="y"}'],
    });
    expect(args.filter((а) => а === '-c')).toHaveLength(2);
    expect(args).toContain('mcp_servers.a={command="x"}');
    expect(args).toContain('mcp_servers.b={command="y"}');
  });

  it('без рабочего стола аргументы прежние', () => {
    // Кодекс без конфига должен запускаться ровно как раньше: лишний ключ в
    // команде — это лишний повод ей сломаться.
    const было = buildCodexArgs(запрос(), { sandbox: 'workspace-write' });
    expect(было).not.toContain('-c');
  });

  it('песочница и приглашение со stdin остаются на месте', () => {
    const args = buildCodexArgs(запрос(), {
      sandbox: 'workspace-write',
      mcpOverrides: ['mcp_servers.a={command="x"}'],
    });
    expect(args).toContain('--sandbox');
    // Приглашение читается со stdin: длинная русская фраза иначе упирается в
    // предел длины командной строки Windows.
    expect(args.at(-1)).toBe('-');
  });
});
