/**
 * Предполётная проверка: одна команда после установки — и видно, какое звено
 * не на месте и что с ним сделать.
 *
 *   pnpm jarvis:preflight                  # без единого хода по подписке
 *   pnpm jarvis:preflight -- --with-agent  # плюс один ход разговора через Codex
 *
 * Звенья — в том порядке, в каком по ним идёт человек: установка и ярлык,
 * запуск из Finder (node, Codex, Claude Code с PATH /usr/bin:/bin:/usr/sbin:/sbin),
 * вход в агентов, модели речи, разрешения, хук красных линий, MCP-сервер.
 *
 * Окон не открывает, фокус не трогает, в данные владельца не пишет: хук и
 * сервер поднимаются во временной папке. Подписку тратит только
 * `--with-agent`, и только одним ходом.
 *
 * Выход: 0 — провалов нет, 1 — есть что чинить, 2 — не намерено ничего.
 * Решения — в `jarvis/setup/preflight.ts`; здесь только замеры.
 */

import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { createClaudeProbe, createCodexProbe, resolveCli } from '../../jarvis/backends/cliProbes';
import { writeDesktopMcpConfig } from '../../jarvis/desktop/mcpConfig';
import { CodexTalkLive } from '../../jarvis/dialogue/codexTalk';
import { setLanguage, tr, type Language } from '../../jarvis/locale/language';
import { prepareGate } from '../../jarvis/risk/gateSetup';
import { jarvisPaths } from '../../jarvis/setup/paths';
import {
  ОПРОС_ЯРЛЫКА,
  звеноМикрофонаWindows,
  звеноМоделей,
  звеноРазговора,
  звеноСервера,
  звеноУстановки,
  звеноХука,
  звеноВхода,
  звеньяРазрешенийМака,
  звеньяЯрлыка,
  значениеРеестра,
  кодВыхода,
  отчёт,
  прочитатьРазрешения,
  разобратьЯрлык,
  толькоМак,
  файлРазрешений,
  type ЗапускХука,
  type Звено,
  type ОтветЯрлыка,
} from '../../jarvis/setup/preflight';
import { DEFAULT_SETTINGS, normaliseSettings, type AppSettings } from '../../jarvis/setup/settings';
import { WHISPER_MODEL_IDS } from '../../jarvis/voice/sttModels';
import { isVoiceInstalled } from '../../jarvis/voice/tts';
import { isWhisperModelInstalled } from '../../jarvis/voice/whisperRecognizer';

const С_АГЕНТОМ = process.argv.includes('--with-agent');
const МАК = process.platform === 'darwin';
const WINDOWS = process.platform === 'win32';
/** PATH, который Finder и автозапуск дают приложению. */
const PATH_FINDER = '/usr/bin:/bin:/usr/sbin:/sbin';

const PATHS = jarvisPaths();
const ЯРЛЫК = МАК
  ? path.join(os.homedir(), 'Applications', 'Rujarvis.app')
  : WINDOWS
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Rujarvis.lnk')
    : '';
const ЗАПУСК_ЯРЛЫКА = path.join(ЯРЛЫК, 'Contents', 'MacOS', 'Rujarvis');

/** Временная папка всех проверок: данные владельца не трогаем. */
const ВРЕМЕННАЯ = mkdtempSync(path.join(os.tmpdir(), 'jarvis-preflight-'));

