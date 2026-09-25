/**
 * Слышит ли Джарвис то, что ему говорят.
 *
 * Синтезирует фразы его же голосом и прогоняет через его же распознаватель.
 * Это не замена живому микрофону — синтез чище человека, — но отвечает на
 * вопрос, который иначе проверяется только догадками: ломается ли смысл на
 * распознавании, или дальше.
 */

import { createRequire } from 'node:module';

// Синтез речи грузит нативный модуль через `require`, которого в ESM нет.
// В приложении этот код живёт в CommonJS-сборке, здесь мост нужен явно.
(globalThis as unknown as { require: NodeRequire }).require = createRequire(import.meta.url);

import { createGpuTranscriber, waitForWhisperServer } from '../app/gpuTranscriber';
import { jarvisPaths } from '../jarvis/setup/paths';
import { DEFAULT_VOICE, Speaker } from '../jarvis/voice/tts';
import type { Transcriber } from '../jarvis/voice/session';

const speaker = new Speaker(jarvisPaths().voiceModels, DEFAULT_VOICE.ru);

const PHRASES = [
  // Пробуждение и остановка — важнее всего: без них не работает ничего.
  'Джарвис',
  'стоп',
  'тишина',
  'хватит',

  // Запуск и окна.
  'открой блендер',
  'открой хром',
  'закрой стим',
  'переключись на блендер',
  'сверни окно',

  // Работа в программах.
  'создай в блендере красную сферу',
  'сделай таблицу с расходами',
  'нарисуй картинку с закатом',
  'отправь привет в чат джипити',
  'поменяй цвет сферы на зелёный',

  // Прямые команды.
  'прокрути вниз',
  'кликни войти',
  'скопируй',
  'вставь',
  'новая вкладка',
  'громче',
  'режим диктовки',
  'что ты умеешь',
  'сетка',
  'клик сорок пять',
];

/** Голос синтезируется в WAV; распознавателю нужны сами отсчёты. */
function samplesFromWav(wav: Buffer): { samples: Float32Array; rate: number } {
  const rate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);

  // Ищем блок данных: заголовок не всегда одной длины.
  let offset = 12;
  while (offset < wav.length - 8) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === 'data') {
      const count = Math.floor(size / (bits / 8));
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        samples[index] = wav.readInt16LE(offset + 8 + index * 2) / 32768;
      }
      return { samples, rate };
    }
    offset += 8 + size;
  }
  throw new Error('в WAV нет данных');
}

async function main(): Promise<void> {
  const endpoint = await waitForWhisperServer();
  if (!endpoint) {
    console.log('сервер распознавания не поднят — проверять нечем');
    process.exit(1);
  }

  const silent: Transcriber = { transcribe: async () => ({ text: '' }) };
  const transcriber = createGpuTranscriber({ endpoint, language: 'ru', fallback: silent });

  let exact = 0;
  for (const phrase of PHRASES) {
    const spoken = await speaker.say(phrase);

    const { samples, rate } = samplesFromWav(spoken.wav);
    const started = Date.now();
    const { text } = await transcriber.transcribe(samples, rate);
    const heard = text.trim();

    const same = heard.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim() ===
      phrase.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    if (same) exact += 1;

    console.log(
      `${same ? ' точно ' : ' МИМО '} «${phrase}»` +
        (same ? '' : ` → «${heard}»`) +
        ` (${Date.now() - started} мс)`,
    );
  }

  console.log('');
  console.log(`совпало дословно: ${exact} из ${PHRASES.length}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('не удалось:', error instanceof Error ? error.message : error);
  process.exit(1);
});
