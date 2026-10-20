import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { bundledGeminiCli, commonCliPaths, hasGeminiLogin } from './cliProbes';
import { createStreamState } from './cliRunner';
import {
  buildGeminiArgs,
  createGeminiLineConsumer,
  explainGeminiFailure,
  GeminiBackend,
  overridesJarvisServer,
  policyFailed,
  protectedRootsFor,
  serverEnv,
} from './gemini';
import { adminPoliciesPresent, geminiEnv, geminiLoginEnv, geminiSettings, GEMINI_CORE_TOOLS } from './geminiHome';
import { allowedWritePatterns, geminiAcceptsPattern, geminiPolicy, protectedWritePatterns, rootPattern } from './geminiPolicy';
import { BackendManager } from './manager';
import type { CliHandle, CliProcessOptions, CliProcessOutcome } from './process';
import { DEFAULT_PERMISSIONS, READ_ONLY_PERMISSIONS } from '../types';
import type { AgentBackend, BackendEvent, BackendRequest, BackendResult, BackendRun } from './types';

/**
 * Gemini CLI в Джарвисе — третий агент, на тех же красных линиях.
 *
 * Хук `BeforeTool` у Gemini на собственном сбое пропускает вызов (замер на
 * 0.64.0: упавший, зависший и бормочущий хук — запись прошла), поэтому
 * проверка здесь — путь «Б»: политика его же движка на уровне администратора
 * и сервер Джарвиса с проверкой внутри. Эти тесты держат то, что видно без
 * запуска CLI; живой прогон — `scripts/qa/gemini-check.ts`.
 */

function request(overrides: Partial<BackendRequest> = {}): BackendRequest {
  return {
    utterance: 'сделай конспект по главе',
    capabilities: ['files', 'reasoning'],
    risk: 'normal',
    permissions: DEFAULT_PERMISSIONS,
    ...overrides,
  };
}

interface FakeCli extends CliHandle {
  options: CliProcessOptions;
}

function fakeSpawn(
  lines: string[],
  outcome: Partial<CliProcessOutcome> = {},
  stderrChunks: string[] = [],
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
        for (const chunk of stderrChunks) options.onStderrChunk?.(chunk);
        // Остановленный процесс дальше не пишет.
        for (const line of lines) if (!cancelled) options.onStdoutLine(line);
        return { exitCode: 0, signal: null, stderr: stderrChunks.join(''), cancelled, timedOut: false, ...outcome };
      },
    };
    calls.push(handle);
    return handle;
  };
  return { spawn, calls };
}

/** Строки потока, снятые с настоящего Gemini CLI 0.64.0 20.10.2026. */
const ПОТОК = [
  '{"type":"init","timestamp":"2026-10-20T11:07:27.418Z","session_id":"36a5a535-9054-4ba6-a7a1-46fec2bdc40e","model":"auto"}',
  '{"type":"message","timestamp":"2026-10-20T11:07:27.420Z","role":"user","content":"напиши файл\\n"}',
  '{"type":"tool_use","timestamp":"2026-10-20T11:07:27.511Z","tool_name":"write_file","tool_id":"write_file__1","parameters":{"file_path":"hello.txt","content":"hi"}}',
  '{"type":"tool_result","timestamp":"2026-10-20T11:07:27.550Z","tool_id":"write_file__1","status":"success"}',
  '{"type":"message","timestamp":"2026-10-20T11:07:27.559Z","role":"assistant","content":"Гото","delta":true}',
  '{"type":"message","timestamp":"2026-10-20T11:07:27.560Z","role":"assistant","content":"во.","delta":true}',
  '{"type":"result","timestamp":"2026-10-20T11:07:27.561Z","status":"success","stats":{"total_tokens":38,"input_tokens":30,"output_tokens":8}}',
];

function дом(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'jarvis-gemini-test-'));
}

const readyProbe = { status: async () => ({ installed: true, loggedIn: true as const, version: '0.64.0', path: '/usr/bin/gemini' }) };

function backend(overrides: Partial<ConstructorParameters<typeof GeminiBackend>[0]> = {}): GeminiBackend {
  return new GeminiBackend({ probe: readyProbe, home: дом(), adminPolicies: () => false, ...overrides });
}

