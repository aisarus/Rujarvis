import { describe, expect, it, vi } from 'vitest';
import {
  EventChannel,
  LineSplitter,
  looksUsageLimited,
  parseJsonLine,
  type CliHandle,
  type CliProcessOptions,
  type CliProcessOutcome,
} from './process';
import {
  ClaudeCodeBackend,
  buildClaudeArgs,
  consumeClaudeStreamLine,
  isVendorInternalPath,
  selectPermissionMode,
} from './claudeCode';
import {
  CodexBackend,
  MAX_CONSECUTIVE_RETRY_NOTICES,
  buildCodexArgs,
  consumeCodexStreamLine,
  createCodexLineConsumer,
  isRetryNotice,
  selectSandbox,
} from './codex';
import { createStreamState } from './cliRunner';
import { BackendManager, isBackendLevelFailure } from './manager';
import { buildBackendPrompt } from './prompt';
import { describeLessons, lessonsFrom } from '../memory/lessons';
import { DEFAULT_PERMISSIONS, READ_ONLY_PERMISSIONS } from '../types';
import type {
  AgentBackend,
  BackendEvent,
  BackendRequest,
  BackendResult,
  BackendRun,
} from './types';

function request(overrides: Partial<BackendRequest> = {}): BackendRequest {
  return {
    utterance: 'посмотри почему билд отъебнулся',
    capabilities: ['coding', 'files'],
    risk: 'normal',
    permissions: DEFAULT_PERMISSIONS,
    ...overrides,
  };
}

/** Collects every event a run emits, terminal event included. */
async function drain(run: BackendRun): Promise<BackendEvent[]> {
  const events: BackendEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
  }
  return events;
}

interface FakeCli extends CliHandle {
  options: CliProcessOptions;
}

/** Replays canned stdout lines, then exits with the given outcome. */
function fakeSpawn(
  lines: string[],
  outcome: Partial<CliProcessOutcome> = {},
): { spawn: (options: CliProcessOptions) => CliHandle; calls: FakeCli[] } {
  const calls: FakeCli[] = [];
  const spawn = (options: CliProcessOptions): CliHandle => {
    let cancelled = false;
    const handle: FakeCli = {
      options,
      cancel: () => {
        cancelled = true;
      },
      wait: async () => {
        for (const line of lines) options.onStdoutLine(line);
        return {
          exitCode: 0,
          signal: null,
          stderr: '',
          cancelled,
          timedOut: false,
          ...outcome,
        };
      },
    };
    calls.push(handle);
    return handle;
  };
  return { spawn, calls };
}

const readyProbe = {
  status: async () => ({ installed: true, loggedIn: true, version: '1.0.0', path: '/usr/bin/fake' }),
};

