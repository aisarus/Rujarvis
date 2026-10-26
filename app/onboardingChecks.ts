/**
 * Проверки первого запуска: слышит ли распознавание и пишет ли модель — до
 * первой пары, а не вечером над пустой заметкой.
 *
 * Тестерше на маке (26.10.2026) помогать некому: всё, что может сломаться,
 * мастер обязан показать сам. Слух — её собственной фразой через ту же модель
 * для лекций и тот же сервер, что у лекции; модель — настоящим коротким
 * запросом к Claude Code и Codex по её подписке. Отказ — словами, которые
 * говорят, что делать: войти, подождать лимит, сменить модель.
 */

import { createServer } from 'node:net';
import path from 'node:path';

import { resolveCli } from '../jarvis/backends/cliProbes';
import { brainOrder, createClaudeSummarizer, createCodexSummarizer, type Brain } from '../jarvis/lecture/summarize';
import { tr } from '../jarvis/locale/language';
import { findGpuWhisper, findLectureModel, gpuWhisperDir, startGpuWhisper } from '../jarvis/voice/gpuWhisper';
import { createGpuTranscriber, isWhisperServerReady } from './gpuTranscriber';

/** Успевает ли этот компьютер за лектором. */
export type HearingSpeed = 'fast' | 'tight' | 'slow';

/**
 * Кусок лекции — до 28 секунд, а фраза проверки короче. Но whisper считает
 * окно в 30 секунд целиком, так что время на фразу — уже почти время на
 * кусок; запас — на более длинный текст куска.
 */
export function hearingSpeed(seconds: number): HearingSpeed {
  const наКусок = seconds * 1.3;
  return наКусок <= 14 ? 'fast' : наКусок <= 26 ? 'tight' : 'slow';
}

export type HearingCheck =
  | { ok: true; text: string; seconds: number; startSeconds: number; model: string; speed: HearingSpeed }
  | { ok: false; reason: 'not-installed' | 'server' | 'failed'; message: string };

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

/** Распознать фразу человека моделью для лекций на своём сервере — и погасить его. */
export async function checkHearing(options: { home: string; language: string; samples: Float32Array; sampleRate: number; log?(line: string): void }): Promise<HearingCheck> {
  const dir = gpuWhisperDir(options.home);
  const files = await findGpuWhisper(dir).catch(() => null);
  if (!files) {
    return {
      ok: false,
      reason: 'not-installed',
      message: tr('Распознавание лекций не установлено — нажмите «Установить» выше.', 'Lecture recognition is not installed — press "Install" above.'),
    };
  }
  const модель = (await findLectureModel(dir, options.language).catch(() => null)) ?? files.model;
  const начало = Date.now();
  let сервер;
  try {
    сервер = await startGpuWhisper(
      { server: files.server, model: модель },
      { port: await свободныйПорт(), isReady: isWhisperServerReady, readyMs: 180_000, log: (строка) => options.log?.(строка.slice(0, 200)) },
    );
  } catch (error) {
    return { ok: false, reason: 'server', message: tr(`Распознавание не запустилось: ${error instanceof Error ? error.message : String(error)}`, `Recognition did not start: ${error instanceof Error ? error.message : String(error)}`) };
  }
  try {
    const запущен = (Date.now() - начало) / 1000;
    const t0 = Date.now();
    const { text } = await createGpuTranscriber({ endpoint: сервер.endpoint, language: options.language, timeoutMs: 180_000 }).transcribe(options.samples, options.sampleRate);
    const seconds = (Date.now() - t0) / 1000;
    options.log?.(`проверка слуха: ${seconds.toFixed(1)} с на фразу, запуск ${запущен.toFixed(1)} с, модель ${path.basename(модель)}`);
    return { ok: true, text: text.trim(), seconds, startSeconds: запущен, model: path.basename(модель), speed: hearingSpeed(seconds) };
  } catch (error) {
    return { ok: false, reason: 'failed', message: tr(`Фраза не распозналась: ${error instanceof Error ? error.message : String(error)}`, `The phrase was not transcribed: ${error instanceof Error ? error.message : String(error)}`) };
  } finally {
    сервер.stop();
  }
}

