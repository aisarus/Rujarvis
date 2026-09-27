import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CliHandle, CliProcessOptions, CliProcessOutcome } from '../backends/process';
import { CodexTalkLive, codexTalkArgs, type CodexTalkOptions } from './codexTalk';
import { TALK_TOOLS } from './talkTools';

/**
 * Разговор через Codex — для тестера с одним Codex (27.09.2026).
 *
 * Процесс подставной: проверяется то, что уходит в командную строку Codex, и
 * порядок ходов. Живьём — `pnpm jarvis:talk-check -- --codex`.
 */

/** talk.json в формате Claude Code — как его пишет приложение. */
function конфиг(): string {
  const папка = mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-talk-'));
  const файл = path.join(папка, 'talk.json');
  writeFileSync(
    файл,
    JSON.stringify({
      mcpServers: {
        'jarvis-talk': { command: 'node', args: ['mcp.cjs'], env: { JARVIS_MCP_ROLE: 'talk' } },
      },
    }),
    'utf8',
  );
  return файл;
}

function опции(spawnCli: CodexTalkOptions['spawnCli']): CodexTalkOptions {
  return { command: 'codex', cwd: os.tmpdir(), mcpConfig: конфиг(), silenceMs: 90_000, userConfig: () => null, spawnCli };
}

/** Подставной Codex: ход отвечает строками и ждёт, пока его отпустят. */
function подставной(ходы: string[][]): {
  spawn: (options: CliProcessOptions) => CliHandle;
  запуски: CliProcessOptions[];
  отпустить: () => void;
  отменены: boolean[];
} {
  const запуски: CliProcessOptions[] = [];
  const отменены: boolean[] = [];
  const ждут: Array<() => void> = [];
  const spawn = (options: CliProcessOptions): CliHandle => {
    const номер = запуски.length;
    запуски.push(options);
    отменены.push(false);
    let отпущен: () => void = () => undefined;
    const отпуск = new Promise<void>((resolve) => {
      отпущен = resolve;
    });
    ждут.push(() => отпущен());
    return {
      cancel: () => {
        отменены[номер] = true;
        отпущен();
      },
      wait: async (): Promise<CliProcessOutcome> => {
        await отпуск;
        if (!отменены[номер]) for (const строка of ходы[номер] ?? []) options.onStdoutLine(строка);
        return { exitCode: отменены[номер] ? null : 0, signal: null, stderr: '', cancelled: отменены[номер] ?? false, timedOut: false };
      },
    };
  };
  return { spawn, запуски, отменены, отпустить: () => ждут.shift()?.() };
}

const ответ = (нить: string, текст: string): string[] => [
  `{"type":"thread.started","thread_id":"${нить}"}`,
  `{"type":"item.completed","item":{"type":"agent_message","text":"${текст}"}}`,
  '{"type":"turn.completed"}',
];

/** Дождаться, пока очередь ходов дойдёт до запуска процесса. */
const тик = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('разговор через Codex', () => {
  it('у разговора нет рук: оболочка выключена, песочница «только чтение», глаголы — только разговора', () => {
    const args = codexTalkArgs(опции(undefined), null);
    const настройки = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));

    // Замер 27.09.2026: без этих двух Codex выполнил «echo», с ними — «NO SHELL».
    expect(настройки).toContain('features.shell_tool=false');
    expect(настройки).toContain('features.unified_exec=false');
    // Свой компьютер-юз и приложения ChatGPT — руки мимо красных линий.
    expect(настройки).toContain('features.computer_use=false');
    expect(настройки).toContain('features.apps=false');
    expect(args.join(' ')).toContain('--sandbox read-only');

    const сервер = настройки.find((н) => н.startsWith('mcp_servers.jarvis-talk='));
    expect(сервер).toContain('default_tools_approval_mode="approve"');
    expect(сервер).toContain(`enabled_tools=[${TALK_TOOLS.map((t) => `"${t}"`).join(',')}]`);
    expect(настройки.some((н) => н.startsWith('mcp_servers.jarvis-desktop'))).toBe(false);
    expect(args).toContain('--ignore-user-config');
  });

  it('первый ход заводит нить, следующий её продолжает — с теми же запретами', async () => {
    const codex = подставной([ответ('t1', 'Привет.'), ответ('t1', 'Потому что.')]);
    const разговор = new CodexTalkLive(опции(codex.spawn));

    expect(разговор.hasSpoken()).toBe(false);
    const первый = разговор.ask('вступление').result();
    await тик();
    codex.отпустить();
    expect((await первый).text).toBe('Привет.');
    expect(разговор.hasSpoken()).toBe(true);

    const второй = разговор.ask('а почему').result();
    await тик();
    codex.отпустить();
    expect((await второй).text).toBe('Потому что.');

    const [a1, a2] = codex.запуски.map((з) => з.args);
    expect(a1?.slice(0, 2)).toEqual(['exec', '--json']);
    expect(a2?.slice(0, 3)).toEqual(['exec', 'resume', 't1']);
    expect(a2).toContain('sandbox_mode="read-only"');
    expect(a2).toContain('features.shell_tool=false');
    expect(codex.запуски[1]?.stdin).toBe('а почему');
  });

  it('ходы идут по очереди: второй не запускается, пока идёт первый', async () => {
    const codex = подставной([ответ('t1', 'Первый.'), ответ('t1', 'Второй.')]);
    const разговор = new CodexTalkLive(опции(codex.spawn));

    const первый = разговор.ask('раз').result();
    const второй = разговор.ask('два').result();
    await тик();
    expect(codex.запуски).toHaveLength(1);

    codex.отпустить();
    await первый;
    await тик();
    expect(codex.запуски).toHaveLength(2);
    // Второй ход — уже продолжение нити, заведённой первым.
    expect(codex.запуски[1]?.args.slice(0, 3)).toEqual(['exec', 'resume', 't1']);
    codex.отпустить();
    expect((await второй).text).toBe('Второй.');
  });

  it('нить не завелась — следующий ход снова первый, с вступлением', async () => {
    const codex = подставной([['{"type":"turn.failed","error":{"message":"сеть"}}'], ответ('t2', 'Есть.')]);
    const разговор = new CodexTalkLive(опции(codex.spawn));

    const первый = разговор.ask('вступление').result();
    await тик();
    codex.отпустить();
    expect((await первый).ok).toBe(false);
    expect(разговор.hasSpoken()).toBe(false);

    const второй = разговор.ask('вступление').result();
    await тик();
    codex.отпустить();
    await второй;
    expect(codex.запуски[1]?.args).not.toContain('resume');
  });

  it('«забудь» гасит идущий ход, и он возвращается отменённым, а не ошибкой', async () => {
    const codex = подставной([ответ('t1', 'не успел')]);
    const разговор = new CodexTalkLive(опции(codex.spawn));

    const ход = разговор.ask('думай долго').result();
    await тик();
    разговор.dispose('Человек попросил забыть');

    const итог = await ход;
    expect(codex.отменены[0]).toBe(true);
    expect(итог.ok).toBe(false);
    expect(итог.cancelled).toBe(true);
    expect(разговор.isAlive()).toBe(false);

    // После закрытия новых процессов не бывает.
    expect((await разговор.ask('ещё').result()).cancelled).toBe(true);
    expect(codex.запуски).toHaveLength(1);
  });
});
