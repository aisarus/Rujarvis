/**
 * Конспект лекции — настоящими частями: `pnpm jarvis:lecture-check -- лекция.wav`.
 *
 * Язык лекции — `--language=xx`, иначе из настроек (пусто — язык интерфейса);
 * конспект — на языке интерфейса. Поднимает свой сервер whisper.cpp с моделью
 * для лекций на свободном порту (работающему Джарвису не мешает), режет
 * запись на куски по паузам, до 28 секунд — как
 * их режет живая лекция — и гонит через `LectureSession` с
 * настоящим Claude Code по подписке. Пишет в папку данных Джарвиса, а не в
 * хранилище Obsidian: проверка не должна оставлять заметок среди лекций.
 *
 * Отвечает тремя способами:
 * - прошло — расшифровка есть, раздел и итог собрались;
 * - не прошло — сервер не поднялся, расшифровка пустая, раздел или итог не
 *   собрались;
 * - нечем мерить — нет сервера распознавания на видеокарте или не передана
 *   запись. Модели для лекций нет — слушает small, как сам Джарвис без неё.
 *   Без записи сервер слушает фразу голоса Piper: на русском и английском это
 *   проверка слуха, на другом языке — только того, что сервер отвечает. Сам
 *   конспект без записи не собрать, и это сказано прямо.
 *
 * Окон не открывает и фокус не трогает.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

import { createGpuTranscriber } from '../../app/gpuTranscriber';
import { splitAtPauses } from '../../jarvis/lecture/audioCut';
import { listCourses, parseFrontmatter } from '../../jarvis/lecture/courses';
import { finalizeLecture } from '../../jarvis/lecture/finalize';
import { BAD_CONFIDENCE } from '../../jarvis/lecture/hearing';
import { LectureSession } from '../../jarvis/lecture/session';
import { createClaudeSummarizer } from '../../jarvis/lecture/summarize';
import { jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';
import { findGpuWhisper, findLectureModel, gpuWhisperDir, startGpuWhisper } from '../../jarvis/voice/gpuWhisper';
import { DEFAULT_VOICE, isVoiceInstalled, Speaker } from '../../jarvis/voice/tts';
import { decodeWav, resampleTo16k } from '../../jarvis/voice/wav';

/** Фраза для проверки без записи и примета, по которой видно, что услышано верно. */
const ФРАЗА: Record<'ru' | 'en', { сказать: string; ждём: string }> = {
  ru: { сказать: 'Сегодня мы поговорим о пределах функций.', ждём: 'предел' },
  en: { сказать: 'Today we will talk about the limits of functions.', ждём: 'limit' },
};

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

