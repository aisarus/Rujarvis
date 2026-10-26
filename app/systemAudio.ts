/**
 * Звук компьютера для лекции в Zoom: где система его отдаёт.
 *
 * Windows — петлёй вывода (loopback) всегда. macOS — с 14.2: Electron 39 и
 * новее берут его через CoreAudio Tap, если в Info.plist запущенного
 * приложения есть `NSAudioCaptureUsageDescription` (у Electron.app он свой).
 * Раньше 14.2 петли на маке нет: окно звука получает экран без звука, честно
 * говорит об этом и пишет с микрофона.
 *
 * Тестеры на маке (26.10.2026): MacBook Pro 2019 тянет macOS 15, так что петля
 * у них есть, — но без разрешения «Запись системного звука» дорожка приходит
 * сразу оконченной и молчит, ни ошибки, ни слова. Это ловит окно звука.
 */

import os from 'node:os';

/** macOS 14.2 и новее: ядро Darwin 23.2 и новее. */
export function macHasLoopback(release: string = os.release()): boolean {
  const [major = 0, minor = 0] = release.split('.').map((part) => Number(part) || 0);
  return major > 23 || (major === 23 && minor >= 2);
}

/** Отдаётся ли звук компьютера петлёй на этой системе. */
export function systemLoopback(platform: NodeJS.Platform = process.platform, release: string = os.release()): boolean {
  return platform === 'win32' || (platform === 'darwin' && macHasLoopback(release));
}

/** Что отдать на `getDisplayMedia` окна звука: экран (его окно гасит сразу) и, где можно, звук. */
export function displayMediaGrant<T>(screen: T, platform: NodeJS.Platform = process.platform, release: string = os.release()): { video: T; audio?: 'loopback' } {
  return systemLoopback(platform, release) ? { video: screen, audio: 'loopback' } : { video: screen };
}
