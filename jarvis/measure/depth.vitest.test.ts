import { describe, expect, it } from 'vitest';

import { depthGate, pageDepth, probePlan, wordForStates } from './depth';
import { isFailure, isPassed, isUnknown } from './gate';
import type { Probe } from './depth';

function probes(spec: Array<[string, boolean, boolean?]>): Probe[] {
  return spec.map(([what, changed, fresh]) => ({ what, changed, fresh: fresh ?? changed }));
}

/** Замер Aegis на пустышке: двенадцать действий, один кадр, ноль ответов. */
const HOLLOW = probes(Array.from({ length: 12 }, () => ['прокрутить', false] as [string, boolean]));

/** Замер Aegis на вещи: двенадцать действий, шесть кадров, пять ответов. */
const REAL = probes([
  ['прокрутить', true],
  ['прокрутить', true],
  ['прокрутить', true],
  ['нажать', true],
  ['нажать', true],
  ['подвигать мышью', false],
  ['подвигать мышью', false],
  ['подвигать мышью', false],
  ['подвигать мышью', false],
  ['подвигать мышью', false],
  ['подвигать мышью', false],
  ['клавиша', false],
]);

describe('pageDepth', () => {
  it('отличает пустышку от вещи — на замере из Aegis', () => {
    // Числа не выдуманы: пустышка 12 действий → 1 кадр, вещь 12 → 6.
    expect(pageDepth(HOLLOW, 1).has).toBe(false);
    expect(pageDepth(REAL, 6).has).toBe(true);
  });

  it('говорит «мерить нечем», когда проб мало', () => {
    // Две пробы не отличат вещь от заставки, и притворяться, что отличили, —
    // хуже, чем промолчать.
    const depth = pageDepth(probes([['прокрутить', true]]), 5);

    expect(depth.has).toBeNull();
    expect(depth.fact).toContain('этого мало');
  });

  it('говорит «мерить нечем», когда кадры не сравнились', () => {
    // Страница, которая не открылась, и страница, в которой нечего делать, —
    // разные новости.
    expect(pageDepth(REAL, null).has).toBeNull();
    expect(pageDepth(REAL, Number.NaN).has).toBeNull();
    expect(pageDepth(REAL, 0).has).toBeNull();
  });

  it('называет, откуда взялось разное', () => {
    // Прокрутка даёт новый кадр всегда: слайд-шоу из тринадцати картинок иначе
    // прошло бы как вещь. Решает тот, кто читает, — но ему надо это сказать.
    const depth = pageDepth(REAL, 6);

    expect(depth.fact).toContain('от «прокрутить»');
    expect(depth.fact).toContain('от «нажать»');
    expect(depth.from?.get('прокрутить')).toBe(3);
  });

  it('считает долю ответивших проб, а не только кадры', () => {
    // Страница из трёх состояний, отвечающая на каждое действие, живее
    // страницы из пяти, отвечающей на одно из десяти.
    expect(pageDepth(REAL, 6).share).toBeCloseTo(5 / 12, 3);
  });

  it('о бедной странице говорит прямо', () => {
    expect(pageDepth(HOLLOW, 2).fact).toContain('тридцать секунд');
  });
});

describe('probePlan', () => {
  it('начинает с прокрутки, кончает клавишей', () => {
    // Порядок не случаен: сперва то, что есть у любой вещи; клавиши последними,
    // на них отвечают редко.
    const plan = probePlan({ handles: 3 });

    expect(plan[0]?.what).toBe('прокрутить');
    expect(plan.at(-1)?.what).toBe('клавиша');
  });

  it('пробует кнопки самой страницы, если они есть', () => {
    expect(probePlan({ handles: 3 }).filter((one) => one.what === 'нажать')).toHaveLength(3);
    expect(probePlan({ handles: 0 }).filter((one) => one.what === 'нажать')).toHaveLength(0);
  });

  it('держит обещанное число проб', () => {
    expect(probePlan({ handles: 5, probes: 12 })).toHaveLength(12);
    expect(probePlan({ handles: 50, probes: 8 })).toHaveLength(8);
  });
});

describe('depthGate', () => {
  it('не путает бедную страницу с неизмеренной', () => {
    expect(isFailure(depthGate(pageDepth(HOLLOW, 1)))).toBe(true);
    expect(isUnknown(depthGate(pageDepth(REAL, null)))).toBe(true);
    expect(isPassed(depthGate(pageDepth(REAL, 6)))).toBe(true);
  });
});

describe('wordForStates', () => {
  it.each([
    [1, 'разный кадр'],
    [2, 'разных кадра'],
    [4, 'разных кадра'],
    [5, 'разных кадров'],
    [11, 'разных кадров'],
    [21, 'разный кадр'],
  ])('%i — «%s»', (count, word) => {
    expect(wordForStates(count)).toBe(word);
  });
});
