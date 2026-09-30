/**
 * Раскрывает ли окно микрофона звук и видео из файла — и сколько это стоит.
 *
 *   pnpm jarvis:lecture-file-check -- запись.m4a [другая.mp4 …] [--expect=секунд]
 *
 * Конспект по файлу раскрывает mp3, m4a и видео тем же Chromium, что держит
 * микрофон, — кусками по пять минут (`lectureFileDecode.ts`), без внешних
 * программ. Здесь поднимается та же страница в скрытом окне и тот же
 * раскрыватель, что у моста, и для каждого файла меряется: сколько секунд
 * звука вышло, за сколько и сколько памяти заняли процессы Электрона на пике.
 * Полуторачасовая лекция целиком — это 4,7 ГБ (замер 30.09.2026), и то, что
 * кусками вышло меньше, надо знать числом, а не надеждой.
 *
 * Отвечает:
 * - прошло — каждый файл раскрыт, длина совпала с `--expect` (±2%);
 * - не прошло — файл не раскрылся или длина другая;
 * - нечем мерить — не передано ни одного файла.
 *
 * Окно скрыто, фокус не берёт, микрофон не открывает.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { AUDIO_BRIDGE_CHANNELS, buildAudioBridgeHtml } from '../../app/audioBridgePage';
import { createFileDecoder } from '../../app/lectureFileDecode';
import { readWavParts } from '../../jarvis/lecture/mediaSlices';

const файлы = process.argv.slice(2).filter((a) => !a.startsWith('-') && /\.[a-z0-9]{2,4}$/iu.test(a) && !a.endsWith('.cjs'));
const ждём = Number(process.argv.find((a) => a.startsWith('--expect='))?.slice(9) ?? 'NaN');
// Образец (WAV), из которого файлы сделаны: раскрытый звук обязан совпасть с
// ним по громкости секунда в секунду, а не только по длине — неверно
// собранный поток AAC раскрылся бы шумом той же длительности.
const образец = process.argv.find((a) => a.startsWith('--reference='))?.slice(12);

/** Громкость по секундам. */
function погромкости(части: Array<{ samples: Float32Array; rate: number }>): number[] {
  const out: number[] = [];
  let сумма = 0;
  let n = 0;
  let частота = 16_000;
  for (const { samples, rate } of части) {
    частота = rate;
    for (const v of samples) {
      сумма += v * v;
      n += 1;
      if (n >= частота) {
        out.push(Math.sqrt(сумма / n));
        сумма = 0;
        n = 0;
      }
    }
  }
  return out;
}

/** Корреляция двух рядов на общей длине (со сдвигом до двух секунд — задержка кодека). */
function сходство(a: number[], b: number[]): number {
  let лучшее = -1;
  for (let сдвиг = -2; сдвиг <= 2; сдвиг += 1) {
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < a.length; i += 1) {
      const j = i + сдвиг;
      if (j < 0 || j >= b.length) continue;
      x.push(a[i] ?? 0);
      y.push(b[j] ?? 0);
    }
    if (x.length < 10) continue;
    const mx = x.reduce((s, v) => s + v, 0) / x.length;
    const my = y.reduce((s, v) => s + v, 0) / y.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < x.length; i += 1) {
      sxy += ((x[i] ?? 0) - mx) * ((y[i] ?? 0) - my);
      sxx += ((x[i] ?? 0) - mx) ** 2;
      syy += ((y[i] ?? 0) - my) ** 2;
    }
    лучшее = Math.max(лучшее, sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : -1);
  }
  return лучшее;
}

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'jarvis-lecture-file-')));

function пикПамяти(): { стоп(): number } {
  let пик = 0;
  const замер = (): void => {
    const всего = app.getAppMetrics().reduce((n, m) => n + (m.memory?.workingSetSize ?? 0), 0);
    пик = Math.max(пик, всего);
  };
  замер();
  const таймер = setInterval(замер, 250);
  return {
    стоп: () => {
      clearInterval(таймер);
      замер();
      return пик / 1024;
    },
  };
}

void app.whenReady().then(async () => {
  if (файлы.length === 0) {
    console.log('НЕЧЕМ МЕРИТЬ: передайте файлы — pnpm jarvis:lecture-file-check -- запись.m4a');
    app.exit(2);
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-lecture-file-page-'));
  const страница = path.join(dir, 'audio.html');
  writeFileSync(страница, buildAudioBridgeHtml(), 'utf8');
  const окно = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  const готово = new Promise<void>((r) => ipcMain.once(AUDIO_BRIDGE_CHANNELS.ready, () => r()));
  await окно.loadFile(страница);
  await готово;

  const раскрыть = createFileDecoder(() => окно);
  const провалы: string[] = [];
  for (const файл of файлы) {
    const t0 = Date.now();
    const память = пикПамяти();
    let секунд = 0;
    // Для сверки хватит первых пяти минут: их громкость и сравнивается.
    const начало: Array<{ samples: Float32Array; rate: number }> = [];
    const итог = await раскрыть(path.resolve(файл), (samples, rate) => {
      if (образец && секунд < 300) начало.push({ samples, rate });
      секунд += samples.length / rate;
    }).then(
      () => ({ секунд, ошибка: undefined as string | undefined }),
      (error: unknown) => ({ секунд, ошибка: error instanceof Error ? error.message : String(error) }),
    );
    const пик = память.стоп();
    const имя = path.basename(файл);
    if (итог.ошибка) {
      провалы.push(`${имя}: ${итог.ошибка}`);
      console.log(`  ${имя}: не раскрылся — ${итог.ошибка}`);
      continue;
    }
    console.log(
      `  ${имя}: ${(итог.секунд / 60).toFixed(1)} мин звука за ${((Date.now() - t0) / 1000).toFixed(1)} с; ` +
        `пик памяти Электрона ${пик.toFixed(0)} МБ`,
    );
    if (Number.isFinite(ждём) && Math.abs(итог.секунд - ждём) > ждём * 0.02) провалы.push(`${имя}: ${итог.секунд.toFixed(0)} с вместо ${ждём}`);
    if (образец) {
      const эталон: Array<{ samples: Float32Array; rate: number }> = [];
      await readWavParts(образец, (samples, rate) => эталон.push({ samples, rate }));
      const а = погромкости(начало).slice(0, 300);
      const б = погромкости(эталон).slice(0, 300);
      const r = сходство(а, б);
      console.log(`    сходство громкости с образцом по секундам: ${r.toFixed(3)}`);
      if (r < 0.9) провалы.push(`${имя}: звук не похож на образец (${r.toFixed(2)})`);
    }
  }
  console.log(провалы.length === 0 ? 'ПРОШЛО' : `НЕ ПРОШЛО: ${провалы.join('; ')}`);
  app.exit(провалы.length === 0 ? 0 : 1);
});