describe('EventChannel', () => {
  it('buffers events pushed before a consumer attaches', async () => {
    const channel = new EventChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.close();

    const seen: number[] = [];
    for await (const value of channel) seen.push(value);
    expect(seen).toEqual([1, 2]);
  });

  it('delivers to a waiting consumer and ends on close', async () => {
    const channel = new EventChannel<string>();
    const iterator = channel[Symbol.asyncIterator]();
    const pending = iterator.next();
    channel.push('a');
    await expect(pending).resolves.toEqual({ value: 'a', done: false });
    channel.close();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('ignores pushes after close instead of throwing', () => {
    const channel = new EventChannel<number>();
    channel.close();
    expect(() => channel.push(1)).not.toThrow();
  });
});

describe('LineSplitter', () => {
  it('holds an incomplete trailing line until it is finished', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\n')).toEqual(['{"b":2}']);
    expect(splitter.flush()).toEqual([]);
  });

  it('flushes a final line that never got a newline', () => {
    const splitter = new LineSplitter();
    splitter.push('{"a":1}');
    expect(splitter.flush()).toEqual(['{"a":1}']);
  });
});

describe('parseJsonLine', () => {
  it('returns null for interleaved human-readable output', () => {
    expect(parseJsonLine('Starting up...')).toBeNull();
    expect(parseJsonLine('{ broken')).toBeNull();
    expect(parseJsonLine('{"type":"x"}')).toEqual({ type: 'x' });
  });
});

describe('looksUsageLimited', () => {
  it('recognises quota refusals but not ordinary failures', () => {
    expect(looksUsageLimited('You have hit your usage limit')).toBe(true);
    expect(looksUsageLimited('429 Too Many Requests')).toBe(true);
    expect(looksUsageLimited('TypeError: cannot read property')).toBe(false);
  });
});

describe('buildBackendPrompt', () => {
  it('passes the raw utterance through verbatim, ahead of the normalised goal', () => {
    const prompt = buildBackendPrompt(
      request({ utterance: 'глянь чё с билдом', goal: 'Diagnose the failing build' }),
    );
    expect(prompt).toContain('глянь чё с билдом');
    expect(prompt.indexOf('глянь чё с билдом')).toBeLessThan(
      prompt.indexOf('Diagnose the failing build'),
    );
  });

  it('states the read-only envelope when editing is not permitted', () => {
    const prompt = buildBackendPrompt(request({ permissions: READ_ONLY_PERMISSIONS }));
    expect(prompt).toContain('Do NOT modify, create or delete any file');
  });

  it('говорит, куда класть файлы, когда папка задана', () => {
    // Без этого агент раскладывает результаты по временным каталогам, и
    // человек их больше не находит.
    const prompt = buildBackendPrompt(request({ outputDir: 'C:\\Users\\user\\Desktop\\Джарвис' }));
    expect(prompt).toContain('C:\\Users\\user\\Desktop\\Джарвис');
  });

  it('требует назвать путь и запрещает ссылаться на несуществующий чат', () => {
    // Человек слышит ответ голосом. «Файл в чате» для него — это «файла нет».
    const prompt = buildBackendPrompt(request({ outputDir: 'C:\\Users\\user\\Desktop\\Джарвис' }));
    expect(prompt).toContain('назови в ответе его полный путь');
    expect(prompt).toContain('«в чате»');
  });

  it('разбивает указания про файлы на строки, а не склеивает их', () => {
    // Этот блок однажды склеился литеральным «\n» и приехал одной кашей,
    // которую модель перестала замечать.
    const prompt = buildBackendPrompt(request({ outputDir: 'C:\\Users\\user\\Desktop\\Джарвис' }));
    expect(prompt).not.toContain('\\n');
    expect(prompt).toContain('WHERE FINISHED FILES GO:\nГотовые файлы');
  });

  it('не выдумывает папку, когда её не задали', () => {
    expect(buildBackendPrompt(request())).not.toContain('Готовые файлы');
  });

  it('asks for a Russian answer by default', () => {
    expect(buildBackendPrompt(request())).toContain('Write the final answer in Russian');
  });
});

/** Минимальный бэкенд: нужен только для того, чтобы он числился у менеджера. */
function stubBackend(id: 'openai-compatible' | 'claude-code' | 'codex'): AgentBackend {
  return {
    id,
    name: id,
    capabilities: new Set(),
    checkAvailability: async () => ({
      id,
      installed: true,
      authenticated: true,
      ready: true,
      checkedAt: 0,
    }),
    run: (): BackendRun => {
      throw new Error('этот бэкенд только числится');
    },
  };
}

describe('задача про рабочий стол не уходит тому, у кого нет инструментов', () => {
  it('управление экраном не откатывается туда, где нет инструментов', () => {
    // Живой случай. Claude Code сорвался, задача «открой блендер» ушла
    // интерпретеру — а у того нет ни одного инструмента Джарвиса. Он пять
    // минут дёргал СВОЙ драйвер рабочего стола, упёрся в «blocked by policy» и
    // сказал человеку «нужен режим Full Access». Всё это неправда: дело было
    // не в правах, а в том, что работать было нечем.
    //
    // Помощник, который не может сделать работу, обязан сказать это, а не
    // изображать работу другим способом.
    const manager = new BackendManager();
    for (const id of ['openai-compatible', 'claude-code', 'codex'] as const) {
      manager.register(stubBackend(id));
    }

    const plan = manager.plan(request({ capabilities: ['computer', 'reasoning'] }));

    expect(plan.order).toEqual(['claude-code']);
  });

  // Живой случай 20.09.2026: «Открой блендер и сделай ракету» — это и код, и
  // управление. Код проверяется раньше экрана, и в кодовой ветке откат на
  // интерпретер стоял без защиты. Клод Код сорвался, задача ушла туда, ключа
  // нет — и человек услышал «API Error: 401 API key is invalid» от системы,
  // у которой ключей нет вовсе. Соврать так — хуже, чем честно не смочь.
  it('задача про код И управление тоже не откатывается к ключам', () => {
    const manager = new BackendManager();
    for (const id of ['claude-code', 'codex', 'openai-compatible'] as const) {
      manager.register(stubBackend(id));
    }

    const plan = manager.plan(request({ capabilities: ['computer', 'coding', 'files'] }));

    expect(plan.order[0]).toBe('claude-code');
    expect(plan.order).not.toContain('openai-compatible');
  });

  it('но разговор и файлы откат сохраняют', () => {
    // Там локальная модель способна ответить, и молчать вместо ответа незачем.
    const manager = new BackendManager();
    for (const id of ['openai-compatible', 'claude-code'] as const) {
      manager.register(stubBackend(id));
    }

    expect(manager.plan(request({ capabilities: ['reasoning'] })).order).toContain('openai-compatible');
  });
});

describe('Claude Code adapter', () => {
  it('maps the permission envelope onto a CLI permission mode', () => {
    expect(selectPermissionMode(request({ permissions: READ_ONLY_PERMISSIONS }), false)).toBe('plan');
    expect(selectPermissionMode(request({ risk: 'normal' }), false)).toBe('acceptEdits');
    expect(selectPermissionMode(request({ risk: 'sensitive' }), false)).toBe('default');
    expect(selectPermissionMode(request({ risk: 'dangerous' }), true)).toBe('default');
  });

  it('подтверждение человека даёт право писать', () => {
    // Живой случай, стоивший часа работы. Джарвис спросил голосом, человек
    // согласился — и задача всё равно запустилась в режиме `default`. В
    // безголовом запуске он ничего не спрашивает: он молча отклоняет каждую
    // запись. Агент час переводил тексты и отчитался, что положить их никуда
    // не смог.
    //
    // Подтверждение, которое ничего не разрешает, — это не осторожность, а
    // театр: работа идёт, время тратится, результата нет.
    expect(selectPermissionMode(request({ risk: 'sensitive' }), false)).toBe('default');
    expect(selectPermissionMode(request({ risk: 'sensitive', approved: true }), false)).toBe(
      'acceptEdits',
    );
  });

  it('без подтверждения опасное так и остаётся спрашивающим', () => {
    expect(selectPermissionMode(request({ risk: 'dangerous' }), false)).toBe('default');
  });

  it('подтверждение не открывает то, что человек закрыл', () => {
    // Запрет на правку сильнее любого «да»: человек мог просить посмотреть, а
    // не менять.
    const looking = request({ risk: 'sensitive', approved: true });
    looking.permissions = { ...looking.permissions, edit: false };

    expect(selectPermissionMode(looking, false)).toBe('plan');
  });

  it('never selects bypassPermissions unless it was explicitly enabled', () => {
    expect(selectPermissionMode(request({ risk: 'safe' }), false)).toBe('acceptEdits');
    expect(selectPermissionMode(request({ risk: 'safe' }), true)).toBe('bypassPermissions');
  });

  it('builds headless arguments and resumes a session when one is given', () => {
    const args = buildClaudeArgs(request({ sessionId: 'sess-1' }), {
      permissionMode: 'acceptEdits',
      model: 'opus',
    });
    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus']));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'sess-1']));
  });

  it('hands Claude Code the desktop tools when the work needs the screen', () => {
    // Computer use lives behind an MCP server that Jarvis passes per run,
    // rather than registering it globally: a mouse-and-keyboard tool should be
    // available to the assistant's own agent, not to every Claude Code session
    // the user starts for unrelated work.
    const args = buildClaudeArgs(request({ capabilities: ['computer'] }), {
      permissionMode: 'acceptEdits',
      desktopMcpConfig: 'C:/jarvis/desktop.json',
    });
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', 'C:/jarvis/desktop.json']));

    // Headless Claude Code withholds the web tools unless they are named, and
    // an assistant that cannot look anything up is half an assistant.
    const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
    expect(allowed).toContain('WebSearch');
    expect(allowed).toContain('WebFetch');
    expect(allowed).toContain('mcp__jarvis-desktop__screenshot');
    expect(allowed).toContain('mcp__jarvis-desktop__remember');
  });

  it('грузит только свой MCP-сервер, а не чужие из настроек', () => {
    // В глобальных настройках человека висят мёртвые серверы: один отказывает,
    // другой ждёт таймаута тридцать секунд. Эта плата бралась с каждой задачи.
    const args = buildClaudeArgs(request({ capabilities: ['computer'] }), {
      permissionMode: 'acceptEdits',
      desktopMcpConfig: 'C:/jarvis/desktop.json',
    });
    expect(args).toContain('--strict-mcp-config');
  });

  it('показывает агенту, на чём он уже спотыкался', () => {
    // Самонаращивающийся кусок промпта: неудача из журнала сама становится
    // строкой следующего поручения, без обучения и без денег.
    const prompt = buildBackendPrompt({
      ...request({}),
      lessons: ['НА ЧЁМ ТЫ УЖЕ СПОТЫКАЛСЯ (не повторяй):', '- кириллица в скрипте'].join('\n'),
    });

    expect(prompt).toContain('НА ЧЁМ ТЫ УЖЕ СПОТЫКАЛСЯ');
    expect(prompt).toContain('кириллица в скрипте');
  });

  it('держит уроки в узде по размеру', () => {
    // Вход — самая дорогая часть работы агента. Кусок, растущий без предела,
    // съедает и время, и квоту на каждой задаче.
    const walls: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      walls.push(`совершенно разная стена о которую бились ${'очень '.repeat(20)}${i}`);
    }
    const events = walls.flatMap((wall, index) => [
      { at: 1_700_000_000_000 + index, kind: 'error' as const, text: wall },
      { at: 1_700_000_000_000 + index + 86_400_000, kind: 'error' as const, text: wall },
    ]);

    const block = describeLessons(lessonsFrom({ events })) ?? '';
    expect(block.length).toBeLessThan(1_000);
  });

  it('в фоне велит не лезть на экран, но проверять по-прежнему', () => {
    // «Работай в фоне» — про то, что человек не видит процесс, а не про то,
    // что проверок нет.
    const prompt = buildBackendPrompt(request({ capabilities: ['computer'], showWork: false }));

    expect(prompt).toContain('РАБОТАЙ В ФОНЕ');
    expect(prompt).toContain('Не открывай окна программ');
    expect(prompt).toContain('всё равно проверяй');
  });

  it('по умолчанию работает на виду', () => {
    expect(buildBackendPrompt(request({ capabilities: ['computer'] }))).not.toContain(
      'РАБОТАЙ В ФОНЕ',
    );
  });

  it('называет инструменты по делу, чтобы агент их не искал', () => {
    // Замер 19 сентября: ToolSearch вызывался четыре раза за одну задачу — на
    // 12-й, 104-й, 109-й и 115-й секундах. Инструментов тридцать пять, их
    // описания отдаются по запросу, и агент искал то, что у него уже было.
    const prompt = buildBackendPrompt(request({ capabilities: ['computer'] }));

    expect(prompt).toContain('blender_live_start');
    expect(prompt).toContain('blender_live');
    expect(prompt).toContain('page_ride');
    expect(prompt).toContain('move_to_output');
  });

  it('велит составить план и не останавливаться на полпути', () => {
    // «Получил команду, составил план и работает» — это и есть требование.
    // Помощник, спрашивающий разрешения на двадцатой минуте, ждёт у
    // клавиатуры, за которой никого нет.
    const prompt = buildBackendPrompt(request({}));

    expect(prompt).toContain('set_plan');
    expect(prompt).toContain('mark_step');
    expect(prompt).toContain('show_plan');
    expect(prompt).toContain('Не спрашивай разрешения посреди работы');
  });

  it('велит заглядывать, не сказал ли человек чего-нибудь', () => {
    const prompt = buildBackendPrompt(request({}));

    expect(prompt).toContain('check_notes');
    expect(prompt).toContain('две минуты');
  });

  it('рассказывает агенту, где он живёт', () => {
    // Права без знания бесполезны: агент, которому можно читать свою папку, но
    // который не знает, что она у него есть, туда не заглянет.
    const prompt = buildBackendPrompt({
      ...request({}),
      homeDir: 'C:/Users/user/AppData/Local/Rujarvis',
    });
    expect(prompt).toContain('C:/Users/user/AppData/Local/Rujarvis');
    expect(prompt).toContain('характер.md');
    expect(prompt).toContain('journal.json');
  });

  it('не выдумывает папку, которой не назвали', () => {
    expect(buildBackendPrompt(request({}))).not.toContain('ГДЕ ТЫ ЖИВЁШЬ');
  });

  it('даёт агенту читать собственную папку Джарвиса', () => {
    // «Дай ему права свободно читать собственную папку, чтоб он всё знал о
    // себе». Без этого он заперт в папке задачи: спросить «почему ты так
    // ответил» или «что у тебя в настройках» некому — свой же код и свой
    // журнал он прочитать не может.
    const args = buildClaudeArgs(request({}), {
      permissionMode: 'acceptEdits',
      homeDir: 'C:/Users/user/AppData/Local/Rujarvis',
      gateSettings: 'C:/jarvis/gate-settings.json',
    });
    expect(args).toEqual(
      expect.arrayContaining(['--add-dir', 'C:/Users/user/AppData/Local/Rujarvis']),
    );
  });

  it('даёт читать свою папку и там, где экран не нужен', () => {
    // Знание о себе не зависит от того, просили ли трогать мышь.
    const args = buildClaudeArgs(request({ capabilities: ['coding'] }), {
      permissionMode: 'acceptEdits',
      homeDir: 'C:/жарвис',
      gateSettings: 'C:/jarvis/gate-settings.json',
    });
    expect(args).toContain('--add-dir');
  });

  it('подключает хук красных линий к каждой работе', () => {
    const args = buildClaudeArgs(request({ capabilities: ['coding'] }), {
      permissionMode: 'acceptEdits',
      gateSettings: 'C:/jarvis/gate-settings.json',
    });
    expect(args).toEqual(expect.arrayContaining(['--settings', 'C:/jarvis/gate-settings.json']));
  });

  it('без хука не даёт оболочку, запись навыков и свою папку', () => {
    // В acceptEdits добавленная папка доступна на запись, а оболочка
    // выполняет что угодно: без хука некому спросить человека.
    const args = buildClaudeArgs(request({ capabilities: ['computer'] }), {
      permissionMode: 'acceptEdits',
      desktopMcpConfig: 'C:/jarvis/desktop.json',
      homeDir: 'C:/жарвис',
    });
    const allowed = (args[args.indexOf('--allowedTools') + 1] ?? '').split(',');
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--settings');
    expect(allowed).not.toContain('Bash');
    expect(allowed).not.toContain('mcp__jarvis-desktop__write_skill');
    expect(allowed).toContain('Read');
  });

  it('не добавляет папку, которой не назвали', () => {
    const args = buildClaudeArgs(request({}), { permissionMode: 'acceptEdits' });
    expect(args).not.toContain('--add-dir');
  });

  it('называет папку один раз, даже если она же и рабочая', () => {
    // Повтор безвреден, но мусорит в командной строке и путает при разборе
    // логов запуска.
    const args = buildClaudeArgs(request({ cwd: 'C:/жарвис' }), {
      permissionMode: 'acceptEdits',
      homeDir: 'C:/жарвис',
    });
    expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(0);
  });

  it('leaves the desktop tools out of work that does not touch the screen', () => {
    const args = buildClaudeArgs(request({ capabilities: ['coding'] }), {
      permissionMode: 'acceptEdits',
      desktopMcpConfig: 'C:/jarvis/desktop.json',
    });
    expect(args).not.toContain('--mcp-config');
  });

  it.each(['vision', 'files', 'browser', 'system'] as const)(
    'даёт инструменты рабочего стола задаче про %s',
    (capability) => {
      // Условие было «только capability computer», и из-за этого «нарисуй
      // картинку» (vision) и «положи файл в папку» (files) доходили до агента
      // вообще без инструментов: он не мог сделать ровно то, о чём просили.
      const args = buildClaudeArgs(request({ capabilities: [capability] }), {
        permissionMode: 'acceptEdits',
        desktopMcpConfig: 'C:/jarvis/desktop.json',
      });
      expect(args).toContain('--mcp-config');
    },
  );

  it('даёт агенту файловые инструменты, иначе он теряет то, что сделал', () => {
    const args = buildClaudeArgs(request({ capabilities: ['files'] }), {
      permissionMode: 'acceptEdits',
      desktopMcpConfig: 'C:/jarvis/desktop.json',
    });
    const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
    expect(allowed).toContain('mcp__jarvis-desktop__output_folder');
    expect(allowed).toContain('mcp__jarvis-desktop__move_to_output');
    expect(allowed).toContain('mcp__jarvis-desktop__show_file');
    expect(allowed).toContain('mcp__jarvis-desktop__blender_python');
  });

  it('turns the stream into files, commands and a final answer', () => {
    const state = createStreamState();
    const events: BackendEvent[] = [];
    const emit = (event: BackendEvent): void => {
      events.push(event);
    };

    consumeClaudeStreamLine(
      { type: 'system', subtype: 'init', session_id: 'abc' },
      state,
      emit,
    );
    consumeClaudeStreamLine(
      {
        type: 'assistant',
        session_id: 'abc',
        message: {
          content: [
            { type: 'text', text: 'Смотрю конфигурацию.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'pnpm build' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/p/vite.config.ts' } },
            { type: 'tool_use', name: 'Write', input: { file_path: '/p/new.ts' } },
          ],
        },
      },
      state,
      emit,
    );
    consumeClaudeStreamLine(
      { type: 'result', subtype: 'success', result: 'Починил конфиг запуска.', session_id: 'abc' },
      state,
      emit,
    );

    expect(state.sessionId).toBe('abc');
    expect(state.text).toBe('Починил конфиг запуска.');
    expect(state.commands).toEqual(['pnpm build']);
    expect(state.filesChanged).toEqual([
      { path: '/p/vite.config.ts', action: 'modified' },
      { path: '/p/new.ts', action: 'created' },
    ]);
    expect(state.errorMessage).toBeUndefined();
    expect(events.filter((event) => event.type === 'command')).toHaveLength(1);
  });

  it('does not report the CLI\'s own plan file as a change to the user\'s work', () => {
    // Observed in a real run: plan mode writes ~/.claude/plans/… and the
    // progress list announced "Создан файл" to someone who had just said
    // «ничего не меняй».
    expect(isVendorInternalPath('/root/.claude/plans/some-plan.md')).toBe(true);
    expect(isVendorInternalPath('C:\\Users\\me\\.codex\\sessions\\x.json')).toBe(true);
    expect(isVendorInternalPath('/home/user/project/src/a.ts')).toBe(false);

    const state = createStreamState();
    const events: BackendEvent[] = [];
    consumeClaudeStreamLine(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/root/.claude/plans/p.md' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/home/user/project/a.ts' } },
          ],
        },
      },
      state,
      (event) => events.push(event),
    );

    expect(state.filesChanged).toEqual([{ path: '/home/user/project/a.ts', action: 'modified' }]);
    expect(events.some((event) => event.type === 'tool' && event.detail?.includes('.claude'))).toBe(false);
  });

  it('flags a quota refusal so the manager can fall back', () => {
    const state = createStreamState();
    consumeClaudeStreamLine(
      { type: 'result', subtype: 'error_during_execution', result: 'Claude usage limit reached', is_error: true },
      state,
      () => {},
    );
    expect(state.usageLimited).toBe(true);
    expect(state.errorMessage).toContain('usage limit');
  });

  it('runs end to end against a fake CLI', async () => {
    const { spawn, calls } = fakeSpawn([
      '{"type":"system","subtype":"init","session_id":"s1"}',
      'Some non-JSON noise',
      '{"type":"result","subtype":"success","result":"Готово.","session_id":"s1"}',
    ]);
    const backend = new ClaudeCodeBackend({ probe: readyProbe, spawnCli: spawn });

    const run = backend.run(request());
    const events = await drain(run);
    const result = await run.result();

    expect(result.ok).toBe(true);
    expect(result.text).toBe('Готово.');
    expect(result.sessionId).toBe('s1');
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    expect(calls[0]?.options.args).toContain('stream-json');
    // The prompt reaches the CLI over stdin, not on the command line.
    expect(calls[0]?.options.stdin).toContain('посмотри почему билд отъебнулся');
    expect(calls[0]?.options.args.join(' ')).not.toContain('посмотри');
  });

  it('runs anyway when authentication cannot be proven either way', async () => {
    // A real installed CLI with no credential file still works in managed and
    // env-authenticated setups; refusing it outright loses a working backend.
    const { spawn } = fakeSpawn([
      '{"type":"result","subtype":"success","result":"Готово."}',
    ]);
    const backend = new ClaudeCodeBackend({
      probe: {
        status: async () => ({
          installed: true,
          loggedIn: 'unknown' as const,
          path: '/usr/bin/fake',
        }),
      },
      spawnCli: spawn,
    });

    const availability = await backend.checkAvailability();
    expect(availability.ready).toBe(true);
    expect(availability.authenticated).toBe(false);
    // Отказ говорится ВСЛУХ, и человек на том конце может не знать слов
    // «CLI» и «аккаунт». Проверяем смысл, а не прежнюю формулировку: названо,
    // к кому обратиться и что сделать.
    expect(availability.reason).toContain('кто меня ставил');
    expect(availability.reason).toMatch(/войти/u);
    expect(availability.reason).not.toMatch(/CLI/u);

    const result = await backend.run(request()).result();
    expect(result.ok).toBe(true);
  });

  it('still refuses when the CLI is definitely not signed in', async () => {
    const backend = new ClaudeCodeBackend({
      probe: { status: async () => ({ installed: true, loggedIn: false }) },
      spawnCli: () => {
        throw new Error('should not spawn');
      },
    });
    const availability = await backend.checkAvailability();
    expect(availability.ready).toBe(false);
    expect(availability.reason).toContain('вход не выполнен');
  });

  it('reports an unavailable CLI as a result instead of throwing', async () => {
    const backend = new ClaudeCodeBackend({
      probe: { status: async () => ({ installed: false, loggedIn: false }) },
      spawnCli: () => {
        throw new Error('should not spawn');
      },
    });

    const result = await backend.run(request()).result();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('кто меня ставил');
    expect(result.error).toMatch(/установить/u);
    expect(result.error).not.toMatch(/CLI/u);
  });

  it('survives a probe that rejects', async () => {
    const backend = new ClaudeCodeBackend({
      probe: {
        status: async () => {
          throw new Error('keychain locked');
        },
      },
    });
    const availability = await backend.checkAvailability();
    expect(availability.ready).toBe(false);
    expect(availability.reason).toContain('keychain locked');
  });

  it('caches availability until the TTL expires or it is invalidated', async () => {
    const status = vi.fn(async () => ({ installed: true, loggedIn: true }));
    let clock = 1_000;
    const backend = new ClaudeCodeBackend({
      probe: { status },
      availabilityTtlMs: 5_000,
      now: () => clock,
    });

    await backend.checkAvailability();
    await backend.checkAvailability();
    expect(status).toHaveBeenCalledTimes(1);

    clock += 6_000;
    await backend.checkAvailability();
    expect(status).toHaveBeenCalledTimes(2);

    backend.invalidate();
    await backend.checkAvailability();
    expect(status).toHaveBeenCalledTimes(3);
  });
});

