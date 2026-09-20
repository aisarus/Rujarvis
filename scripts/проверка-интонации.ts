/**
 * Сквозная проверка: доезжает ли вопрос до ответа словами.
 *
 * ## Зачем отдельная проверка
 *
 * Человек попросил, чтобы «вопрос интонацией считывался». В русском общий
 * вопрос отличается от утверждения ТОЛЬКО интонацией — «ты сделал ракету?» и
 * «ты сделал ракету.» это разные просьбы, и разбор слов их не различит.
 * Единственный признак, который у нас есть, — вопросительный знак, который
 * распознаватель ставит, услышав интонацию.
 *
 * 20.09.2026 замером выяснилось, что знак терялся не у распознавателя, а у
 * нас: очистка речи стирала его вместе с остальными знаками ДО того, как фразу
 * кто-либо видел. В журнале 1502 живых фразы и ни одного знака препинания — при
 * том, что сервер на видеокарте их честно возвращает.
 *
 * Модульные тесты этого не ловили и поймать не могли: каждый слой по
 * отдельности вёл себя правильно, а терялось на шве между ними. Поэтому
 * проверка идёт через НАСТОЯЩИЙ распознаватель, а не через выдуманные строки.
 *
 * ## Чего эта проверка не доказывает
 *
 * Голос для стенда синтезирует Пайпер, а он вопросительную интонацию не
 * произносит: замер контура основного тона показал, что «ты сделал ракету?» и
 * «ты сделал ракету.» у него заканчиваются одинаковым падением. Значит вопрос,
 * заданный ОДНОЙ интонацией, здесь проверить нечем — и такие случаи честно
 * помечаются «нечем», а не выдаются за пройденные.
 *
 * Сам знак к тому же приходит не всегда: одна и та же фраза в двух прогонах
 * подряд пришла и со знаком, и с точкой. Поэтому проверяется РЕШЕНИЕ — вопрос
 * обязан кончиться ответом словами, — а знак только считается и показывается.
 *
 * Ответить на вопрос про живую речь человека может лишь сам человек: скажет и
 * посмотрит в журнал. Здесь проверяется путь, а не слух.
 */

import path from 'node:path';
import { createRequire } from 'node:module';

import { fixMishearings } from '../jarvis/voice/mishearing';
import { meaningfulSpeech } from '../jarvis/voice/noise';
import { route } from '../jarvis/router/router';
import { isTalk } from '../jarvis/core';
import { tokenize } from '../jarvis/router/text';

const СЕРВЕР = process.env.JARVIS_GPU_STT ?? 'http://127.0.0.1:8178';

/** Прошло — null. Не прошло — что именно. Нечем мерить — отдельное значение. */
type Verdict = null | string | { нечем: string };

interface Случай {
  текст: string;
  /** Чего ждём от готового решения. Это и есть предмет проверки. */
  ждём: 'ответ словами' | 'работа';
  /** Есть ли в фразе вопросительное слово — тогда знак не нужен вовсе. */
  словоВопроса: boolean;
}

/**
 * Что говорим стенду.
 *
 * Про знак вопроса замерено 20.09.2026: large-v3-turbo ставит его НЕ каждый
 * раз. Одна и та же фраза «что ты сделал» в двух прогонах подряд пришла и со
 * знаком, и с точкой. Поэтому знак здесь — подспорье, а не условие: требовать
 * его значило бы получить прибор, который иногда краснеет на исправной
 * системе, а такой прибор перестают читать.
 *
 * Проверяется решение. Вопрос обязан кончиться ответом словами, а поручение —
 * работой, и знак к этому либо добавляется, либо нет.
 */
const СЛУЧАИ: Случай[] = [
  { текст: 'Что ты сделал?', ждём: 'ответ словами', словоВопроса: true },
  { текст: 'Почему это не работает?', ждём: 'ответ словами', словоВопроса: true },
  { текст: 'Сколько сейчас времени?', ждём: 'ответ словами', словоВопроса: true },
  { текст: 'Открой блокнот.', ждём: 'работа', словоВопроса: false },
  { текст: 'Ты сделал ракету?', ждём: 'ответ словами', словоВопроса: false },
];

const ГОЛОС = path.join(
  process.env.TEST_TTS_INSTALL_ROOT ??
    path.join(process.env.APPDATA ?? '', 'Interpreter', 'tts-models'),
  'vits-piper-ru_RU-irina-medium',
  'vits-piper-ru_RU-irina-medium',
);

