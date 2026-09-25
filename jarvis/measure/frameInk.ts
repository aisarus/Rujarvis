/**
 * Линейка по самим пикселям: сколько кадра занято работой.
 *
 * Перенесено из Aegis (`operator/src/frame-ink.js`) почти дословно — вместе с
 * объяснениями, потому что каждое из них след конкретного провала.
 *
 * ## Зачем это Джарвису
 *
 * Чтобы отличать сделанное от заявленного. Сегодня он сообщал «открыл блендер»
 * при закрытом окне и «готово» при пустом файле — и заметить это мог только
 * человек, посмотрев на экран. Снимок, у которого чернил ноль, — это чёрный
 * экран, пустая страница или окно, которое не открылось, и сказать об этом
 * можно без всякой модели.
 *
 * ## Что считается работой
 *
 * Кадр режется на клетки. Клетка занята, если внутри неё есть ПЕРЕПАД: край,
 * буква, граница фигуры, зерно фотографии. Ровная заливка и плавный градиент за
 * работу не считаются нарочно — экран загрузки обычно и есть ровный фон с парой
 * слов, а сильная работа так или иначе оставляет в кадре края.
 *
 * В Aegis сперва была вторая проверка: «клетка заметно отличается от общего
 * цвета кадра». Её убрал собственный тест — на плавном градиенте она дала 65%,
 * потому что у градиента общего цвета нет вовсе. Плата за простоту известна и
 * принята: сплошная плашка считается только своими краями, а не всей площадью.
 * Для вопроса «есть ли в кадре что смотреть» этого довольно, а лишний рычаг,
 * который врёт на градиенте, хуже отсутствующего.
 *
 * Это не суждение о вкусе. Это ответ на один вопрос: есть ли в кадре что
 * смотреть.
 */

import zlib from 'node:zlib';

import { cannotMeasure, failed, passed, type Gate } from './gate';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CELL = 8;
/**
 * Перепад внутри клетки, после которого в ней что-то нарисовано.
 *
 * Порог низкий нарочно: тонкая светло-серая типографика на белом даёт около
 * тридцати.
 */
const EDGE = 24;

export interface Frame {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

export interface Ink {
  /** Доля занятых клеток, 0..1. */
  share: number;
  width: number;
  height: number;
  cells: number;
  filled: number;
}

/**
 * Разобрать PNG в пиксели.
 *
 * Не наш случай — `null`: мерить нечем, а не ноль. Разница принципиальная и
 * ровно та, ради которой существуют трёхзначные ворота.
 */
export function decodePng(bytes: Buffer): Frame | null {
  if (!Buffer.isBuffer(bytes) || bytes.length < 33) return null;
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) return null;

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const depth = bytes[24];
  const colour = bytes[25];
  const interlaced = bytes[28];

  // Берём только то, что сами снимаем: восемь бит, RGB или RGBA, без
  // чересстрочности. Остальное честнее не мерить, чем померить неправильно.
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlaced !== 0) return null;
  if (width <= 0 || height <= 0) return null;
  const channels = colour === 6 ? 4 : 3;

  const chunks: Buffer[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const name = bytes.toString('latin1', at + 4, at + 8);
    if (name === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + length));
    if (name === 'IEND') break;
    at += length + 12;
  }
  if (chunks.length === 0) return null;

  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(chunks));
  } catch {
    return null;
  }

  const inRow = width * channels;
  if (raw.length < (inRow + 1) * height) return null;

  // Снятие фильтров. Каждая строка PNG начинается байтом способа, и способ
  // ссылается на уже восстановленную строку выше — поэтому только по порядку.
  const pixels = Buffer.allocUnsafe(inRow * height);
  for (let y = 0; y < height; y += 1) {
    const method = raw[y * (inRow + 1)];
    const from = y * (inRow + 1) + 1;
    const to = y * inRow;
    for (let x = 0; x < inRow; x += 1) {
      const byte = raw[from + x] as number;
      const a = x >= channels ? (pixels[to + x - channels] as number) : 0;
      const b = y > 0 ? (pixels[to - inRow + x] as number) : 0;
      const c = x >= channels && y > 0 ? (pixels[to - inRow + x - channels] as number) : 0;

      let value: number;
      switch (method) {
        case 0:
          value = byte;
          break;
        case 1:
          value = byte + a;
          break;
        case 2:
          value = byte + b;
          break;
        case 3:
          value = byte + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = byte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          // Неизвестный способ фильтрации: дальше пойдёт мусор, и лучше
          // сказать «нечем мерить», чем посчитать его чернилами.
          return null;
      }
      pixels[to + x] = value & 0xff;
    }
  }

  return { width, height, channels, pixels };
}

/**
 * Доля кадра, в которой есть что смотреть.
 *
 * `null` — мерить нечем: файл не PNG, не тот формат, битый.
 */