describe('Codex adapter', () => {
  it('maps the permission envelope onto a sandbox level', () => {
    expect(selectSandbox(request({ permissions: READ_ONLY_PERMISSIONS }), true)).toBe('read-only');
    expect(selectSandbox(request({ risk: 'normal' }), false)).toBe('workspace-write');
    expect(selectSandbox(request({ risk: 'safe' }), false)).toBe('workspace-write');
    expect(selectSandbox(request({ risk: 'safe' }), true)).toBe('danger-full-access');
  });

  it('builds exec arguments, resumes a thread and reads the prompt from stdin', () => {
    const args = buildCodexArgs(request({ sessionId: 'thread-9', cwd: 'D:\\Projects\\aegis' }), {
      sandbox: 'workspace-write',
    });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9']);
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(args).toEqual(expect.arrayContaining(['--cd', 'D:\\Projects\\aegis']));
    expect(args.at(-1)).toBe('-');
  });

  it('reads the thread-event schema', () => {
    const state = createStreamState();
    const events: BackendEvent[] = [];
    const emit = (event: BackendEvent): void => {
      events.push(event);
    };

    consumeCodexStreamLine({ type: 'thread.started', thread_id: 't1' }, state, emit);
    consumeCodexStreamLine(
      { type: 'item.completed', item: { type: 'command_execution', command: 'npm test', exit_code: 0 } },
      state,
      emit,
    );
    consumeCodexStreamLine(
      {
        type: 'item.completed',
        item: { type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }] },
      },
      state,
      emit,
    );
    consumeCodexStreamLine(
      { type: 'item.completed', item: { type: 'assistant_message', text: 'Готово.' } },
      state,
      emit,
    );

    expect(state.sessionId).toBe('t1');
    expect(state.commands).toEqual(['npm test']);
    expect(state.filesChanged).toEqual([
      { path: 'src/a.ts', action: 'modified' },
      { path: 'src/b.ts', action: 'created' },
    ]);
    expect(state.text).toBe('Готово.');
  });

  it('also reads the older msg envelope', () => {
    const state = createStreamState();
    consumeCodexStreamLine(
      { id: '0', msg: { type: 'session_configured', session_id: 'legacy-1' } },
      state,
      () => {},
    );
    consumeCodexStreamLine(
      { id: '1', msg: { type: 'exec_command_begin', command: ['pnpm', 'build'] } },
      state,
      () => {},
    );
    consumeCodexStreamLine(
      { id: '2', msg: { type: 'agent_message', message: 'Собрал.' } },
      state,
      () => {},
    );

    expect(state.sessionId).toBe('legacy-1');
    expect(state.commands).toEqual(['pnpm build']);
    expect(state.text).toBe('Собрал.');
  });

  it('marks a failed turn as an error and detects a quota refusal', () => {
    const state = createStreamState();
    consumeCodexStreamLine(
      { type: 'turn.failed', error: { message: 'You have reached your usage limit' } },
      state,
      () => {},
    );
    expect(state.errorMessage).toContain('usage limit');
    expect(state.usageLimited).toBe(true);
  });

  it('runs end to end against a fake CLI', async () => {
    const { spawn } = fakeSpawn([
      '{"type":"thread.started","thread_id":"t7"}',
      '{"type":"item.completed","item":{"type":"assistant_message","text":"Сделал."}}',
      '{"type":"turn.completed"}',
    ]);
    const backend = new CodexBackend({ probe: readyProbe, spawnCli: spawn });

    const result = await backend.run(request()).result();
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Сделал.');
    expect(result.sessionId).toBe('t7');
  });

  it('tells a retry notice apart from a real failure', () => {
    // Taken verbatim from a real run against a blocked endpoint.
    for (const notice of [
      'Reconnecting... 2/5 (stream disconnected before completion: URL error: Proxy connection failed)',
      'Reconnecting... waiting for network (Connection failed: error sending request)',
      'Falling back from WebSockets to HTTPS transport. stream disconnected before completion',
    ]) {
      expect(isRetryNotice(notice)).toBe(true);
    }
    expect(isRetryNotice('You have hit your usage limit')).toBe(false);
    expect(isRetryNotice('SyntaxError: unexpected token')).toBe(false);
  });

  it('shows a retry as progress, not as a red error line', () => {
    const state = createStreamState();
    const events: BackendEvent[] = [];
    consumeCodexStreamLine(
      { type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion)' },
      state,
      (event) => events.push(event),
    );
    expect(events).toEqual([
      { type: 'status', backend: 'codex', text: 'Переподключаюсь…' },
    ]);
    expect(state.errorMessage).toBeUndefined();
  });

  it('classifies a retry notice the same way whichever schema carries it', () => {
    const notice = 'Reconnecting... waiting for network';
    for (const line of [
      { type: 'error', message: notice },
      { type: 'item.completed', item: { type: 'error', message: notice } },
      { id: '1', msg: { type: 'error', message: notice } },
    ]) {
      const state = createStreamState();
      const events: BackendEvent[] = [];
      consumeCodexStreamLine(line, state, (event) => events.push(event));
      expect(events.map((event) => event.type)).toEqual(['status']);
      expect(state.errorMessage).toBeUndefined();
    }
  });

  it('gives up once retries make clear the network is unavailable', () => {
    // Without this the run sat until its timeout: the CLI retries, falls back
    // to another transport, then waits for a network that never arrives, with
    // no terminal event of its own.
    const consume = createCodexLineConsumer();
    const state = createStreamState();
    for (let index = 0; index < MAX_CONSECUTIVE_RETRY_NOTICES; index += 1) {
      expect(state.fatalMessage).toBeUndefined();
      consume({ type: 'error', message: 'Reconnecting... waiting for network' }, state, () => {});
    }
    expect(state.fatalMessage).toContain('не может подключиться к сети');
  });

  it('does not give up while real progress keeps arriving between retries', () => {
    const consume = createCodexLineConsumer();
    const state = createStreamState();
    for (let index = 0; index < MAX_CONSECUTIVE_RETRY_NOTICES * 2; index += 1) {
      consume({ type: 'error', message: 'Reconnecting... waiting for network' }, state, () => {});
      consume(
        { type: 'item.completed', item: { type: 'assistant_message', text: 'ещё работаю' } },
        state,
        () => {},
      );
    }
    expect(state.fatalMessage).toBeUndefined();
  });

  it('stops the process and reports the reason rather than calling it a cancel', async () => {
    const retries = Array.from(
      { length: MAX_CONSECUTIVE_RETRY_NOTICES },
      () => '{"type":"error","message":"Reconnecting... waiting for network"}',
    );
    const { spawn } = fakeSpawn(retries, { cancelled: true });
    const backend = new CodexBackend({ probe: readyProbe, spawnCli: spawn });

    const result = await backend.run(request()).result();
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBeUndefined();
    expect(result.error).toContain('не может подключиться к сети');
  });

  it('reports a missing sign-in without spawning', async () => {
    const backend = new CodexBackend({
      probe: { status: async () => ({ installed: true, loggedIn: false }) },
    });
    const result = await backend.run(request()).result();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('codex login');
  });
});

