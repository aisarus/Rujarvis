/**
 * Вид и тема окон — одно место в главном процессе.
 *
 * Тема (как в системе, светлая, тёмная) уходит в nativeTheme: страницы
 * узнают её через `prefers-color-scheme`, и переключение доходит до всех окон
 * без перезагрузки. Вид (тетрадь, маркер, кольцо) — атрибут `data-look`
 * страницы: его окнам рассылает сообщение, а новое окно берёт нынешний при
 * открытии. Цвета и шрифты видов — в `ui/looks.css`.
 */

import { BrowserWindow, nativeTheme } from 'electron';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import type { AppSettings, Look } from '../jarvis/setup/settings';
import { APP_ROOT } from './root';

export const LOOK_CHANNEL = 'jarvis-look';

let текущий: Look = 'ring';

export function currentLook(): Look {
  return текущий;
}

/** Таблица стилей видов — адресом файла: её подключают и страницы, собранные на лету. */
export function looksCssUrl(): string {
  return pathToFileURL(path.join(APP_ROOT, 'app', 'ui', 'looks.css')).href;
}

/**
 * Применить вид и тему из настроек.
 *
 * Вызывается при запуске и на каждую смену настроек: тема — системе, вид —
 * всем открытым окнам сообщением. Окну, которому вид не нужен (окно звука),
 * сообщение ничего не стоит.
 */
export function applyAppearance(settings: Pick<AppSettings, 'look' | 'theme'>): void {
  try {
    nativeTheme.themeSource = settings.theme;
  } catch {
    // Без системной темы окна остаются в светлой — работать это не мешает.
  }
  if (settings.look === текущий) return;
  текущий = settings.look;
  let окна: BrowserWindow[] = [];
  try {
    окна = BrowserWindow.getAllWindows();
  } catch {
    // Окон ещё нет — каждое возьмёт вид при открытии.
  }
  for (const окно of окна) {
    try {
      if (!окно.isDestroyed() && !окно.webContents.isDestroyed()) окно.webContents.send(LOOK_CHANNEL, текущий);
    } catch {
      // Кадр окна умер между проверкой и отправкой — новый возьмёт вид сам.
    }
  }
}

const ФОН: Record<Look, { light: string; dark: string }> = {
  tetrad: { light: '#fbfcff', dark: '#121935' },
  marker: { light: '#ffffff', dark: '#18191c' },
  ring: { light: '#f1f3fb', dark: '#0f1530' },
};

/**
 * Цвет окна до первой отрисовки страницы — фон вида в нынешней теме.
 * Иначе светлое окно на миг вспыхивало бы тёмным прямоугольником.
 */
export function windowBackground(look: Look = текущий): string {
  let тёмная = false;
  try {
    тёмная = nativeTheme.shouldUseDarkColors;
  } catch {
    // Нет системной темы — светлая.
  }
  return ФОН[look][тёмная ? 'dark' : 'light'];
}
