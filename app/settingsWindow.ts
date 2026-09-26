/**
 * Окно настроек и онбординга.
 *
 * Одна страница (`ui/settings.html`) в двух режимах: пошаговый первый запуск
 * и обычные настройки. Всё, что трогает диск и процессы, делается здесь, в
 * главном процессе; страница получает только узкий API через preload.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';

import { терминалДляВхода } from './loginTerminal';
import { APP_ROOT } from './root';
import { cliStatus, createClaudeProbe, createCodexProbe } from '../jarvis/backends/cliProbes';
import { checkLocalModel, normaliseEndpoint } from '../jarvis/backends/localModel';
import type { JarvisPaths } from '../jarvis/setup/paths';
import { jarvisOutputDir } from '../jarvis/setup/paths';
import type { AppSettings, SettingsStore } from '../jarvis/setup/settings';
import { WHISPER_MODELS, type WhisperModelId } from '../jarvis/voice/sttModels';
import { installVoice, isVoiceInstalled, Speaker, voiceForLanguage, VOICES } from '../jarvis/voice/tts';
import { installWhisperModel } from '../jarvis/voice/whisperInstall';
import { isWhisperModelInstalled } from '../jarvis/voice/whisperRecognizer';
import { UI_STRINGS } from './ui/strings';

export interface SettingsWindowOptions {
  settings: SettingsStore;
  paths: JarvisPaths;
  page?: 'onboarding';
  /** Онбординг пройден. */
  onFinished(): void;
  onSettingsChanged(changed: Array<keyof AppSettings>): void;
}

export const SETTINGS_CHANNEL = 'jarvis-settings';

let window: BrowserWindow | null = null;
let current: SettingsWindowOptions | null = null;
let registered = false;
/** Для кнопки «Послушать» — отдельный синтезатор, чтобы не мешать мосту. */
let preview: Speaker | null = null;
// Итог загрузки: `ok: false` и причина, а не `undefined` на любой исход.
//
// Раньше отказ превращался в `undefined` сразу после отправки события
// `progress`. Если событие не дошло — окно закрыли и открыли заново, — вызов
// `api.install` в странице завершался как успешный, и человек смотрел на
// «готово» при пустой папке моделей.
type InstallOutcome = { ok: true } | { ok: false; message: string };

const installs = new Map<string, Promise<InstallOutcome>>();

/**
 * Что показать: мастер или вкладки.
 *
 * Решает НЕ вызывающий, а состояние: пока онбординг не пройден, окно всегда
 * мастер, как бы его ни открыли. Иначе получалось так: человек начинает
 * настройку, окно уходит за другое, он щёлкает значок в трее — и попадает во
 * вкладки, где нет ни «Далее», ни «Начать». Онбординг оказывался без
 * продолжения, а голос не запускался никогда, потому что `onboarded`
 * ставится только кнопкой в конце мастера.
 */
function какуюСтраницу(options: SettingsWindowOptions): 'onboarding' | 'settings' {
  if (!options.settings.get().onboarded) return 'onboarding';
  return options.page ?? 'settings';
}

export function openSettingsWindow(options: SettingsWindowOptions): void {
  current = options;
  registerHandlers();

  if (window && !window.isDestroyed()) {
    window.webContents.send(`${SETTINGS_CHANNEL}:page`, какуюСтраницу(options));
    window.show();
    window.focus();
    return;
  }

  window = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 640,
    minHeight: 520,
    title: UI_STRINGS[options.settings.get().language].windowTitle,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(APP_ROOT, 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'app', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
    preview?.dispose();
    preview = null;
  });
  void window.loadFile(path.join(APP_ROOT, 'app', 'ui', 'settings.html'), {
    query: { page: какуюСтраницу(options) },
  });
}

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(`${SETTINGS_CHANNEL}:${channel}`, payload);
}

/**
 * Всё, что зависит от настроек, а значит меняется прямо во время работы окна.
 *
 * Отдельно от `state()`, потому что страница получает это не только при
 * открытии, но и в ответ на каждое сохранение. Раньше в ответ приходили одни
 * настройки, и переведённые главным процессом куски оставались от прежнего
 * языка. Замер 25.09.2026: переключаем интерфейс на English на вкладке
 * «Общие» и идём на «Речь» — все пять описаний моделей распознавания
 * по-русски; на «Папках» путь к папке результатов показан как
 * `…\\Desktop\\Джарвис`, а кнопка «Открыть» открывает `…\\Desktop\\Jarvis`,
 * потому что главный процесс берёт язык заново. Надпись врала до тех пор,
 * пока окно не закроют и не откроют снова.
 *
 * Пробы CLI сюда не входят: они запускают процессы и стоят секунды, а от
 * сохранения настроек не зависят.
 */
