/**
 * Голос по кругу: синтез → распознавание → разбор команды.
 *
 * Проверяет голосовой путь без микрофона: фраза произносится голосом Piper,
 * распознаётся Whisper на том же языке и идёт в тот же разбор, что и живая
 * речь. Синтез чище человека, поэтому это нижняя граница проблем, а не
 * замена живой проверке, — но ломается здесь то же самое, что ломается у
 * человека: ослышка в слове остановки, команда, ушедшая агенту.
 *
 * Три ответа, как везде в проекте: прошло, не прошло, нечем мерить (модели не
 * скачаны).
 *
 *     pnpm jarvis:roundtrip                        # русский
 *     pnpm jarvis:roundtrip -- --en                # английский
 *     pnpm jarvis:roundtrip -- --en --model base   # конкретная модель
 */

import { matchAppLaunch, spokenCloseTarget } from '../jarvis/apps/launch';
import { parseDirectCommand } from '../jarvis/control/commands';
import { setLanguage, type Language } from '../jarvis/locale/language';
import { jarvisPaths } from '../jarvis/setup/paths';
import { matchVoiceControl } from '../jarvis/voice/interrupts';
import { fixMishearings } from '../jarvis/voice/mishearing';
import { isSilenceRequest, meaningfulSpeech } from '../jarvis/voice/noise';
import { DEFAULT_VOICE, isVoiceInstalled, Speaker } from '../jarvis/voice/tts';
import { WHISPER_MODEL_IDS, type WhisperModelId } from '../jarvis/voice/sttModels';
import { findWakeWord } from '../jarvis/voice/wakeWord';
import { isWhisperModelInstalled, WhisperRecognizer } from '../jarvis/voice/whisperRecognizer';

type Expect = (heard: string) => boolean;

const control = (kind: string): Expect => (heard) => matchVoiceControl(heard)?.control === kind;
const silence: Expect = (heard) => matchVoiceControl(heard)?.control === 'mute' || isSilenceRequest(heard);
const direct = (kind: string): Expect => (heard) => {
  const woken = findWakeWord(heard);
  return parseDirectCommand(woken?.command || heard)?.kind === kind;
};
const wake: Expect = (heard) => findWakeWord(heard) !== null;
const opens = (target: string): Expect => (heard) => matchAppLaunch(findWakeWord(heard)?.command || heard)?.target === target;
const closes: Expect = (heard) => spokenCloseTarget(findWakeWord(heard)?.command || heard) !== null;

const CASES: Record<Language, Array<[string, Expect]>> = {
  ru: [
    ['Стоп.', control('stop')],
    ['Тишина.', silence],
    ['Пауза.', control('pause')],
    ['Продолжай.', control('resume')],
    ['Джарвис, открой хром.', opens('chrome')],
    ['Джарвис.', wake],
    ['Прокрути вниз.', direct('scroll')],
    ['Скопируй.', direct('key')],
    ['Закрой вкладку.', direct('key')],
    ['Переключись на телеграм.', direct('focus')],
    ['Закрой спотифай.', closes],
    ['Что ты умеешь?', direct('help')],
  ],
  en: [
    ['Stop.', control('stop')],
    ['Silence.', silence],
    ['Pause.', control('pause')],
    ['Continue.', control('resume')],
    ['Jarvis, open Chrome.', opens('chrome')],
    ['Jarvis.', wake],
    ['Scroll down.', direct('scroll')],
    ['Copy.', direct('key')],
    ['Close the tab.', direct('key')],
    ['Switch to Telegram.', direct('focus')],
    ['Close Spotify.', closes],
    ['What can you do?', direct('help')],
  ],
};

/**
 * WAV в отсчёты — с тишиной по краям.
 *
 * Синтез начинается с первого же отсчёта, а Whisper на коротком слове без
 * паузы перед ним съедает начало: «Stop» слышится как «Top». Живая запись с
 * микрофона всегда приходит с паузой (её отрезает детектор речи), поэтому
 * здесь она добавляется, чтобы мерить распознавание, а не артефакт синтеза.
 */
function samplesFromWav(wav: Buffer): { samples: Float32Array; rate: number } {
  const rate = wav.readUInt32LE(24);
  const data = wav.subarray(44);
  const pad = Math.round(rate * 0.4);
  const samples = new Float32Array(data.length / 2 + pad * 2);
  for (let i = 0; i < data.length / 2; i += 1) samples[pad + i] = data.readInt16LE(i * 2) / 0x8000;
  return { samples, rate };
}

async function main(): Promise<void> {
  const language: Language = process.argv.includes('--en') ? 'en' : 'ru';
  setLanguage(language);
  const paths = jarvisPaths();

  const voiceId = DEFAULT_VOICE[language];
  if (!isVoiceInstalled(paths.voiceModels, voiceId)) {
    console.log(`НЕЧЕМ МЕРИТЬ: голос ${voiceId} не скачан в ${paths.voiceModels}`);
    process.exit(2);
  }
  // `--model turbo` — мерить конкретную; иначе самую точную из установленных.
  const asked = process.argv[process.argv.indexOf('--model') + 1] as WhisperModelId | undefined;
  let model: WhisperModelId | undefined;
  if (process.argv.includes('--model') && asked && (await isWhisperModelInstalled(paths.whisperModels, asked))) {
    model = asked;
  }
  for (const id of [...WHISPER_MODEL_IDS].reverse()) {
    if (model) break;
    if (await isWhisperModelInstalled(paths.whisperModels, id)) model = id;
  }
  if (!model) {
    console.log(`НЕЧЕМ МЕРИТЬ: нет модели Whisper в ${paths.whisperModels}`);
    process.exit(2);
  }

  const speaker = new Speaker(paths.voiceModels, voiceId);
  // Большие модели на однопоточном WASM грузятся минутами: срок щедрый.
  const ears = new WhisperRecognizer({ installRoot: paths.whisperModels, modelId: model, language, timeoutMs: 600_000 });
  console.log(`${language}: голос ${voiceId}, распознавание whisper-${model}\n`);

  let failed = 0;
  for (const [said, expect] of CASES[language]) {
    const { samples, rate } = samplesFromWav((await speaker.say(said)).wav);
    const raw = (await ears.transcribe(samples, rate)).text.trim();
    // Тот же конвейер, что в мосте: ослышки, затем отсев шума.
    const heard = meaningfulSpeech(fixMishearings(raw)) ?? '';
    const ok = expect(heard);
    if (!ok) failed += 1;
    const shown = heard === raw ? `«${raw}»` : `«${raw}» → «${heard}»`;
    console.log(`${ok ? 'ОК   ' : 'МИМО '} ${said.padEnd(28)} → ${shown}`);
  }

  speaker.dispose();
  console.log(`\n${CASES[language].length - failed} из ${CASES[language].length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
