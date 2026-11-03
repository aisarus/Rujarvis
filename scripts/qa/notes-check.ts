/**
 * Вариант «только конспекты» настоящим Электроном: `pnpm jarvis:notes-check -- --file=речь.wav --expect=слово`.
 *
 * Поднимает тот же мост, что приложение с `edition: 'notes'`
 * (`startNotesBridge`), вместо микрофона — WAV-файл
 * (`--use-file-for-fake-audio-capture`), и идёт путём человека: «● Конспект» →
 * «Микрофон» на плашке, файл доигрывает, «■ Закончить конспект». Проверяется:
 * - до лекции микрофон не взят — слуха команд у варианта нет;
 * - лекция началась, звук лёг в запись целиком;
 * - речь распознана: в расшифровке есть `--expect`;
 * - после лекции микрофон отпущен;
 * - на плашке и в окне звука нет ошибок страницы.
 *
 * Отвечает: прошло / не прошло / нечем мерить. Расшифровка — «нечем мерить»,
 * если распознавание лекций не установлено (`pnpm jarvis:gpu-stt`). Итога
 * конспекта без Claude Code или Codex не будет, и его здесь не ждут: проверка
 * про звук и слух, а не про модель.
 *
 * Меняет настройки и пишет лекцию — поэтому работает только во временной
 * папке Джарвиса (`JARVIS_HOME`) или в CI, и никогда в хранилище Obsidian.
 * Плашка показывается (без фокуса): на машине владельца без спроса не гонять.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app, BrowserWindow } from 'electron';

import { lectureState, type LectureState } from '../../app/lectureMode';
import { startNotesBridge } from '../../app/voiceBridge';
import { lectureFolder } from '../../jarvis/lecture/vault';
import { jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';
import { findGpuWhisper, gpuWhisperDir } from '../../jarvis/voice/gpuWhisper';
import { decodeWav } from '../../jarvis/voice/wav';

const арг = (имя: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${имя}=`))?.slice(имя.length + 3);

const файл = арг('file');
const ждём = (арг('expect') ?? '').toLowerCase();
const язык = арг('language') ?? 'en';

type Итог = { вид: 'прошло' | 'не прошло' | 'нечем мерить'; что: string };
const итоги: Array<{ имя: string; итог: Итог }> = [];
const записать = (имя: string, итог: Итог): void => {
  итоги.push({ имя, итог });
};

const ждать = (мс: number): Promise<void> => new Promise((r) => setTimeout(r, мс));

async function дождаться(условие: () => boolean | Promise<boolean>, мс: number, шаг = 250): Promise<boolean> {
  const до = Date.now() + мс;
  while (Date.now() < до) {
    if (await условие()) return true;
    await ждать(шаг);
  }
  return Boolean(await условие());
}

/** Окно по примете на странице: плашка и окно звука — обычные окна Electron. */
async function окноГде(примета: string): Promise<BrowserWindow | null> {
  for (const окно of BrowserWindow.getAllWindows()) {
    if (окно.isDestroyed()) continue;
    const есть = await окно.webContents.executeJavaScript(примета).catch(() => false);
    if (есть) return окно;
  }
  return null;
}

function найтиФайлы(папка: string, out: string[] = []): string[] {
  if (!existsSync(папка)) return out;
  for (const имя of readdirSync(папка)) {
    const полный = path.join(папка, имя);
    if (statSync(полный).isDirectory()) найтиФайлы(полный, out);
    else out.push(полный);
  }
  return out;
}

