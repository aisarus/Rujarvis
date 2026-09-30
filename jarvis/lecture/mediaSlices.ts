/**
 * Длинный файл лекции — кусками по несколько минут, а не целиком.
 *
 * Chromium раскрывает файл одним вызовом (`decodeAudioData`) и держит в
 * памяти весь звук на родной частоте: замер 30.09.2026 — полуторачасовой m4a
 * с телефона занял 4,7 ГБ, видео курса — 3 ГБ. На ноутбуке с 16 ГБ, где
 * свободно пять, это своп и замерший компьютер.
 *
 * Поэтому самые частые форматы режутся здесь, без чужих программ:
 *
 * - **MP4, M4A, MOV** — запись телефона и видео курса. Из контейнера
 *   достаётся звуковая дорожка AAC (таблицы `stsz`/`stco`/`stsc`), кадры
 *   собираются в поток ADTS, и Chromium раскрывает его по кускам.
 * - **AAC** (ADTS) — режется по кадрам как есть.
 * - **MP3** — режется по кадрам: каждый кадр начинается синхрословом.
 *
 * Остальное (ogg, opus, webm, flac) раскрывается целиком: реже встречается,
 * а разбирать каждый контейнер — не та цена.
 */

import { open, stat, type FileHandle } from 'node:fs/promises';

/** Сколько секунд звука в одном куске. */
export const SLICE_SECONDS = 300;

