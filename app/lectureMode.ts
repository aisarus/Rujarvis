/**
 * Режим лекции в мосте: «Джарвис, конспектируй лекцию по …» — и до «закончи
 * конспект».
 *
 * Звук из аудитории идёт в конспект (`LectureSession`), а не в разговор.
 * Слушает его модель для лекций (`pnpm jarvis:lecture-model`) на своём
 * сервере whisper.cpp на соседнем порту, разделы пишет Claude Code по
 * подписке, заметка — в Obsidian и открывается сразу, чтобы её было видно
 * живой.
 *
 * Сервер модели поднимается секунды. Мост его не ждёт: куски звука стоят в
 * очереди сессии и распознаются, как только он ответит. Модели для лекций
 * нет — слушает общий сервер (small) с языком лекции: хуже, но лекция не
 * пропадает, и человеку об этом сказано.
 */

import path from 'node:path';

import { shell } from 'electron';

import { LectureSession, type NotesLanguage } from '../jarvis/lecture/session';
import { createClaudeSummarizer } from '../jarvis/lecture/summarize';
import { lectureFolder, obsidianOpenUrl } from '../jarvis/lecture/vault';
import { tr } from '../jarvis/locale/language';
import { findGpuWhisper, findLectureModel, gpuWhisperDir, startGpuWhisper, type GpuWhisperServer } from '../jarvis/voice/gpuWhisper';
import { createGpuTranscriber, isWhisperServerReady, WHISPER_SERVER_PORT } from './gpuTranscriber';

const ПОРТ_ЛЕКЦИИ = WHISPER_SERVER_PORT + 1;

interface Лекция {
  session: LectureSession;
  сервер: Promise<GpuWhisperServer | null>;
}

let идёт: Лекция | null = null;
/** Итог прошлой лекции ещё пишется: её сервер занимает тот же порт. */
let дописывается: Promise<string> | null = null;
/**
 * Лекция поднимается: до `идёт` — несколько ожиданий. Двойное нажатие кнопки
 * или кнопка вместе с голосом заводили две сессии и два сервера на одном
 * порту (ревью 29.09.2026).
 */
let запускается = false;

export function lectureActive(): boolean {
  return идёт !== null;
}

/** Что с конспектом сейчас — для кнопки на плашке. */
export type LectureState = 'off' | 'starting' | 'on' | 'finishing';

export function lectureState(): LectureState {
  return идёт ? 'on' : запускается ? 'starting' : дописывается ? 'finishing' : 'off';
}

const слушатели = new Set<(state: LectureState) => void>();

/** Подписка на смену состояния. Возвращает отписку. */
export function onLectureState(listener: (state: LectureState) => void): () => void {
  слушатели.add(listener);
  return () => слушатели.delete(listener);
}

function оповестить(): void {
  const state = lectureState();
  for (const слушатель of слушатели) {
    try {
      слушатель(state);
    } catch {
      // Упавший слушатель — не повод ронять конспект.
    }
  }
}

export interface LectureStartOptions {
  home: string;
  outputDir: string;
  /** Язык лекции — код Whisper; конспект пишется на `notesLanguage`. */
  lectureLanguage: string;
  notesLanguage: NotesLanguage;
  /** Адрес общего сервера распознавания — запасной, когда модели для лекций нет. */
  mainEndpoint(): string | null;
}

export async function startLecture(subject: string | undefined, options: LectureStartOptions): Promise<string> {
  if (идёт || запускается) return tr('Конспект уже пишется.', 'Already taking notes.');
  if (дописывается) return tr('Ещё дописываю прошлый конспект — через минуту.', 'Still finishing the previous notes. Give me a minute.');
  запускается = true;
  оповестить();
  try {
    return await начатьЛекцию(subject, options);
  } finally {
    запускается = false;
    оповестить();
  }
}

