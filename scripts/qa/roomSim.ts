/**
 * Аудитория из чистой записи: лектор далеко, зал гулкий, вокруг люди.
 *
 * Нужна, чтобы знать, чего ждать от микрофона ноутбука на паре, до того как
 * человек на неё пошёл: портим запись из тихой комнаты так, как её испортил бы
 * зал, и меряем распознавание. Три порчи, и все три — физика, а не догадка:
 *
 * - **Даль.** Голос с десяти метров тише на 20–26 дБ, чем с полуметра.
 * - **Гул.** Хвост отражений — ревербератор Шрёдера (Freeverb): восемь
 *   гребёнок с обратной связью под заданное время спада RT60 и четыре
 *   фазовых звена. Прямой звук с десяти метров слабее отражённого.
 * - **Люди.** Бормотание — та же речь задом наперёд со сдвигами: спектр речи
 *   без смысла, какой и бывает у зала. Плюс розовый шум — вентиляция и проектор.
 *
 * Случайность — со своим зерном: замер повторяем.
 */

export interface RoomOptions {
  /** Насколько лектор тише, чем в исходной записи, дБ. */
  gainDb: number;
  /** Время спада отражений на 60 дБ, секунды. */
  rt60: number;
  /** Прямой звук к отражённому, дБ: на десяти метрах в зале — около −6. */
  drrDb: number;
  /** Речь к шуму зала, дБ; Infinity — без шума. */
  snrDb: number;
  /** Доля бормотания в шуме зала, остальное — ровный розовый шум. По умолчанию половина. */
  babble?: number;
  seed: number;
}

/** Воспроизводимая случайность (mulberry32). */
function зерно(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function энергия(x: Float32Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return x.length > 0 ? s / x.length : 0;
}

/** Задержки Freeverb для 44,1 кГц — пересчитываются на свою частоту. */
const ГРЕБЁНКИ = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ФАЗОВЫЕ = [556, 441, 341, 225];

export function reverb(x: Float32Array, sampleRate: number, rt60: number): Float32Array {
  const масштаб = sampleRate / 44_100;
  const мокрый = new Float32Array(x.length);
  for (const d0 of ГРЕБЁНКИ) {
    const d = Math.max(1, Math.round(d0 * масштаб));
    // Каждый круг гребёнки — d отсчётов; за rt60 секунд сигнал обязан упасть на 60 дБ.
    const g = Math.pow(10, (-3 * d) / (rt60 * sampleRate));
    const буфер = new Float32Array(d);
    let i = 0;
    // Лёгкое затухание верхов на каждом круге, как у настоящих стен.
    let фильтр = 0;
    for (let n = 0; n < x.length; n += 1) {
      const выход = буфер[i] ?? 0;
      фильтр = выход * 0.8 + фильтр * 0.2;
      буфер[i] = (x[n] ?? 0) + фильтр * g;
      мокрый[n] = (мокрый[n] ?? 0) + выход;
      i = (i + 1) % d;
    }
  }
  let сигнал = мокрый;
  for (const d0 of ФАЗОВЫЕ) {
    const d = Math.max(1, Math.round(d0 * масштаб));
    const буфер = new Float32Array(d);
    const out = new Float32Array(сигнал.length);
    let i = 0;
    for (let n = 0; n < сигнал.length; n += 1) {
      const задержано = буфер[i] ?? 0;
      const вход = сигнал[n] ?? 0;
      out[n] = -вход + задержано;
      буфер[i] = вход + задержано * 0.5;
      i = (i + 1) % d;
    }
    сигнал = out;
  }
  return сигнал;
}

/** Розовый шум (фильтр Пола Келлета) единичной мощности. */
function розовый(длина: number, случ: () => number): Float32Array {
  const out = new Float32Array(длина);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let n = 0; n < длина; n += 1) {
    const w = случ() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[n] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  const e = энергия(out);
  if (e > 0) for (let n = 0; n < длина; n += 1) out[n] = (out[n] ?? 0) / Math.sqrt(e);
  return out;
}

/** Бормотание зала: речь задом наперёд, шесть голосов со сдвигами, единичной мощности. */
function бормотание(речь: Float32Array, случ: () => number): Float32Array {
  const out = new Float32Array(речь.length);
  for (let голос = 0; голос < 6; голос += 1) {
    const сдвиг = Math.floor(случ() * речь.length);
    for (let n = 0; n < речь.length; n += 1) {
      const от = речь.length - 1 - ((n + сдвиг) % речь.length);
      out[n] = (out[n] ?? 0) + (речь[от] ?? 0);
    }
  }
  const e = энергия(out);
  if (e > 0) for (let n = 0; n < out.length; n += 1) out[n] = (out[n] ?? 0) / Math.sqrt(e);
  return out;
}

export function degrade(clean: Float32Array, sampleRate: number, options: RoomOptions): Float32Array {
  const случ = зерно(options.seed);
  const мокрый = reverb(clean, sampleRate, options.rt60);
  // Прямой к отражённому — по мощности.
  const eСух = энергия(clean);
  const eМокр = энергия(мокрый);
  // rt60 = 0 — без гула вовсе.
  const kМокр = options.rt60 > 0 && eМокр > 0 ? Math.sqrt(eСух / eМокр / Math.pow(10, options.drrDb / 10)) : 0;
  const зал = new Float32Array(clean.length);
  for (let n = 0; n < clean.length; n += 1) зал[n] = (clean[n] ?? 0) + (мокрый[n] ?? 0) * kМокр;

  const eРечи = энергия(зал);
  const шумМощность = Number.isFinite(options.snrDb) ? eРечи / Math.pow(10, options.snrDb / 10) : 0;
  const бор = бормотание(clean, случ);
  const роз = розовый(clean.length, случ);
  const доляБор = Math.max(0, Math.min(1, options.babble ?? 0.5));
  const kБор = Math.sqrt(шумМощность * доляБор);
  const kРоз = Math.sqrt(шумМощность * (1 - доляБор));

  const усиление = Math.pow(10, options.gainDb / 20);
  const out = new Float32Array(clean.length);
  for (let n = 0; n < clean.length; n += 1) {
    const v = ((зал[n] ?? 0) + (бор[n] ?? 0) * kБор + (роз[n] ?? 0) * kРоз) * усиление;
    out[n] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

/** Слова для сравнения: без огласовок иврита, знаков и регистра. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[֑-ׇ]/gu, '')
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

/** Доля ошибок по словам (WER): замены, вставки и пропуски к длине образца. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = wordsOf(reference);
  const h = wordsOf(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  let prev = new Uint32Array(h.length + 1);
  let cur = new Uint32Array(h.length + 1);
  for (let j = 0; j <= h.length; j += 1) prev[j] = j;
  for (let i = 1; i <= r.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= h.length; j += 1) {
      const замена = (prev[j - 1] ?? 0) + (r[i - 1] === h[j - 1] ? 0 : 1);
      cur[j] = Math.min(замена, (prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return (prev[h.length] ?? 0) / r.length;
}
