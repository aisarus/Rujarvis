/**
 * Local Russian speech recognition through sherpa-onnx Whisper.
 *
 * Three constraints came out of running this against the real models, and each
 * one is encoded here rather than left as folklore:
 *
 *  1. The npm `sherpa-onnx` package is a WebAssembly build with ONE module
 *     instance per process. Creating a TTS engine and an ASR engine in the
 *     same process aborts the module. The Workstation already isolates its TTS
 *     engine in a worker thread for this reason; recognition gets its own.
 *  2. That build is single-threaded. `numThreads` above 1 aborts at load.
 *  3. `acceptWaveform` takes positional arguments, not an options object, and
 *     wants 16 kHz float samples in [-1, 1].
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { access } from 'node:fs/promises';
import {
  DEFAULT_WHISPER_MODEL,
  getWhisperModel,
  whisperModelFiles,
  type WhisperModelId,
} from './sttModels';
import { createRequire } from 'node:module';

export const WHISPER_SAMPLE_RATE = 16_000;

export interface WhisperRecognizerOptions {
  /** Directory holding the extracted model archives. */
  installRoot: string;
  modelId?: WhisperModelId;
  /** Spoken language. Russian is the point of this backend. */
  language?: string;
  /** 'cpu' always works; 'cuda' only when the runtime was built for it. */
  provider?: 'cpu' | 'cuda';
  quantized?: boolean;
  /** A recognition that takes longer than this is abandoned. */
  timeoutMs?: number;
}

export interface TranscriptionResult {
  text: string;
  /** Wall-clock milliseconds, useful for showing the user when to downgrade. */
  durationMs: number;
}

export interface ResolvedWhisperPaths {
  encoder: string;
  decoder: string;
  tokens: string;
}

export function resolveWhisperPaths(
  installRoot: string,
  modelId: WhisperModelId,
  quantized = true,
): ResolvedWhisperPaths {
  const model = getWhisperModel(modelId);
  const root = path.join(installRoot, model.rootDirName);
  const files = whisperModelFiles(modelId, quantized);
  return {
    encoder: path.join(root, files.encoder),
    decoder: path.join(root, files.decoder),
    tokens: path.join(root, files.tokens),
  };
}

