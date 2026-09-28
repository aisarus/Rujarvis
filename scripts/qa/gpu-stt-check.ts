/**
 * Распознавание на видеокарте — настоящим сервером: `pnpm jarvis:gpu-stt-check`.
 *
 * Поднимает свой сервер whisper.cpp на свободном порту (работающему
 * Джарвису не мешает), говорит три команды голосом Piper, распознаёт их и
 * меряет время. Отвечает тремя способами: прошло; не прошло; нечем мерить —
 * не установлено (`pnpm jarvis:gpu-stt`) или нет голоса для синтеза. На чём
 * считал сервер — CUDA, Metal или процессор — берётся из его собственного
 * вывода: раннеры CI без видеокарты считают на процессоре, и выдавать это за
 * видеокарту нельзя.
 *
 * Окон не открывает и фокус не трогает: можно гонять и на машине владельца.
 */
import { createServer } from 'node:net';

import { jarvisPaths } from '../../jarvis/setup/paths';
import { findGpuWhisper, gpuWhisperDir, startGpuWhisper } from '../../jarvis/voice/gpuWhisper';
import { DEFAULT_VOICE, isVoiceInstalled, Speaker } from '../../jarvis/voice/tts';
import { encodeWav16 } from '../../jarvis/voice/wav';

const ФРАЗЫ: Array<{ сказать: string; ждём: string }> = [
  { сказать: 'Открой блокнот.', ждём: 'блокнот' },
  { сказать: 'Поставь громкость на семьдесят.', ждём: 'громкост' },
  { сказать: 'Вернись на предыдущую вкладку.', ждём: 'вкладк' },
];

async function свободныйПорт(): Promise<number> {
  return new Promise((resolve, reject) => {
    const сервер = createServer();
    сервер.once('error', reject);
    сервер.listen(0, '127.0.0.1', () => {
      const адрес = сервер.address();
      сервер.close(() => resolve(typeof адрес === 'object' && адрес ? адрес.port : 0));
    });
  });
}

const отвечает = async (endpoint: string): Promise<boolean> => {
  try {
    return (await fetch(`${endpoint}/`)).ok;
  } catch {
    return false;
  }
};

/** WAV Piper (16 бит, моно) → отсчёты и частота. */
function изWav(wav: Buffer): { samples: Float32Array; rate: number } {
  const rate = wav.readUInt32LE(24);
  const data = wav.subarray(44);
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 0x8000;
  return { samples, rate };
}

/** Линейно в 16 кГц: столько ждёт сервер, и столько же пишет микрофон Джарвиса. */
function в16кГц(samples: Float32Array, rate: number): Float32Array {
  if (rate === 16_000) return samples;
  const out = new Float32Array(Math.floor((samples.length * 16_000) / rate));
  for (let i = 0; i < out.length; i += 1) {
    const x = (i * rate) / 16_000;
    const a = Math.floor(x);
    const t = x - a;
    out[i] = (samples[a] ?? 0) * (1 - t) + (samples[a + 1] ?? samples[a] ?? 0) * t;
  }
  return out;
}

async function main(): Promise<void> {
  console.log('');
  console.log('Распознавание на видеокарте: свой сервер whisper.cpp, три команды голосом');
  const paths = jarvisPaths();
  const files = await findGpuWhisper(gpuWhisperDir(paths.home));
  if (!files) {
    console.log('НЕЧЕМ МЕРИТЬ: не установлено — pnpm jarvis:gpu-stt');
    process.exitCode = 2;
    return;
  }
  if (!isVoiceInstalled(paths.voiceModels, DEFAULT_VOICE.ru)) {
    console.log(`НЕЧЕМ МЕРИТЬ: нет голоса ${DEFAULT_VOICE.ru} для синтеза фраз`);
    process.exitCode = 2;
    return;
  }

  const устройство: string[] = [];
  const port = await свободныйПорт();
  const начало = Date.now();
  let сервер;
  try {
    сервер = await startGpuWhisper(files, { port, isReady: отвечает, log: (строка) => устройство.push(строка) });
  } catch (беда) {
    console.log(`НЕ ПРОШЛО: сервер не поднялся — ${беда instanceof Error ? беда.message : String(беда)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  сервер поднят за ${Date.now() - начало} мс (pid ${сервер.pid}), порт ${port}`);
  for (const строка of устройство.slice(0, 6)) console.log(`  сервер: ${строка.slice(0, 160)}`);

  const speaker = new Speaker(paths.voiceModels, DEFAULT_VOICE.ru);
  let неПрошло = 0;
  const времена: number[] = [];
  try {
    for (const { сказать, ждём } of ФРАЗЫ) {
      const { samples, rate } = изWav((await speaker.say(сказать)).wav);
      const форма = new FormData();
      форма.append('file', new Blob([new Uint8Array(encodeWav16(в16кГц(samples, rate), 16_000))], { type: 'audio/wav' }), 'speech.wav');
      форма.append('response_format', 'json');
      форма.append('language', 'ru');
      форма.append('translate', 'false');
      const t0 = performance.now();
      const ответ = await fetch(`${сервер.endpoint}/inference`, { method: 'POST', body: форма });
      const мс = Math.round(performance.now() - t0);
      времена.push(мс);
      const текст = ответ.ok ? String(((await ответ.json()) as { text?: unknown }).text ?? '').trim() : `HTTP ${ответ.status}`;
      const верно = текст.toLowerCase().replace(/ё/gu, 'е').includes(ждём);
      if (!верно) неПрошло += 1;
      console.log(`  ${верно ? 'прошло      ' : 'НЕ ПРОШЛО   '} «${сказать}» → «${текст}» — ${мс} мс`);
    }
  } finally {
    speaker.dispose();
    сервер.stop();
  }

  const считал = устройство.some((с) => /metal/iu.test(с))
    ? 'Metal'
    : устройство.some((с) => /cuda/iu.test(с) && !/no cuda|failed|not found|error/iu.test(с))
      ? 'CUDA'
      : 'процессор или не видно из вывода сервера';
  const медиана = [...времена].sort((a, b) => a - b)[Math.floor(времена.length / 2)] ?? 0;
  console.log(`  считал: ${считал}; распознавание — медиана ${медиана} мс`);
  console.log(`Всего ${ФРАЗЫ.length}: не прошло ${неПрошло}, нечем мерить 0`);
  process.exitCode = неПрошло > 0 ? 1 : 0;
}

void main();
