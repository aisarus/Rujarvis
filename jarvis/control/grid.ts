/**
 * Сетка с номерами поверх экрана.
 *
 * Дерево доступности знает кнопки, но не знает содержимого игр, холстов и
 * картинок: в Dota оно не покажет ни одного предмета, в Blender — ни одной
 * вершины. Там остаётся один честный способ указать точку голосом — назвать
 * её номер.
 *
 * Человек говорит «сетка», поверх экрана появляются пронумерованные клетки, он
 * говорит «клик сорок пять» — и клик уходит в середину сорок пятой. Если надо
 * точнее, следующей фразой: «точнее пять» — клетка делится на девять долей.
 *
 * Уточнение отдельной фразой, а не хвостом: «клик сорок пять пять» на слух
 * складывается в пятьдесят, потому что составные числительные не дают отличить
 * номер клетки от номера доли.
 *
 * ## Почему двенадцать на восемь
 *
 * Клеток должно быть достаточно, чтобы попадать, и достаточно мало, чтобы
 * номер можно было прочитать и произнести. 96 клеток на экране 1920×1080 дают
 * 160×135 точек — размер крупной кнопки; с уточнением до девятой доли это
 * 53×45, чего хватает почти всегда.
 *
 * Сетка постоянная, а не подстраиваемая: номера остаются на тех же местах, и
 * со временем человек перестаёт их читать.
 */

export interface ScreenArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridLayout extends ScreenArea {
  columns: number;
  rows: number;
  cells: number;
  cellWidth: number;
  cellHeight: number;
}

export interface Point {
  x: number;
  y: number;
}

const COLUMNS = 12;
const ROWS = 8;

/** Сколько всего клеток — знать это нужно и разбору команд. */
export const GRID_CELLS = COLUMNS * ROWS;
/** Уточнение внутри клетки: три на три. */
const SUB = 3;

/**
 * Настоящие пиксели экрана из тех, что называет Electron.
 *
 * Здесь две системы координат, и их легко перепутать с дорогими
 * последствиями. Electron живёт в независимых от плотности точках: при
 * масштабе 125% он называет экран 1536×864. Драйвер мыши работает в
 * физических пикселях и видит тот же экран как 1920×1080.
 *
 * Окно сетки ставится по первым, а клик уходит по вторым. Посчитать клетки в
 * координатах окна означало бы промахиваться на четверть экрана — и тем
 * сильнее, чем правее и ниже цель.
 */
export function physicalArea(bounds: ScreenArea, scaleFactor: number): ScreenArea {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  return {
    x: Math.round(bounds.x * scale),
    y: Math.round(bounds.y * scale),
    width: Math.round(bounds.width * scale),
    height: Math.round(bounds.height * scale),
  };
}

export function gridLayout(screen: ScreenArea): GridLayout {
  return {
    ...screen,
    columns: COLUMNS,
    rows: ROWS,
    cells: COLUMNS * ROWS,
    cellWidth: screen.width / COLUMNS,
    cellHeight: screen.height / ROWS,
  };
}

/**
 * Середина клетки с этим номером.
 *
 * Возвращает ничего для номера вне сетки. Выдуманная точка хуже отказа: клик
 * уйдёт неизвестно куда, и человек не поймёт, почему.
 */
export function cellCenter(cell: number, layout: GridLayout): Point | null {
  if (!Number.isInteger(cell) || cell < 1 || cell > layout.cells) return null;

  const index = cell - 1;
  // Слева направо, потом вниз — так же, как читают.
  const column = index % layout.columns;
  const row = Math.floor(index / layout.columns);

  return {
    x: layout.x + column * layout.cellWidth + layout.cellWidth / 2,
    y: layout.y + row * layout.cellHeight + layout.cellHeight / 2,
  };
}

/** Середина одной из девяти долей клетки — когда нужно точнее. */
export function subCellCenter(cell: number, sub: number, layout: GridLayout): Point | null {
  if (!Number.isInteger(sub) || sub < 1 || sub > SUB * SUB) return null;

  const centre = cellCenter(cell, layout);
  if (!centre) return null;

  const subWidth = layout.cellWidth / SUB;
  const subHeight = layout.cellHeight / SUB;
  const left = centre.x - layout.cellWidth / 2;
  const top = centre.y - layout.cellHeight / 2;

  const index = sub - 1;
  return {
    x: left + (index % SUB) * subWidth + subWidth / 2,
    y: top + Math.floor(index / SUB) * subHeight + subHeight / 2,
  };
}

const UNITS: Record<string, number> = {
  'один': 1, 'одна': 1, 'два': 2, 'две': 2, 'три': 3, 'четыре': 4, 'пять': 5,
  'шесть': 6, 'семь': 7, 'восемь': 8, 'девять': 9,
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7,
  'eight': 8, 'nine': 9, 'twice': 2,
};

const TEENS: Record<string, number> = {
  'десять': 10, 'одиннадцать': 11, 'двенадцать': 12, 'тринадцать': 13,
  'четырнадцать': 14, 'пятнадцать': 15, 'шестнадцать': 16, 'семнадцать': 17,
  'восемнадцать': 18, 'девятнадцать': 19,
  'ten': 10, 'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14,
  'fifteen': 15, 'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
};

const TENS: Record<string, number> = {
  'двадцать': 20, 'тридцать': 30, 'сорок': 40, 'пятьдесят': 50,
  'шестьдесят': 60, 'семьдесят': 70, 'восемьдесят': 80, 'девяносто': 90,
  // «Сто» в сетке не нужно — клеток меньше, — но нужно повторам: человек
  // говорит «прокрути вниз сто раз», и это должно пониматься, а не молчать.
  'сто': 100,
  'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60,
  'seventy': 70, 'eighty': 80, 'ninety': 90, 'hundred': 100,
};

/**
 * Число, сказанное вслух.
 *
 * Распознаватель пишет числа то цифрами, то словами, и предугадать нельзя —
 * поэтому понимаются оба вида.
 */
export function parseSpokenNumber(text: string): number | null {
  const digits = /\d+/u.exec(text);
  if (digits) return Number.parseInt(digits[0], 10);

  const words = text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  // Порядок обязателен: десятки, потом единицы. И ничего больше.
  //
  // Раньше слагаемые просто складывались, поэтому «пять пять» давало десять,
  // а «сорок сорок» — восемьдесят: ошибка распознавания превращалась в клик
  // по клетке, которую человек не называл. Число, собранное не по-русски, —
  // это «не понял», а не «наверное, вот это».
  let total = 0;
  let found = false;
  let былиДесятки = false;
  let былиЕдиницы = false;

  for (const word of words) {
    const tens = TENS[word];
    const teen = TEENS[word];
    const unit = UNITS[word];

    if (tens !== undefined) {
      // Вторые десятки или десятки после единиц — не число, а шум.
      if (былиДесятки || былиЕдиницы) return null;
      total += tens;
      былиДесятки = true;
      found = true;
    } else if (teen !== undefined) {
      // «Двенадцать» — само по себе целое: рядом с ним слагаемых не бывает.
      if (found) return null;
      total += teen;
      былиЕдиницы = true;
      found = true;
    } else if (unit !== undefined) {
      if (былиЕдиницы) return null;
      total += unit;
      былиЕдиницы = true;
      found = true;
    }
  }

  return found ? total : null;
}
