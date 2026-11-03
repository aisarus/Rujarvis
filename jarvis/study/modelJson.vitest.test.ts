import { describe, expect, it } from 'vitest';

import { jsonFromReply } from './generate';
import { parseModelJson } from './modelJson';
import { parseOpenVerdict } from './openAnswer';
import { checkGenerated } from './quality';
import type { StudyTopic } from './types';

/** Значение строки из JSON, где модель написала её как есть, в кавычках. */
const значение = (внутри: string): unknown => (parseModelJson(`{"a":"${внутри}"}`) as { a: unknown }).a;

describe('JSON от модели с формулами', () => {
  it('неудвоенный слеш не роняет пачку и не портит команду молча', () => {
    // \d — неверная последовательность: JSON.parse падал и терял всю пачку.
    expect(значение('$\\dfrac{a}{b}$')).toBe('$\\dfrac{a}{b}$');
    // \f \t \n \r \b — верные: JSON.parse молча давал управляющий символ и огрызок.
    for (const команда of ['\\frac{a}{b}', '\\times', '\\neq', '\\ne', '\\nu', '\\rho', '\\right)', '\\tau', '\\theta', '\\text{x}', '\\tilde{x}', '\\to', '\\beta', '\\bar{x}']) {
      expect(значение(`$${команда}$`)).toBe(`$${команда}$`);
    }
    expect(значение('$\\underline{x}$')).toBe('$\\underline{x}$');
    expect(значение('$a\\,b\\{c\\}\\%$ и \\$5')).toBe('$a\\,b\\{c\\}\\%$ и \\$5');
  });

  it('удвоенный слеш и настоящие последовательности JSON не трогаются', () => {
    expect(значение('$\\\\dfrac{a}{b}$')).toBe('$\\dfrac{a}{b}$');
    expect(значение('$\\\\frac{a}{b}\\\\neq c$')).toBe('$\\frac{a}{b}\\neq c$');
    expect(значение('первая\\nвторая\\tтретья')).toBe('первая\nвторая\tтретья');
    expect(значение('line one\\nNext\\ntext\\r\\n')).toBe('line one\nNext\ntext\r\n');
    expect(значение('сказал \\"да\\", \\u0041 и a\\/b')).toBe('сказал "да", A и a/b');
    expect(значение('перенос\\n$\\neq$')).toBe('перенос\n$\\neq$');
  });

  it('заготовка и открытый ответ читают такие ответы', () => {
    expect(jsonFromReply('```json\n{"front":"$\\dfrac{l}{f}$","back":"$\\frac{n}{2}$"}\n```')).toEqual({ front: '$\\dfrac{l}{f}$', back: '$\\frac{n}{2}$' });
    expect(parseOpenVerdict('{"verdict":"partial","feedback":"нужно $\\dfrac{n}{2}$, а не $\\times 2$"}')).toEqual({ verdict: 'partial', feedback: 'нужно $\\dfrac{n}{2}$, а не $\\times 2$' });
  });

  it('варианты-формулы доходят до вопроса и не считаются повтором', () => {
    const темы: StudyTopic[] = [{ id: 't1', lecture: 'L', title: 'Медиана', from: 0, to: 600 }];
    const ответ = jsonFromReply(`{"questions":[{"section":1,"at":"01:00","prompt":"Формула?","options":[
      {"text":"$\\dfrac{a}{b}$","why":"верно","correct":true},
      {"text":"$\\dfrac{b}{a}$","why":"неверно","correct":false},
      {"text":"$a+b$","why":"неверно","correct":false},
      {"text":"$a-b$","why":"неверно","correct":false}],
      "explanation":"$\\frac{a}{b}$","hint":"h","answer":"$\\dfrac{a}{b}$"}]}`);
    const { questions, warnings } = checkGenerated(ответ, { lecture: 'L', topics: темы, translate: false });
    expect(warnings).toEqual([]);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.options.map((o) => o.text)).toEqual(['$\\dfrac{a}{b}$', '$\\dfrac{b}{a}$', '$a+b$', '$a-b$']);
    expect(questions[0]?.explanation).toBe('$\\frac{a}{b}$');
  });
});
