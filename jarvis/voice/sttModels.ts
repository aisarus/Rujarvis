/**
 * Russian-capable local STT models.
 *
 * The Workstation ships two speech backends: Qwen ASR and Moonshine. Moonshine
 * is English-only and is the only backend Windows allows today, which leaves
 * the Windows-first Russian assistant without a usable ear.
 *
 * Whisper through sherpa-onnx fixes that without adding a dependency: the
 * Workstation already bundles `sherpa-onnx` for text-to-speech, the ASR models
 * come from the same k2-fsa release channel as the TTS voices, and the int8
 * exports run on CPU. A GPU is an optimisation, never a requirement.
 *
 * Every entry below was verified against the real release assets.
 */

export const WHISPER_MODEL_IDS = ['tiny', 'base', 'small', 'medium', 'turbo'] as const;
export type WhisperModelId = (typeof WHISPER_MODEL_IDS)[number];

export interface WhisperModelDefinition {
  id: WhisperModelId;
  label: string;
  description: string;
  assetName: string;
  rootDirName: string;
  /** Archive size in bytes, as served. */
  downloadBytes: number;
  /** Rough resident memory for the int8 export. */
  approximateRamMb: number;
}

const RELEASE_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

export const WHISPER_MODELS: readonly WhisperModelDefinition[] = [
  {
    id: 'tiny',
    label: 'Whisper Tiny (многоязычный)',
    description: 'Самый быстрый. Русский понимает, но путает слова — годится для слабых машин.',
    assetName: 'sherpa-onnx-whisper-tiny.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-tiny',
    downloadBytes: 116_204_861,
    approximateRamMb: 250,
  },
  {
    id: 'base',
    label: 'Whisper Base (многоязычный)',
    description: 'Рекомендуемый баланс скорости и качества для русского на CPU.',
    assetName: 'sherpa-onnx-whisper-base.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-base',
    downloadBytes: 207_557_382,
    approximateRamMb: 400,
  },
  {
    id: 'small',
    label: 'Whisper Small (многоязычный)',
    description: 'Заметно точнее на длинных фразах, но втрое медленнее base на CPU.',
    assetName: 'sherpa-onnx-whisper-small.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-small',
    downloadBytes: 639_387_718,
    approximateRamMb: 1_100,
  },
  {
    id: 'turbo',
    label: 'Whisper Turbo (многоязычный)',
    description: 'Качество уровня large при меньшей задержке. Нужна быстрая машина или GPU.',
    assetName: 'sherpa-onnx-whisper-turbo.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-turbo',
    downloadBytes: 563_790_207,
    approximateRamMb: 1_600,
  },
  {
    id: 'medium',
    label: 'Whisper Medium (многоязычный)',
    description: 'Самый точный из доступных. Медленный на CPU, рассчитан на GPU.',
    assetName: 'sherpa-onnx-whisper-medium.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-medium',
    downloadBytes: 1_931_372_882,
    approximateRamMb: 3_200,
  },
];

/**
 * The default.
 *
 * `base` rather than `small`: on a CPU-only machine `small` is roughly three
 * times slower for no reliable gain on short commands, and a voice assistant
 * that thinks for nine seconds before acting is not one people keep using.
 */
export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'base';

export function getWhisperModel(id: WhisperModelId): WhisperModelDefinition {
  const model = WHISPER_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Unknown Whisper model: ${id}`);
  return model;
}

export function getWhisperDownloadUrl(id: WhisperModelId): string {
  return `${RELEASE_BASE}/${getWhisperModel(id).assetName}`;
}

export interface WhisperModelFiles {
  encoder: string;
  decoder: string;
  tokens: string;
}

/**
 * File names inside an extracted archive.
 *
 * The layout is `<root>/<id>-encoder.onnx`, with `.int8.onnx` variants beside
 * them; int8 is the default because it halves memory and load time at no
 * measurable cost on short commands.
 */
export function whisperModelFiles(id: WhisperModelId, quantized = true): WhisperModelFiles {
  const suffix = quantized ? '.int8.onnx' : '.onnx';
  return {
    encoder: `${id}-encoder${suffix}`,
    decoder: `${id}-decoder${suffix}`,
    tokens: `${id}-tokens.txt`,
  };
}

/** Which models are realistic on this machine. */
export function recommendWhisperModel(input: {
  totalRamMb: number;
  hasGpu?: boolean;
}): WhisperModelId {
  if (input.hasGpu && input.totalRamMb >= 16_000) return 'turbo';
  if (input.totalRamMb >= 16_000) return 'small';
  if (input.totalRamMb >= 8_000) return 'base';
  return 'tiny';
}