async function main(): Promise<void> {
  const запись = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings).get();
  const язык = (process.argv.find((a) => a.startsWith('--language='))?.slice('--language='.length) || settings.lectureLanguage || settings.language).toLowerCase();
  const конспект = settings.language;
  console.log('');
  console.log(`Конспект лекции: язык лекции «${язык}», конспект — «${конспект}»; куски по паузам, разделы — Claude Code по подписке`);
  const dir = gpuWhisperDir(paths.home);
  const files = await findGpuWhisper(dir);
  if (!files) {
    console.log('НЕЧЕМ МЕРИТЬ: нет распознавания на видеокарте — pnpm jarvis:gpu-stt');
    process.exitCode = 2;
    return;
  }
  // Модели для лекций нет — слушает small, как и сам Джарвис без неё.
  const своя = await findLectureModel(dir, язык);
  const модель = своя ?? files.model;
  if (!своя) console.log('  модели для лекций нет (pnpm jarvis:lecture-model) — слушает small, как Джарвис без неё');

  // Слух без записи проверяется только на языке, на котором есть голос Piper.
  const фраза = язык === 'ru' || язык === 'en' ? ФРАЗА[язык] : null;
  const голос = язык === 'en' ? DEFAULT_VOICE.en : DEFAULT_VOICE.ru;
  let звук: Float32Array;
  if (запись) {
    const { samples, sampleRate: rate } = decodeWav(await readFile(запись));
    звук = resampleTo16k(samples, rate);
    console.log(`  запись: ${path.basename(запись)}, ${(звук.length / 16_000).toFixed(1)} с`);
  } else if (isVoiceInstalled(paths.voiceModels, голос)) {
    const speaker = new Speaker(paths.voiceModels, голос);
    try {
      const { samples, sampleRate: rate } = decodeWav((await speaker.say((фраза ?? ФРАЗА.ru).сказать)).wav);
      звук = resampleTo16k(samples, rate);
    } finally {
      speaker.dispose();
    }
  } else {
    console.log(`НЕЧЕМ МЕРИТЬ: нет записи и нет голоса ${голос}, чтобы проверить хотя бы сервер`);
    process.exitCode = 2;
    return;
  }

  const устройство: string[] = [];
  const port = await свободныйПорт();
  const начало = Date.now();
  let сервер;
  try {
    сервер = await startGpuWhisper({ server: files.server, model: модель }, { port, isReady: отвечает, readyMs: 180_000, log: (строка) => устройство.push(строка) });
  } catch (беда) {
    console.log(`НЕ ПРОШЛО: сервер лекции не поднялся — ${беда instanceof Error ? беда.message : String(беда)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  сервер лекции поднят за ${Math.round((Date.now() - начало) / 1000)} с (pid ${сервер.pid}), модель ${path.basename(модель)}`);
  const признаки = устройство.filter((с) => !/\bno\b|failed|not found|error/iu.test(с));
  console.log(`  считает: ${признаки.some((с) => /cuda/iu.test(с)) ? 'CUDA' : признаки.some((с) => /metal/iu.test(с)) ? 'Metal' : 'процессор или не видно из вывода сервера'}`);

  // Тот же клиент, что у моста: проверяется то, что пишет Джарвис, а не свой запрос.
  const ухо = createGpuTranscriber({ endpoint: сервер.endpoint, language: язык, timeoutMs: 120_000, withConfidence: true });
  const уверенность: number[] = [];
  const распознать = async (samples: Float32Array): Promise<string> => {
    const { text, confidence } = await ухо.transcribe(samples, 16_000);
    if (confidence !== undefined) уверенность.push(confidence);
    return text;
  };

  try {
    if (!запись) {
      const t0 = performance.now();
      const текст = await распознать(звук);
      console.log(`  фраза Piper → «${текст}» — ${Math.round(performance.now() - t0)} мс`);
      const услышано = фраза ? текст.toLowerCase().replace(/ё/gu, 'е').includes(фраза.ждём) : Boolean(текст);
      if (!услышано) {
        console.log(фраза ? `НЕ ПРОШЛО: фраза не узнана — ждали «${фраза.ждём}»` : 'НЕ ПРОШЛО: сервер лекции ответил пустым текстом');
        process.exitCode = 1;
        return;
      }
      console.log(фраза ? '  фраза узнана' : `  сервер отвечает; слух на «${язык}» без записи не проверить`);
      console.log('НЕЧЕМ МЕРИТЬ конспект: нет записи. Передайте её: pnpm jarvis:lecture-check -- лекция.wav');
      process.exitCode = 2;
      return;
    }

    // Проверочная «папка лекций» с двумя курсами: модель обязана выбрать из
    // них или назвать новый, а лекция — лечь в папку курса с темой в имени.
    const папка = path.join(paths.data, 'lecture-check', new Date().toISOString().replace(/[:.]/gu, '-'));
    await mkdir(папка, { recursive: true });
    const курсы = конспект === 'en' ? ['History of Humankind', 'Physics'] : ['История человечества', 'Физика'];
    for (const курс of курсы) await mkdir(path.join(папка, курс), { recursive: true });
    const времена: number[] = [];
    // Метки и разделы считаются по самому звуку, а не по часам: запись
    // подаётся разом, а конспект выходит таким же, как на живой лекции.
    const сессия = new LectureSession(папка, конспект === 'en' ? 'Check' : 'Проверка', {
      lectureLanguage: язык,
      notesLanguage: конспект,
      transcribe: async (samples) => {
        const t0 = performance.now();
        const текст = await распознать(samples);
        времена.push((performance.now() - t0) / 1000 / (samples.length / 16_000));
        return текст;
      },
      summarize: createClaudeSummarizer(),
      log: (строка) => console.log(`  ${строка}`),
    });
    await сессия.start();
    // Куски — по паузам, как их режет живая лекция.
    for (const [от, до] of splitAtPauses(звук, 16_000)) сессия.addAudio(звук.subarray(от, до), 16_000);
    const t0 = Date.now();
    const итог = await сессия.finish(listCourses(папка));
    const место = await finalizeLecture({
      root: папка,
      notesFile: итог.notesFile,
      transcriptFile: итог.transcriptFile,
      audioFile: итог.audioFile,
      notes: конспект,
      when: сессия.startedAt,
      durationSec: итог.durationSec,
      course: null,
      modelCourse: итог.course,
      topic: итог.topic,
    });
    const заметка = await readFile(место.notesFile, 'utf8');
    const свойства = parseFrontmatter(заметка);
    const среднее = уверенность.length > 0 ? уверенность.reduce((a, b) => a + b, 0) / уверенность.length : null;
    const естьИтог = заметка.includes(конспект === 'en' ? '## Summary' : '## Кратко');
    const скорость = времена.length > 0 ? Math.max(...времена) : 0;
    console.log(`  расшифровка: ${итог.words} слов; распознавание — не медленнее ${скорость.toFixed(2)} × реального времени`);
    console.log(`  разделов: ${итог.sections}; итог: ${естьИтог ? 'есть' : 'нет'}; конспект собран за ${Math.round((Date.now() - t0) / 1000)} с после записи`);
    console.log(`  курс по мнению модели: «${итог.course ?? '—'}», тема: «${итог.topic ?? '—'}» → ${path.relative(папка, место.notesFile)}`);
    console.log(`  уверенность распознавания: ${среднее === null ? 'сервер не сказал' : среднее.toFixed(2)} (порог «слышно плохо» — ${BAD_CONFIDENCE})`);
    console.log(`  конспект: ${место.notesFile}`);

    const провалы = [
      итог.words === 0 ? 'расшифровка пустая' : '',
      итог.sections === 0 ? 'ни одного раздела' : '',
      заметка.includes('Раздел не собрался') || заметка.includes('This section failed') ? 'раздел не собрался' : '',
      !естьИтог ? 'нет итога' : '',
      !итог.topic ? 'модель не назвала тему' : '',
      !итог.course ? 'модель не назвала курс' : '',
      !свойства ? 'в заметке нет свойств лекции' : '',
      !/^### .+ \(\d[\d:]*–\d[\d:]*\)$/mu.test(заметка) ? 'у разделов нет времени' : '',
      среднее === null ? 'сервер не дал уверенности' : '',
      скорость > 1 ? 'распознавание медленнее реального времени' : '',
    ].filter(Boolean);
    console.log(провалы.length === 0 ? 'ПРОШЛО' : `НЕ ПРОШЛО: ${провалы.join('; ')}`);
    process.exitCode = провалы.length === 0 ? 0 : 1;
  } finally {
    сервер.stop();
  }
}

main().catch((error: unknown) => {
  console.error(`НЕ ПРОШЛО: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
