import { describe, expect, it } from 'vitest';

import { findRider, longerAxis, rideTo, riderSlot } from './pageRider';

describe('findRider', () => {
  it('ищет ездока толчком, а не по числам', () => {
    // Главное правило прибора: элемент с огромным scrollWidth, который не
    // двигается, по числам выглядит лучшим кандидатом — и им не является.
    const script = findRider('вбок');

    expect(script).toContain('+ 10');
    expect(script).toContain('поехал');
    expect(script).toContain('scrollLeft');
  });

  it('по каждой оси смотрит свои размеры', () => {
    expect(findRider('вбок')).toContain('scrollWidth');
    expect(findRider('вбок')).toContain('clientWidth');
    expect(findRider('вниз')).toContain('scrollHeight');
    expect(findRider('вниз')).toContain('clientHeight');
  });

  it('возвращает толчок в исходное положение', () => {
    // Иначе поиск ездока сам сдвигает страницу, и первый же кадр снимается не
    // с начала.
    const script = findRider('вниз');
    const push = script.indexOf('было + 10');
    const restore = script.indexOf('= было;', push);

    expect(restore).toBeGreaterThan(push);
  });

  it('оси не путают своих ездоков', () => {
    expect(riderSlot('вбок')).not.toBe(riderSlot('вниз'));
    expect(findRider('вбок')).toContain(riderSlot('вбок'));
    expect(findRider('вниз')).toContain(riderSlot('вниз'));
  });

  it('порог запаса задаётся', () => {
    expect(findRider('вниз', 200)).toContain('> 200');
  });
});

describe('rideTo', () => {
  it('двигает найденного ездока, а не окно', () => {
    const script = rideTo('вбок', 1500);

    expect(script).toContain(`window.${riderSlot('вбок')}`);
    expect(script).toContain('scrollLeft = 1500');
  });

  it('без ездока отступает к окну', () => {
    // Запасной путь нужен: на простой странице ездок и есть окно.
    expect(rideTo('вниз', 800)).toContain('window.scrollTo(0, 800)');
    expect(rideTo('вбок', 800)).toContain('window.scrollTo(800, 0)');
  });
});

describe('longerAxis', () => {
  it('выбирает ту ось, где запас больше', () => {
    // Горизонтальную новеллу вертикальный проезд не открывает вовсе, и ось
    // надо выбрать ДО съёмки.
    expect(longerAxis(4000, 900)).toBe('вбок');
    expect(longerAxis(900, 4000)).toBe('вниз');
  });

  it('молчит, когда ехать некуда', () => {
    // Не «вниз по умолчанию»: страница в один экран — это один кадр, и
    // проезжать нечего.
    expect(longerAxis(0, 0)).toBeNull();
  });

  it('не принимает мусор за размер', () => {
    // Number(null) === 0, и на этом уже ломались приборы.
    expect(longerAxis(Number.NaN, 0)).toBeNull();
    expect(longerAxis(Number.NaN, 1200)).toBe('вниз');
  });
});