if (файл) {
  app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-check-')));
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  // %noloop — сыграть файл один раз, дальше тишина: лекция кончилась.
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${файл}%noloop`);
  // Файл подставного микрофона читает служба звука. На маке она в песочнице
  // и к файлу не допускается — ошибка в сборке не печатается, а запись
  // выходит тишиной (CI 26.10.2026: пик 0,00 на обоих маках, на Windows тот
  // же путь слышит). Только для проверки: служба звука — в главном процессе.
  app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess,AudioServiceSandbox');
}

async function main(): Promise<number> {
  if (!файл || !existsSync(файл)) {
    console.log('НЕЧЕМ МЕРИТЬ: нужна запись речи — --file=речь.wav');
    return 2;
  }
  if (!process.env.JARVIS_HOME && process.env.CI !== 'true') {
    console.log('НЕЧЕМ МЕРИТЬ: проверка меняет настройки и пишет лекцию — задайте временную JARVIS_HOME или гоняйте в CI');
    return 2;
  }
  const звукФайла = decodeWav(readFileSync(файл));
  const секундФайла = звукФайла.samples.length / звукФайла.sampleRate;

  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings);
  const результаты = mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-out-'));
  settings.update({ edition: 'notes', language: язык === 'ru' ? 'ru' : 'en', lectureLanguage: язык, outputDir: результаты });
  const { folder, vault } = lectureFolder(результаты, settings.get().language);
  if (vault) {
    console.log(`НЕЧЕМ МЕРИТЬ: найдено хранилище Obsidian (${vault}) — лекция легла бы туда, а не во временную папку`);
    return 2;
  }
  const распознавание = await findGpuWhisper(gpuWhisperDir(paths.home));
  console.log(`  запись: ${path.basename(файл)}, ${секундФайла.toFixed(1)} с; язык лекции: ${язык}; распознавание: ${распознавание ? path.basename(распознавание.server) : 'не установлено'}`);

  const ошибки: string[] = [];
  const мост = await startNotesBridge({ settings });
  for (const окно of BrowserWindow.getAllWindows()) {
    окно.webContents.on('console-message', (event) => {
      if (event.level === 'error') ошибки.push(event.message);
    });
  }

  const плашка = await окноГде("Boolean(document.getElementById('source-mic'))");
  const звук = await окноГде("typeof lectureSource !== 'undefined'");
  if (!плашка || !звук) {
    записать('окна', { вид: 'не прошло', что: `${плашка ? '' : 'плашки нет; '}${звук ? '' : 'окна звука нет'}` });
    мост.dispose();
    return итог();
  }
  const микрофонВзят = async (): Promise<boolean> =>
    Boolean(await звук.webContents.executeJavaScript("stream !== null && stream.getAudioTracks().some((t) => t.readyState === 'live')"));

  await ждать(1500);
  записать('до лекции микрофон не взят', (await микрофонВзят())
    ? { вид: 'не прошло', что: 'микрофон открыт без лекции — слух команд у конспектора включился' }
    : { вид: 'прошло', что: 'микрофон свободен' });

  // Путь человека: «● Конспект» раскрывает выбор, «Микрофон» начинает.
  await плашка.webContents.executeJavaScript("document.getElementById('lecture').click()");
  await ждать(300);
  await плашка.webContents.executeJavaScript("document.getElementById('source-mic').click()");
  const началась = await дождаться(() => lectureState() === 'on', 120_000);
  if (!началась) {
    записать('лекция началась', { вид: 'не прошло', что: `состояние: ${lectureState()}` });
    мост.dispose();
    return итог();
  }
  записать('лекция началась', { вид: 'прошло', что: 'кнопками на плашке' });
  const началоЗаписи = Date.now();

  await ждать(секундФайла * 1000 + 3000);
  записать('во время лекции микрофон взят', (await микрофонВзят())
    ? { вид: 'прошло', что: 'поток живой' }
    : { вид: 'не прошло', что: 'лекция идёт, а микрофона нет' });
  const длилась = (Date.now() - началоЗаписи) / 1000;
  await плашка.webContents.executeJavaScript("document.getElementById('lecture').click()");
  const состояния: LectureState[] = [];
  const кончилась = await дождаться(() => {
    const с = lectureState();
    if (состояния.at(-1) !== с) состояния.push(с);
    return с === 'off';
  }, 15 * 60_000, 1000);
  записать('лекция закончилась', кончилась
    ? { вид: 'прошло', что: `через ${состояния.join(' → ')}` }
    : { вид: 'не прошло', что: `за 15 минут не дописалась: ${состояния.join(' → ')}` });

  const файлы = найтиФайлы(folder);
  const wav = файлы.find((f) => f.endsWith('.wav'));
  if (!wav) {
    записать('звук в записи', { вид: 'не прошло', что: `в ${folder} нет .wav: ${файлы.map((f) => path.basename(f)).join(', ') || 'пусто'}` });
  } else {
    const записано = decodeWav(readFileSync(wav));
    const секунд = записано.samples.length / записано.sampleRate;
    let пик = 0;
    for (const s of записано.samples) пик = Math.max(пик, Math.abs(s));
    записать('звук в записи', секунд >= Math.min(секундФайла, длилась) * 0.8 && пик > 0.05
      ? { вид: 'прошло', что: `${секунд.toFixed(1)} с, пик ${пик.toFixed(2)}` }
      : { вид: 'не прошло', что: `${секунд.toFixed(1)} с из ${секундФайла.toFixed(1)}, пик ${пик.toFixed(2)}` });
  }

  const расшифровка = файлы.find((f) => / — (расшифровка|transcript)\.md$/u.test(f));
  const текст = расшифровка ? readFileSync(расшифровка, 'utf8') : '';
  if (!распознавание) {
    записать('речь распознана', { вид: 'нечем мерить', что: 'распознавание лекций не установлено — pnpm jarvis:gpu-stt' });
  } else if (!ждём) {
    записать('речь распознана', { вид: 'нечем мерить', что: 'не названо, что ждать: --expect=слово' });
  } else {
    записать('речь распознана', текст.toLowerCase().includes(ждём)
      ? { вид: 'прошло', что: `«${ждём}» в расшифровке` }
      : { вид: 'не прошло', что: `нет «${ждём}»: ${текст.replace(/\s+/gu, ' ').slice(0, 200) || 'расшифровки нет'}` });
  }

  const отпущен = await дождаться(async () => !(await микрофонВзят()), 10_000);
  записать('после лекции микрофон отпущен', отпущен
    ? { вид: 'прошло', что: 'поток закрыт' }
    : { вид: 'не прошло', что: 'микрофон остался открыт между парами' });

  записать('ошибки страниц', ошибки.length === 0
    ? { вид: 'прошло', что: 'нет' }
    : { вид: 'не прошло', что: ошибки.join('; ').slice(0, 300) });

  мост.dispose();
  return итог();
}

function итог(): number {
  let неПрошло = 0;
  let нечем = 0;
  for (const { имя, итог: и } of итоги) {
    if (и.вид === 'не прошло') неПрошло++;
    if (и.вид === 'нечем мерить') нечем++;
    const метка = и.вид === 'прошло' ? 'прошло      ' : и.вид === 'не прошло' ? 'НЕ ПРОШЛО   ' : 'нечем мерить';
    console.log(`  ${метка} ${имя} — ${и.что}`);
  }
  console.log(`Всего ${итоги.length}: не прошло ${неПрошло}, нечем мерить ${нечем}`);
  return неПрошло > 0 ? 1 : нечем > 0 ? 2 : 0;
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
