/**
 * Замер «зала»: чего ждать от конспекта на паре с микрофона ноутбука.
 *
 *   pnpm jarvis:lecture-room -- чистая-лекция.wav [--seconds=150] [--from=0]
 *
 * Берёт запись из тихой комнаты и портит её так, как портит аудитория
 * (`roomSim.ts`): лектор далеко, зал гулкий, вокруг люди. Каждый вариант идёт
 * через настоящую обработку звука Chromium — микрофон подменяется файлом
 * (`fake-mic-capture.ts`) — в трёх режимах: как слушаются команды (всё
 * включено), сырой и только автоусиление. Всё распознаётся моделью для лекций
 * кусками по паузам, как на живой лекции, и сравнивается с распознанной чистой
 * записью: доля ошибок по словам (WER) — насколько зал и обработка портят
 * расшифровку.
 *
 * Отвечает:
 * - прошло — замер сделан, таблица напечатана;
 * - не прошло — сервер не поднялся, запись пустая, Chromium не вернул звук;
 * - нечем мерить — нет распознавания на видеокарте или нет записи.
 *
 * Записи и отчёт — в папке данных Джарвиса (`lecture-room\`), не в хранилище и
 * не в репозитории. Окон не открывает, фокус не трогает.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';

import { createGpuTranscriber } from '../../app/gpuTranscriber';
import { chunkLevel, splitAtPauses } from '../../jarvis/lecture/audioCut';
import { jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';
import { findGpuWhisper, findLectureModel, gpuWhisperDir, startGpuWhisper } from '../../jarvis/voice/gpuWhisper';
import { decodeWav, encodeWav16, resampleTo16k } from '../../jarvis/voice/wav';
import { degrade, wordErrorRate, wordsOf, type RoomOptions } from './roomSim';

/**
 * Залы для сравнения обработки Chromium.
 *
 * Первый замер (30.09.2026) шёл с бормотанием зала на SNR 10 дБ — и дал 80%
 * ошибок уже без всякой обработки: бормотание здесь — тот же голос лектора
 * задом наперёд, для распознавания это худший случай из возможных. На
 * настоящей лекции зал в основном молчит, а шумят вентиляция и проектор.
 */
const ЗАЛЫ: Array<{ имя: string; порча: RoomOptions | null }> = [
  { имя: 'тихая комната', порча: null },
  // Средняя аудитория, ноутбук в середине: гул, вентиляция, редкий шёпот.
  { имя: 'зал', порча: { gainDb: -20, rt60: 0.8, drrDb: -3, snrDb: 15, babble: 0.2, seed: 1 } },
  // Большая гулкая аудитория, задние ряды, шумно.
  { имя: 'плохой зал', порча: { gainDb: -26, rt60: 1.4, drrDb: -8, snrDb: 8, babble: 0.5, seed: 2 } },
];

/** Разбор по причинам — только цифрой, без Chromium (`--digital`): что именно губит расшифровку. */
const ПРИЧИНЫ: Array<{ имя: string; порча: RoomOptions | null }> = [
  { имя: 'тихая комната', порча: null },
  { имя: 'даль −26 дБ', порча: { gainDb: -26, rt60: 0, drrDb: 0, snrDb: Infinity, seed: 3 } },
  { имя: 'гул 0,8 с', порча: { gainDb: 0, rt60: 0.8, drrDb: 0, snrDb: Infinity, seed: 3 } },
  { имя: 'гул 1,2 с −6', порча: { gainDb: 0, rt60: 1.2, drrDb: -6, snrDb: Infinity, seed: 3 } },
  { имя: 'гул 1,5 с −10', порча: { gainDb: 0, rt60: 1.5, drrDb: -10, snrDb: Infinity, seed: 3 } },
  { имя: 'шум 20 дБ', порча: { gainDb: 0, rt60: 0, drrDb: 0, snrDb: 20, babble: 0, seed: 3 } },
  { имя: 'шум 10 дБ', порча: { gainDb: 0, rt60: 0, drrDb: 0, snrDb: 10, babble: 0, seed: 3 } },
  { имя: 'шум 5 дБ', порча: { gainDb: 0, rt60: 0, drrDb: 0, snrDb: 5, babble: 0, seed: 3 } },
  { имя: 'шёпот 20 дБ', порча: { gainDb: 0, rt60: 0, drrDb: 0, snrDb: 20, babble: 1, seed: 3 } },
  { имя: 'шёпот 10 дБ', порча: { gainDb: 0, rt60: 0, drrDb: 0, snrDb: 10, babble: 1, seed: 3 } },
  { имя: 'зал', порча: ЗАЛЫ[1]?.порча ?? null },
  { имя: 'плохой зал', порча: ЗАЛЫ[2]?.порча ?? null },
];

const РЕЖИМЫ = [
  { код: 'on', имя: 'обработка (как команды)' },
  { код: 'raw', имя: 'сырой' },
  { код: 'agc', имя: 'только автоусиление' },
] as const;

