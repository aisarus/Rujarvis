/**
 * Окно настроек и онбординга.
 *
 * Одна страница (`ui/settings.html`) в двух режимах: пошаговый первый запуск
 * и обычные настройки. Всё, что трогает диск и процессы, делается здесь, в
 * главном процессе; страница получает только узкий API через preload.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';

import { APP_ROOT } from './root';
import { cliStatus, createClaudeProbe, createCodexProbe } from '../jarvis/backends/cliProbes';
import { checkLocalModel, normaliseEndpoint } from '../jarvis/backends/localModel';
import type { JarvisPaths } from '../jarvis/setup/paths';
import { jarvisOutputDir } from '../jarvis/setup/paths';
import type { AppSettings, SettingsStore } from '../jarvis/setup/settings';
import { WHISPER_MODELS, type WhisperModelId } from '../jarvis/voice/sttModels';
import { installVoice, isVoiceInstalled, Speaker, VOICES } from '../jarvis/voice/tts';
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
const installs = new Map<string, Promise<void>>();

export function openSettingsWindow(options: SettingsWindowOptions): void {
  current = options;
  registerHandlers();

  if (window && !window.isDestroyed()) {
    window.webContents.send(`${SETTINGS_CHANNEL}:page`, options.page ?? 'settings');
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
    query: { page: options.page ?? 'settings' },
  });
}

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(`${SETTINGS_CHANNEL}:${channel}`, payload);
}

async function state() {
  const options = current as SettingsWindowOptions;
  const { paths } = options;
  const settings = options.settings.get();
  const [claude, codex] = await Promise.all([createClaudeProbe().status(), createCodexProbe().status()]);
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
    strings: UI_STRINGS,
    platform: process.platform,
    paths: {
      home: paths.home,
      log: paths.log,
      output:
        settings.outputDir ||
        jarvisOutputDir(process.env, app.getPath('desktop'), settings.language === 'en' ? 'Jarvis' : 'Джарвис'),
    },
    agents: { claude, codex },
    whisper,
    voices,
  };
}

/** Сохранить и сказать приложению, что поменялось: от этого зависит перезапуск моста. */
function applyPatch(patch: Partial<AppSettings>): AppSettings {
  const options = current as SettingsWindowOptions;
  const before = options.settings.get();
  const after = options.settings.update(patch);
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

  ipcMain.handle(`${SETTINGS_CHANNEL}:update`, (_event, patch: Partial<AppSettings>) => applyPatch(patch));

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
      .then(() => undefined)
      .catch((error: unknown) => {
        send('progress', { kind, id, stage: 'error', message: error instanceof Error ? error.message : String(error) });
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
    openTerminal(status.path, cli === 'claude' ? ['auth', 'login'] : ['login']);
    return true;
  });

  ipcMain.handle(`${SETTINGS_CHANNEL}:openUrl`, (_event, url: string) => {
    if (/^https:\/\//u.test(url)) void shell.openExternal(url);
  });
}

/** Открыть CLI во внешнем окне терминала: вход в аккаунт интерактивный. */
function openTerminal(command: string, args: string[]): void {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', `"${command}"`, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    const line = [command, ...args].map((part) => `'${part.replace(/'/gu, "'\\''")}'`).join(' ');
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${line.replace(/"/gu, '\\"')}"`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  spawn('x-terminal-emulator', ['-e', command, ...args], { detached: true, stdio: 'ignore' }).unref();
}
