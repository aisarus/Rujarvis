/**
 * Файл лекции → звук одним каналом, кусками.
 *
 * WAV читается здесь же (`readWavParts`). MP4, M4A, MOV, MP3 и AAC режутся на
 * куски по пять минут (`mediaSlices`), и каждый кусок раскрывает Chromium в
 * окне микрофона — без внешних программ. Остальное (ogg, opus, webm, flac)
 * Chromium раскрывает целиком: реже встречается.
 *
 * Куски — по одному за раз: пока окно раскрывает кусок, следующий не
 * читается, и в памяти держится несколько минут звука, а не полтора часа
 * (замер 30.09.2026: целиком — 4,7 ГБ на полуторачасовом m4a).
 */

import path from 'node:path';

import { ipcMain, type BrowserWindow } from 'electron';

import { mediaSlices, readWavParts } from '../jarvis/lecture/mediaSlices';
import { AUDIO_BRIDGE_CHANNELS } from './audioBridgePage';

type OnPart = (samples: Float32Array, sampleRate: number) => void;

let номер = 0;

function вFloat32(samples: Float32Array | ArrayBuffer | number[]): Float32Array {
  if (samples instanceof Float32Array) return samples;
  if (samples instanceof ArrayBuffer) return new Float32Array(samples);
  return Float32Array.from(samples);
}

/** Один запрос к окну: файл целиком или вырезанный кусок. */
function раскрытьВОкне(окно: BrowserWindow, запрос: { path?: string; bytes?: Uint8Array }, onPart: OnPart, имя: string): Promise<void> {
  const id = ++номер;
  return new Promise((resolve, reject) => {
    const слушать = (
      _event: Electron.IpcMainEvent,
      ответ: { id?: number; samples?: Float32Array; sampleRate?: number; done?: boolean; error?: string },
    ): void => {
      if (ответ?.id !== id) return;
      if (ответ.error) {
        ipcMain.removeListener(AUDIO_BRIDGE_CHANNELS.decoded, слушать);
        reject(new Error(`не раскрыл ${имя}: ${ответ.error}`));
        return;
      }
      try {
        if (ответ.samples) onPart(вFloat32(ответ.samples), ответ.sampleRate ?? 16_000);
      } catch (error) {
        ipcMain.removeListener(AUDIO_BRIDGE_CHANNELS.decoded, слушать);
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (!ответ.done) return;
      ipcMain.removeListener(AUDIO_BRIDGE_CHANNELS.decoded, слушать);
      resolve();
    };
    ipcMain.on(AUDIO_BRIDGE_CHANNELS.decoded, слушать);
    окно.webContents.send(AUDIO_BRIDGE_CHANNELS.decodeFile, { id, ...запрос });
  });
}

export function createFileDecoder(окноМикрофона: () => BrowserWindow | null): (file: string, onPart: OnPart) => Promise<void> {
  return async (file, onPart) => {
    const имя = path.basename(file);
    if (/\.wav$/iu.test(file)) {
      await readWavParts(file, onPart);
      return;
    }
    const окно = окноМикрофона();
    if (!окно || окно.isDestroyed()) throw new Error('окно микрофона не поднято — раскрыть файл нечем');
    const куски = await mediaSlices(file);
    if (!куски) {
      await раскрытьВОкне(окно, { path: file }, onPart, имя);
      return;
    }
    try {
      for (let i = 0; i < куски.count; i += 1) {
        const bytes = await куски.read(i);
        if (bytes.length > 0) await раскрытьВОкне(окно, { bytes }, onPart, `${имя}, кусок ${i + 1}`);
      }
    } finally {
      await куски.close();
    }
  };
}