async function свободныйПорт(): Promise<number> {
  return new Promise((resolve, reject) => {
    const сервер = createServer();
    сервер.once('error', reject);
    сервер.listen(0, '127.0.0.1', () => {
      const адрес = сервер.address();
      сервер.close(() => resolve(typeof адрес === 'object' && адрес ? адрес.port : 0));
    });
  });
}

const отвечает = async (endpoint: string): Promise<boolean> => {
  try {
    return (await fetch(`${endpoint}/`)).ok;
  } catch {
    return false;
  }
};

function электрон(): string {
  // Бинарь из пакета electron: сам пакет вне Электрона отдаёт путь к нему.
  return createRequire(import.meta.url)('electron') as string;
}

function снять(вход: string, выход: string, режим: string, секунд: number): Promise<{ settings?: Record<string, unknown>; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      электрон(),
      [path.resolve('dist/qa/fake-mic.cjs'), `--file=${вход}`, `--out=${выход}`, `--mode=${режим}`, `--seconds=${секунд}`],
      { timeout: (секунд + 60) * 1000, windowsHide: true },
      (_ошибка, stdout) => {
        const строка = String(stdout).split(/\r?\n/u).reverse().find((с) => с.startsWith('{'));
        try {
          resolve(строка ? (JSON.parse(строка) as { settings?: Record<string, unknown>; error?: string }) : { error: 'Электрон промолчал' });
        } catch {
          resolve({ error: `не JSON: ${строка?.slice(0, 120)}` });
        }
      },
    );
  });
}

async function поОчереди<T>(задачи: Array<() => Promise<T>>, разом: number): Promise<T[]> {
  const итоги: T[] = new Array<T>(задачи.length);
  let следующая = 0;
  await Promise.all(
    Array.from({ length: разом }, async () => {
      while (следующая < задачи.length) {
        const i = следующая++;
        итоги[i] = await (задачи[i] as () => Promise<T>)();
      }
    }),
  );
  return итоги;
}

