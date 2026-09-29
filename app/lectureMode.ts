/**
 * Режим лекции в мосте: «Джарвис, конспектируй лекцию по …» — и до «закончи
 * конспект».
 *
 * Звук из аудитории идёт в конспект (`LectureSession`), а не в разговор:
 * иврит слушает свой сервер whisper.cpp с моделью ivrit.ai на соседнем порту,
 * разделы пишет Claude Code по подписке, заметка — в Obsidian и открывается
 * сразу, чтобы её было видно живой (решения владельца 29.09.2026).
 *
 * Сервер иврита поднимается десятки секунд. Мост его не ждёт: куски звука
 * стоят в очереди сессии и распознаются, как только он ответит. Модели иврита
 * нет — слушает общий сервер (small) с языком «иврит»: хуже, но лекция не
 * пропадает, и человеку об этом сказано.
 */

import { shell } from 'electron';

import { LectureSession } from '../jarvis/lecture/session';
import { createClaudeSummarizer } from '../jarvis/lecture/summarize';
import { lectureFolder, obsidianOpenUrl } from '../jarvis/lecture/vault';
import { tr } from '../jarvis/locale/language';
import { findGpuWhisper, findHebrewWhisper, gpuWhisperDir, startGpuWhisper, type GpuWhisperServer } from '../jarvis/voice/gpuWhisper';
import { createGpuTranscriber, isWhisperServerReady, WHISPER_SERVER_PORT } from './gpuTranscriber';

const ПОРТ_ИВРИТА = WHISPER_SERVER_PORT + 1;

interface Лекция {
  session: LectureSession;
  сервер: Promise<GpuWhisperServer | null>;
}

let идёт: Лекция | null = null;

export function lectureActive(): boolean {
  return идёт !== null;
}

export interface LectureStartOptions {
  home: string;
  outputDir: string;
  /** Адрес общего сервера распознавания — запасной, когда модели иврита нет. */
  mainEndpoint(): string | null;
}

export async function startLecture(subject: string | undefined, options: LectureStartOptions): Promise<string> {
  if (идёт) return tr('Конспект уже пишется.', 'Already taking notes.');

  const dir = gpuWhisperDir(options.home);
  const files = await findGpuWhisper(dir).catch(() => null);
  const иврит = files ? await findHebrewWhisper(dir).catch(() => null) : null;
  const сервер: Promise<GpuWhisperServer | null> =
    files && иврит
      ? startGpuWhisper(
          { server: files.server, model: иврит },
          {
            port: ПОРТ_ИВРИТА,
            isReady: isWhisperServerReady,
            readyMs: 180_000,
            log: (строка) => console.log(`[jarvis:lecture] сервер иврита: ${строка.slice(0, 200)}`),
          },
        ).catch((error: unknown) => {
          console.error(`[jarvis:lecture] сервер иврита не поднялся: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
      : Promise.resolve(null);

  const transcribe = async (samples: Float32Array, sampleRate: number): Promise<string> => {
    const свой = await сервер;
    const endpoint = свой?.endpoint ?? options.mainEndpoint();
    if (!endpoint) throw new Error('распознавать нечем: нет сервера на видеокарте (pnpm jarvis:gpu-stt)');
    return (await createGpuTranscriber({ endpoint, language: 'he' }).transcribe(samples, sampleRate)).text;
  };

  const { folder, vault } = lectureFolder(options.outputDir);
  const session = new LectureSession(folder, subject ?? '', {
    transcribe,
    summarize: createClaudeSummarizer(),
    // Только счёт и события: сама лекция в журнал Джарвиса не пишется.
    log: (строка) => console.log(`[jarvis:lecture] ${строка}`),
  });
  await session.start();
  идёт = { session, сервер };
  console.log(
    `[jarvis:lecture] конспект начат${vault ? ' в хранилище Obsidian' : ' в папке результатов (Obsidian не найден)'}; ` +
      `иврит: ${иврит ? 'ivrit.ai large-v3-turbo' : 'модели нет — общий сервер'}`,
  );
  if (vault) await shell.openExternal(obsidianOpenUrl(session.notesFile)).catch(() => undefined);

  return иврит
    ? tr('Конспектирую. Закончить — «Джарвис, закончи конспект».', 'Taking notes. Say "Jarvis, stop lecture notes" to finish.')
    : tr(
        'Конспектирую, но модели для иврита нет — слышу хуже. Поставить: pnpm jarvis:lecture-model.',
        'Taking notes, but the Hebrew model is missing, so recognition is weaker. Install it with pnpm jarvis:lecture-model.',
      );
}

/** Кусок звука из аудитории — в конспект. */
export function feedLecture(samples: Float32Array, sampleRate: number): void {
  идёт?.session.addAudio(samples, sampleRate);
}

export async function finishLecture(): Promise<string> {
  const была = идёт;
  if (!была) return tr('Конспект сейчас не пишется.', 'No lecture notes are being taken.');
  идёт = null;
  try {
    const итог = await была.session.finish();
    console.log(`[jarvis:lecture] конспект готов: ${итог.sections} разделов, ${итог.words} слов расшифровки`);
    return tr(`Конспект готов: разделов — ${итог.sections}.`, `Notes are ready: ${итог.sections} sections.`);
  } finally {
    (await была.сервер)?.stop();
  }
}

/**
 * Мост закрывается посреди лекции: сервер — погасить (свой pid), записанное
 * остаётся на диске как есть. Итога нет — на него нужна минута модели, а
 * закрытие ждать не может.
 */
export function abandonLecture(): void {
  const была = идёт;
  идёт = null;
  void была?.сервер.then((сервер) => сервер?.stop());
}
