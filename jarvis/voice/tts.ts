/**
 * Голос Джарвиса: локальный Piper через sherpa-onnx.
 *
 * Только голоса семейства VITS/Piper — русские и английские. Движок держится
 * прогретым в отдельном потоке: первый синтез платит загрузку модели (около
 * секунды), следующие — только саму фразу. Раньше поток заводился на каждую
 * фразу заново, и каждая ответная реплика стоила лишнюю загрузку.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { installArchive, type ModelInstallProgress } from './modelArchive';

const RELEASE_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models';

export interface VoiceDefinition {
  id: string;
  language: 'ru' | 'en';
  label: string;
  /** Файл модели внутри папки голоса. */
  modelFile: string;
  downloadBytes: number;
}

export const VOICES: readonly VoiceDefinition[] = [
  { id: 'vits-piper-ru_RU-irina-medium', language: 'ru', label: 'Ирина', modelFile: 'ru_RU-irina-medium.onnx', downloadBytes: 67_153_308 },
  { id: 'vits-piper-ru_RU-dmitri-medium', language: 'ru', label: 'Дмитрий', modelFile: 'ru_RU-dmitri-medium.onnx', downloadBytes: 67_188_551 },
  { id: 'vits-piper-ru_RU-ruslan-medium', language: 'ru', label: 'Руслан', modelFile: 'ru_RU-ruslan-medium.onnx', downloadBytes: 67_210_684 },
  { id: 'vits-piper-ru_RU-denis-medium', language: 'ru', label: 'Денис', modelFile: 'ru_RU-denis-medium.onnx', downloadBytes: 67_190_991 },
  { id: 'vits-piper-en_US-lessac-medium', language: 'en', label: 'Lessac', modelFile: 'en_US-lessac-medium.onnx', downloadBytes: 67_230_653 },
  { id: 'vits-piper-en_US-libritts_r-medium', language: 'en', label: 'LibriTTS', modelFile: 'en_US-libritts_r-medium.onnx', downloadBytes: 82_038_311 },
  { id: 'vits-piper-en_US-glados', language: 'en', label: 'GLaDOS', modelFile: 'en_US-glados.onnx', downloadBytes: 67_208_137 },
];

export const DEFAULT_VOICE: Record<'ru' | 'en', string> = {
  ru: 'vits-piper-ru_RU-irina-medium',
  en: 'vits-piper-en_US-lessac-medium',
};

export function getVoice(id: string): VoiceDefinition {
  const voice = VOICES.find((entry) => entry.id === id);
  if (!voice) throw new Error(`Неизвестный голос: ${id}`);
  return voice;
}

function voiceRoot(installRoot: string, voice: VoiceDefinition): string {
  return path.join(installRoot, voice.id);
}

function voiceFiles(installRoot: string, voice: VoiceDefinition) {
  const root = voiceRoot(installRoot, voice);
  return {
    model: path.join(root, voice.modelFile),
    tokens: path.join(root, 'tokens.txt'),
    dataDir: path.join(root, 'espeak-ng-data'),
  };
}

export function isVoiceInstalled(installRoot: string, id: string): boolean {
  const files = voiceFiles(installRoot, getVoice(id));
  try {
    return existsSync(files.model) && existsSync(files.tokens) && statSync(files.dataDir).isDirectory();
  } catch {
    return false;
  }
}

export async function installVoice(
  installRoot: string,
  id: string,
  onProgress?: (progress: ModelInstallProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const voice = getVoice(id);
  return installArchive({
    url: `${RELEASE_BASE}/${voice.id}.tar.bz2`,
    installRoot,
    rootDirName: voice.id,
    expectedBytes: voice.downloadBytes,
    isInstalled: async () => isVoiceInstalled(installRoot, id),
    onProgress,
    signal,
  });
}

export interface Synthesized {
  wav: Buffer;
  sampleRate: number;
  durationSeconds: number;
}

/**
 * Код потока синтеза. Строкой, а не отдельным файлом: так он переживает
 * сборку в один бандл, а sherpa-onnx грузится по пути, найденному снаружи.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const sherpa = require(workerData.sherpaPath);
const create = sherpa.createOfflineTts || (sherpa.default && sherpa.default.createOfflineTts);
const engine = create({
  offlineTtsModelConfig: {
    offlineTtsVitsModelConfig: {
      model: workerData.model, tokens: workerData.tokens, dataDir: workerData.dataDir,
      lexicon: '', noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1.0,
    },
    // Сборка sherpa-onnx для node — однопоточный WASM: больше одного потока роняет движок.
    numThreads: 1, debug: 0, provider: 'cpu',
  },
  maxNumSentences: 1,
});

function wav(samples, rate) {
  const data = samples.length * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), 44 + i * 2);
  }
  return b;
}

parentPort.on('message', ({ id, text, speed }) => {
  try {
    const out = engine.generate({ text, sid: 0, speed });
    const buffer = wav(out.samples, out.sampleRate);
    parentPort.postMessage({ id, ok: true, wav: buffer, sampleRate: out.sampleRate, samples: out.samples.length });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
});
`;

interface Pending {
  resolve(result: Synthesized): void;
  reject(error: Error): void;
}

/** Прогретый синтезатор одного голоса. */
export class Speaker {
  private worker: Worker | null = null;
  private next = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly installRoot: string,
    readonly voiceId: string,
  ) {}

  async say(text: string, speed = 1): Promise<Synthesized> {
    const clean = text.trim();
    if (!clean) throw new Error('Пустая фраза');
    if (!isVoiceInstalled(this.installRoot, this.voiceId)) {
      throw new Error(`Голос ${getVoice(this.voiceId).label} не установлен`);
    }
    const worker = this.ensureWorker();
    const id = (this.next += 1);
    // Держим процесс, пока фраза в работе; простаивающий поток его не держит.
    worker.ref();
    return new Promise<Synthesized>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, text: clean, speed: Math.max(0.5, Math.min(2, speed)) });
    });
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = null;
    this.failAll(new Error('Синтезатор остановлен'));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const files = voiceFiles(this.installRoot, getVoice(this.voiceId));
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sherpaPath: require.resolve('sherpa-onnx'), ...files },
    });
    worker.on('message', (message: { id: number; ok: boolean; wav?: Uint8Array; sampleRate?: number; samples?: number; error?: string }) => {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (this.pending.size === 0) worker.unref();
      if (!message.ok || !message.wav || !message.sampleRate) {
        waiter.reject(new Error(message.error ?? 'Синтез не удался'));
        return;
      }
      waiter.resolve({
        wav: Buffer.from(message.wav),
        sampleRate: message.sampleRate,
        durationSeconds: (message.samples ?? 0) / message.sampleRate,
      });
    });
    const broken = (error: Error) => {
      this.worker = null;
      this.failAll(error);
    };
    worker.on('error', broken);
    worker.on('exit', (code) => {
      if (this.worker === worker) broken(new Error(`Поток синтеза завершился с кодом ${code}`));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}