export interface MediaSlices {
  /** Всего секунд звука, если известно заранее. */
  seconds?: number;
  count: number;
  /** Кусок `i` — готовый к `decodeAudioData` поток байт. */
  read(i: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

// ——— MP4 ———

interface Коробка {
  тип: string;
  начало: number;
  тело: number;
  конец: number;
}

function коробки(буфер: Buffer, от: number, до: number): Коробка[] {
  const out: Коробка[] = [];
  let at = от;
  while (at + 8 <= до) {
    let размер = буфер.readUInt32BE(at);
    const тип = буфер.toString('latin1', at + 4, at + 8);
    let тело = at + 8;
    if (размер === 1) {
      размер = Number(буфер.readBigUInt64BE(at + 8));
      тело = at + 16;
    } else if (размер === 0) {
      размер = до - at;
    }
    if (размер < 8 || at + размер > до) break;
    out.push({ тип, начало: at, тело, конец: at + размер });
    at += размер;
  }
  return out;
}

function найти(буфер: Buffer, внутри: Коробка, путь: string[]): Коробка | null {
  let текущая: Коробка | null = внутри;
  for (const тип of путь) {
    if (!текущая) return null;
    текущая = коробки(буфер, текущая.тело, текущая.конец).find((к) => к.тип === тип) ?? null;
  }
  return текущая;
}

/** Длина дескриптора MPEG-4: до четырёх байт по семь бит. */
function длинаДескриптора(буфер: Buffer, at: number): { длина: number; после: number } {
  let длина = 0;
  let i = at;
  for (let k = 0; k < 4; k += 1) {
    const b = буфер[i] ?? 0;
    i += 1;
    длина = (длина << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) break;
  }
  return { длина, после: i };
}

export interface AacConfig {
  /** Тип объекта AAC: 2 — AAC-LC. */
  objectType: number;
  /** Индекс частоты по таблице MPEG-4. */
  frequencyIndex: number;
  channels: number;
}

/** AudioSpecificConfig из коробки `esds`. */
export function aacConfigFromEsds(буфер: Buffer, от: number, до: number): AacConfig | null {
  // Полная версия и флаги коробки — 4 байта.
  let i = от + 4;
  while (i < до) {
    const тег = буфер[i] ?? 0;
    const { длина, после } = длинаДескриптора(буфер, i + 1);
    if (тег === 0x03) {
      // ES_ID (2) и флаги (1), за флагами — необязательные поля.
      const флаги = буфер[после + 2] ?? 0;
      i = после + 3 + (флаги & 0x80 ? 2 : 0) + (флаги & 0x40 ? 1 + (буфер[после + 3] ?? 0) : 0) + (флаги & 0x20 ? 2 : 0);
      continue;
    }
    if (тег === 0x04) {
      // objectTypeIndication, streamType, bufferSize, max/avg bitrate — 13 байт.
      i = после + 13;
      continue;
    }
    if (тег === 0x05) {
      if (длина < 2) return null;
      const b0 = буфер[после] ?? 0;
      const b1 = буфер[после + 1] ?? 0;
      return { objectType: b0 >> 3, frequencyIndex: ((b0 & 0x07) << 1) | (b1 >> 7), channels: (b1 >> 3) & 0x0f };
    }
    i = после + длина;
  }
  return null;
}

/** Заголовок ADTS на кадр AAC — так Chromium узнаёт поток без контейнера. */
export function adtsHeader(config: AacConfig, длинаКадра: number): Buffer {
  const всего = длинаКадра + 7;
  const h = Buffer.alloc(7);
  h[0] = 0xff;
  h[1] = 0xf1;
  h[2] = (((config.objectType - 1) & 0x03) << 6) | ((config.frequencyIndex & 0x0f) << 2) | ((config.channels >> 2) & 0x01);
  h[3] = ((config.channels & 0x03) << 6) | ((всего >> 11) & 0x03);
  h[4] = (всего >> 3) & 0xff;
  h[5] = ((всего & 0x07) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

const ЧАСТОТЫ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

interface Дорожка {
  config: AacConfig;
  timescale: number;
  длительность: number;
  /** Где каждый кадр в файле и какого размера. */
  смещения: number[];
  размеры: number[];
}

/** Звуковая дорожка AAC из `moov`; другой кодек или нет звука — null. */
export function aacTrackFromMoov(буфер: Buffer): Дорожка | null {
  const moov: Коробка = { тип: 'moov', начало: 0, тело: 8, конец: буфер.length };
  for (const trak of коробки(буфер, moov.тело, moov.конец).filter((к) => к.тип === 'trak')) {
    const hdlr = найти(буфер, trak, ['mdia', 'hdlr']);
    if (!hdlr || буфер.toString('latin1', hdlr.тело + 8, hdlr.тело + 12) !== 'soun') continue;
    const mdhd = найти(буфер, trak, ['mdia', 'mdhd']);
    const stbl = найти(буфер, trak, ['mdia', 'minf', 'stbl']);
    if (!mdhd || !stbl) continue;
    const версия = буфер[mdhd.тело] ?? 0;
    const timescale = версия === 1 ? буфер.readUInt32BE(mdhd.тело + 20) : буфер.readUInt32BE(mdhd.тело + 12);
    const длительность = версия === 1 ? Number(буфер.readBigUInt64BE(mdhd.тело + 24)) : буфер.readUInt32BE(mdhd.тело + 16);

    const stsd = найти(буфер, stbl, ['stsd']);
    if (!stsd) continue;
    // stsd: версия+флаги (4), число записей (4), дальше запись mp4a.
    const mp4a = коробки(буфер, stsd.тело + 8, stsd.конец)[0];
    if (!mp4a || mp4a.тип !== 'mp4a') return null;
    // AudioSampleEntry: 28 байт полей, дальше вложенные коробки (esds). У
    // QuickTime (mov) версии 1 и 2 полей больше — на 16 и 36 байт.
    const esds = [28, 44, 64]
      .map((поля) => коробки(буфер, mp4a.тело + поля, mp4a.конец).find((к) => к.тип === 'esds'))
      .find(Boolean);
    const config = esds ? aacConfigFromEsds(буфер, esds.тело, esds.конец) : null;
    // Только AAC-LC с частотой из таблицы: у HE-AAC и явной частоты ADTS
    // другой, и такой файл раскрывается целиком.
    if (!config || config.objectType !== 2 || config.frequencyIndex >= ЧАСТОТЫ.length) return null;

    const stsz = найти(буфер, stbl, ['stsz']);
    const stsc = найти(буфер, stbl, ['stsc']);
    const stco = найти(буфер, stbl, ['stco']) ?? найти(буфер, stbl, ['co64']);
    if (!stsz || !stsc || !stco) return null;

    const общийРазмер = буфер.readUInt32BE(stsz.тело + 4);
    const кадров = буфер.readUInt32BE(stsz.тело + 8);
    const размеры: number[] = [];
    for (let k = 0; k < кадров; k += 1) размеры.push(общийРазмер || буфер.readUInt32BE(stsz.тело + 12 + k * 4));

    const широкие = stco.тип === 'co64';
    const кусков = буфер.readUInt32BE(stco.тело + 4);
    const началаКусков: number[] = [];
    for (let k = 0; k < кусков; k += 1) {
      началаКусков.push(широкие ? Number(буфер.readBigUInt64BE(stco.тело + 8 + k * 8)) : буфер.readUInt32BE(stco.тело + 8 + k * 4));
    }

    const записей = буфер.readUInt32BE(stsc.тело + 4);
    const правила: Array<{ первый: number; кадров: number }> = [];
    for (let k = 0; k < записей; k += 1) {
      правила.push({ первый: буфер.readUInt32BE(stsc.тело + 8 + k * 12), кадров: буфер.readUInt32BE(stsc.тело + 12 + k * 12) });
    }

    const смещения: number[] = [];
    let кадр = 0;
    for (let кусок = 0; кусок < кусков && кадр < кадров; кусок += 1) {
      const номер = кусок + 1;
      let правило = правила[0];
      for (const п of правила) if (п.первый <= номер) правило = п;
      let at = началаКусков[кусок] ?? 0;
      for (let k = 0; k < (правило?.кадров ?? 0) && кадр < кадров; k += 1) {
        смещения.push(at);
        at += размеры[кадр] ?? 0;
        кадр += 1;
      }
    }
    if (смещения.length !== кадров) return null;
    return { config, timescale, длительность, смещения, размеры };
  }
  return null;
}

async function читать(fh: FileHandle, от: number, длина: number): Promise<Buffer> {
  const буфер = Buffer.alloc(длина);
  let прочитано = 0;
  while (прочитано < длина) {
    const { bytesRead } = await fh.read(буфер, прочитано, длина - прочитано, от + прочитано);
    if (bytesRead === 0) break;
    прочитано += bytesRead;
  }
  return прочитано === длина ? буфер : буфер.subarray(0, прочитано);
}

/** Где в файле коробка `moov` — ищется по верхнему уровню, не читая мегабайты данных. */
async function найтиMoov(fh: FileHandle, размерФайла: number): Promise<Buffer | null> {
  let at = 0;
  while (at + 8 <= размерФайла) {
    const заголовок = await читать(fh, at, 16);
    let размер = заголовок.readUInt32BE(0);
    const тип = заголовок.toString('latin1', 4, 8);
    if (размер === 1) размер = Number(заголовок.readBigUInt64BE(8));
    else if (размер === 0) размер = размерФайла - at;
    if (размер < 8) return null;
    if (тип === 'moov') return читать(fh, at, размер);
    at += размер;
  }
  return null;
}

async function mp4Slices(file: string, seconds: number): Promise<MediaSlices | null> {
  const fh = await open(file, 'r');
  try {
    const moov = await найтиMoov(fh, (await fh.stat()).size);
    const дорожка = moov ? aacTrackFromMoov(moov) : null;
    if (!дорожка) {
      await fh.close();
      return null;
    }
    const частота = ЧАСТОТЫ[дорожка.config.frequencyIndex] ?? 44_100;
    // Кадр AAC-LC — 1024 отсчёта.
    const кадровНаКусок = Math.max(1, Math.round((seconds * частота) / 1024));
    const count = Math.ceil(дорожка.смещения.length / кадровНаКусок);
    return {
      seconds: дорожка.длительность / дорожка.timescale,
      count,
      async read(i) {
        const от = i * кадровНаКусок;
        const до = Math.min(дорожка.смещения.length, от + кадровНаКусок);
        const части: Buffer[] = [];
        // Кадры внутри куска контейнера лежат подряд — читаем их одним вызовом.
        let k = от;
        while (k < до) {
          let конецПодряд = k + 1;
          while (
            конецПодряд < до &&
            (дорожка.смещения[конецПодряд] ?? 0) === (дорожка.смещения[конецПодряд - 1] ?? 0) + (дорожка.размеры[конецПодряд - 1] ?? 0)
          ) {
            конецПодряд += 1;
          }
          const начало = дорожка.смещения[k] ?? 0;
          const сплошь = await читать(fh, начало, (дорожка.смещения[конецПодряд - 1] ?? 0) + (дорожка.размеры[конецПодряд - 1] ?? 0) - начало);
          let at = 0;
          for (let j = k; j < конецПодряд; j += 1) {
            const размер = дорожка.размеры[j] ?? 0;
            части.push(adtsHeader(дорожка.config, размер), сплошь.subarray(at, at + размер));
            at += размер;
          }
          k = конецПодряд;
        }
        return Buffer.concat(части);
      },
      close: () => fh.close(),
    };
  } catch (error) {
    await fh.close().catch(() => undefined);
    throw error;
  }
}

// ——— MP3 и ADTS: режем по кадрам ———

/** Начало кадра MP3 или ADTS не раньше `от`: синхрослово и правдоподобный заголовок. */
export function nextFrameStart(буфер: Uint8Array, от: number, вид: 'mp3' | 'adts'): number {
  for (let i = Math.max(0, от); i + 4 < буфер.length; i += 1) {
    if (буфер[i] !== 0xff) continue;
    const b1 = буфер[i + 1] ?? 0;
    if (вид === 'adts') {
      if ((b1 & 0xf6) === 0xf0) return i;
      continue;
    }
    // MP3: 11 бит синхро, версия не «зарезервирована», слой не 00, битрейт не 1111, частота не 11.
    const b2 = буфер[i + 2] ?? 0;
    if ((b1 & 0xe0) === 0xe0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0 && (b2 & 0xf0) !== 0xf0 && (b2 & 0x0c) !== 0x0c) return i;
  }
  return буфер.length;
}

async function frameSlices(file: string, вид: 'mp3' | 'adts', seconds: number): Promise<MediaSlices> {
  const fh = await open(file, 'r');
  const размер = (await fh.stat()).size;
  // Длительность заранее не известна (переменный битрейт): режем по байтам,
  // считая 128 кбит/с, — кусок выходит минуты на две-пять, и этого хватает.
  const байтНаКусок = Math.max(256 * 1024, Math.round((seconds * 128_000) / 8));
  const count = Math.max(1, Math.ceil(размер / байтНаКусок));
  const ЗАПАС = 8192;
  const начало = async (i: number): Promise<number> => {
    if (i === 0) return 0;
    if (i >= count) return размер;
    const от = i * байтНаКусок;
    const окно = await читать(fh, от, Math.min(ЗАПАС * 8, размер - от));
    return от + nextFrameStart(окно, 0, вид);
  };
  return {
    count,
    async read(i) {
      const от = await начало(i);
      const до = await начало(i + 1);
      return читать(fh, от, до - от);
    },
    close: () => fh.close(),
  };
}

// ——— WAV: читаем сами, по кускам ———

/**
 * WAV по кускам: 16 бит или 32 бита с плавающей точкой, любое число каналов —
 * в один канал на родной частоте. Запись с диктофона на полтора часа — это
 * гигабайт, и целиком в память ей незачем.
 */
export async function readWavParts(
  file: string,
  onPart: (samples: Float32Array, sampleRate: number) => void,
  seconds = SLICE_SECONDS,
  между?: () => Promise<void>,
): Promise<number> {
  const fh = await open(file, 'r');
  try {
    const размерФайла = (await fh.stat()).size;
    const голова = await читать(fh, 0, 12);
    if (голова.toString('ascii', 0, 4) !== 'RIFF' || голова.toString('ascii', 8, 12) !== 'WAVE') throw new Error('это не WAV');
    let формат = 1;
    let каналов = 1;
    let частота = 16_000;
    let бит = 16;
    let at = 12;
    while (at + 8 <= размерФайла) {
      const заголовок = await читать(fh, at, 8);
      const id = заголовок.toString('ascii', 0, 4);
      // Размер данных у недописанной записи бывает нулём — тогда до конца файла.
      let размер = заголовок.readUInt32LE(4);
      if (id === 'fmt ') {
        const fmt = await читать(fh, at + 8, Math.min(размер, 40));
        формат = fmt.readUInt16LE(0);
        каналов = fmt.readUInt16LE(2);
        частота = fmt.readUInt32LE(4);
        бит = fmt.readUInt16LE(14);
        if (формат === 0xfffe && fmt.length >= 26) формат = fmt.readUInt16LE(24);
      } else if (id === 'data') {
        if (размер === 0 || at + 8 + размер > размерФайла) размер = размерФайла - at - 8;
        const байтНаОтсчёт = (бит / 8) * каналов;
        const кадровНаКусок = Math.max(1, Math.round(seconds * частота));
        let всего = 0;
        for (let от = 0; от < размер; от += кадровНаКусок * байтНаОтсчёт) {
          const сырые = await читать(fh, at + 8 + от, Math.min(кадровНаКусок * байтНаОтсчёт, размер - от));
          const кадров = Math.floor(сырые.length / байтНаОтсчёт);
          const out = new Float32Array(кадров);
          for (let k = 0; k < кадров; k += 1) {
            let сумма = 0;
            for (let c = 0; c < каналов; c += 1) {
              const i = k * байтНаОтсчёт + c * (бит / 8);
              сумма +=
                формат === 3 && бит === 32
                  ? сырые.readFloatLE(i)
                  : бит === 16
                    ? сырые.readInt16LE(i) / 32768
                    : бит === 24
                      ? сырые.readIntLE(i, 3) / 8388608
                      : бит === 32
                        ? сырые.readInt32LE(i) / 2147483648
                        : ((сырые[i] ?? 128) - 128) / 128;
            }
            out[k] = сумма / каналов;
          }
          всего += кадров;
          onPart(out, частота);
          await между?.();
        }
        return всего / частота;
      }
      at += 8 + размер + (размер % 2);
    }
    throw new Error('в WAV нет данных');
  } finally {
    await fh.close();
  }
}

/**
 * Файл → куски для раскрытия. Формат не режется — null: раскрывать целиком.
 */
export async function mediaSlices(file: string, seconds = SLICE_SECONDS): Promise<MediaSlices | null> {
  const расширение = file.toLowerCase().split('.').pop() ?? '';
  if (['mp4', 'm4a', 'mov', 'm4v'].includes(расширение)) return mp4Slices(file, seconds);
  if (расширение === 'mp3') return frameSlices(file, 'mp3', seconds);
  if (расширение === 'aac') return frameSlices(file, 'adts', seconds);
  await stat(file);
  return null;
}