describe('BackendManager', () => {
  function stubBackend(
    id: AgentBackend['id'],
    results: BackendResult | (() => BackendResult),
    ready = true,
  ): AgentBackend & { runs: number } {
    const backend = {
      id,
      name: id,
      runs: 0,
      capabilities: new Set<never>(),
      checkAvailability: async () => ({
        id,
        installed: ready,
        authenticated: ready,
        ready,
        checkedAt: 0,
      }),
      run: (): BackendRun => {
        backend.runs += 1;
        const result = typeof results === 'function' ? results() : results;
        const channel = new EventChannel<BackendEvent>();
        channel.push({ type: 'completed', backend: id, result });
        channel.close();
        return {
          id: `${id}-run`,
          backend: id,
          events: channel,
          cancel: () => {},
          result: () => Promise.resolve(result),
        };
      },
    } as unknown as AgentBackend & { runs: number };
    return backend;
  }

  function result(overrides: Partial<BackendResult>): BackendResult {
    return {
      ok: false,
      backend: 'claude-code',
      text: '',
      durationMs: 1,
      filesChanged: [],
      commands: [],
      ...overrides,
    };
  }

  function managerWith(...backends: AgentBackend[]): BackendManager {
    const manager = new BackendManager();
    for (const backend of backends) manager.register(backend);
    return manager;
  }

  it('отдаёт работу с экраном агенту, у которого есть инструменты и скиллы', () => {
    // Инструменты рабочего стола и скиллы под программы есть только у Claude
    // Code. Рантайм, получавший такие задачи раньше, не видел ни того ни
    // другого — и не мог ни собрать сцену в Blender, ни положить файл человеку.
    const manager = managerWith(
      stubBackend('openai-compatible', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
    );
    const plan = manager.plan(request({ capabilities: ['computer', 'vision'] }));
    expect(plan.order[0]).toBe('claude-code');
  });

  it('оставляет Codex запасным для работы с файлами без мыши', () => {
    const manager = managerWith(
      stubBackend('codex', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
    );
    const plan = manager.plan(request({ capabilities: ['files'] }));
    expect(plan.order).toEqual(['claude-code', 'codex']);
  });

  it('отправляет переписку Claude Code — окна мессенджеров открываются только его инструментами', () => {
    const manager = managerWith(
      stubBackend('codex', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
    );
    const plan = manager.plan(request({ capabilities: ['communication'] }));
    expect(plan.order[0]).toBe('claude-code');
  });

  it('sends coding work to the preferred coding backend first', () => {
    const manager = managerWith(
      stubBackend('openai-compatible', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
      stubBackend('codex', result({ ok: true })),
    );
    expect(manager.plan(request(), { codingPreference: 'codex' }).order[0]).toBe('codex');
    expect(manager.plan(request(), { codingPreference: 'auto' }).order[0]).toBe('claude-code');
  });

  it('honours a backend named in the utterance', () => {
    const manager = managerWith(
      stubBackend('openai-compatible', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
      stubBackend('codex', result({ ok: true })),
    );
    const plan = manager.plan(request({ capabilities: ['computer'] }), { requested: 'codex' });
    expect(plan.order[0]).toBe('codex');
    expect(plan.rationale).toContain('codex');
  });

  it('keeps the other coding backend behind an explicitly requested one', () => {
    // «Отдай Кодексу» plus an exhausted Codex must still reach Claude Code;
    // otherwise naming a backend silently gives up the coding fallback.
    const manager = managerWith(
      stubBackend('openai-compatible', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
      stubBackend('codex', result({ ok: true })),
    );
    const plan = manager.plan(request(), { requested: 'codex' });
    expect(plan.order.slice(0, 2)).toEqual(['codex', 'claude-code']);
    expect(plan.order.indexOf('claude-code')).toBeLessThan(plan.order.indexOf('openai-compatible'));
  });

  it('does not drag coding backends into a desktop request', () => {
    const manager = managerWith(
      stubBackend('openai-compatible', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
      stubBackend('codex', result({ ok: true })),
    );
    const plan = manager.plan(request({ capabilities: ['computer'] }));
    expect(plan.order).not.toContain('codex');
  });

  it('falls back from a named Codex to Claude Code when Codex cannot connect', async () => {
    const codex = stubBackend(
      'codex',
      result({ backend: 'codex', error: 'Codex не может подключиться к сети.' }),
    );
    const claude = stubBackend('claude-code', result({ ok: true, text: 'Готово.' }));
    const manager = managerWith(codex, claude, stubBackend('openai-compatible', result({ ok: true })));

    const final = await manager.run(request(), { requested: 'codex' }).result();
    expect(codex.runs).toBe(1);
    expect(claude.runs).toBe(1);
    expect(final.ok).toBe(true);
  });

  it('drops an excluded backend from the whole chain', () => {
    const manager = managerWith(
      stubBackend('openai-compatible', result({ ok: true })),
      stubBackend('claude-code', result({ ok: true })),
      stubBackend('codex', result({ ok: true })),
    );
    const plan = manager.plan(request(), { excluded: ['claude-code'] });
    expect(plan.order).not.toContain('claude-code');
  });

  it('falls back to the next backend when a quota is exhausted', async () => {
    const claude = stubBackend('claude-code', result({ usageLimited: true, error: 'limit' }));
    const codex = stubBackend('codex', result({ ok: true, backend: 'codex', text: 'Готово.' }));
    const manager = managerWith(claude, codex, stubBackend('openai-compatible', result({ ok: true })));

    const run = manager.run(request(), { codingPreference: 'claude-code' });
    const events = await drain(run);
    const final = await run.result();

    expect(claude.runs).toBe(1);
    expect(codex.runs).toBe(1);
    expect(final.ok).toBe(true);
    expect(final.backend).toBe('codex');
    expect(events.some((event) => event.type === 'status' && event.text.includes('codex'))).toBe(true);
  });

  it('does not second-guess an honest failure from a backend that ran', async () => {
    const claude = stubBackend(
      'claude-code',
      result({ ok: false, text: 'Не смог починить: нужен доступ к приватному пакету.' }),
    );
    const codex = stubBackend('codex', result({ ok: true, text: 'Готово.' }));
    const manager = managerWith(claude, codex);

    const final = await manager.run(request(), { codingPreference: 'claude-code' }).result();
    expect(codex.runs).toBe(0);
    expect(final.ok).toBe(false);
  });

  it('reports every failure when nothing works, without throwing', async () => {
    const manager = managerWith(
      stubBackend('claude-code', result({ error: 'нет CLI' })),
      stubBackend('codex', result({ backend: 'codex', error: 'нет входа' })),
    );
    const final = await manager.run(request()).result();
    expect(final.ok).toBe(false);
    expect(final.error).toContain('нет CLI');
    expect(final.error).toContain('нет входа');
  });

  it('survives a backend whose run() throws synchronously', async () => {
    const exploding = {
      id: 'claude-code',
      name: 'boom',
      capabilities: new Set(),
      checkAvailability: async () => ({
        id: 'claude-code' as const,
        installed: true,
        authenticated: true,
        ready: true,
        checkedAt: 0,
      }),
      run: () => {
        throw new Error('adapter exploded');
      },
    } as unknown as AgentBackend;

    const manager = managerWith(exploding, stubBackend('codex', result({ ok: true, backend: 'codex', text: 'ок' })));
    const final = await manager.run(request(), { codingPreference: 'claude-code' }).result();
    expect(final.ok).toBe(true);
    expect(final.backend).toBe('codex');
  });

  it('reports no backends at all as a result, not an exception', async () => {
    const final = await new BackendManager().run(request()).result();
    expect(final.ok).toBe(false);
    expect(final.error).toContain('Нет доступных backend');
  });
});

describe('isBackendLevelFailure', () => {
  const base: BackendResult = {
    ok: false,
    backend: 'claude-code',
    text: '',
    durationMs: 0,
    filesChanged: [],
    commands: [],
  };

  it('treats a quota refusal and a silent death as backend-level', () => {
    expect(isBackendLevelFailure({ ...base, usageLimited: true, text: 'anything' })).toBe(true);
    expect(isBackendLevelFailure({ ...base, error: 'spawn ENOENT' })).toBe(true);
  });

  it('treats an answered failure, a cancellation and a timeout as final', () => {
    expect(isBackendLevelFailure({ ...base, text: 'не получилось, вот почему' })).toBe(false);
    expect(isBackendLevelFailure({ ...base, cancelled: true })).toBe(false);
    expect(isBackendLevelFailure({ ...base, timedOut: true })).toBe(false);
    expect(isBackendLevelFailure({ ...base, ok: true })).toBe(false);
  });
});

describe('самозапись навыков', () => {
  it('объясняет агенту, когда записывать найденное', () => {
    // Иначе выясненное с трудом живёт до конца задачи, а в следующий раз
    // выясняется заново — человеком, вручную.
    const prompt = buildBackendPrompt(request({ capabilities: ['computer'] }));
    expect(prompt).toContain('write_skill');
    expect(prompt).toContain('list_skills');
  });

  it('не зовёт записывать навыки там, где нет инструментов', () => {
    expect(buildBackendPrompt(request({ capabilities: ['reasoning'] }))).not.toContain('write_skill');
  });
});

describe('свои постоянные указания', () => {
  it('подмешивает их в каждый запрос', () => {
    // Человек правит файл характера — и это должно действовать сразу,
    // без пересборки и без меня.
    const prompt = buildBackendPrompt(
      request({ instructions: 'Отвечай коротко. Не извиняйся.' }),
    );
    expect(prompt).toContain('Отвечай коротко. Не извиняйся.');
  });

  it('ставит их раньше остального — они главнее', () => {
    const prompt = buildBackendPrompt(
      request({ instructions: 'ПОСТОЯННОЕ УКАЗАНИЕ', utterance: 'сделай что-нибудь' }),
    );
    expect(prompt.indexOf('ПОСТОЯННОЕ УКАЗАНИЕ')).toBeLessThan(prompt.indexOf('сделай что-нибудь'));
  });

  it('не оставляет пустого места, когда указаний нет', () => {
    const prompt = buildBackendPrompt(request());
    expect(prompt).not.toContain('ПОСТОЯННЫЕ УКАЗАНИЯ');
  });

  it('не ломается на пробельных указаниях', () => {
    expect(buildBackendPrompt(request({ instructions: '   ' }))).not.toContain('ПОСТОЯННЫЕ УКАЗАНИЯ');
  });
});
