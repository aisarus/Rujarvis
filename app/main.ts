/**
 * Главный процесс Rujarvis.
 *
 * Приложение живёт в трее: окна у него только служебные — настройки, события,
 * оверлеи. Первый запуск открывает онбординг; пока он не пройден, голос не
 * слушает — сначала человек выбирает язык и скачивает модели, потом Джарвис
 * начинает слушать.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { app, Menu, nativeImage, shell, Tray } from 'electron';

import { APP_ROOT } from './root';
import { jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore } from '../jarvis/setup/settings';
import { openSettingsWindow } from './settingsWindow';
import { uiStrings } from './ui/strings';
import { startJarvisVoiceBridge, type JarvisVoiceBridge } from './voiceBridge';

const PATHS = jarvisPaths();

app.setName('Rujarvis');
// Профиль Electron (кэш, localStorage окон) — внутри папки Джарвиса, а не в
// Roaming: всё приложение лежит в одном месте.
mkdirSync(PATHS.profile, { recursive: true });
app.setPath('userData', PATHS.profile);
app.setAppLogsPath(PATHS.logs);

if (process.platform === 'win32') app.setAppUserModelId('io.github.aisarus.rujarvis');

if (!app.requestSingleInstanceLock()) {
  // Второй экземпляр подрался бы с первым за микрофон и горячие клавиши.
  app.quit();
}

const settings = new SettingsStore(PATHS.settings);
let bridge: JarvisVoiceBridge | null = null;
let starting: Promise<void> | null = null;
let tray: Tray | null = null;
let voiceError = '';

function iconPath(name: string): string {
  return path.join(APP_ROOT, 'resources', name);
}

async function startVoice(): Promise<void> {
  if (bridge || starting) return starting ?? undefined;
  starting = (async () => {
    // Две попытки: однажды под xvfb окно звука не загрузилось с ERR_FAILED, а
    // со второго раза поднялось. Человеку не нужно ради этого лезть в трей.
    for (let attempt = 1; attempt <= 2 && !bridge; attempt += 1) {
      try {
        bridge = await startJarvisVoiceBridge({ settings });
        voiceError = '';
      } catch (error) {
        voiceError = error instanceof Error ? error.message : String(error);
        console.error(`[main] голос не запустился (попытка ${attempt}):`, error);
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    starting = null;
    refreshTray();
  })();
  return starting;
}

async function restartVoice(): Promise<void> {
  await starting;
  bridge?.dispose();
  bridge = null;
  await startVoice();
}

function showSettings(page?: 'onboarding'): void {
  openSettingsWindow({
    settings,
    paths: PATHS,
    page,
    onFinished: () => {
      void restartVoice();
    },
    onSettingsChanged: (changed) => {
      // Язык, модель распознавания и папки читаются при запуске моста.
      if (changed.some((key) => ['language', 'whisperModel', 'workspace', 'outputDir', 'claudeModel', 'localModelUrl', 'localModelName'].includes(key))) {
        void restartVoice();
      }
      refreshTray();
    },
  });
}

function refreshTray(): void {
  if (!tray) return;
  const t = uiStrings(settings.get().language);
  const status = bridge ? t.trayListening : voiceError ? `${t.trayVoiceFailed}: ${voiceError}` : t.trayNotListening;
  tray.setToolTip(`Rujarvis — ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: t.trayEvents, enabled: Boolean(bridge), click: () => bridge?.showEvents() },
      { label: t.traySettings, click: () => showSettings() },
      { type: 'separator' },
      { label: t.trayOpenLog, click: () => void shell.openPath(PATHS.log) },
      { label: t.trayOpenData, click: () => void shell.openPath(PATHS.home) },
      { type: 'separator' },
      { label: t.trayRestartVoice, click: () => void restartVoice() },
      { label: t.trayQuit, click: () => app.quit() },
    ]),
  );
}

app.on('second-instance', () => showSettings());

// Закрытое окно настроек не значит «выйти»: Джарвис продолжает слушать из трея.
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  bridge?.dispose();
  bridge = null;
});

void app.whenReady().then(async () => {
  const image = nativeImage.createFromPath(iconPath(process.platform === 'win32' ? 'tray.ico' : 'tray.png'));
  tray = new Tray(image);
  tray.on('click', () => showSettings());
  refreshTray();

  if (!settings.get().onboarded) {
    showSettings('onboarding');
    return;
  }
  await startVoice();
});
