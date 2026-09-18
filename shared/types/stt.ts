// 'whisper' is the Jarvis addition: a local, Russian-capable backend that runs
// on CPU through the sherpa-onnx runtime the app already bundles for speech
// synthesis. Qwen and Moonshine remain untouched.
export const STT_BACKENDS = ['qwen', 'moonshine', 'whisper'] as const;
export type SttBackend = (typeof STT_BACKENDS)[number];

export const VOICE_MODES = ['conversational', 'push-to-talk', 'ambient'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export interface SttSettings {
  backend: SttBackend;
  /**
   * Which Whisper model the 'whisper' backend uses.
   *
   * Typed as a plain string here so this renderer-facing module stays free of
   * node-side imports; the catalog in `jarvis/voice/sttModels.ts` validates it
   * and falls back to its own default for anything it does not recognise.
   */
  whisperModelId?: string;
  stripChineseCharacters: boolean;
  silenceTimeoutMs: number;
  fastSentenceSilenceTimeoutMs: number;
  previewBeforeSendMs: number;
  sendCommand: string;
  newChatCommand: string;
  voiceMode: VoiceMode;
  ambientTriggerPhrases: string[];
  ambientEndPhrases: string[];
}

export const STT_MIN_SILENCE_TIMEOUT_MS = 250;
export const STT_MAX_SILENCE_TIMEOUT_MS = 8000;
export const STT_MIN_FAST_SENTENCE_TIMEOUT_MS = 100;
export const STT_MAX_FAST_SENTENCE_TIMEOUT_MS = 4000;
export const STT_MIN_PREVIEW_BEFORE_SEND_MS = 0;
export const STT_MAX_PREVIEW_BEFORE_SEND_MS = 4000;
// The wake word, plus the spellings Russian speech recognition actually
// produces for it. A recogniser that hears "Жарвис" must still wake Jarvis.
export const DEFAULT_AMBIENT_TRIGGER_PHRASES = [
  'Джарвис',
  'Жарвис',
  'Джарвес',
  'Джарвиз',
  'Jarvis',
];
export const DEFAULT_AMBIENT_END_PHRASES = ['выполняй', 'поехали', 'make it so'];

export function normalizeAmbientPhrases(phrases: readonly string[], fallback: readonly string[]): string[] {
  const normalized = Array.from(new Set(
    phrases
      .map((phrase) => phrase.trim())
      .filter((phrase) => phrase.length > 0),
  ));

  if (normalized.length > 0) {
    return normalized;
  }

  return [...fallback];
}

export function getPrimaryAmbientPhrase(phrases: readonly string[], fallback: string): string {
  return normalizeAmbientPhrases(phrases, [fallback])[0] ?? fallback;
}

export const DEFAULT_STT_SETTINGS: SttSettings = {
  backend: 'whisper',
  whisperModelId: 'base',
  // Kept on: multilingual Whisper occasionally hallucinates CJK characters in
  // Russian audio, and this is the existing cleanup that removes them. The
  // language-driven reset in configStore depends on this default too.
  stripChineseCharacters: true,
  silenceTimeoutMs: 2000,
  fastSentenceSilenceTimeoutMs: 700,
  previewBeforeSendMs: 0,
  sendCommand: 'выполняй',
  newChatCommand: 'новый чат',
  voiceMode: 'push-to-talk',
  ambientTriggerPhrases: [...DEFAULT_AMBIENT_TRIGGER_PHRASES],
  ambientEndPhrases: [...DEFAULT_AMBIENT_END_PHRASES],
};