/** Строка аргументов так, как её сверяет Gemini: ключи по алфавиту, каждая пара в `\0`. */
function аргументы(args: Record<string, unknown>): string {
  const пары = Object.keys(args)
    .sort()
    .map((ключ) => `\0${JSON.stringify(ключ)}:${JSON.stringify(args[ключ])}\0`);
  return `{${пары.join(',')}}`;
}

describe('аргументы запуска Gemini', () => {
  const полный = buildGeminiArgs({
    policyFile: 'C:\\Rujarvis\\data\\gemini\\run-policies\\a.toml',
    server: 'jarvis-desktop',
    approval: 'auto_edit',
    model: 'flash',
    sessionId: 'abc',
    include: ['C:\\Users\\Иван\\Desktop\\Джарвис'],
  });

  it('безголовый поток, политика администратора и только сервер Джарвиса', () => {
    expect(полный).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
    expect(полный).toEqual(expect.arrayContaining(['--admin-policy', 'C:\\Rujarvis\\data\\gemini\\run-policies\\a.toml']));
    expect(полный).toEqual(expect.arrayContaining(['--allowed-mcp-server-names', 'jarvis-desktop']));
    expect(полный).toEqual(expect.arrayContaining(['--extensions', 'none']));
    expect(полный).toEqual(expect.arrayContaining(['--approval-mode', 'auto_edit']));
    expect(полный).toEqual(expect.arrayContaining(['--resume', 'abc']));
    expect(полный).toEqual(expect.arrayContaining(['--include-directories', 'C:\\Users\\Иван\\Desktop\\Джарвис']));
    // Без доверия к папке безголовый Gemini не запускается вовсе.
    expect(полный).toContain('--skip-trust');
  });

  it('без сервера — ни одного сервера, а не все из настроек', () => {
    const args = buildGeminiArgs({ policyFile: 'p.toml', approval: 'default' });
    expect(args[args.indexOf('--allowed-mcp-server-names') + 1]).toBe('none');
    expect(args).not.toContain('--resume');
  });

  it('никогда не yolo и не промпт в командной строке: он идёт через stdin', () => {
    for (const args of [полный, buildGeminiArgs({ policyFile: 'p.toml', approval: 'default' })]) {
      expect(args).not.toContain('--yolo');
      expect(args).not.toContain('-y');
      expect(args.join(' ')).not.toMatch(/approval-mode yolo|-p\b|--prompt/u);
    }
  });
});

describe('настройки и окружение Gemini', () => {
  it('вход только через Google, без кредитов, без телеметрии и без оболочки', () => {
    const s = geminiSettings() as {
      security: { auth: { selectedType: string; enforcedType: string } };
      billing: { overageStrategy: string };
      privacy: { usageStatisticsEnabled: boolean };
      telemetry: { enabled: boolean };
      tools: { core: string[]; exclude: string[] };
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(s.security.auth).toEqual({ selectedType: 'oauth-personal', enforcedType: 'oauth-personal' });
    expect(s.billing.overageStrategy).toBe('never');
    expect(s.privacy.usageStatisticsEnabled).toBe(false);
    expect(s.telemetry.enabled).toBe(false);
    expect(s.tools.core).not.toContain('run_shell_command');
    expect(s.tools.exclude).toContain('run_shell_command');
    expect(GEMINI_CORE_TOOLS).not.toContain('activate_skill');
    // Сервер описан переменными: настройки одни на работу и разговор.
    expect(s.mcpServers['jarvis-desktop']).toEqual(expect.objectContaining({ command: '$JARVIS_GEMINI_MCP_COMMAND' }));
    expect(s.mcpServers['jarvis-talk']).toEqual(expect.objectContaining({ args: ['$JARVIS_GEMINI_MCP_SCRIPT'] }));
  });

  it('окружение без ключей и обходов входа, свой дом, без браузера', () => {
    const env = geminiEnv('/jarvis/data/gemini', {
      PATH: '/bin',
      GEMINI_API_KEY: 'AIza-нельзя',
      google_api_key: 'и-так-нельзя',
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_APPLICATION_CREDENTIALS: '/sa.json',
      GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'true',
      GEMINI_CLI_HOME: '/чужой',
    });
    for (const ключ of Object.keys(env)) {
      expect(ключ.toUpperCase()).not.toMatch(/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_APPLICATION_CREDENTIALS|GEMINI_FORCE_ENCRYPTED_FILE_STORAGE)$/u);
    }
    expect(env.GEMINI_CLI_HOME).toBe('/jarvis/data/gemini');
    expect(env.NO_BROWSER).toBe('true');
    expect(env.PATH).toBe('/bin');
  });

  it('окно входа: тот же дом, ключи убраны, браузер разрешён', () => {
    const env = geminiLoginEnv('/jarvis/data/gemini');
    expect(env.GEMINI_CLI_HOME).toBe('/jarvis/data/gemini');
    expect(env.GEMINI_API_KEY).toBe('');
    expect(env.GOOGLE_API_KEY).toBe('');
    expect(env).not.toHaveProperty('NO_BROWSER');
  });

  it('политики администратора на машине — Gemini работать не пускают; не прочли папку — тоже', () => {
    expect(adminPoliciesPresent('win32', () => [])).toBe(false);
    expect(adminPoliciesPresent('win32', () => ['readme.txt'])).toBe(false);
    expect(adminPoliciesPresent('win32', () => ['company.TOML'])).toBe(true);
    expect(
      adminPoliciesPresent('linux', () => {
        throw new Error('EACCES');
      }),
    ).toBe(true);
  });
});