/**
 * Отказ агента — словами, которые говорят, что делать.
 *
 * Сырой текст CLI («Invalid API key · Please run /login», «The 'x' model is
 * not supported when using Codex with a ChatGPT account») человеку не из IT
 * ничего не говорит.
 */
export function agentFailure(cli: 'claude' | 'codex', raw: string): string {
  if (/not supported when using codex with a chatgpt account/iu.test(raw)) {
    return tr('Ваш тариф ChatGPT не даёт Codex этой модели. Нужна подписка Plus или выше.', 'Your ChatGPT plan does not include this Codex model. Plus or higher is needed.');
  }
  // Вход — раньше лимита, а коды — только отдельным числом. Codex без входа
  // отвечает «401 Unauthorized … request id: req_…», и в случайных цифрах
  // номера попалось «429»: проверка звала незалогиненный Codex «лимит
  // исчерпан» (CI на маке, 26.10.2026).
  if (/\b401\b|unauthori[sz]ed|missing bearer|not logged in|logged out|log ?in|sign in|not authenticated|invalid api key|oauth|failed to authenticate/iu.test(raw)) {
    return tr('Вход не выполнен — нажмите «Войти».', 'Not signed in — press "Sign in".');
  }
  if (/usage limit|rate limit|limit reached|quota|too many requests|\b429\b/iu.test(raw)) {
    return tr('Лимит подписки на сейчас исчерпан — попробуйте позже.', 'The subscription limit is used up for now — try again later.');
  }
  if (/не найден|not found|ENOENT/iu.test(raw)) {
    return tr(`${cli === 'claude' ? 'Claude Code' : 'Codex'} не установлен — нажмите «Установить».`, `${cli === 'claude' ? 'Claude Code' : 'Codex'} is not installed — press "Install".`);
  }
  if (/не ответил за|did not answer|timed out|timeout/iu.test(raw)) {
    return tr('Модель долго не отвечает — проверьте интернет и нажмите ещё раз.', 'The model takes too long — check the internet and try again.');
  }
  return raw.slice(0, 240);
}

export interface BrainCheck {
  cli: 'claude' | 'codex';
  ok: boolean;
  seconds: number;
  message: string;
}

const ПРОБА = 'Это проверка связи перед лекцией. Ответь одним словом: готово.';

/**
 * Короткий настоящий запрос к каждому установленному агенту — тем же вызовом,
 * что пишет разделы конспекта, — и кто из них будет писать конспект.
 */
export async function checkBrains(
  choice: Brain,
  options: {
    installed?: (cli: 'claude' | 'codex') => boolean;
    ask?: (cli: 'claude' | 'codex', prompt: string) => Promise<string>;
  } = {},
): Promise<{ order: Array<'claude' | 'codex'>; results: BrainCheck[] }> {
  const installed = options.installed ?? ((cli) => resolveCli(cli) !== null);
  const ask =
    options.ask ??
    ((cli, prompt) => (cli === 'codex' ? createCodexSummarizer({ effort: 'low', timeoutMs: 180_000 }) : createClaudeSummarizer({ timeoutMs: 180_000 }))(prompt));
  const кого = (['claude', 'codex'] as const).filter((cli) => installed(cli));
  const results = await Promise.all(
    кого.map(async (cli): Promise<BrainCheck> => {
      const t0 = Date.now();
      try {
        const ответ = (await ask(cli, ПРОБА)).trim();
        return { cli, ok: ответ.length > 0, seconds: (Date.now() - t0) / 1000, message: ответ.slice(0, 80) };
      } catch (error) {
        return { cli, ok: false, seconds: (Date.now() - t0) / 1000, message: agentFailure(cli, error instanceof Error ? error.message : String(error)) };
      }
    }),
  );
  return { order: brainOrder(choice, installed), results };
}
