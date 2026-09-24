/**
 * Какой драйвер рабочего стола брать на этой машине.
 *
 * Выбор один на всё приложение: голосовой слой и MCP-сервер заводят драйвер
 * каждый свой, и если выбирать в двух местах, они однажды разойдутся.
 *
 * Windows и macOS — разные драйверы, Linux остаётся на Windows-драйвере и
 * честно падает при первой операции: рабочего стола под Linux у Джарвиса нет,
 * и делать вид, что он есть, хуже, чем сказать «не умею».
 */

import { DarwinDriver } from './darwinDriver';
import { DesktopDriver, driverStamp, type DesktopControl } from './driver';

export type { DesktopControl };

export function createDesktopDriver(): DesktopControl {
  return process.platform === 'darwin' ? new DarwinDriver() : new DesktopDriver();
}

/**
 * Чем именно работаем — в первую строку журнала прогона.
 *
 * На Windows это путь и хеш скрипта: две правды об одном файле однажды
 * разошлись на сутки, и отладка выглядела как «в исходнике починено, в работе
 * нет». На маке скрипта нет, весь драйвер собран в бандл — поэтому и хеша нет.
 */
export function desktopStamp(): { path: string; hash: string } {
  if (process.platform === 'darwin') return { path: 'osascript (darwinDriver.ts)', hash: 'в сборке' };
  return driverStamp();
}