describe('политика запуска: белый список', () => {
  it('сначала запрещено всё, оболочка запрещена поверх всего', () => {
    const текст = geminiPolicy({ builtins: ['read_file'] });
    expect(текст.indexOf('toolName = "*"')).toBeGreaterThan(-1);
    expect(текст).toMatch(/toolName = "\*"\ndecision = "deny"/u);
    expect(текст).toMatch(/toolName = "run_shell_command"\ndecision = "deny"\npriority = 999/u);
    // Без права менять — правил записи нет вовсе: запись падает под общий запрет.
    expect(текст).not.toContain('write_file');
  });

  it('сервер — только перечисленные инструменты', () => {
    const текст = geminiPolicy({ builtins: [], server: { name: 'jarvis-desktop', tools: ['window_list', 'screenshot'] } });
    expect(текст).toContain('mcpName = "jarvis-desktop"');
    expect(текст).toContain('toolName = ["window_list", "screenshot"]');
  });

  it('каждый шаблон Gemini принимает: без повторителя за группой и не длиннее 2048', () => {
    // Замер на 0.64.0: шаблон с `(?:\\\\|/)+` Gemini отверг как опасный, правило
    // выпало, и запись не прошла даже в папку задачи. Проверка — его же.
    const длинная = 'C:\\Users\\Константин Константинопольский\\Desktop\\Джарвис\\Подготовка к экзамену по истории';
    const writes = { roots: [длинная, 'C:\\Users\\Константин Константинопольский\\Desktop\\Джарвис'], protectedRoots: protectedRootsFor(длинная, длинная), cwd: длинная };
    const все = [...allowedWritePatterns(writes, 'win32'), ...protectedWritePatterns(writes, 'win32')];
    expect(все.filter((ш) => !geminiAcceptsPattern(ш))).toEqual([]);
    expect(geminiAcceptsPattern(String.raw`\x00"file_path":"(?:\\\\|/)+x`)).toBe(false);
  });

  it('шаблоны в TOML читаются той же строкой и собираются в регулярное выражение', () => {
    const текст = geminiPolicy({
      builtins: [],
      writes: { roots: ['C:\\Users\\Иван\\Desktop\\Джарвис'], protectedRoots: ['C:\\Users\\Иван\\AppData\\Local\\Rujarvis'], cwd: 'C:\\Users\\Иван\\Desktop\\Джарвис' },
      platform: 'win32',
    });
    const шаблоны = [...текст.matchAll(/^argsPattern = (".*")$/gmu)].map((m) => JSON.parse(m[1] ?? '""') as string);
    expect(шаблоны.length).toBeGreaterThan(2);
    for (const шаблон of шаблоны) expect(() => new RegExp(шаблон)).not.toThrow();
  });
});

