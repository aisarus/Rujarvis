import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { decodePng, frameInk, frameSignature, inkGate, sameFrame } from './frameInk';
import { isFailure, isPassed, isUnknown } from './gate';

/**
 * Сборка настоящего PNG прямо в тесте.
 *
 * Не заготовка на диске: файл-образец молча устаревает, и тест начинает
 * проверять не то, что думает. Здесь видно каждый байт, из которого картинка
 * состоит, — и видно, почему прибор отвечает именно так.
 *
 * Контрольные суммы не считаются: разборщик их не проверяет, а считать их
 * ради теста значило бы писать второй разборщик.
 */
function makePng(
  width: number,
  height: number,
  colour: (x: number, y: number) => [number, number, number],
  способ = 0,
): Buffer {
  const chunk = (name: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(name, 'latin1'), data, Buffer.alloc(4)]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // восемь бит на канал
  header[9] = 2; // RGB
  header[10] = 0;
  header[11] = 0;
  header[12] = 0; // без чересстрочности

  // Сначала сырые пиксели построчно, потом — фильтрация тем же способом,
  // каким её снимает разборщик. Кодирование фильтра — обратная операция, и
  // второй разборщик ради этого писать не нужно.
  const шаг = width * 3;
  const строки: number[][] = [];
  for (let y = 0; y < height; y += 1) {
    const строка: number[] = [];
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colour(x, y);
      строка.push(r, g, b);
    }
    строки.push(строка);
  }

  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
  };

  const raw = Buffer.alloc((шаг + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (шаг + 1);
    raw[row] = способ;
    const текущая = строки[y] as number[];
    const прошлая = (строки[y - 1] ?? []) as number[];
    for (let i = 0; i < шаг; i += 1) {
      const сырой = текущая[i] as number;
      const слева = i >= 3 ? (текущая[i - 3] as number) : 0;
      const сверху = y > 0 ? (прошлая[i] as number) : 0;
      const наискось = y > 0 && i >= 3 ? (прошлая[i - 3] as number) : 0;
      const вычесть =
        способ === 1
          ? слева
          : способ === 2
            ? сверху
            : способ === 3
              ? Math.floor((слева + сверху) / 2)
              : способ === 4
                ? paeth(слева, сверху, наискось)
                : 0;
      raw[row + 1 + i] = (сырой - вычесть) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE = makePng(64, 64, () => [255, 255, 255]);
const BLACK = makePng(64, 64, () => [0, 0, 0]);
/** Шахматка по клеткам меньше восьми: перепад есть в каждой клетке. */
const CHECKER = makePng(64, 64, (x, y) =>
  (x >> 2) % 2 === (y >> 2) % 2 ? [255, 255, 255] : [0, 0, 0],
);
/**
 * Плавный градиент: перепада внутри клетки почти нет.
 *
 * Шаг ровно единица на пиксель — то есть восемь уровней на клетку при пороге
 * двадцать четыре. Первая попытка теста брала шаг четыре и провалилась честно:
 * тридцать два на клетку — это уже край, а не плавность. Настоящий градиент
 * растянут на ширину экрана, а не на шестьдесят четыре пикселя.
 */
const GRADIENT = makePng(64, 64, (x) => [x, x, x]);

describe('decodePng', () => {
  it('разбирает наш собственный PNG', () => {
    const frame = decodePng(WHITE);

    expect(frame).not.toBeNull();
    expect(frame?.width).toBe(64);
    expect(frame?.height).toBe(64);
    expect(frame?.channels).toBe(3);
  });

  it.each([
    ['пустой буфер', Buffer.alloc(0)],
    ['мусор', Buffer.from('это не картинка, а строка текста', 'utf8')],
    ['обрезанный PNG', WHITE.subarray(0, 20)],
  ])('говорит «нечем мерить» про %s', (_name, bytes) => {
    // Не ноль, а null. Ноль означал бы «пустая картинка», а это другое: файл
    // вообще не картинка, и перепутать одно с другим — ровно та ошибка,
    // против которой всё это.
    expect(decodePng(bytes)).toBeNull();
  });
});

describe('frameInk', () => {
  it('на ровной заливке чернил нет', () => {
    // Экран загрузки — это ровный фон с парой слов. Он не должен проходить
    // как работа.
    expect(frameInk(WHITE)?.share).toBe(0);
    expect(frameInk(BLACK)?.share).toBe(0);
  });

  it('на шахматке чернила есть везде', () => {
    expect(frameInk(CHECKER)?.share).toBe(1);
  });

  it('плавный градиент работой не считает', () => {
    // Собственный тест Aegis убрал отсюда вторую проверку: на градиенте она
    // давала 65%, потому что у градиента общего цвета нет вовсе.
    const ink = frameInk(GRADIENT);

    expect(ink).not.toBeNull();
    expect(ink!.share).toBeLessThan(0.1);
  });

  it('считает клетки, а не пиксели', () => {
    const ink = frameInk(CHECKER);

    expect(ink?.cells).toBe(64); // 64×64 при клетке 8
    expect(ink?.filled).toBe(64);
  });

  it('мерить нечем — значит null, а не ноль', () => {
    expect(frameInk(Buffer.from('не картинка'))).toBeNull();
  });
});

describe('frameSignature и sameFrame', () => {
  it('одинаковые кадры считает одинаковыми', () => {
    expect(sameFrame(CHECKER, CHECKER)).toBe(true);
  });

  it('разные кадры различает', () => {
    expect(sameFrame(WHITE, BLACK)).toBe(false);
    expect(sameFrame(WHITE, CHECKER)).toBe(false);
  });

  it('не замечает мелкой дрожи', () => {
    // У живой страницы мигает каретка и дрожит курсор. Два одинаковых по сути
    // кадра не должны считаться разными — иначе заставка пройдёт за вещь.
    const still = makePng(64, 64, () => [120, 120, 120]);
    const blink = makePng(64, 64, (x, y) => (x === 1 && y === 1 ? [0, 0, 0] : [120, 120, 120]));

    expect(sameFrame(still, blink)).toBe(true);
  });

  it('мерить нечем — значит null, а не «разные»', () => {
    // Ответить «разные» на неразобранный снимок значило бы соврать в пользу
    // работы: заставка прошла бы за вещь.
    expect(sameFrame(WHITE, Buffer.from('не картинка'))).toBeNull();
    expect(frameSignature(Buffer.from('не картинка'))).toBeNull();
  });
});

describe('inkGate', () => {
  it('пустой кадр не проходит', () => {
    const gate = inkGate(WHITE);

    expect(isFailure(gate)).toBe(true);
    expect(gate.why).toContain('почти ничего нет');
  });

  it('кадр с работой проходит', () => {
    expect(isPassed(inkGate(CHECKER))).toBe(true);
  });

  it('не бракует честно редкий кадр', () => {
    // Замер на настоящих работах Джарвиса: «Зелёная сфера» — 1% на кадре
    // 1920x1080. Один предмет на ровном фоне занимает мало, и это не поломка.
    // Первый порог в 2% забраковал бы её, и это было бы ложное обвинение.
    const sparse = makePng(64, 64, (x, y) => (x < 3 && y < 3 ? [0, 0, 0] : [255, 255, 255]));

    expect(isPassed(inkGate(sparse))).toBe(true);
  });

  it('строгий порог задаётся тем, кто спрашивает', () => {
    // У веб-страницы и у рендера одного предмета планка разная.
    expect(isFailure(inkGate(makePng(64, 64, (x, y) => (x < 3 && y < 3 ? [0, 0, 0] : [255, 255, 255])), 0.5))).toBe(true);
  });

  it('неразобранный снимок — «нечем мерить», а не провал', () => {
    // Окно, которого нет, и окно, которое пустое, — разные новости. Первое
    // чинят иначе, чем второе.
    const gate = inkGate(Buffer.from('файла нет'));

    expect(isUnknown(gate)).toBe(true);
    expect(isFailure(gate)).toBe(false);
  });
});

describe('снятие фильтров PNG', () => {
  /**
   * Замечание CodeRabbit (кусок 3, PR №42). Все проверки строили картинку
   * способом 0 — «никакой фильтрации», — и ветки Sub, Up, Average и Paeth в
   * разборщике не выполнялись НИ РАЗУ. Сломай любую из них, и набор остался
   * бы зелёным. А снимки Chromium и Electron кодируются адаптивно: ошибка
   * там портила бы пиксели каждого настоящего снимка, и `frameInk` мерил бы
   * мусор.
   */
  const пёстрая = (x: number, y: number): [number, number, number] => [
    (x * 37 + y * 11) & 0xff,
    (x * 5 + y * 83) & 0xff,
    (x * 149 + y * 29) & 0xff,
  ];

  it.each([0, 1, 2, 3, 4])('способ %i разбирается в те же пиксели', (способ) => {
    const разобранное = decodePng(makePng(7, 5, пёстрая, способ));
    expect(разобранное, `способ ${способ} не разобрался`).not.toBeNull();

    const ожидаемые: number[] = [];
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 7; x += 1) ожидаемые.push(...пёстрая(x, y));
    }
    expect([...(разобранное?.pixels ?? [])]).toEqual(ожидаемые);
  });
});
