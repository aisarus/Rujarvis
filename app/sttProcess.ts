/**
 * Speech recognition, in a process of its own.
 *
 * The recogniser is a WebAssembly build of sherpa-onnx. Loading it inside the
 * Electron main process works right up until the moment it has to decode:
 * every call then fails with Emscripten's `null function`, including on the
 * reference audio the model ships with. The same model, the same samples and
 * the same code decode correctly in a plain Node process, so the engine is
 * fine and its host is not.
 *
 * Rather than fight that, recognition runs where it works. Electron's own
 * binary started with ELECTRON_RUN_AS_NODE is a plain Node runtime, so this
 * needs no second toolchain and keeps working in a packaged app.
 *
 * It also buys something the worker-thread version could never have: the
 * synthesis engine and the recognition engine stop sharing a process, which
 * is the one arrangement sherpa-onnx's WebAssembly build cannot survive.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isWhisperModelInstalled, resolveWhisperPaths, resampleTo16k, WHISPER_SAMPLE_RATE } from '../jarvis/voice/whisperRecognizer';
import { tr } from '../jarvis/locale/language';
import { type WhisperModelId } from '../jarvis/voice/sttModels';
import type { Transcriber } from '../jarvis/voice/session';

/**
 * Accuracy first, because on this engine speed is not bought with a smaller
 * model.
 *
 * Whisper pads every input to a fixed 30-second window, so decoding costs
 * roughly the same whether the user said "открой хром" or spoke for half a
 * minute. Measured on this machine: `small` 11.7 s, `base` 9.2 s — a smaller
 * model buys almost nothing here.
 *
 * Accuracy was NOT measured. The obvious reference audio to try is the one
 * shipped beside the model, and that file turns out to be English, so running
 * it through a Russian recogniser says nothing about Russian. The ordering
 * below is therefore the conservative one — the larger model first — and not
 * a measured result.
 *
 * Real latency has to come from a different engine, not a smaller Whisper.
 * Set JARVIS_WHISPER_MODEL to override.
 */
const PREFERENCE: readonly WhisperModelId[] = ['small', 'medium', 'turbo', 'base', 'tiny'];

const CHILD_SOURCE = `
const sherpa = require(process.env.JARVIS_SHERPA_MODULE);

const recognizer = sherpa.createOfflineRecognizer({
  featConfig: { sampleRate: ${WHISPER_SAMPLE_RATE}, featureDim: 80 },
  modelConfig: {
    whisper: {
      encoder: process.env.JARVIS_WHISPER_ENCODER,
      decoder: process.env.JARVIS_WHISPER_DECODER,
      language: process.env.JARVIS_WHISPER_LANGUAGE || 'ru',
      task: 'transcribe',
      tailPaddings: -1,
    },
    tokens: process.env.JARVIS_WHISPER_TOKENS,
    // The WebAssembly build is single-threaded; anything above 1 aborts.
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  },
  decodingMethod: 'greedy_search',
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

send({ type: 'ready' });

let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let index = pending.indexOf('\\n');
  while (index >= 0) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line.trim()) handle(line);
    index = pending.indexOf('\\n');
  }
});

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    return;
  }
  try {
    const bytes = Buffer.from(message.samples, 'base64');
    // Copy rather than view: a base64 decode gives no alignment guarantee,
    // and a misaligned Float32Array view throws.
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const samples = new Float32Array(copy);

    const stream = recognizer.createStream();
    stream.acceptWaveform(${WHISPER_SAMPLE_RATE}, samples);
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text;
    if (typeof stream.free === 'function') stream.free();
    send({ id: message.id, text });
  } catch (error) {
    send({ id: message.id, error: (error && error.message) || String(error) });
  }
}
`;

export interface SttProcessOptions {
  installRoot: string;
  /** Модель из настроек. Если её нет на диске — любая установленная. */
  model?: WhisperModelId;
  language?: string;
  /** A recognition that takes longer than this is abandoned. */
  timeoutMs?: number;
}

export interface SttProcess extends Transcriber {
  dispose(): void;
}