describe('куда Gemini можно писать (Windows)', () => {
  const cwd = 'C:\\Users\\Иван\\Desktop\\Джарвис\\Задача';
  const writes = {
    roots: [cwd, 'C:\\Users\\Иван\\Desktop\\Джарвис'],
    protectedRoots: protectedRootsFor(cwd, 'C:\\Users\\Иван\\AppData\\Local\\Rujarvis'),
    cwd,
  };
  const можно = allowedWritePatterns(writes, 'win32').map((ш) => new RegExp(ш));
  const нельзя = protectedWritePatterns(writes, 'win32').map((ш) => new RegExp(ш));
  const пишет = (file: string): boolean => {
    const строка = аргументы({ content: 'x', file_path: file });
    return можно.some((ш) => ш.test(строка)) && !нельзя.some((ш) => ш.test(строка));
  };

  it.each([
    'notes.md',
    'конспект/глава 1.md',
    'C:\\Users\\Иван\\Desktop\\Джарвис\\Задача\\итог.docx',
    'c:/users/иван/desktop/джарвис/другое.md',
  ])('в папке задачи и результатов — можно: %s', (file) => {
    expect(пишет(file)).toBe(true);
  });

  it.each([
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    'C:\\Users\\Иван\\Documents\\диплом.docx',
    '..\\..\\Documents\\x.md',
    'C:\\Users\\Иван\\Desktop\\Джарвис\\Задача\\..\\..\\x.md',
    '.gemini\\settings.json',
    'C:\\Users\\Иван\\Desktop\\Джарвис\\.claude\\settings.json',
    'C:\\Users\\Иван\\AppData\\Local\\Rujarvis\\data\\settings.json',
    '\\\\сервер\\общая\\x.md',
  ])('за пределами, наверх или в настройки агентов — нельзя: %s', (file) => {
    expect(пишет(file)).toBe(false);
  });

  it('работа в исходниках Джарвиса: исходники можно, его данные и «характер» — нет', () => {
    const дома = 'C:\\Users\\Иван\\AppData\\Local\\Rujarvis';
    const w = { roots: [дома], protectedRoots: protectedRootsFor(дома, дома), cwd: дома };
    const можноЗдесь = allowedWritePatterns(w, 'win32').map((ш) => new RegExp(ш));
    const нельзяЗдесь = protectedWritePatterns(w, 'win32').map((ш) => new RegExp(ш));
    const здесь = (file: string): boolean => {
      const строка = аргументы({ file_path: file, content: 'x' });
      return можноЗдесь.some((ш) => ш.test(строка)) && !нельзяЗдесь.some((ш) => ш.test(строка));
    };
    expect(здесь('src\\app\\main.ts')).toBe(true);
    expect(здесь('data\\settings.json')).toBe(false);
    expect(здесь('.\\data\\gate\\ok-1.json')).toBe(false);
    expect(здесь('характер.md')).toBe(false);
    expect(здесь(`${дома}\\data\\settings.json`)).toBe(false);
  });
});

describe('куда Gemini можно писать (мак)', () => {
  const cwd = '/Users/ivan/Desktop/Jarvis';
  const writes = { roots: [cwd], protectedRoots: ['/Users/ivan/Library/Application Support/Rujarvis'], cwd };
  const можно = allowedWritePatterns(writes, 'darwin').map((ш) => new RegExp(ш));
  const нельзя = protectedWritePatterns(writes, 'darwin').map((ш) => new RegExp(ш));
  const пишет = (file: string): boolean => {
    const строка = аргументы({ file_path: file, content: 'x' });
    return можно.some((ш) => ш.test(строка)) && !нельзя.some((ш) => ш.test(строка));
  };

  it('внутри — да, рядом с тем же началом имени — нет', () => {
    expect(пишет('/Users/ivan/Desktop/Jarvis/notes.md')).toBe(true);
    expect(пишет('/Users/ivan/Desktop/JarvisEvil/notes.md')).toBe(false);
    expect(пишет('/Users/ivan/.gemini/settings.json')).toBe(false);
    expect(пишет('/Users/ivan/Library/Application Support/Rujarvis/data/x')).toBe(false);
  });

  it('корень записывается сегментами с любым разделителем', () => {
    expect(new RegExp(rootPattern('/Users/ivan', 'darwin')).test('/users/IVAN')).toBe(true);
  });
});