export async function isWhisperModelInstalled(
  installRoot: string,
  modelId: WhisperModelId,
  quantized = true,
): Promise<boolean> {
  const paths = resolveWhisperPaths(installRoot, modelId, quantized);
  try {
    await Promise.all(Object.values(paths).map((file) => access(file)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resampling to 16 kHz with band-limited (windowed-sinc) interpolation.
 *
 * This used to be plain linear interpolation, and that is not "good enough for
 * speech": going down from 22 or 48 kHz without a low-pass filter folds
 * everything above 8 kHz back into the band Whisper listens to. Fricatives and
 * bursts live exactly there, so the first consonant of a short command got
 * lost — measured through Piper → Whisper: "Stop" came back as "Top", "Scroll
 * down" as "Crawl down", «Тишина» as «Дышина».
 *
 * The kernel is a Hann-windowed sinc at the target Nyquist; 16 taps each side
 * cost a few million multiply-adds for a five-second phrase.
 */
export function resampleTo16k(samples: Float32Array, sampleRate: number): Float32Array {
  if (sampleRate === WHISPER_SAMPLE_RATE) return samples;
  const ratio = sampleRate / WHISPER_SAMPLE_RATE;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  // Downsampling narrows the pass band to the new Nyquist; upsampling keeps it.
  const cutoff = Math.min(1, 1 / ratio);
  const half = Math.ceil(16 / cutoff);

  for (let index = 0; index < output.length; index += 1) {
    const centre = index * ratio;
    const first = Math.max(0, Math.ceil(centre - half));
    const last = Math.min(samples.length - 1, Math.floor(centre + half));
    let sum = 0;
    let weight = 0;
    for (let source = first; source <= last; source += 1) {
      const distance = source - centre;
      const x = distance * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / (half + 1));
      const w = sinc * window;
      sum += (samples[source] ?? 0) * w;
      weight += w;
    }
    output[index] = weight !== 0 ? sum / weight : 0;
  }
  return output;
}

/**
 * Worker source.
 *
 * Inlined rather than shipped as a file so it survives the Electron bundler
 * the same way the Workstation's own TTS worker does.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const sherpa = require(workerData.modulePath);

const recognizer = sherpa.createOfflineRecognizer({
  featConfig: { sampleRate: ${WHISPER_SAMPLE_RATE}, featureDim: 80 },
  modelConfig: {
    whisper: {
      encoder: workerData.encoder,
      decoder: workerData.decoder,
      language: workerData.language,
      task: 'transcribe',
      tailPaddings: -1,
    },
    tokens: workerData.tokens,
    // The WebAssembly build is single-threaded; anything above 1 aborts.
    numThreads: 1,
    provider: workerData.provider,
    debug: 0,
  },
  decodingMethod: 'greedy_search',
});

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (message) => {
  if (message.type !== 'transcribe') return;
  try {
    const stream = recognizer.createStream();
    // Positional arguments: (sampleRate, samples).
    stream.acceptWaveform(${WHISPER_SAMPLE_RATE}, message.samples);
    recognizer.decode(stream);
    const text = recognizer.getResult(stream).text;
    if (typeof stream.free === 'function') stream.free();
    parentPort.postMessage({ type: 'result', id: message.id, text });
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      id: message.id,
      error: error && error.message ? error.message : String(error),
    });
  }
});
`;

/** Lets tests substitute the worker without a WebAssembly runtime. */
export interface RecognitionWorker {
  transcribe(samples: Float32Array): Promise<string>;
  dispose(): Promise<void>;
}

export type RecognitionWorkerFactory = (
  options: WhisperRecognizerOptions & { paths: ResolvedWhisperPaths },
) => Promise<RecognitionWorker>;

function resolveSherpaModulePath(): string {
  // В сборке (CJS) есть `require`; под tsx (ESM) — только `createRequire`.
  const find = typeof require === 'function' ? require : createRequire(import.meta.url);
  return find.resolve('sherpa-onnx');
}

export const createWorkerThreadRecognizer: RecognitionWorkerFactory = async (options) => {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      modulePath: resolveSherpaModulePath(),
      encoder: options.paths.encoder,
      decoder: options.paths.decoder,
      tokens: options.paths.tokens,
      language: options.language ?? 'ru',
      provider: options.provider ?? 'cpu',
    },
  });

  const pending = new Map<number, { resolve(text: string): void; reject(error: Error): void }>();
  let nextId = 0;

  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: { type?: string }): void => {
      if (message?.type === 'ready') {
        worker.off('error', onError);
        resolve();
      }
    };
    const onError = (error: Error): void => {
      worker.off('message', onMessage);
      reject(error);
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
  });

  worker.on('message', (message: { type?: string; id?: number; text?: string; error?: string }) => {
    if (message?.type !== 'result' || typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.text ?? '');
  });

  worker.on('error', (error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });

  return {
    transcribe(samples) {
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        // Transfer the buffer rather than copy it: a minute of audio is
        // several megabytes, and the caller does not reuse it.
        const transfer = samples.buffer instanceof ArrayBuffer ? [samples.buffer] : undefined;
        worker.postMessage({ type: 'transcribe', id, samples }, transfer);
      });
    },
    async dispose() {
      await worker.terminate();
    },
  };
};

/**
 * A Whisper recogniser that starts lazily and keeps the worker warm.
 *
 * Loading the model costs seconds, so it happens once — on first use, not at
 * app start, because a user who never speaks should not pay for it.
 */
export class WhisperRecognizer {
  private worker: Promise<RecognitionWorker> | null = null;

  constructor(
    private readonly options: WhisperRecognizerOptions,
    private readonly factory: RecognitionWorkerFactory = createWorkerThreadRecognizer,
  ) {}

  get modelId(): WhisperModelId {
    return this.options.modelId ?? DEFAULT_WHISPER_MODEL;
  }

  private ensureWorker(): Promise<RecognitionWorker> {
    if (!this.worker) {
      const paths = resolveWhisperPaths(
        this.options.installRoot,
        this.modelId,
        this.options.quantized ?? true,
      );
      this.worker = this.factory({ ...this.options, paths }).catch((error: unknown) => {
        // A failed load must not poison every later attempt.
        this.worker = null;
        throw error;
      });
    }
    return this.worker;
  }

  async transcribe(samples: Float32Array, sampleRate: number): Promise<TranscriptionResult> {
    const started = Date.now();
    const worker = await this.ensureWorker();
    const resampled = resampleTo16k(samples, sampleRate);

    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const text = await Promise.race([
      worker.transcribe(resampled),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Распознавание речи не уложилось во время')),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);

    return { text: text.trim(), durationMs: Date.now() - started };
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    try {
      await (await worker).dispose();
    } catch {
      // Terminating an already-dead worker is not an error worth surfacing.
    }
  }
}
