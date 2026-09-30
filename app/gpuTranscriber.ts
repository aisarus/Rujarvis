/**
 * Recognition on the graphics card, through a whisper.cpp server.
 *
 * Measured on this machine, large-v3-turbo on an RTX 2050 against 6.6 seconds
 * of speech: 425 ms per request, with the transcript correct. That is as fast
 * as the hosted service and costs nothing, so it is the first choice and the
 * cloud becomes the fallback rather than the other way round.
 *
 * It must be a server, not the command-line tool: the model is 548 MB and
 * loading it takes about five seconds, which is fine once and unacceptable per
 * phrase. The server keeps it resident in video memory.
 */

import type { Transcriber } from '../jarvis/voice/session';
import { encodeWav16 } from '../jarvis/voice/wav';

export const WHISPER_SERVER_PORT = 8178;
export const WHISPER_SERVER_URL = `http://127.0.0.1:${WHISPER_SERVER_PORT}`;

export interface GpuTranscriberOptions {
  endpoint?: string;
  language?: string;
  timeoutMs?: number;
  /**
   * Вместе с текстом — уверенность распознавания (`confidence`): средняя
   * логарифмическая вероятность по сегментам, взвешенная длительностью.
   * Нужна слуху лекции: в гулком зале Whisper пишет столько же слов, только
   * неверных, и видно это лишь по его собственной уверенности.
   */
  withConfidence?: boolean;
  /** Used when the local server is not answering, so speech is never lost. */
  fallback?: Transcriber;
}

/**
 * Waits for the local recogniser, but only when one is expected.
 *
 * The launcher sets JARVIS_GPU_STT when it has a model to serve, and the
 * server needs about twenty seconds to load 548 MB into video memory. Without
 * waiting, the app checks once during startup, finds nothing, and settles for
 * the cloud for the rest of the session. Without the variable, it does not
 * wait at all for a server that will never come.
 */
export async function waitForWhisperServer(): Promise<string | null> {
  const endpoint = process.env.JARVIS_GPU_STT?.trim();
  if (!endpoint) return null;

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isWhisperServerReady(endpoint)) return endpoint;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.error('[jarvis:stt] сервер распознавания не поднялся за минуту');
  return null;
}

/** True when the local recogniser is up and ready to be used. */
export async function isWhisperServerReady(endpoint = WHISPER_SERVER_URL): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`${endpoint}/`, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Текст сервера whisper.cpp → текст фразы.
 *
 * Сервер дописывает перевод строки после каждого сегмента, а пробел перед
 * новым словом и так стоит в начале сегмента. Сегмент же может кончиться
 * посреди слова: замер на лекциях на иврите 29.09.2026 дал «הרמ⏎ונית» вместо
 * «הרמונית». Поэтому переводы строк убираются, а не меняются на пробел —
 * иначе слово рвётся надвое.
 *
 * Там же модель иврита ставила в начало сегментов невидимые знаки
 * направления письма (U+202B и родня). Их не видно, но с ними текст не
 * находится поиском, а фраза не совпадает с командой.
 */
export function cleanWhisperText(text: string): string {
  return text.replace(/\n/gu, '').replace(/[‎‏‪-‮⁦-⁩]/gu, '').trim();
}

/** Распознанное и уверенность; её нет — сервер не сказал. */
export interface ConfidentResult {
  text: string;
  confidence?: number;
}

/** Средняя уверенность по сегментам ответа `verbose_json`, взвешенная их длительностью. */
export function segmentConfidence(segments: unknown): number | undefined {
  if (!Array.isArray(segments)) return undefined;
  let вес = 0;
  let сумма = 0;
  for (const сегмент of segments as Array<{ start?: unknown; end?: unknown; avg_logprob?: unknown }>) {
    const длина = Number(сегмент.end) - Number(сегмент.start);
    if (typeof сегмент.avg_logprob !== 'number' || !Number.isFinite(сегмент.avg_logprob) || !(длина > 0)) continue;
    вес += длина;
    сумма += сегмент.avg_logprob * длина;
  }
  return вес > 0 ? сумма / вес : undefined;
}

/** Тот же `Transcriber`, но ответ может нести и уверенность. */
export interface ConfidentTranscriber extends Transcriber {
  transcribe(samples: Float32Array, sampleRate: number): Promise<ConfidentResult>;
}

export function createGpuTranscriber(options: GpuTranscriberOptions = {}): ConfidentTranscriber {
  const endpoint = options.endpoint ?? WHISPER_SERVER_URL;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return {
    async transcribe(samples: Float32Array, sampleRate: number) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(encodeWav16(samples, sampleRate))], { type: 'audio/wav' }), 'speech.wav');
        form.append('response_format', options.withConfidence ? 'verbose_json' : 'json');
        if (options.language) form.append('language', options.language);
        // Without this the server will happily "translate" Russian into
        // English, which is not what a Russian assistant wants.
        form.append('translate', 'false');

        const response = await fetch(`${endpoint}/inference`, {
          method: 'POST',
          body: form,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const payload = (await response.json()) as { text?: unknown; segments?: unknown };
        // Пустая строка — это тишина. Отсутствие поля — это сломанный ответ.
        //
        // Раньше одно выдавалось за другое: `?? ''` превращал `{"error": ...}`
        // в успешное «человек промолчал». Фраза пропадала без следа в журнале,
        // и запасной путь не запускался — а он тут для того и заведён.
        if (typeof payload.text !== 'string') {
          throw new Error(`ответ без text: ${JSON.stringify(payload).slice(0, 200)}`);
        }
        return options.withConfidence
          ? { text: cleanWhisperText(payload.text), confidence: segmentConfidence(payload.segments) }
          : { text: cleanWhisperText(payload.text) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!options.fallback) throw error;
        console.error(`[jarvis:stt] видеокарта недоступна (${message}) — беру запасной путь`);
        return options.fallback.transcribe(samples, sampleRate);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