async function зависитОтНастроек() {
  const options = current as SettingsWindowOptions;
  const { paths } = options;
  const settings = options.settings.get();
  const whisper = await Promise.all(
    WHISPER_MODELS.map(async (model) => ({
      id: model.id,
      label: model.label,
      description: settings.language === 'en' ? model.descriptionEn : model.description,
      bytes: model.downloadBytes,
      installed: await isWhisperModelInstalled(paths.whisperModels, model.id),
    })),
  );
  const voices = VOICES.map((voice) => ({
    id: voice.id,
    label: voice.label,
    language: voice.language,
    bytes: voice.downloadBytes,
    installed: isVoiceInstalled(paths.voiceModels, voice.id),
  }));
  return {
    settings,
    paths: {
      home: paths.home,
      log: paths.log,
      output:
        settings.outputDir ||
        jarvisOutputDir(process.env, app.getPath('desktop'), settings.language === 'en' ? 'Jarvis' : 'Джарвис'),
    },
    whisper,
    voices,
  };
}

async function state() {
  const [живое, claude, codex] = await Promise.all([
    зависитОтНастроек(),
    createClaudeProbe().status(),
    createCodexProbe().status(),
  ]);
  return {
    ...живое,
    strings: UI_STRINGS,
    platform: process.platform,
    agents: { claude, codex },
  };
}

/**
 * Сменили язык — меняем и голос.
 *
 * Голос привязан к языку: русская Ирина по-английски не говорит. А смена
 * языка меняла только язык, и выбранным оставался прежний голос.
 *
 * В мастере это открывало дыру. Список голосов на шаге показывается по
 * языку, а проверка «можно ли дальше» смотрит на ВЫБРАННЫЙ голос. Человек
 * выбирал English, видел пустой список английских голосов — и всё равно шёл
 * дальше, потому что выбранной оставалась установленная Ирина. Настройка
 * заканчивалась, интерфейс и слух были английскими, а говорил Джарвис
 * по-русски.
 *
 * Теперь при смене языка выбирается голос по умолчанию для нового языка.
 * Он, скорее всего, ещё не скачан — и мастер честно не пустит дальше, пока
 * его не поставят.
 */
function подобратьГолос(patch: Partial<AppSettings>, before: AppSettings): Partial<AppSettings> {
  const язык = patch.language;
  if (!язык || язык === before.language) return patch;

  return { ...patch, voiceId: voiceForLanguage(язык, patch.voiceId ?? before.voiceId) };
}

function applyPatch(patch: Partial<AppSettings>): AppSettings {
  const options = current as SettingsWindowOptions;
  const before = options.settings.get();
  const after = options.settings.update(подобратьГолос(patch, before));
  const changed = (Object.keys(after) as Array<keyof AppSettings>).filter((key) => before[key] !== after[key]);
  if (changed.length > 0 && after.onboarded) options.onSettingsChanged(changed);
  return after;
}