function wav16(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    data.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * Голос для стенда.
 *
 * Синтез и распознавание обязаны быть в разных процессах — сборка sherpa для
 * WebAssembly держит один экземпляр модуля на процесс и падает от второго.
 * Здесь это выполнено само собой: распознаватель живёт за HTTP.
 */
function создатьГолос(): { сказать(текст: string): Buffer } | null {
  try {
    const require_ = createRequire(path.join(process.cwd(), 'package.json'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sherpa = require_('sherpa-onnx') as any;
    const tts = sherpa.createOfflineTts({
      offlineTtsModelConfig: {
        offlineTtsVitsModelConfig: {
          model: path.join(ГОЛОС, 'ru_RU-irina-medium.onnx'),
          tokens: path.join(ГОЛОС, 'tokens.txt'),
          dataDir: path.join(ГОЛОС, 'espeak-ng-data'),
          lexicon: '',
          noiseScale: 0.667,
          noiseScaleW: 0.8,
          lengthScale: 1.0,
        },
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      ruleFsts: '',
      ruleFars: '',
      maxNumSentences: 1,
    });
    return {
      сказать(текст: string): Buffer {
        const audio = tts.generate({ text: текст, sid: 0, speed: 1.0 });
        return wav16(audio.samples, audio.sampleRate);
      },
    };
  } catch {
    return null;
  }
}

async function распознать(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
  form.append('response_format', 'json');
  form.append('language', 'ru');
  form.append('translate', 'false');
  const response = await fetch(`${СЕРВЕР}/inference`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(`сервер ответил HTTP ${response.status}`);
  const payload = (await response.json()) as { text?: string };
  return (payload.text ?? '').trim();
}

async function серверЖивой(): Promise<boolean> {
  try {
    const ответ = await fetch(`${СЕРВЕР}/`, { signal: AbortSignal.timeout(3000) });
    return ответ.status < 500;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(`Сквозная проверка вопросов: ${СЛУЧАИ.length} фраз${String.fromCharCode(10)}`);

  const живой = await серверЖивой();
  const голос = живой ? создатьГолос() : null;

  let плохо = 0;
  let нечем = 0;
  // Сколько раз распознаватель услышал вопрос знаком. Это наблюдение, а не
  // условие: знак приходит не каждый раз даже на одной и той же фразе.
  let знаков = 0;

  for (const случай of СЛУЧАИ) {
    let вердикт: Verdict;
    try {
      if (!живой) {
        вердикт = { нечем: `распознаватель не поднят (${СЕРВЕР})` };
      } else if (!голос) {
        вердикт = { нечем: 'голос для стенда не установлен' };
      } else {
        const сырое = await распознать(голос.сказать(случай.текст));
        // Ровно тот путь очистки, что стоит в обёртке распознавателя.
        const очищенное = meaningfulSpeech(fixMishearings(сырое));
        if (!очищенное) {
          вердикт = `очистка съела фразу целиком: ${JSON.stringify(сырое)}`;
        } else {
          const естьЗнак = tokenize(очищенное).includes('?');
          const решение = route(очищенное, { basePermissions: { canRunCode: true } as never });
          const вышло = isTalk(решение) ? 'ответ словами' : 'работа';

          // Вопрос без вопросительного слова держится ТОЛЬКО на знаке. Если
          // распознаватель его не поставил, проверять нечего: стенд не умеет
          // произносить вопросительную интонацию, и провал был бы его, а не
          // системы.
          if (!случай.словоВопроса && случай.ждём === 'ответ словами' && !естьЗнак) {
            вердикт = { нечем: `стенд не произносит вопрос интонацией: ${JSON.stringify(сырое)}` };
          } else if (вышло !== случай.ждём) {
            вердикт = `ждали «${случай.ждём}», вышло «${вышло}» (${решение.intent}, нужно: ${решение.needs.join(', ') || 'ничего'})`;
          } else {
            вердикт = null;
            знаков += естьЗнак ? 1 : 0;
          }
        }
      }
    } catch (error) {
      вердикт = error instanceof Error ? error.message : String(error);
    }

    if (вердикт === null) {
      console.log(`  ок   ${случай.текст}`);
    } else if (typeof вердикт === 'object') {
      нечем += 1;
      console.log(`нечем  ${случай.текст.padEnd(26)} ${вердикт.нечем}`);
    } else {
      плохо += 1;
      console.log(`ПЛОХО  ${случай.текст.padEnd(26)} ${вердикт}`);
    }
  }

  console.log('');
  const хвост = нечем > 0 ? `, нечем проверить: ${нечем}` : '';
  console.log(`Знак вопроса расслышан: ${знаков} раз из ${СЛУЧАИ.length}.`);
  console.log(
    плохо === 0 ? `Всё прошло${хвост}.` : `Не прошло: ${плохо} из ${СЛУЧАИ.length}${хвост}.`,
  );
  process.exit(плохо === 0 ? 0 : 1);
}

void main();
