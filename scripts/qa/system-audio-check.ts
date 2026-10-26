/**
 * Звук компьютера (лекция в Zoom) на маке: `pnpm jarvis:system-audio-check`.
 *
 * Тот же запрос, что у окна звука: `getDisplayMedia` со звуком и то же
 * решение главного процесса (`displayMediaGrant`). Пока окно слушает, система
 * играет звук (`afplay`), и проверка смотрит, дошёл ли он.
 *
 * Отвечает:
 * - прошло — звук компьютера пришёл;
 * - не прошло — дорожка живая, звук играл, а пришла тишина;
 * - нечем мерить — не мак, macOS старше 14.2, нечем играть или разрешения
 *   «Запись системного звука» нет (дорожка оконченная) — на раннере его
 *   некому дать.
 *
 * Окно скрыто и фокус не берёт; звук слышен — на машине владельца без спроса
 * не гонять.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron';

import { displayMediaGrant, macHasLoopback } from '../../app/systemAudio';

const ПАПКА = mkdtempSync(path.join(os.tmpdir(), 'jarvis-system-audio-'));
app.setPath('userData', ПАПКА);

const СТРАНИЦА = `<!doctype html><meta charset="utf-8"><script>
const { ipcRenderer } = require('electron');
(async () => {
  try {
    const got = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    got.getVideoTracks().forEach((t) => t.stop());
    const tracks = got.getAudioTracks();
    const states = tracks.map((t) => t.readyState);
    if (!tracks.some((t) => t.readyState === 'live')) { ipcRenderer.send('done', { states }); return; }
    ipcRenderer.send('listening');
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(new MediaStream(tracks));
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    let peak = 0; let samples = 0;
    proc.onaudioprocess = (e) => { const d = e.inputBuffer.getChannelData(0); samples += d.length; for (const v of d) peak = Math.max(peak, Math.abs(v)); };
    src.connect(proc);
    const mute = ctx.createGain(); mute.gain.value = 0; proc.connect(mute); mute.connect(ctx.destination);
    setTimeout(() => ipcRenderer.send('done', { states, peak, seconds: samples / 16000 }), 6000);
  } catch (error) {
    ipcRenderer.send('done', { error: String((error && error.message) || error) });
  }
})();
</script>`;

function играть(): Promise<boolean> {
  return new Promise((resolve) => {
    const звук = spawn('afplay', ['/System/Library/Sounds/Ping.aiff'], { stdio: 'ignore' });
    звук.on('error', () => resolve(false));
    звук.on('close', (code) => resolve(code === 0));
  });
}

async function main(): Promise<number> {
  if (process.platform !== 'darwin') {
    console.log('НЕЧЕМ МЕРИТЬ: проверка для мака (на Windows петля работает с первого дня)');
    return 2;
  }
  if (!macHasLoopback()) {
    console.log(`НЕЧЕМ МЕРИТЬ: macOS старше 14.2 (Darwin ${os.release()}) — петли нет, окно звука пишет с микрофона`);
    return 2;
  }
  session.defaultSession.setPermissionRequestHandler((_c, permission, callback) => callback(permission === 'media' || permission === 'display-capture'));
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
      .then((sources) => (sources[0] ? callback(displayMediaGrant(sources[0])) : callback({})))
      .catch(() => callback({}));
  });

  let играло = false;
  ipcMain.on('listening', () => {
    void (async () => {
      for (let i = 0; i < 4; i += 1) играло = (await играть()) || играло;
    })();
  });
  const итог = new Promise<{ states?: string[]; peak?: number; seconds?: number; error?: string }>((resolve) => ipcMain.once('done', (_e, r) => resolve(r)));
  const окно = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  // Файлом, как окно звука: у страницы с адреса data: нет navigator.mediaDevices
  // (CI 26.10.2026: «Cannot read properties of undefined (reading 'getDisplayMedia')»).
  const страница = path.join(ПАПКА, 'capture.html');
  writeFileSync(страница, СТРАНИЦА, 'utf8');
  await окно.loadFile(страница);
  const r = await итог;
  окно.destroy();

  console.log(`  дорожки: ${JSON.stringify(r.states ?? [])}; играло: ${играло ? 'да' : 'нет'}; пик: ${r.peak?.toFixed(3) ?? '—'}; записано: ${r.seconds?.toFixed(1) ?? '—'} с`);
  if (r.error) {
    console.log(`НЕЧЕМ МЕРИТЬ: getDisplayMedia отказал — ${r.error}`);
    return 2;
  }
  if (!r.states?.includes('live')) {
    console.log('НЕЧЕМ МЕРИТЬ: дорожка звука оконченная — нет разрешения «Запись системного звука» (окно звука скажет человеку, где его включить)');
    return 2;
  }
  if (!играло) {
    console.log('НЕЧЕМ МЕРИТЬ: afplay не сыграл — у машины нет вывода звука');
    return 2;
  }
  if ((r.peak ?? 0) > 0.01) {
    console.log('ПРОШЛО');
    return 0;
  }
  console.log('НЕ ПРОШЛО: дорожка живая, звук играл, а пришла тишина');
  return 1;
}

app.on('window-all-closed', () => undefined);
void app.whenReady().then(async () => {
  let код = 1;
  try {
    код = await main();
  } catch (беда) {
    console.log(`НЕ ПРОШЛО: ${беда instanceof Error ? беда.message : String(беда)}`);
  }
  app.exit(код);
});