function настройки(): AppSettings {
  try {
    return normaliseSettings(JSON.parse(readFileSync(PATHS.settings, 'utf8')));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function запускаемый(файл: string): boolean {
  try {
    accessSync(файл, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// --- замеры ---------------------------------------------------------------------

function установка(): Звено {
  const plist = path.join(ЯРЛЫК, 'Contents', 'Info.plist');
  return звеноУстановки({
    platform: process.platform,
    source: PATHS.source,
    приложение: existsSync(path.join(PATHS.source, 'dist', 'app', 'main.cjs')),
    сервер: existsSync(path.join(PATHS.source, 'dist', 'jarvis', 'desktop', 'mcp.cjs')),
    ярлык: ЯРЛЫК,
    ярлыкЕсть: Boolean(ЯРЛЫК) && existsSync(МАК ? ЗАПУСК_ЯРЛЫКА : ЯРЛЫК),
    ...(МАК
      ? {
          ярлыкЗапускается: запускаемый(ЗАПУСК_ЯРЛЫКА),
          ключМикрофона: existsSync(plist) && readFileSync(plist, 'utf8').includes('NSMicrophoneUsageDescription'),
        }
      : {}),
  });
}

/**
 * Ярлык так, как его запускает Finder: чистое окружение, PATH Finder, сам
 * ярлык без последней строки (`exec` Электрона) — и ответ node, Codex, Claude.
 */
function опроситьЯрлык(): { ответ: ОтветЯрлыка | null; почему?: string } {
  if (!existsSync(ЗАПУСК_ЯРЛЫКА)) return { ответ: null, почему: tr(`нет ${ЗАПУСК_ЯРЛЫКА}`, `no ${ЗАПУСК_ЯРЛЫКА}`) };
  const безЗапуска = readFileSync(ЗАПУСК_ЯРЛЫКА, 'utf8')
    .split('\n')
    .filter((строка) => !строка.startsWith('exec '))
    .join('\n');
  const файл = path.join(ВРЕМЕННАЯ, 'launcher-path.sh');
  writeFileSync(файл, безЗапуска, 'utf8');
  // Окружение — объектом целиком: это и есть `env -i`.
  const итог = spawnSync('/bin/bash', ['-c', `. "$1"\n${ОПРОС_ЯРЛЫКА}`, 'preflight', файл], {
    env: { HOME: os.homedir(), PATH: PATH_FINDER },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (итог.error) return { ответ: null, почему: итог.error.message };
  return { ответ: разобратьЯрлык(`${итог.stdout ?? ''}\n${итог.stderr ?? ''}`) };
}

async function вход(): Promise<Звено[]> {
  const [codex, claude] = await Promise.all([createCodexProbe().status(), createClaudeProbe().status()]);
  return [звеноВхода('codex', codex, claude), звеноВхода('claude', claude, codex)];
}

async function модели(выбор: AppSettings): Promise<Звено> {
  const стоят: string[] = [];
  for (const id of WHISPER_MODEL_IDS) {
    if (await isWhisperModelInstalled(PATHS.whisperModels, id)) стоят.push(id);
  }
  let голосСтоит = false;
  try {
    голосСтоит = isVoiceInstalled(PATHS.voiceModels, выбор.voiceId);
  } catch {
    голосСтоит = false;
  }
  return звеноМоделей({ распознавание: выбор.whisperModel, стоятРаспознавания: стоят, голос: выбор.voiceId, голосСтоит });
}

function микрофонWindows(): Звено {
  const ключ = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
  const спросить = (где: string): string | null => {
    const итог = spawnSync('reg', ['query', где, '/v', 'Value'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return итог.status === 0 ? итог.stdout : null;
  };
  return звеноМикрофонаWindows(значениеРеестра(спросить(ключ)), значениеРеестра(спросить(`${ключ}\\NonPackaged`)));
}

/** Команда хука — из тех же настроек, что получает агент, и тем же путём. */
function хук(language: Language, pathПриложения: string | null): Звено {
  const готовность = prepareGate({
    appRoot: PATHS.source,
    dataDir: ВРЕМЕННАЯ,
    outputDir: ВРЕМЕННАЯ,
    homeDir: os.homedir(),
    language,
    // На маке node ищет не Терминал, а приложение — PATH ярлыка.
    ...(pathПриложения !== null ? { nodeAvailable: () => есть('node', pathПриложения) } : {}),
  });
  if (!готовность.ok) return звеноХука({ ok: false, reason: готовность.reason });

  const настройкиХука = JSON.parse(readFileSync(готовность.settings, 'utf8')) as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
  };
  const команда = настройкиХука.hooks.PreToolUse[0]?.hooks[0]?.command ?? '';
  const позвать = (вход: string): ЗапускХука => {
    const итог = pathПриложения !== null
      ? spawnSync('/bin/sh', ['-c', команда], {
          env: { HOME: os.homedir(), PATH: pathПриложения },
          input: вход,
          encoding: 'utf8',
          timeout: 30_000,
        })
      : spawnSync(команда, { shell: true, input: вход, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    return {
      код: итог.status,
      вывод: `${итог.stdout ?? ''}${итог.stderr ?? ''}`,
      ...(итог.error ? { беда: итог.error.message } : {}),
    };
  };
  const безобидный = позвать(
    JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path.join(ВРЕМЕННАЯ, 'probe.txt') }, cwd: ВРЕМЕННАЯ }),
  );
  const мусор = позвать('{}');
  return звеноХука({ ok: true }, безобидный, мусор);
}

function есть(команда: string, pathПриложения: string): boolean {
  const итог = spawnSync('/bin/sh', ['-c', `command -v ${команда} >/dev/null 2>&1`], {
    env: { HOME: os.homedir(), PATH: pathПриложения },
    timeout: 10_000,
  });
  return итог.status === 0;
}

/** Электрон установки: им приложение запускает MCP-сервер (`ELECTRON_RUN_AS_NODE`). */
function электрон(): string | null {
  try {
    const путь = createRequire(path.join(PATHS.source, 'package.json'))('electron') as unknown;
    return typeof путь === 'string' && existsSync(путь) ? путь : null;
  } catch {
    return null;
  }
}

interface ЗапускСервера {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Конфиг сервера — тот же, что пишет приложение, но с данными во временной папке. */
function конфигСервера(language: Language, роль?: 'talk'): ЗапускСервера | { error: string } {
  const конфиг = writeDesktopMcpConfig({
    appRoot: PATHS.source,
    dataDir: ВРЕМЕННАЯ,
    outputDir: ВРЕМЕННАЯ,
    language,
    extraEnv: {
      JARVIS_HOME: ВРЕМЕННАЯ,
      ...(роль === 'talk' ? { JARVIS_MCP_ROLE: 'talk', JARVIS_TALK_BRIDGE: path.join(ВРЕМЕННАЯ, 'talk-bridge') } : {}),
    },
  });
  if (!конфиг.ok) {
    return { error: 'missing' in конфиг ? tr(`нет сборки ${конфиг.missing}`, `no build at ${конфиг.missing}`) : String(конфиг.error) };
  }
  const сервер = (JSON.parse(readFileSync(конфиг.file, 'utf8')) as { mcpServers: Record<string, ЗапускСервера> }).mcpServers[
    'jarvis-desktop'
  ];
  if (!сервер) return { error: tr('в конфиге нет сервера', 'no server in the config') };
  // Мы под tsx, а приложение — под Электроном: сервер у него запускается
  // двоичным файлом Электрона. Меряем тем же, иначе проверили бы не то.
  const бинарь = электрон();
  return бинарь ? { command: бинарь, args: сервер.args, env: { ...сервер.env, ELECTRON_RUN_AS_NODE: '1' } } : сервер;
}

function спроситьСервер(запуск: ЗапускСервера, pathПриложения: string | null): Promise<{ tools: string[]; ms: number } | { error: string }> {
  return new Promise((готово) => {
    const начало = Date.now();
    const дитя = spawn(запуск.command, запуск.args, {
      env: { ...process.env, ...(pathПриложения !== null ? { PATH: pathПриложения } : {}), ...запуск.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let буфер = '';
    let ошибки = '';
    let закончено = false;
    const конец = (ответ: { tools: string[]; ms: number } | { error: string }): void => {
      if (закончено) return;
      закончено = true;
      clearTimeout(таймер);
      погасить(дитя.pid);
      готово(ответ);
    };
    const таймер = setTimeout(() => конец({ error: tr('сервер молчит 60 с', 'the server was silent for 60 s') }), 60_000);
    дитя.on('error', (error) => конец({ error: error.message }));
    дитя.on('exit', (код) => конец({ error: tr(`сервер вышел с кодом ${String(код)}: ${ошибки.trim().slice(0, 300)}`, `the server exited with ${String(код)}: ${ошибки.trim().slice(0, 300)}`) }));
    дитя.stderr.on('data', (кусок: Buffer) => { ошибки += кусок.toString('utf8'); });
    дитя.stdout.on('data', (кусок: Buffer) => {
      буфер += кусок.toString('utf8');
      let край: number;
      while ((край = буфер.indexOf('\n')) >= 0) {
        const строка = буфер.slice(0, край).trim();
        буфер = буфер.slice(край + 1);
        if (!строка.startsWith('{')) continue;
        let сообщение: { id?: number; result?: { tools?: Array<{ name?: string }> }; error?: { message?: string } };
        try {
          сообщение = JSON.parse(строка) as typeof сообщение;
        } catch {
          continue;
        }
        if (сообщение.id === 1) {
          дитя.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          дитя.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        } else if (сообщение.id === 2) {
          if (сообщение.error) конец({ error: сообщение.error.message ?? JSON.stringify(сообщение.error) });
          else if (!Array.isArray(сообщение.result?.tools)) конец({ error: tr('ответ без списка инструментов', 'an answer without a tool list') });
          else конец({ tools: сообщение.result.tools.map((t) => String(t.name ?? '')), ms: Date.now() - начало });
        }
      }
    });
    дитя.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'preflight', version: '1' } },
      })}\n`,
    );
  });
}

/** Гасим только своё: дерево процесса по номеру, без групп и масок. */
function погасить(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (WINDOWS) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid);
  } catch {
    // Уже вышел — это не ошибка.
  }
}

async function разговор(language: Language, pathПриложения: string | null): Promise<Звено> {
  if (!С_АГЕНТОМ) return звеноРазговора(false);
  const codex = resolveCli('codex');
  if (!codex) return звеноРазговора(true, { нет: tr('Codex не найден', 'Codex not found') });
  const сервер = конфигСервера(language, 'talk');
  let mcpConfig: string | undefined;
  if (!('error' in сервер)) {
    mcpConfig = path.join(ВРЕМЕННАЯ, 'talk.json');
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'jarvis-talk': { type: 'stdio', ...сервер } } }), 'utf8');
  }
  // Ход — под тем PATH, что будет у приложения.
  if (pathПриложения !== null) process.env.PATH = pathПриложения;
  const live = new CodexTalkLive({ command: codex, cwd: ВРЕМЕННАЯ, mcpConfig, silenceMs: 120_000 });
  try {
    const ответ = await live.ask(tr('Ответь одним словом: готов', 'Answer with one word: ready')).result();
    return звеноРазговора(true, { ok: ответ.ok, text: ответ.text, ...(ответ.error ? { error: ответ.error } : {}) });
  } finally {
    live.dispose('проверка окончена');
  }
}

// --- ход проверки -----------------------------------------------------------------

async function main(): Promise<void> {
  const выбор = настройки();
  setLanguage(выбор.language);
  const language = выбор.language;

  console.log(`\nRujarvis preflight — ${process.platform} ${os.release()}`);
  console.log(tr(`  установка: ${PATHS.home}`, `  installation: ${PATHS.home}`));
  if (path.resolve(process.cwd()) !== path.resolve(PATHS.source)) {
    console.log(
      tr(
        `  (запущено из ${process.cwd()}, проверяется установка выше)`,
        `  (run from ${process.cwd()}; the installation above is what gets checked)`,
      ),
    );
  }
  console.log('');

  const звенья: Звено[] = [];
  const показать = (новые: Звено[]): void => {
    звенья.push(...новые);
  };

  показать([установка()]);

  let pathПриложения: string | null = null;
  if (МАК) {
    const { ответ, почему } = опроситьЯрлык();
    pathПриложения = ответ?.path ?? PATH_FINDER;
    показать(
      звеньяЯрлыка(ответ, { node: process.execPath, codex: resolveCli('codex'), claude: resolveCli('claude') }, почему),
    );
  } else {
    показать([толькоМак('finder-path', tr('PATH как у Finder', 'Finder PATH'))]);
  }

  показать(await вход());
  показать([await модели(выбор)]);

  if (МАК) показать(звеньяРазрешенийМака(прочитатьРазрешения(файлРазрешений(PATHS.data))));
  else if (WINDOWS) {
    показать([
      микрофонWindows(),
      толькоМак('perm-access', tr('Универсальный доступ', 'Accessibility')),
      толькоМак('perm-screen', tr('Запись экрана', 'Screen Recording')),
    ]);
  }

  показать([хук(language, pathПриложения)]);

  const сервер = конфигСервера(language);
  показать([звеноСервера('error' in сервер ? сервер : await спроситьСервер(сервер, pathПриложения))]);

  показать([await разговор(language, pathПриложения)]);

  for (const строка of отчёт(звенья)) console.log(строка);
  console.log('');
  console.log(
    tr(
      `Если Джарвис молчит — журнал: ${PATHS.log}`,
      `If Jarvis stays silent, see the log: ${PATHS.log}`,
    ),
  );

  try {
    rmSync(ВРЕМЕННАЯ, { recursive: true, force: true });
  } catch {
    // Временную папку уберёт система.
  }
  process.exit(кодВыхода(звенья));
}

void main().catch((error: unknown) => {
  console.error(tr('\nПроверка оборвалась:', '\nThe check broke off:'), error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(3);
});
