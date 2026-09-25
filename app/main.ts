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
import { setLanguage } from '../jarvis/locale/language';
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

/**
 * Один экземпляр на машину.
 *
 * Второй подрался бы с первым за микрофон и горячие клавиши. Одного
 * `app.quit()` для этого мало: он не прерывает загрузку модуля, и
 * `whenReady` всё равно срабатывает. Замер 25.09.2026, второй запуск при
 * работающем первом: успел повесить свой значок в трее, дописать заголовок в
 * общий `jarvis.log` и открыть окно звука — то есть полез за микрофоном,
 * пока первый уже слушал. Остановило его только то, что профиль Electron был
 * занят (`Unable to move the cache: Отказано в доступе`), а это случайность,
 * а не защита. Поэтому ответ лока запоминается и проверяется ещё раз.
 */
const единственный = app.requestSingleInstanceLock();
if (!единственный) app.quit();

const settings = new SettingsStore(PATHS.settings);

// Язык главного процесса.
//
// Раньше его ставил только голосовой мост (`voiceBridge`), и до его подъёма —
// а на первом запуске он и не поднимается, пока не пройден онбординг, — всё,
// что главный процесс говорит через `tr()`, выходило по-русски даже в
// английском режиме. Видно это прямо в окне настроек: причина отказа при
// проверке своей модели приходит оттуда.
setLanguage(settings.get().language);
settings.subscribe((next) => setLanguage(next.language));
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
      // Первые слова после «Начать».
      //
      // Раньше здесь была тишина: голос просто запускался, и человек
      // оставался со значком в трее. Как позвать и как остановить, он видел
      // один раз на последнем шаге мастера — и больше никогда.
      //
      // Говорится один раз, сразу после настройки, и учит ровно трём вещам:
      // имени, остановке и тому, как спросить остальное.
      void restartVoice().then(() => {
        void bridge?.session.speak(
          uiStrings(settings.get().language).firstWords,
        );
      });
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

/**
 * Подсказка значка в трее.
 *
 * Windows берёт из неё 127 знаков и остальное молча отрезает. Причина отказа
 * бывает длиннее: «Ни одна модель распознавания не установлена в
 * C:\\Users\\…\\models\\whisper. Откройте настройки Джарвиса и скачайте
 * модель» — это 175 знаков вместе с «Rujarvis — голос не запустился: », и
 * обрезается ровно конец, то есть то, что надо сделать. Поэтому режем сами и
 * ставим многоточие: человек видит, что текст не весь, и идёт в меню, где
 * строка состояния целая.
 */
export function трейПодсказка(status: string, предел = 127): string {
  const полная = `Rujarvis — ${status}`;
  if (полная.length <= предел) return полная;
  const край = полная.slice(0, предел - 1);
  const пробел = край.lastIndexOf(' ');
  return `${(пробел > предел / 2 ? край.slice(0, пробел) : край).trimEnd()}…`;
}

function refreshTray(): void {
  if (!tray) return;
  const t = uiStrings(settings.get().language);
  const status = bridge ? t.trayListening : voiceError ? `${t.trayVoiceFailed}: ${voiceError}` : t.trayNotListening;
  tray.setToolTip(трейПодсказка(status));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: t.trayEvents, enabled: Boolean(bridge), click: () => bridge?.showEvents() },
      // Микрофон — и мышью тоже.
      //
      // Выключался он только сочетанием Ctrl+M, а голосом вернуть слух нельзя
      // по определению: выключенный микрофон не слышит просьбы включиться.
      // Человек, которому сочетание недоступно, оставался с глухим
      // помощником до прихода того, кому доступно.
      {
        label: bridge?.muteState().muted ? t.trayMicOn : t.trayMicOff,
        enabled: Boolean(bridge),
        click: () => {
          bridge?.toggleMute();
          refreshTray();
        },
      },
      { label: t.traySettings, click: () => showSettings() },
      // Настройку можно пройти заново.
      //
      // Мастер показывается, пока не выставлен `onboarded`, и другого входа в
      // него не было: чтобы посмотреть его снова, приходилось править
      // settings.json руками. Человек так и упёрся - жал ярлык и видел
      // вкладки. Флаг здесь не сбрасывается нарочно: если мастер закрыть на
      // середине, рабочее состояние остаётся прежним.
      { label: t.trayRunSetup, click: () => showSettings('onboarding') },
      { type: 'separator' },
      { label: t.trayOpenLog, click: () => void shell.openPath(PATHS.log) },
      { label: t.trayOpenData, click: () => void shell.openPath(PATHS.home) },
      { type: 'separator' },
      { label: t.trayRestartVoice, click: () => void restartVoice() },
      { label: t.trayQuit, click: () => app.quit() },
    ]),
  );
}

/**
 * Ярлык нажали, когда Джарвис уже работает.
 *
 * Раньше это открывало настройки — окно с вкладками, которого человек не
 * просил. Дважды подряд он принял его за «вернулся старый сломанный
 * онбординг» и был прав в главном: окно появилось само и не о том.
 *
 * Джарвис живёт в трее. Значит ярлык показывает трей: там его состояние и
 * там же все действия, включая настройки и «пройти настройку заново».
 */
app.on('second-instance', () => {
  if (tray && !tray.isDestroyed()) {
    tray.popUpContextMenu();
    return;
  }
  showSettings();
});

// Закрытое окно настроек не значит «выйти»: Джарвис продолжает слушать из трея.
app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  bridge?.dispose();
  bridge = null;
});

void app.whenReady().then(async () => {
  // Второй экземпляр сюда доходить не должен: ни значка, ни микрофона.
  if (!единственный) return;

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