async function main(): Promise<void> {
  const запись = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const секунд = Number(process.argv.find((a) => a.startsWith('--seconds='))?.slice(10) ?? '150');
  const с = Number(process.argv.find((a) => a.startsWith('--from='))?.slice(7) ?? '0');
  // Только цифрой: разбор по причинам, без Chromium, — минуты вместо получаса.
  const цифрой = process.argv.includes('--digital');
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings).get();
  const язык = settings.lectureLanguage || settings.language;
  if (!запись) {
    console.log('НЕЧЕМ МЕРИТЬ: нужна чистая запись лекции — pnpm jarvis:lecture-room -- лекция.wav');
    process.exitCode = 2;
    return;
  }
  const dir = gpuWhisperDir(paths.home);
  const files = await findGpuWhisper(dir);
  if (!files) {
    console.log('НЕЧЕМ МЕРИТЬ: нет распознавания на видеокарте — pnpm jarvis:gpu-stt');
    process.exitCode = 2;
    return;
  }
  const модель = (await findLectureModel(dir, язык)) ?? files.model;

  const { samples, sampleRate } = decodeWav(await readFile(запись));
  const весь = resampleTo16k(samples, sampleRate);
  const чистый = весь.slice(Math.floor(с * 16_000), Math.floor((с + секунд) * 16_000));
  if (чистый.length < 16_000 * 10) {
    console.log('НЕ ПРОШЛО: в записи меньше десяти секунд звука');
    process.exitCode = 1;
    return;
  }
  const папка = path.join(paths.data, 'lecture-room', new Date().toISOString().replace(/[:.]/gu, '-'));
  await mkdir(папка, { recursive: true });
  console.log('');
  console.log(`Замер зала: ${(чистый.length / 16_000).toFixed(0)} с записи, язык «${язык}», модель ${path.basename(модель)}`);
  console.log(`  записи — ${папка}`);

  // 1. Залы — цифрой.
  const варианты: Array<{ зал: string; файл: string }> = [];
  for (const зал of цифрой ? ПРИЧИНЫ : ЗАЛЫ) {
    const звук = зал.порча ? degrade(чистый, 16_000, зал.порча) : чистый;
    const файл = path.join(папка, `${зал.имя}.wav`);
    await writeFile(файл, encodeWav16(звук, 16_000));
    варианты.push({ зал: зал.имя, файл });
  }

  // 2. Каждый зал — через обработку Chromium в трёх режимах, по нескольку разом.
  const снимки = цифрой ? [] : варианты.flatMap((в) => РЕЖИМЫ.map((р) => ({ ...в, режим: р, выход: path.join(папка, `${в.зал} — ${р.код}.wav`) })));
  if (снимки.length > 0) console.log(`  снимаю через Chromium: ${снимки.length} записей по ${секунд} с, по три разом…`);
  const отчёты = await поОчереди(
    снимки.map((сн) => () => снять(сн.файл, сн.выход, сн.режим.код, (чистый.length / 16_000) + 1)),
    3,
  );
  const сломанные = отчёты.map((о, i) => (о.error ? `${снимки[i]?.зал}/${снимки[i]?.режим.код}: ${о.error}` : '')).filter(Boolean);
  if (сломанные.length > 0) {
    console.log(`НЕ ПРОШЛО: Chromium не вернул звук — ${сломанные.join('; ')}`);
    process.exitCode = 1;
    return;
  }
  for (const [i, о] of отчёты.entries()) {
    const s = о.settings ?? {};
    const сн = снимки[i];
    if (!сн) continue;
    const ждали = сн.режим.код === 'on' ? [true, true, true] : сн.режим.код === 'agc' ? [false, false, true] : [false, false, false];
    const есть = [s.echoCancellation, s.noiseSuppression, s.autoGainControl];
    if (есть.some((v, k) => v !== ждали[k])) console.log(`  внимание: ${сн.зал}/${сн.режим.код} — Chromium включил не то: ${JSON.stringify(есть)}`);
  }

  // 3. Распознавание — моделью для лекций, кусками по паузам.
  const port = await свободныйПорт();
  const сервер = await startGpuWhisper({ server: files.server, model: модель }, { port, isReady: отвечает, readyMs: 180_000 });
  try {
    const ухо = createGpuTranscriber({ endpoint: сервер.endpoint, language: язык, timeoutMs: 120_000 });
    // По кускам — то же, что видит слух лекции: уровень, доля речи, слова.
    const кускиОтчёта: Array<Record<string, string | number>> = [];
    const распознать = async (файл: string): Promise<{ текст: string; пустых: number; кусков: number; уровень: ReturnType<typeof chunkLevel> }> => {
      const { samples: s, sampleRate: r } = decodeWav(await readFile(файл));
      const звук = resampleTo16k(s, r);
      const куски = splitAtPauses(звук, 16_000);
      const тексты: string[] = [];
      let пустых = 0;
      for (const [от, до] of куски) {
        const часть = звук.subarray(от, до);
        const т = (await ухо.transcribe(часть, 16_000)).text.trim();
        if (!т) пустых += 1;
        тексты.push(т);
        const у = chunkLevel(часть, 16_000);
        кускиОтчёта.push({ файл: path.basename(файл), секунд: часть.length / 16_000, речьДб: у.speechDb, полДб: у.floorDb, доля: у.speechShare, слов: wordsOf(т).length });
      }
      await writeFile(`${файл}.txt`, тексты.join('\n'), 'utf8');
      return { текст: тексты.join(' '), пустых, кусков: куски.length, уровень: chunkLevel(звук, 16_000) };
    };

    const образец = await распознать(варианты[0]?.файл ?? '');
    if (!образец.текст) {
      console.log('НЕ ПРОШЛО: чистая запись распозналась пустой — сравнивать не с чем');
      process.exitCode = 1;
      return;
    }
    const строки: Array<Record<string, string | number>> = [];
    for (const в of варианты) {
      const цифра = await распознать(в.файл);
      строки.push({ зал: в.зал, путь: 'без Chromium', WER: wordErrorRate(образец.текст, цифра.текст), речьДб: цифра.уровень.speechDb, полДб: цифра.уровень.floorDb, пустых: `${цифра.пустых}/${цифра.кусков}` });
      for (const р of РЕЖИМЫ) {
        const сн = снимки.find((x) => x.зал === в.зал && x.режим.код === р.код);
        if (!сн) continue;
        const итог = await распознать(сн.выход);
        строки.push({ зал: в.зал, путь: р.имя, WER: wordErrorRate(образец.текст, итог.текст), речьДб: итог.уровень.speechDb, полДб: итог.уровень.floorDb, пустых: `${итог.пустых}/${итог.кусков}` });
      }
    }
    console.log('');
    console.log('  зал            путь                       WER    речь дБ  пол дБ  пустых кусков');
    for (const с of строки) {
      console.log(
        `  ${String(с.зал).padEnd(14)} ${String(с.путь).padEnd(26)} ${(Number(с.WER) * 100).toFixed(0).padStart(3)}%  ${Number(с.речьДб).toFixed(1).padStart(7)} ${Number(с.полДб).toFixed(1).padStart(7)}  ${с.пустых}`,
      );
    }
    await writeFile(path.join(папка, 'отчёт.json'), JSON.stringify({ запись: path.basename(запись), секунд, язык, модель: path.basename(модель), строки, куски: кускиОтчёта }, null, 2), 'utf8');
    console.log('');
    console.log('ПРОШЛО: замер сделан (WER — к распознанной чистой записи, не к ручной расшифровке)');
  } finally {
    сервер.stop();
  }
}

main().catch((error: unknown) => {
  console.error(`НЕ ПРОШЛО: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
