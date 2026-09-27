/**
 * Recognition through ElevenLabs Scribe.
 *
 * Local Whisper works and is private, but on this machine it costs 6–17
 * seconds per phrase and mangles an isolated «Джарвис» into «Жаравес» often
 * enough to miss the wake word. Whisper pads every input to a fixed 30-second
 * window, so a two-word command costs the same as a monologue and a smaller
 * model buys almost nothing — measured, not assumed.
 *
 * A hosted recogniser has neither problem. The trade is real and deliberate:
 * the microphone audio leaves the machine. That is why a failure here falls
 * back to the local recogniser instead of leaving the assistant deaf.
 */

import type { Transcriber } from '../jarvis/voice/session';
import { encodeWav16 } from '../jarvis/voice/wav';

/**
 * Ключ облака — только если облако включено в настройках.
 *
 * Раньше «включено» означало «в системе есть ELEVENLABS_API_KEY». Ключ живёт
 * в переменных среды пользователя и нужен бывает другим программам, так что
 * облако включалось без ведома человека: 26–27.09.2026 у владельца полтора
 * дня весь звук с микрофона — около 800 отрезков, 145 из них не Джарвису —
 * уходил в ElevenLabs, а настройки показывали Whisper на этом компьютере.
 * Ключ без переключателя теперь ничего не включает.
 */
export function cloudSpeechKey(enabled: boolean, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!enabled) return null;
  const key = env.ELEVENLABS_API_KEY?.trim();
  return key ? key : null;
}

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const DEFAULT_MODEL = 'scribe_v2';

export interface CloudTranscriberOptions {
  apiKey: string;
  language?: string;
  modelId?: string;
  timeoutMs?: number;
  /** Used when the service cannot be reached, so speech is never simply lost. */
  fallback?: Transcriber;
}

export function createElevenLabsTranscriber(options: CloudTranscriberOptions): Transcriber {
  const model = options.modelId ?? process.env.ELEVENLABS_STT_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return {
    async transcribe(samples: Float32Array, sampleRate: number) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const form = new FormData();
        form.append('model_id', model);
        if (options.language) form.append('language_code', options.language);
        form.append(
          'file',
          new Blob([new Uint8Array(encodeWav16(samples, sampleRate))], { type: 'audio/wav' }),
          'speech.wav',
        );

        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'xi-api-key': options.apiKey },
          body: form,
          signal: controller.signal,
        });

        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        const payload = (await response.json()) as { text?: unknown };
        // Пустая строка — это тишина. Отсутствие поля — это сломанный ответ.
        //
        // Раньше одно выдавалось за другое: `?? ''` превращал `{"error": ...}`
        // в успешное «человек промолчал». Фраза пропадала без следа в журнале,
        // и запасной путь не запускался — а он тут для того и заведён.
        if (typeof payload.text !== 'string') {
          throw new Error(`ответ без text: ${JSON.stringify(payload).slice(0, 200)}`);
        }
        return { text: payload.text.trim() };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!options.fallback) throw error;
        console.error(`[jarvis:stt] облако недоступно (${message}) — распознаю локально`);
        return options.fallback.transcribe(samples, sampleRate);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