function registerHandlers(): void {
  if (registered) return;
  registered = true;

  // Окно настроек проверяет микрофон; окно звука моста слушает его. Больше
  // ничего приложению не нужно.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'media');
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:state`, () => state());

  // Ответ — не только настройки: язык меняет и описания моделей, и путь к
  // папке результатов, а их считает главный процесс.
  ipcMain.handle(`${SETTINGS_CHANNEL}:update`, async (_event, patch: Partial<AppSettings>) => {
    applyPatch(patch);
    return зависитОтНастроек();
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:finish`, () => {
    const options = current as SettingsWindowOptions;
    options.settings.update({ onboarded: true });
    options.onFinished();
    window?.close();
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:install`, (_event, kind: 'whisper' | 'voice', id: string) => {
    const key = `${kind}:${id}`;
    const running = installs.get(key);
    if (running) return running;
    const { paths } = current as SettingsWindowOptions;
    const progress = (p: { stage: string; ratio?: number; message?: string }) =>
      send('progress', { kind, id, ...p });
    const job = (
      kind === 'whisper'
        ? installWhisperModel({ installRoot: paths.whisperModels, modelId: id as WhisperModelId, onProgress: progress })
        : installVoice(paths.voiceModels, id, progress)
    )
      .then((): InstallOutcome => ({ ok: true }))
      .catch((error: unknown): InstallOutcome => {
        const message = error instanceof Error ? error.message : String(error);
        send('progress', { kind, id, stage: 'error', message });
        return { ok: false, message };
      })
      .finally(() => installs.delete(key));
    installs.set(key, job);
    return job;
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:preview`, async (_event, voiceId: string, text: string) => {
    const { paths } = current as SettingsWindowOptions;
    if (preview?.voiceId !== voiceId) {
      preview?.dispose();
      preview = new Speaker(paths.voiceModels, voiceId);
    }
    const result = await preview.say(text);
    return result.wav.toString('base64');
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:open`, (_event, target: 'home' | 'log' | 'output') => {
    const { paths, settings } = current as SettingsWindowOptions;
    const s = settings.get();
    const file =
      target === 'log'
        ? paths.log
        : target === 'output'
          ? s.outputDir || jarvisOutputDir(process.env, app.getPath('desktop'), s.language === 'en' ? 'Jarvis' : 'Джарвис')
          : paths.home;
    if (target !== 'log') mkdirSync(file, { recursive: true });
    return shell.openPath(file);
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:chooseFolder`, async () => {
    if (!window) return null;
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // Проверка настоящим запросом к модели; включается только то, что прошло:
  // сервер без инструментов оставил бы человека с молчащим агентом.
  ipcMain.handle(`${SETTINGS_CHANNEL}:checkLocal`, async (_event, url: string, model: string) => {
    const target = { url: normaliseEndpoint(String(url ?? '')), model: String(model ?? '').trim() };
    const result = await checkLocalModel(target);
    if (result.ok && result.tools) applyPatch({ localModelUrl: target.url, localModelName: target.model });
    return result;
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:signIn`, async (_event, cli: 'claude' | 'codex') => {
    const status = await cliStatus(cli);
    if (!status.path) return false;
    const { paths } = current as SettingsWindowOptions;
    // Подкоманды сверены с самими CLI 26.09.2026: `claude auth login` и
    // `codex login` — обе существуют.
    // Сценарий входа лежит в папке Джарвиса: всё на диске живёт под одной
    // крышей, и мусор в чужих местах не остаётся.
    return openTerminal(
      status.path,
      cli === 'claude' ? ['auth', 'login'] : ['login'],
      path.join(paths.home, 'data'),
    );
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:openUrl`, (_event, url: string) => {
    if (/^https:\/\//u.test(url)) void shell.openExternal(url);
  });
}

/**
/**
 * Открыть CLI во внешнем окне терминала: вход в аккаунт интерактивный.
 *
 * Сборка живёт в `loginTerminal.ts` и проверяется тестами на обе платформы:
 * поломка была ровно в кавычках, и увидеть её можно было только на живой
 * машине.
 *
 * Отказ больше не глотается. Раньше стояло `stdio: 'ignore'` и ничего сверх, и
 * на маке без разрешения на автоматизацию Терминала вход просто НЕ ПРОИСХОДИЛ
 * молча: окно не открывалось, ошибка уходила в никуда, а человек оставался на
 * шаге, который обойти нельзя.
 */
function openTerminal(command: string, args: string[], папка: string): boolean {
  const запуск = терминалДляВхода(command, args, папка);
  try {
    if (запуск.сценарий) {
      mkdirSync(path.dirname(запуск.сценарий.файл), { recursive: true });
      writeFileSync(запуск.сценарий.файл, запуск.сценарий.текст, 'utf8');
    }
    const дитя = spawn(запуск.file, запуск.args, {
      detached: true,
      // stderr читаем: на маке именно туда приезжает «not authorized to send
      // Apple events», и это единственный след отказа.
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: false,
    });
    дитя.stderr?.on('data', (кусок: Buffer) => {
      const текст = кусок.toString('utf8').trim();
      if (текст) console.error(`[jarvis] окно входа отказало: ${текст.slice(0, 400)}`);
    });
    дитя.on('error', (беда: Error) => {
      console.error(`[jarvis] окно входа не запустилось: ${беда.message}`);
    });
    дитя.unref();
    return true;
  } catch (беда) {
    console.error(
      `[jarvis] окно входа не запустилось: ${беда instanceof Error ? беда.message : String(беда)}`,
    );
    return false;
  }
}