describe('поток Gemini', () => {
  it('сессия, текст после последнего инструмента, записанный файл и токены', () => {
    const state = createStreamState();
    const events: BackendEvent[] = [];
    const consume = createGeminiLineConsumer();
    for (const line of ПОТОК) consume(JSON.parse(line) as Record<string, unknown>, state, (e) => events.push(e));
    expect(state.sessionId).toBe('36a5a535-9054-4ba6-a7a1-46fec2bdc40e');
    expect(state.text).toBe('Готово.');
    expect(state.filesChanged).toEqual([{ path: 'hello.txt', action: 'created' }]);
    expect(state.inputTokens).toBe(30);
    expect(state.errorMessage).toBeUndefined();
    expect(events.filter((e) => e.type === 'assistant-text').map((e) => (e as { text: string }).text)).toEqual(['Готово.']);
  });

  it('отказ политики — инструмент в ленте есть, а файла нет', () => {
    const state = createStreamState();
    const consume = createGeminiLineConsumer();
    consume({ type: 'tool_use', tool_name: 'write_file', tool_id: 't1', parameters: { file_path: 'C:\\Windows\\x' } }, state, () => {});
    consume({ type: 'tool_result', tool_id: 't1', status: 'error', error: { type: 'policy_violation' } }, state, () => {});
    expect(state.filesChanged).toEqual([]);
  });

  it('кончилась дневная квота — это лимит, а не поломка', () => {
    const state = createStreamState();
    const consume = createGeminiLineConsumer();
    consume({ type: 'error', severity: 'error', message: 'You have exhausted your daily quota on this model.' }, state, () => {});
    consume({ type: 'result', status: 'error', error: { type: 'Error', message: 'RESOURCE_EXHAUSTED' } }, state, () => {});
    expect(state.usageLimited).toBe(true);
    expect(state.errorMessage).toBe('RESOURCE_EXHAUSTED');
  });

  it('предупреждение — статус, а не провал задачи', () => {
    const state = createStreamState();
    createGeminiLineConsumer()({ type: 'error', severity: 'warning', message: 'Loop detected' }, state, () => {});
    expect(state.errorMessage).toBeUndefined();
  });
});

describe('сбои Gemini — словами для человека', () => {
  it('без входа — войти через Google, и ни слова про ключ', () => {
    const текст = explainGeminiFailure('Manual authorization is required ... provide a GEMINI_API_KEY', 41) ?? '';
    expect(текст).toMatch(/вход не выполнен|not signed in/u);
    expect(текст).not.toMatch(/API_KEY|ключ/u);
  });

  it('сломанная политика узнаётся по stderr Gemini', () => {
    expect(policyFailed('[ADMIN] Policy file error in a.toml:\n  TOML parsing failed')).toBe(true);
    expect(policyFailed('Ripgrep is not available. Falling back to GrepTool.')).toBe(false);
  });
});

