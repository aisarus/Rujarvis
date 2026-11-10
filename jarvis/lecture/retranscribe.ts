/**
 * Дыры расшифровки: звук записан, а текста нет.
 *
 * Кусок не распознался (сервер whisper упал, завис, не успел до закрытия) —
 * раньше об этом оставалась строка в журнале, а в расшифровке не оставалось
 * ничего. Расшифровка выглядела целой, звук через неделю удалялся «потому что
 * расшифрован», и минуты лекции пропадали насовсем.
 *
 * Теперь дыра записана в самой расшифровке — строкой-комментарием Obsidian
 * (`%% … %%`, в заметке не видна): от какой до какой миллисекунды звука. По
 * ней дыру добирают из записи — в конце лекции и при следующем запуске, — и
 * пока она есть, звук лекции не удаляется.
 *
 * Этот файл ни о сессии, ни о заметках не знает: только пометки и чтение
 * куска WAV, который сессия пишет сама (16 бит, моно).
 */

import { open, stat } from 'node:fs/promises';

import { LIVE_CUT, type CutOptions } from './audioCut';
import { LectureRecorder } from './recorder';

/** Отрезок звука, мс от начала записи. */
export interface Gap {
  from: number;
  to: number;
}

const ПОМЕТКА = /^%% jarvis:gap (\d+)-(\d+) %%[ \t]*$/u;

export function gapLine(gap: Gap): string {
  return `%% jarvis:gap ${Math.max(0, Math.round(gap.from))}-${Math.max(0, Math.round(gap.to))} %%`;
}

/** Дыры, записанные в расшифровке. */
export function parseGaps(markdown: string): Gap[] {
  const дыры: Gap[] = [];
  for (const строка of markdown.split(/\r?\n/u)) {
    const m = ПОМЕТКА.exec(строка.trim());
    if (m && Number(m[2]) > Number(m[1])) дыры.push({ from: Number(m[1]), to: Number(m[2]) });
  }
  return дыры;
}

/** Расшифровка без пометок о дырах. */
export function withoutGapLines(markdown: string): string {
  return markdown
    .split(/\r?\n/u)
    .filter((строка) => !ПОМЕТКА.test(строка.trim()))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n');
}

/** Соседние и пересекающиеся дыры — одной. */
export function mergeGaps(gaps: readonly Gap[]): Gap[] {
  const по = [...gaps].filter((д) => д.to > д.from).sort((a, b) => a.from - b.from);
  const out: Gap[] = [];
  for (const д of по) {
    const прошлая = out[out.length - 1];
    if (прошлая && д.from <= прошлая.to + 1) прошлая.to = Math.max(прошлая.to, д.to);
    else out.push({ ...д });
  }
  return out;
}

export function gapsSeconds(gaps: readonly Gap[]): number {
  return gaps.reduce((всего, д) => всего + Math.max(0, д.to - д.from), 0) / 1000;
}

/** Частота и длина записи по самому файлу: заголовок брошенной записи мог не дописаться. */
export async function wavInfo(file: string): Promise<{ sampleRate: number; durationMs: number }> {
  const размер = (await stat(file)).size;
  const f = await open(file, 'r');
  try {
    const заголовок = Buffer.alloc(44);
    await f.read(заголовок, 0, 44, 0);
    const частота = заголовок.readUInt32LE(24) || 16_000;
    return { sampleRate: частота, durationMs: (Math.max(0, размер - 44) / 2 / частота) * 1000 };
  } finally {
    await f.close();
  }
}

export interface RangeResult {
  /** Распознанное: время куска в записи, мс, и текст. Тишина строк не даёт. */
  lines: Array<{ at: number; text: string }>;
  /** Что распознать так и не вышло. */
  failed: Gap[];
}

/**
 * Распознать отрезок записи заново. Звук читается по минуте, а не целиком
 * (полтора часа — 170 МБ), и режется по паузам так же, как на живой лекции.
 *
 * Три отказа подряд — распознавать нечем: остаток уходит в `failed` сразу, а
 * не после сотни ожиданий по две минуты.
 */
export async function transcribeRange(
  file: string,
  range: Gap,
  transcribe: (samples: Float32Array, sampleRate: number) => Promise<string>,
  cut: CutOptions = LIVE_CUT,
): Promise<RangeResult> {
  const итог: RangeResult = { lines: [], failed: [] };
  const { sampleRate, durationMs } = await wavInfo(file);
  const от = Math.max(0, Math.floor((range.from / 1000) * sampleRate));
  const до = Math.min(Math.floor((durationMs / 1000) * sampleRate), Math.ceil((range.to / 1000) * sampleRate));
  if (до <= от) return итог;

  const очередь: Array<{ samples: Float32Array; at: number }> = [];
  let отдано = от;
  const запись = new LectureRecorder((samples) => {
    очередь.push({ samples, at: (отдано / sampleRate) * 1000 });
    отдано += samples.length;
  }, cut);
  let подряд = 0;
  const разобрать = async (): Promise<boolean> => {
    for (const кусок of очередь.splice(0)) {
      const конец = кусок.at + (кусок.samples.length / sampleRate) * 1000;
      try {
        const текст = (await transcribe(кусок.samples, sampleRate)).trim();
        подряд = 0;
        if (текст) итог.lines.push({ at: кусок.at, text: текст });
      } catch {
        итог.failed.push({ from: кусок.at, to: конец });
        подряд += 1;
        if (подряд >= 3) {
          // Всё, что дальше, — тоже дыра: и уже нарезанное, и ещё не прочитанное.
          итог.failed.push({ from: конец, to: Math.min(range.to, durationMs) });
          итог.failed = mergeGaps(итог.failed);
          return false;
        }
      }
    }
    return true;
  };

  const f = await open(file, 'r');
  try {
    const шаг = 60 * sampleRate;
    for (let место = от; место < до; место += шаг) {
      const отсчётов = Math.min(шаг, до - место);
      const байты = Buffer.alloc(отсчётов * 2);
      const { bytesRead } = await f.read(байты, 0, байты.length, 44 + место * 2);
      const прочитано = Math.floor(bytesRead / 2);
      const звук = new Float32Array(прочитано);
      for (let i = 0; i < прочитано; i += 1) звук[i] = байты.readInt16LE(i * 2) / 0x8000;
      запись.push(звук, sampleRate);
      if (!(await разобрать())) return итог;
      if (прочитано < отсчётов) break;
    }
    запись.flush();
    if (!(await разобрать())) return итог;
  } finally {
    await f.close();
  }
  итог.failed = mergeGaps(итог.failed);
  return итог;
}