async function начатьЛекцию(subject: string | undefined, options: LectureStartOptions): Promise<string> {

  const dir = gpuWhisperDir(options.home);
  const files = await findGpuWhisper(dir).catch(() => null);
  const модель = files ? await findLectureModel(dir, options.lectureLanguage).catch(() => null) : null;
  const сервер: Promise<GpuWhisperServer | null> =
    files && модель
      ? startGpuWhisper(
          { server: files.server, model: модель },
          {
            port: ПОРТ_ЛЕКЦИИ,
            isReady: isWhisperServerReady,
            readyMs: 180_000,
            log: (строка) => console.log(`[jarvis:lecture] сервер лекции: ${строка.slice(0, 200)}`),
          },
        ).catch((error: unknown) => {
          console.error(`[jarvis:lecture] сервер лекции не поднялся: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
      : Promise.resolve(null);

  const transcribe = async (samples: Float32Array, sampleRate: number): Promise<string> => {
    const свой = await сервер;
    const endpoint = свой?.endpoint ?? options.mainEndpoint();
    if (!endpoint) throw new Error('распознавать нечем: нет сервера на видеокарте (pnpm jarvis:gpu-stt)');
    return (await createGpuTranscriber({ endpoint, language: options.lectureLanguage }).transcribe(samples, sampleRate)).text;
  };

  const { folder, vault } = lectureFolder(options.outputDir, options.notesLanguage);
  const session = new LectureSession(folder, subject ?? '', {
    transcribe,
    summarize: createClaudeSummarizer(),
    lectureLanguage: options.lectureLanguage,
    notesLanguage: options.notesLanguage,
    // Только счёт и события: сама лекция в журнал Джарвиса не пишется.
    log: (строка) => console.log(`[jarvis:lecture] ${строка}`),
  });
  await session.start();
  идёт = { session, сервер };
  оповестить();
  console.log(
    `[jarvis:lecture] конспект начат${vault ? ' в хранилище Obsidian' : ' в папке результатов (Obsidian не найден)'}; ` +
      `язык лекции: ${options.lectureLanguage}, конспекта: ${options.notesLanguage}; ` +
      `модель: ${модель ? path.basename(модель) : 'для лекций нет — общий сервер'}`,
  );
  if (vault) await shell.openExternal(obsidianOpenUrl(session.notesFile)).catch(() => undefined);

  return модель
    ? tr('Конспектирую. Закончить — «Джарвис, закончи конспект».', 'Taking notes. Say "Jarvis, stop lecture notes" to finish.')
    : tr(
        'Конспектирую общим распознаванием. Точнее будет с моделью для лекций: pnpm jarvis:lecture-model.',
        'Taking notes with the general recognition. The lecture model is more accurate: pnpm jarvis:lecture-model.',
      );
}

/** Кусок звука из аудитории — в конспект. */
export function feedLecture(samples: Float32Array, sampleRate: number): void {
  идёт?.session.addAudio(samples, sampleRate);
}

/**
 * Дописать итог и погасить сервер лекции.
 *
 * Итог — минута-другая модели. Мост поэтому не ждёт его внутри команды:
 * реплики разбираются по одной, и «стоп» простоял бы за итогом всё это время.
 * Лекция перестаёт быть активной сразу — следующая фраза уже разговор.
 */
export function finishLecture(): Promise<string> | null {
  const была = идёт;
  if (!была) return null;
  идёт = null;
  const работа = (async (): Promise<string> => {
    try {
      const итог = await была.session.finish();
      console.log(`[jarvis:lecture] конспект готов: ${итог.sections} разделов, ${итог.words} слов расшифровки`);
      return tr(`Конспект готов: разделов — ${итог.sections}.`, `Notes are ready: ${итог.sections} sections.`);
    } finally {
      (await была.сервер)?.stop();
      дописывается = null;
      оповестить();
    }
  })();
  дописывается = работа;
  оповестить();
  return работа;
}

/**
 * Мост закрывается посреди лекции: сервер — погасить (свой pid), записанное
 * остаётся на диске как есть. Итога нет — на него нужна минута модели, а
 * закрытие ждать не может.
 */
export function abandonLecture(): void {
  const была = идёт;
  идёт = null;
  была?.session.abandon();
  void была?.сервер.then((сервер) => сервер?.stop());
  if (была) оповестить();
}
