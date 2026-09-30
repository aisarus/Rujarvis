/**
 * Звук лекции: где резать и что в куске слышно.
 *
 * Лекция пишется сплошной записью, а распознаётся кусками до 28 секунд —
 * столько влезает в окно Whisper. Резать вслепую по часам нельзя: слово на
 * стыке рвётся пополам, и обе половины распознаются мусором. Режем в самой
 * тихой точке последних секунд куска — там, где лектор перевёл дух.
 *
 * Здесь же — признаки качества куска. Их считает звук, а не текст: уровень,
 * шумовой пол и доля кадров, где кто-то говорит. По ним видно и то, что
 * лектора не слышно, и то, что распознавать тишину незачем — на тишине Whisper
 * выдумывает субтитры.
 */

/** Кадр, по которому меряется громкость. */
const КАДР_МС = 100;

/** RMS кадров по `КАДР_МС`. */
export function frameRms(samples: Float32Array, sampleRate: number, frameMs = КАДР_МС): Float32Array {
  const кадр = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const кадров = Math.floor(samples.length / кадр);
  const out = new Float32Array(кадров);
  for (let к = 0; к < кадров; к += 1) {
    let сумма = 0;
    const от = к * кадр;
    for (let i = от; i < от + кадр; i += 1) {
      const s = samples[i] ?? 0;
      сумма += s * s;
    }
    out[к] = Math.sqrt(сумма / кадр);
  }
  return out;
}

export interface CutOptions {
  /** Раньше этого не режем. */
  minSec: number;
  /** Дальше этого — режем обязательно. */
  maxSec: number;
}

export const LIVE_CUT: CutOptions = { minSec: 20, maxSec: 28 };

/**
 * Где закончить кусок: самый тихий кадр между `minSec` и `maxSec`, считая
 * от начала `samples`. Меньше `maxSec` звука — резать рано (null).
 *
 * Из равно тихих берётся последний: кусок длиннее — меньше стыков.
 */
export function cutAtPause(samples: Float32Array, sampleRate: number, options: CutOptions = LIVE_CUT): number | null {
  const макс = Math.floor(options.maxSec * sampleRate);
  if (samples.length < макс) return null;
  const кадр = Math.max(1, Math.round((sampleRate * КАДР_МС) / 1000));
  const мин = Math.floor(options.minSec * sampleRate);
  let лучший = макс;
  let тише = Infinity;
  for (let от = мин; от + кадр <= макс; от += кадр) {
    let сумма = 0;
    for (let i = от; i < от + кадр; i += 1) {
      const s = samples[i] ?? 0;
      сумма += s * s;
    }
    const rms = Math.sqrt(сумма / кадр);
    if (rms <= тише) {
      тише = rms;
      // Середина тихого кадра: и хвост слова до, и начало после — целы.
      лучший = от + Math.floor(кадр / 2);
    }
  }
  return лучший;
}

/** Вся запись — куски от паузы до паузы: [начало, конец) в отсчётах. */
export function splitAtPauses(samples: Float32Array, sampleRate: number, options: CutOptions = LIVE_CUT): Array<[number, number]> {
  const куски: Array<[number, number]> = [];
  let от = 0;
  while (от < samples.length) {
    const срез = cutAtPause(samples.subarray(от), sampleRate, options);
    // Нулевой срез зациклил бы деление — хотя бы один отсчёт.
    const до = срез === null ? samples.length : от + Math.max(1, срез);
    куски.push([от, до]);
    от = до;
  }
  return куски;
}

export interface ChunkLevel {
  /** Громкость речи: RMS громких кадров (верхняя десятая часть), дБ от полной шкалы. */
  speechDb: number;
  /** Шумовой пол: RMS тихих кадров (нижняя десятая часть), дБ. */
  floorDb: number;
  /** Доля кадров заметно громче пола — кто-то говорит. */
  speechShare: number;
}

function дб(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

function квантиль(отсортированные: Float32Array, доля: number): number {
  if (отсортированные.length === 0) return 0;
  const i = Math.min(отсортированные.length - 1, Math.max(0, Math.floor(доля * (отсортированные.length - 1))));
  return отсортированные[i] ?? 0;
}

/** Порог речи над полом: вдвое громче тишины — уже голос, а не вентилятор. */
const РЕЧЬ_НАД_ПОЛОМ = 2;
/** И не тише этого вовсе: цифровой ноль или выключенный микрофон — не речь. */
const АБСОЛЮТНЫЙ_ПОРОГ = 0.0015;

export function chunkLevel(samples: Float32Array, sampleRate: number): ChunkLevel {
  const кадры = frameRms(samples, sampleRate);
  if (кадры.length === 0) return { speechDb: -120, floorDb: -120, speechShare: 0 };
  const по = Float32Array.from(кадры).sort();
  const пол = квантиль(по, 0.1);
  const речь = квантиль(по, 0.9);
  const порог = Math.max(АБСОЛЮТНЫЙ_ПОРОГ, пол * РЕЧЬ_НАД_ПОЛОМ);
  let громких = 0;
  for (const к of кадры) if (к > порог) громких += 1;
  return { speechDb: дб(речь), floorDb: дб(пол), speechShare: громких / кадры.length };
}