async function pickInstalledModel(installRoot: string, wanted?: WhisperModelId): Promise<WhisperModelId> {
  const requested = (process.env.JARVIS_WHISPER_MODEL as WhisperModelId | undefined) ?? wanted;
  if (requested && (await isWhisperModelInstalled(installRoot, requested))) {
    return requested;
  }
  for (const id of PREFERENCE) {
    if (await isWhisperModelInstalled(installRoot, id)) return id;
  }
  // Эту строку человек читает в трее: «голос не запустился: …». Оставлять её
  // только по-русски значит показать русский текст посреди английского меню.
  throw new Error(
    tr(
      `Ни одна модель распознавания не установлена в ${installRoot}. Откройте настройки Джарвиса и скачайте модель.`,
      `No recognition model is installed in ${installRoot}. Open Jarvis settings and download one.`,
    ),
  );
}

export async function createSttProcess(options: SttProcessOptions): Promise<SttProcess> {
  const modelId = await pickInstalledModel(options.installRoot, options.model);
  const paths = resolveWhisperPaths(options.installRoot, modelId, true);
  console.log(`[jarvis:stt] модель: ${modelId}`);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-stt-'));
  const scriptPath = path.join(dir, 'recognise.cjs');
  writeFileSync(scriptPath, CHILD_SOURCE, 'utf8');

  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [scriptPath],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        JARVIS_SHERPA_MODULE: require.resolve('sherpa-onnx'),
        JARVIS_WHISPER_ENCODER: paths.encoder,
        JARVIS_WHISPER_DECODER: paths.decoder,
        JARVIS_WHISPER_TOKENS: paths.tokens,
        JARVIS_WHISPER_LANGUAGE: options.language ?? 'ru',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const pending = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();
  let nextId = 0;
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    const trimmed = text.trim();
    if (trimmed) console.error(`[jarvis:stt] ${trimmed}`);
  });

  // Чем кончился процесс распознавания, если он кончился.
  //
  // Без этого запись в мёртвый процесс роняла ВСЁ приложение: `child.stdin`
  // выпускает EPIPE как событие 'error', слушателя не было, и необработанное
  // исключение в главном процессе Electron гасило окно вместе с голосом.
  // Вторая беда тише: если EPIPE не случился, запрос ложился в `pending`
  // уже после 'exit', отклонять его было некому, и голос молчал все шестьдесят
  // секунд тайм-аута без единой строки в журнале.
  let умер: Error | null = null;
  const похоронить = (error: Error) => {
    умер ??= error;
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  child.stdin.on('error', (error: Error) => { умер ??= error; });
  child.on('error', (error: Error) => { похоронить(error); });

  const ready = new Promise<void>((resolve, reject) => {
    const onExit = (code: number | null) => {
      reject(new Error(`Процесс распознавания завершился с кодом ${code} до готовности`));
    };
    // 'error' до готовности: `spawn` не нашёл исполняемый файл. Без этого
    // `ready` не разрешался бы никогда, и запуск вис молча.
    const onError = (error: Error) => reject(error);
    child.once('exit', onExit);
    child.once('error', onError);
    child.stdout.on('data', function onData(text: string) {
      buffer += text;
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line.trim()) continue;
        let message: { type?: string; id?: number; text?: string; error?: string };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === 'ready') {
          child.off('exit', onExit);
          child.off('error', onError);
          resolve();
          continue;
        }
        if (typeof message.id !== 'number') continue;
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.text ?? '');
      }
    });
  });

  child.on('exit', (code) => {
    похоронить(new Error(`Процесс распознавания завершился с кодом ${code}`));
  });

  await ready;

  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async transcribe(samples: Float32Array, sampleRate: number) {
      // Мёртвому писать нечего: лучше отказ сразу, чем минута тишины.
      if (умер) throw умер;
      const resampled = resampleTo16k(samples, sampleRate);
      const id = nextId++;
      const payload = Buffer.from(
        resampled.buffer,
        resampled.byteOffset,
        resampled.byteLength,
      ).toString('base64');

      const answer = new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      child.stdin.write(`${JSON.stringify({ id, samples: payload })}\n`);
      // Процесс мог умереть между проверкой и записью: EPIPE прилетает не
      // броском, а событием, и запрос остался бы висеть до тайм-аута.
      if (умер) {
        pending.delete(id);
        throw умер;
      }

      const text = await Promise.race([
        answer,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error('Распознавание речи не уложилось во время'));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
      return { text: text.trim() };
    },
    dispose() {
      child.kill();
    },
  };
}
