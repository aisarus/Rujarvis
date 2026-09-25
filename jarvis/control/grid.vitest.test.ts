import { describe, expect, it } from 'vitest';

import { cellCenter, gridLayout, parseSpokenNumber, physicalArea, subCellCenter } from './grid';

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };

describe('gridLayout', () => {
  it('накрывает экран целиком', () => {
    const layout = gridLayout(SCREEN);
    expect(layout.columns * layout.rows).toBe(layout.cells);
    expect(layout.cellWidth * layout.columns).toBe(SCREEN.width);
    expect(layout.cellHeight * layout.rows).toBe(SCREEN.height);
  });

  it('держит клетки близкими к квадрату', () => {
    // Вытянутая клетка плохо читается: человек не понимает, что куда попало.
    const layout = gridLayout(SCREEN);
    const ratio = layout.cellWidth / layout.cellHeight;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.7);
  });

  it('работает на втором мониторе со сдвигом', () => {
    const layout = gridLayout({ x: -1920, y: 0, width: 1920, height: 1080 });
    expect(layout.cells).toBeGreaterThan(0);
  });
});

describe('cellCenter', () => {
  const layout = gridLayout(SCREEN);

  it('первая клетка — в левом верхнем углу', () => {
    const point = cellCenter(1, layout);
    expect(point?.x).toBe(layout.cellWidth / 2);
    expect(point?.y).toBe(layout.cellHeight / 2);
  });

  it('последняя клетка — в правом нижнем', () => {
    const point = cellCenter(layout.cells, layout);
    expect(point?.x).toBe(SCREEN.width - layout.cellWidth / 2);
    expect(point?.y).toBe(SCREEN.height - layout.cellHeight / 2);
  });

  it('нумерует слева направо, потом вниз — как читают', () => {
    const second = cellCenter(2, layout);
    const firstOfSecondRow = cellCenter(layout.columns + 1, layout);
    expect(second?.y).toBe(cellCenter(1, layout)?.y);
    expect(firstOfSecondRow?.x).toBe(cellCenter(1, layout)?.x);
  });

  it('учитывает сдвиг монитора', () => {
    const shifted = gridLayout({ x: -1920, y: 0, width: 1920, height: 1080 });
    expect(cellCenter(1, shifted)?.x).toBeLessThan(0);
  });

  it('молчит на числе за пределами сетки', () => {
    // Выдуманная точка хуже отказа: клик уйдёт неизвестно куда.
    expect(cellCenter(0, layout)).toBe(null);
    expect(cellCenter(layout.cells + 1, layout)).toBe(null);
    expect(cellCenter(-5, layout)).toBe(null);
  });
});

describe('subCellCenter', () => {
  const layout = gridLayout(SCREEN);

  it('делит клетку на девять и попадает в середину нужной', () => {
    const centre = cellCenter(1, layout);
    const middle = subCellCenter(1, 5, layout);
    // Пятая из девяти — ровно центр клетки.
    expect(middle).toEqual(centre);
  });

  it('первая подклетка левее и выше центра', () => {
    const centre = cellCenter(1, layout);
    const corner = subCellCenter(1, 1, layout);
    expect(corner!.x).toBeLessThan(centre!.x);
    expect(corner!.y).toBeLessThan(centre!.y);
  });

  it('молчит на подклетке вне девятки', () => {
    expect(subCellCenter(1, 0, layout)).toBe(null);
    expect(subCellCenter(1, 10, layout)).toBe(null);
  });
});

describe('parseSpokenNumber', () => {
  it('понимает цифры', () => {
    expect(parseSpokenNumber('14')).toBe(14);
    expect(parseSpokenNumber('7')).toBe(7);
  });

  it('понимает слова', () => {
    // Распознаватель пишет числа то цифрами, то словами.
    expect(parseSpokenNumber('четырнадцать')).toBe(14);
    expect(parseSpokenNumber('семь')).toBe(7);
    expect(parseSpokenNumber('двадцать')).toBe(20);
  });

  it('понимает составные', () => {
    expect(parseSpokenNumber('двадцать три')).toBe(23);
    expect(parseSpokenNumber('сорок пять')).toBe(45);
    expect(parseSpokenNumber('девяносто девять')).toBe(99);
  });

  it('не зависит от регистра и лишних слов вокруг', () => {
    expect(parseSpokenNumber('Тридцать Один')).toBe(31);
  });

  it('молчит, когда числа нет', () => {
    expect(parseSpokenNumber('кнопка войти')).toBe(null);
    expect(parseSpokenNumber('')).toBe(null);
  });
});

describe('physicalArea', () => {
  it('переводит точки Electron в настоящие пиксели', () => {
    // При 125% Electron называет экран 1536×864, а мышь живёт в 1920×1080.
    // Считать клетки в первых координатах — значит промахиваться тем сильнее,
    // чем правее цель.
    expect(physicalArea({ x: 0, y: 0, width: 1536, height: 864 }, 1.25)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it('при обычном масштабе ничего не меняет', () => {
    const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    expect(physicalArea(bounds, 1)).toEqual(bounds);
  });

  it('учитывает сдвиг второго монитора', () => {
    expect(physicalArea({ x: -1536, y: 0, width: 1536, height: 864 }, 1.25).x).toBe(-1920);
  });

  it('не ломается на бессмысленном масштабе', () => {
    const bounds = { x: 0, y: 0, width: 800, height: 600 };
    expect(physicalArea(bounds, 0)).toEqual(bounds);
  });
});
