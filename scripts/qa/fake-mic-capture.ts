/**
 * Микрофон из файла: что делает с записью обработка звука Chromium.
 *
 * Chromium умеет подставить вместо микрофона WAV-файл
 * (`--use-file-for-fake-audio-capture`), и обработка — эхоподавление,
 * шумоподавление, автоусиление — идёт по нему так же, как по живому
 * микрофону. Так видно, что обработка делает с голосом из аудитории, без
 * колонок, без микрофона и без человека рядом.
 *
 *   electron dist/qa/fake-mic.cjs --file=зал.wav --out=зал-сырой.wav --mode=raw --seconds=150
 *
 * Режимы: `on` — как Джарвис слушает команды, `raw` — без всякой обработки,
 * `agc` — только автоусиление. Отчёт (что Chromium на самом деле включил —
 * `getSettings()` дорожки) — строкой JSON в stdout.
 *
 * Окно скрыто и фокус не берёт; у каждого запуска свой профиль, поэтому
 * несколько замеров идут разом.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { encodeWav16 } from '../../jarvis/voice/wav';

const арг = (имя: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${имя}=`))?.slice(имя.length + 3);

const файл = арг('file');
const выход = арг('out');
const режим = арг('mode') ?? 'on';
const секунд = Number(арг('seconds') ?? '30');

if (!файл || !выход) {
  console.log(JSON.stringify({ error: 'нужны --file= и --out=' }));
  process.exit(2);
}

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'jarvis-fake-mic-')));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
// %noloop — сыграть файл один раз, дальше тишина.
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${файл}%noloop`);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const ОГРАНИЧЕНИЯ: Record<string, { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean }> = {
  on: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  raw: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  agc: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
};

function страница(): string {
  const ограничения = JSON.stringify({ channelCount: 1, ...(ОГРАНИЧЕНИЯ[режим] ?? ОГРАНИЧЕНИЯ.on) });
  return `<!doctype html><meta charset="utf-8"><script>
const { ipcRenderer } = require('electron');
(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: ${ограничения} });
    const track = stream.getAudioTracks()[0];
    const settings = track.getSettings();
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const parts = [];
    let total = 0;
    proc.onaudioprocess = (e) => { const c = new Float32Array(e.inputBuffer.getChannelData(0)); parts.push(c); total += c.length; };
    src.connect(proc);
    const mute = ctx.createGain(); mute.gain.value = 0; proc.connect(mute); mute.connect(ctx.destination);
    setTimeout(() => {
      const out = new Float32Array(total); let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      ipcRenderer.send('done', { settings, sampleRate: ctx.sampleRate, samples: out });
    }, ${Math.round(секунд * 1000)});
  } catch (error) {
    ipcRenderer.send('done', { error: String((error && error.message) || error) });
  }
})();
</script>`;
}

void app.whenReady().then(async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-fake-mic-page-'));
  const pagePath = path.join(dir, 'mic.html');
  writeFileSync(pagePath, страница(), 'utf8');
  const окно = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  окно.webContents.session.setPermissionRequestHandler((_c, permission, callback) => callback(permission === 'media'));
  ipcMain.once('done', (_e, итог: { error?: string; settings?: unknown; sampleRate?: number; samples?: Float32Array }) => {
    if (итог.error || !итог.samples || !итог.sampleRate) {
      console.log(JSON.stringify({ error: итог.error ?? 'пустая запись' }));
      app.exit(1);
      return;
    }
    writeFileSync(выход, encodeWav16(итог.samples, итог.sampleRate));
    console.log(JSON.stringify({ settings: итог.settings, seconds: итог.samples.length / итог.sampleRate }));
    app.exit(0);
  });
  await окно.loadFile(pagePath);
});
