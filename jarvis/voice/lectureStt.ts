/**
 * Распознавание лекций для окна настроек: стоит ли, будет ли конспект и что
 * поставить одной кнопкой.
 *
 * Конспект пишется только распознаванием whisper.cpp (`gpuWhisper.ts`): своя
 * модель для лекций на своём сервере или, без неё, общий сервер. Нет
 * программы — лекция только записывается. Раньше это ставилось установщиком
 * или командами `pnpm jarvis:gpu-stt` и `pnpm jarvis:lecture-model`, а
 * окно настроек об этом молчало (аудит интерфейса 21.10.2026).
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import type { ModelInstallProgress } from './modelArchive';
import {
  findGpuWhisper,
  GPU_WHISPER_MODEL,
  GPU_WHISPER_RUNTIME,
  installedLectureModel,
  installGpuWhisper,
  installLectureModel,
  lectureModelFor,
} from './gpuWhisper';

export type GpuKind = 'nvidia' | 'none' | 'metal' | 'unknown';

export interface LectureSttStatus {
  /** Ставится ли на этой системе вообще: Windows и мак. */
  supported: boolean;
  /** Программа whisper.cpp и общая модель стоят: лекция расшифровывается. */
  runtime: boolean;
  /** Модель для лекций на этом языке стоит: расшифровка точнее. */
  model: boolean;
  /** Её файл — для подписи. */
  modelFile: string;
  /** Сколько скачать, чтобы встало всё; на маке программу ставит Homebrew, её размер не известен. */
  missingBytes: number;
  gpu: GpuKind;
}

/**
 * Видеокарта NVIDIA: её драйвер кладёт nvidia-smi в System32 (старые — в
 * Program Files). Сборка whisper.cpp у Джарвиса — с CUDA; без NVIDIA она не
 * проверялась.
 */
export function detectGpu(platform: NodeJS.Platform = process.platform, exists: (file: string) => boolean = existsSync): GpuKind {
  if (platform === 'darwin') return 'metal';
  if (platform !== 'win32') return 'unknown';
  // Путь Windows — разделителями Windows, на какой бы системе это ни считалось
  // (проверки идут и на маке с Linux).
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const где = [path.win32.join(windows, 'System32', 'nvidia-smi.exe'), 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];
  return где.some((файл) => exists(файл)) ? 'nvidia' : 'none';
}

export async function lectureSttStatus(dir: string, language: string, platform: NodeJS.Platform = process.platform): Promise<LectureSttStatus> {
  const supported = platform === 'win32' || platform === 'darwin';
  const source = lectureModelFor(language);
  const runtime = supported && (await findGpuWhisper(dir, GPU_WHISPER_MODEL, platform).catch(() => null)) !== null;
  const model = (await installedLectureModel(dir, source).catch(() => null)) !== null;
  // Общая модель уже лежит — её не качать; программу без неё не найти, так что
  // при неполной установке считаем и её: лучше назвать с запасом, чем меньше.
  const общая = existsSync(path.join(dir, GPU_WHISPER_MODEL.file)) && statSync(path.join(dir, GPU_WHISPER_MODEL.file)).size === GPU_WHISPER_MODEL.bytes;
  const missingBytes =
    (runtime ? 0 : (platform === 'win32' ? GPU_WHISPER_RUNTIME.bytes : 0) + (общая ? 0 : GPU_WHISPER_MODEL.bytes)) + (model ? 0 : source.bytes);
  return { supported, runtime, model, modelFile: source.file, missingBytes, gpu: detectGpu(platform) };
}

/** Поставить всё для лекций на этом языке: программу, общую модель и модель для лекций. */
export async function installLectureStt(
  dir: string,
  language: string,
  onProgress?: (что: 'программа' | 'модель' | 'модель для лекций', progress: ModelInstallProgress) => void,
): Promise<void> {
  await installGpuWhisper({ dir, onProgress });
  await installLectureModel({ dir, language, onProgress: (_что, p) => onProgress?.('модель для лекций', p) });
}