export function frameInk(
  bytes: Buffer,
  options: { cell?: number; edge?: number } = {},
): Ink | null {
  const cell = options.cell ?? CELL;
  const edge = options.edge ?? EDGE;

  const frame = decodePng(bytes);
  if (!frame) return null;

  const { width, height, channels, pixels } = frame;
  let cells = 0;
  let filled = 0;

  for (let y0 = 0; y0 < height; y0 += cell) {
    for (let x0 = 0; x0 < width; x0 += cell) {
      cells += 1;
      let minR = 255;
      let maxR = 0;
      let minG = 255;
      let maxG = 0;
      let minB = 255;
      let maxB = 0;
      let points = 0;

      const toY = Math.min(y0 + cell, height);
      const toX = Math.min(x0 + cell, width);
      for (let y = y0; y < toY; y += 1) {
        for (let x = x0; x < toX; x += 1) {
          const at = y * width * channels + x * channels;
          const r = pixels[at] as number;
          const g = pixels[at + 1] as number;
          const b = pixels[at + 2] as number;
          if (r < minR) minR = r;
          if (r > maxR) maxR = r;
          if (g < minG) minG = g;
          if (g > maxG) maxG = g;
          if (b < minB) minB = b;
          if (b > maxB) maxB = b;
          points += 1;
        }
      }
      if (points === 0) continue;

      const spread = Math.max(maxR - minR, maxG - minG, maxB - minB);
      if (spread >= edge) filled += 1;
    }
  }

  if (cells === 0) return null;
  return {
    share: Number((filled / cells).toFixed(3)),
    width,
    height,
    cells,
    filled,
  };
}

/**
 * Подпись кадра: средняя яркость по клеткам.
 *
 * Побайтовое сравнение снимков не годится: у живой страницы дрожит курсор,
 * мигает каретка, крутится спиннер — и два одинаковых по сути кадра выходят
 * разными. А прибор запаса спрашивает именно про суть: показала страница
 * что-то новое или то же самое.
 *
 * Числа, а не буквы. Первая попытка огрубляла яркость до шестнадцати ступеней,
 * и собственный тест её похоронил дважды: `% 16` свернул белое в чёрное
 * (`round(255/16)` это 16, а 16 % 16 — ноль), а один чёрный пиксель на клетку
 * перевалил границу округления и сделал неподвижный кадр «другим». Порог,
 * спрятанный в квантовании, — плохой порог; он должен быть виден и назван.
 *
 * `null` — мерить нечем.
 */
export function frameSignature(bytes: Buffer, cell = 32): number[] | null {
  const frame = decodePng(bytes);
  if (!frame) return null;

  const { width, height, channels, pixels } = frame;
  const marks: number[] = [];

  for (let y0 = 0; y0 < height; y0 += cell) {
    for (let x0 = 0; x0 < width; x0 += cell) {
      let sum = 0;
      let points = 0;
      const toY = Math.min(y0 + cell, height);
      const toX = Math.min(x0 + cell, width);
      for (let y = y0; y < toY; y += 1) {
        for (let x = x0; x < toX; x += 1) {
          const at = y * width * channels + x * channels;
          sum +=
            ((pixels[at] as number) +
              (pixels[at + 1] as number) +
              (pixels[at + 2] as number)) /
            3;
          points += 1;
        }
      }
      marks.push(points === 0 ? 0 : sum / points);
    }
  }

  return marks;
}

/**
 * Один ли это кадр.
 *
 * Пороги названы прямо, а не спрятаны в округлении. `tolerance` — насколько
 * клетка может потемнеть или посветлеть, оставаясь той же (дрожь курсора,
 * мигание каретки). `share` — какая доля клеток может измениться, прежде чем
 * кадр считается новым.
 *
 * `null` — мерить нечем: хотя бы один снимок не разобрался. Отвечать «разные»
 * в этом случае было бы ложью в пользу работы: заставка прошла бы за вещь.
 */
export function sameFrame(
  left: Buffer,
  right: Buffer,
  options: { tolerance?: number; share?: number } = {},
): boolean | null {
  const tolerance = options.tolerance ?? 8;
  const share = options.share ?? 0.02;

  const a = frameSignature(left);
  const b = frameSignature(right);
  if (a === null || b === null) return null;
  if (a.length !== b.length || a.length === 0) return null;

  let moved = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs((a[i] as number) - (b[i] as number)) > tolerance) moved += 1;
  }

  return moved / a.length <= share;
}

/**
 * Ворота по чернилам: не пустой ли кадр.
 *
 * Отдельно от замера нарочно. Замер отвечает «сколько», ворота — «годится ли»,
 * и порог годности зависит от того, кто спрашивает.
 *
 * ## Откуда порог
 *
 * Замер на том, что Джарвис сделал за сегодня:
 *
 *     1%   1920x1080  Зелёная сфера.png
 *     2%   1920x1080  Красная сфера.png
 *     5%   1100x1100  Мультяшная сфера.png
 *     4%   1400x1400  Ракета в стиле Бруно Симон.png
 *
 * Первая попытка взяла порогом 2%, и он забраковал бы честно сделанную сферу:
 * один предмет на ровном фоне занимает мало, и это не поломка, а такой кадр.
 * Поэтому по умолчанию порог отвечает только на вопрос «кадр вообще пустой?» —
 * чёрный экран, белая страница, окно, которое не открылось. Тот, кто хочет
 * спросить строже, называет своё число: у веб-страницы оно совсем другое.
 *
 * ## Чего эти ворота НЕ умеют
 *
 * Сказать, что на снимке не та программа. Сегодняшнее ложное «открыл блендер»
 * показывало рабочий стол — со значками и панелью задач, то есть чернил там
 * было вдоволь. Против такого нужен не этот прибор, а список окон.
 */
export function inkGate(bytes: Buffer, least = 0.005): Gate {
  const ink = frameInk(bytes);
  if (!ink) return cannotMeasure('снимок не разобрался: не PNG или не тот формат');
  if (ink.share < least) {
    return failed(
      `в кадре почти ничего нет: занято ${Math.round(ink.share * 100)}% клеток из ${ink.cells}`,
    );
  }
  return passed(`занято ${Math.round(ink.share * 100)}% кадра`);
}
