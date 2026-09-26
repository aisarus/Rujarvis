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
  /** То же по-английски: для окна настроек в английском режиме. */
  descriptionEn: string;
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
    label: 'Whisper Tiny (multilingual)',
    description: 'Самый быстрый. Русский понимает, но путает слова — годится для слабых машин.',
    descriptionEn: 'Fastest. Understands speech but mixes up words — for slow machines.',
    assetName: 'sherpa-onnx-whisper-tiny.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-tiny',
    downloadBytes: 116_204_861,
    approximateRamMb: 250,
  },
  {
    id: 'base',
    label: 'Whisper Base (multilingual)',
    description: 'Рекомендуемый баланс скорости и качества для русского на CPU.',
    descriptionEn: 'Recommended balance of speed and quality on a CPU.',
    assetName: 'sherpa-onnx-whisper-base.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-base',
    downloadBytes: 207_557_382,
    approximateRamMb: 400,
  },
  {
    id: 'small',
    label: 'Whisper Small (multilingual)',
    description: 'Заметно точнее на длинных фразах, но втрое медленнее base на CPU.',
    descriptionEn: 'Noticeably more accurate on long phrases, three times slower than base on a CPU.',
    assetName: 'sherpa-onnx-whisper-small.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-small',
    downloadBytes: 639_387_718,
    approximateRamMb: 1_100,
  },
  {
    id: 'turbo',
    label: 'Whisper Turbo (multilingual)',
    description: 'Качество уровня large при меньшей задержке. Нужна быстрая машина или GPU.',
    descriptionEn: 'Large-level quality with lower latency. Needs a fast machine or a GPU.',
    assetName: 'sherpa-onnx-whisper-turbo.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-turbo',
    downloadBytes: 563_790_207,
    approximateRamMb: 1_600,
  },
  {
    id: 'medium',
    label: 'Whisper Medium (multilingual)',
    description: 'Самый точный из доступных. Медленный на CPU, рассчитан на GPU.',
    descriptionEn: 'The most accurate one. Slow on a CPU, meant for a GPU.',
    assetName: 'sherpa-onnx-whisper-medium.tar.bz2',
    rootDirName: 'sherpa-onnx-whisper-medium',
    downloadBytes: 1_931_372_882,
    approximateRamMb: 3_200,
  },
];

/**
 * Модель по умолчанию — `small`.
 *
 * Прежде здесь стоял `base` с доводом «small втрое медленнее без надёжного
 * выигрыша на коротких командах». Оба довода опроверг замер 26.09.2026.
 *
 * Выигрыш есть, и именно на красных линиях. Голос по кругу (синтез Piper →
 * Whisper → разбор), по два-четыре прогона: по-русски base дал 12, 9, 9 и 8 из
 * 12, small — 11, 12 и 11; по-английски base 9, 8, 9, small 9 и 11. Промахи
 * base приходились на «Тишина», «Пауза» и «Стоп».
 *
 * Медленнее — не настолько, чтобы мешать: живой журнал на small у владельца
 * даёт 0,6–1,2 с на фразу в 2–5,6 с речи. «Девяти секунд» не видно нигде.
 *
 * Цена — память (~1,1 ГБ против ~400 МБ) и загрузка (639 МБ против 208 МБ).
 * Поэтому по памяти решает `recommendWhisperModel`, а это — запас на случай,
 * когда объём памяти неизвестен.
 */
export const DEFAULT_WHISPER_MODEL: WhisperModelId = 'small';

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
  // От 8 ГБ — small: ~1,1 ГБ на распознавание такая машина держит, а base
  // промахивался по красным линиям (см. DEFAULT_WHISPER_MODEL).
  if (input.totalRamMb >= 8_000) return 'small';
  return 'tiny';
}