describe('GeminiBackend', () => {
  it('запуск: политика лежит в доме, окружение без ключей, промпт — в stdin', async () => {
    const home = дом();
    const { spawn, calls } = fakeSpawn(ПОТОК);
    const старый = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'AIza-лишний';
    try {
      const run = new GeminiBackend({ probe: readyProbe, home, adminPolicies: () => false, spawnCli: spawn }).run(request({ cwd: home }));
      const result = await run.result();
      expect(result.ok).toBe(true);
      expect(result.text).toBe('Готово.');
      const options = calls[0]?.options;
      const policyFile = options?.args[(options?.args.indexOf('--admin-policy') ?? 0) + 1] ?? '';
      expect(policyFile.startsWith(path.join(home, 'run-policies'))).toBe(true);
      expect(readFileSync(policyFile, 'utf8')).toContain('toolName = "run_shell_command"');
      expect(options?.env?.GEMINI_API_KEY).toBeUndefined();
      expect(options?.env?.GEMINI_CLI_HOME).toBe(home);
      expect(options?.stdin).toContain('сделай конспект по главе');
      // Настройки дома легли до запуска: без них Gemini не знает, что вход — Google.
      expect(JSON.parse(readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8'))).toEqual(geminiSettings());
    } finally {
      if (старый === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = старый;
    }
  });

  it('сбой проверки: Gemini не прочитал политику — работа остановлена и провалена', async () => {
    const { spawn, calls } = fakeSpawn(ПОТОК, {}, ['[ADMIN] Policy file error in x.toml:\n  TOML parsing failed\n']);
    const result = await backend({ spawnCli: spawn }).run(request()).result();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/правила Джарвиса|Jarvis rules/u);
    expect(calls[0]?.options.args).toContain('--admin-policy');
  });

  it('политики администратора на машине — отказ до запуска', async () => {
    const { spawn, calls } = fakeSpawn(ПОТОК);
    const result = await backend({ spawnCli: spawn, adminPolicies: () => true }).run(request()).result();
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('папка задачи переписывает сервер Джарвиса — отказ до запуска', async () => {
    const папка = дом();
    mkdirSync(path.join(папка, '.gemini'));
    writeFileSync(path.join(папка, '.gemini', 'settings.json'), '{"mcpServers":{"jarvis-desktop":{"command":"evil"}}}');
    expect(overridesJarvisServer(папка)).toBe(true);
    const { spawn, calls } = fakeSpawn(ПОТОК);
    const result = await backend({ spawnCli: spawn }).run(request({ cwd: папка })).result();
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('без входа — не готов, и причина говорит, где войти', async () => {
    const b = backend({ probe: { status: async () => ({ installed: true, loggedIn: false, path: '/x/gemini' }) } });
    const a = await b.checkAvailability(true);
    expect(a.ready).toBe(false);
    expect(a.reason).toMatch(/Google/u);
  });

  it('экран — только вместе с проверкой в сервере', () => {
    const папка = дом();
    const конфиг = path.join(папка, 'desktop.json');
    writeFileSync(конфиг, JSON.stringify({ mcpServers: { 'jarvis-desktop': { command: 'electron.exe', args: ['mcp.cjs'], env: { JARVIS_LANGUAGE: 'ru' } } } }));
    expect(backend({ desktopMcpConfig: конфиг }).capabilities.has('computer')).toBe(false);
    const сРуками = backend({ desktopMcpConfig: конфиг, gateConfig: path.join(папка, 'gate.json') });
    expect(сРуками.capabilities.has('computer')).toBe(true);

    // Сервер получает путь к gate.json: каждый вызов проверяет serverGate.
    const план = сРуками.planRun(request({ capabilities: ['computer'], cwd: папка }));
    expect(план.server).toBe('jarvis-desktop');
    expect(план.env.JARVIS_TOOL_GATE).toBe(path.join(папка, 'gate.json'));
    expect(план.env.JARVIS_GEMINI_MCP_COMMAND).toBe('electron.exe');
    expect(план.policy.server?.tools).toContain('window_list');
  });

  it('задача «только посмотреть» — без записи и без пишущих инструментов сервера', () => {
    const папка = дом();
    const конфиг = path.join(папка, 'desktop.json');
    writeFileSync(конфиг, JSON.stringify({ mcpServers: { 'jarvis-desktop': { command: 'node', args: ['mcp.cjs'] } } }));
    const план = backend({ desktopMcpConfig: конфиг, gateConfig: 'gate.json' }).planRun(
      request({ capabilities: ['computer'], permissions: READ_ONLY_PERMISSIONS, cwd: папка }),
    );
    expect(план.policy.writes).toBeUndefined();
    expect(план.policy.server?.tools).not.toContain('move_to_output');
  });

  it('сервер без пути к сборке рабочего стол не получает', () => {
    expect(serverEnv({ command: 'my-server.cmd', args: [] })).toBeNull();
    expect(serverEnv({ command: 'node', args: ['a.cjs'] }, { JARVIS_TOOL_GATE: 'g' })).toEqual({
      JARVIS_GEMINI_MCP_COMMAND: 'node',
      JARVIS_GEMINI_MCP_SCRIPT: 'a.cjs',
      JARVIS_TOOL_GATE: 'g',
    });
  });
});

describe('поиск и вход Gemini', () => {
  it('свой Gemini из папки Джарвиса — первым', () => {
    expect(bundledGeminiCli('C:\\Rujarvis\\agents', 'win32')).toBe('C:\\Rujarvis\\agents\\gemini\\node_modules\\.bin\\gemini.cmd');
    expect(commonCliPaths('gemini', 'C:\\Users\\x', 'win32')[0]).toMatch(/agents.gemini.node_modules.\.bin.gemini\.cmd$/u);
  });

  it('вход — по файлу в доме Джарвиса, токены не нужны', () => {
    const home = дом();
    expect(hasGeminiLogin(home)).toBe(false);
    mkdirSync(path.join(home, '.gemini'));
    writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), '{"refresh_token":"x","token_type":"Bearer"}');
    expect(hasGeminiLogin(home)).toBe(true);
  });
});

describe('Gemini в очереди менеджера', () => {
  function stub(id: AgentBackend['id'], ready: boolean, computer = false, text = 'ок'): AgentBackend & { runs: number } {
    const b = {
      id,
      name: id,
      runs: 0,
      capabilities: new Set(computer ? ['computer'] : []) as AgentBackend['capabilities'],
      checkAvailability: async () => ({ id, installed: ready, authenticated: ready, ready, checkedAt: 0 }),
      run(): BackendRun {
        b.runs += 1;
        const result: BackendResult = { ok: text !== '', backend: id, text, durationMs: 1, filesChanged: [], commands: [], usageLimited: text === '' || undefined };
        return { id: 'r', backend: id, events: (async function* () {})(), cancel: () => {}, result: async () => result };
      },
    };
    return b;
  }

  it('сам — Claude Code, Codex, Gemini; выбранный в настройках — первым', () => {
    const m = new BackendManager();
    for (const b of [stub('claude-code', true), stub('codex', true), stub('gemini', true)]) m.register(b);
    expect(m.plan(request({ capabilities: ['reasoning'] })).order).toEqual(['claude-code', 'codex', 'gemini']);
    expect(m.plan(request({ capabilities: ['reasoning'] }), { mainPreference: 'gemini' }).order[0]).toBe('gemini');
    expect(m.plan(request({ capabilities: ['coding'] }), { codingPreference: 'gemini' }).order[0]).toBe('gemini');
  });

  it('экран: Gemini берут, только если у него есть руки', () => {
    const m = new BackendManager();
    m.register(stub('gemini', true, false));
    expect(m.plan(request({ capabilities: ['computer'] })).order).toEqual([]);
    const сРуками = new BackendManager();
    сРуками.register(stub('gemini', true, true));
    expect(сРуками.plan(request({ capabilities: ['computer'] }), { mainPreference: 'gemini' }).order).toEqual(['gemini']);
  });

  it('Gemini не подменяет Claude Code: лимит Claude не тратит Google-аккаунт', async () => {
    const claude = stub('claude-code', true, false, '');
    const gemini = stub('gemini', true);
    const m = new BackendManager();
    m.register(claude);
    m.register(gemini);
    const result = await m.run(request({ capabilities: ['reasoning'] })).result();
    expect(result.ok).toBe(false);
    expect(gemini.runs).toBe(0);
  });

  it('у кого только Gemini — работает он', async () => {
    const claude = stub('claude-code', false, false, '');
    const gemini = stub('gemini', true);
    const m = new BackendManager();
    m.register(claude);
    m.register(gemini);
    // Claude Code не готов — его запуск падает сразу, и очередь доходит до Gemini.
    const result = await m.run(request({ capabilities: ['reasoning'] })).result();
    expect(result.ok).toBe(true);
    expect(result.backend).toBe('gemini');
  });
});

describe('выбор агента в настройках', () => {
  it('понимает три агента и «первый готовый»; чужое значение — «первый готовый»', async () => {
    const { normaliseSettings } = await import('../setup/settings');
    expect(normaliseSettings({}).agent).toBe('auto');
    expect(normaliseSettings({ agent: 'gemini' }).agent).toBe('gemini');
    expect(normaliseSettings({ agent: 'codex' }).agent).toBe('codex');
    expect(normaliseSettings({ agent: 'gpt' }).agent).toBe('auto');
  });
});
