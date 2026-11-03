import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

// Обычный скрипт страницы, без модулей: грузится ровно так, как его грузит окно.
const среда: { readableMath?: (text: string) => string } = {};
vm.runInNewContext(readFileSync(path.join(__dirname, 'mathText.js'), 'utf8'), среда);
const читаемо = (text: string): string => (среда.readableMath as (t: string) => string)(text);
/** Без изоляции направления письма: она невидима, а проверяется отдельно. */
const формула = (text: string): string => читаемо(text).replace(/[\u2066\u2069]/gu, '');

describe('формулы окна учёбы — читаемым текстом', () => {
  it('формула медианы из статистики читается и не теряет скобок (03.11.2026)', () => {
    expect(формула('$Me = L_0 + \\dfrac{l}{f(x)}\\left(\\dfrac{n}{2} - F_1\\right)$')).toBe('Me = L₀ + (l/f(x))(n/2 - F₁)');
    expect(формула('$Me = L_0 + \\dfrac{l}{f_{x_m}}\\left(\\dfrac{n}{2} - F_{x_{m-1}}\\right)$')).toBe('Me = L₀ + (l/f_(xₘ))(n/2 - F_(xₘ₋₁))');
  });

  it('дробь: скобки только там, где без них читалось бы иначе', () => {
    expect(формула('$\\dfrac{a}{b}$')).toBe('a/b');
    expect(формула('$x = \\frac{1}{2} + y$')).toBe('x = 1/2 + y');
    expect(формула('$\\dfrac{a+b}{c-d}$')).toBe('(a+b)/(c-d)');
    expect(формула('$v = v_0 + \\dfrac{F}{m}\\,t$')).toBe('v = v₀ + (F/m) t');
    expect(формула('$2\\dfrac{a}{b}$')).toBe('2(a/b)');
    expect(формула('$\\dfrac{\\dfrac{a}{b}}{c}$')).toBe('(a/b)/c');
  });

  it('значки, степени, индексы, корни и пояснения', () => {
    expect(формула('$\\alpha \\le \\beta \\neq \\gamma \\times 2$')).toBe('α ≤ β ≠ γ × 2');
    expect(формула('$x^2 + y^{n+1}$')).toBe('x² + yⁿ⁺¹');
    expect(формула('$x_{ab} + y_b + z^T$')).toBe('x_(ab) + y_b + z^T');
    expect(формула('$90^\\circ$')).toBe('90°');
    expect(формула('$\\sqrt{2} + \\sqrt{x+1} + \\sqrt[3]{8}$')).toBe('√2 + √(x+1) + ³√8');
    expect(формула('$\\bar{x} = \\text{сумма}$')).toBe('x\u0304 = сумма');
    expect(формула('$\\sum_{i=1}^{n} x_i$')).toBe('Σᵢ₌₁ⁿ xᵢ');
    expect(формула('$\\lvert x \\rvert \\mid y$')).toBe('| x | | y');
    expect(формула('$$\\dfrac{a}{b}$$')).toBe('a/b');
  });

  it('вне формулы ничего не трогается: деньги, пути, обычный текст', () => {
    expect(читаемо('C:\\temp\\file — без формул')).toBe('C:\\temp\\file — без формул');
    expect(читаемо('билет \\$5 и ещё \\$7')).toBe('билет $5 и ещё $7');
    expect(читаемо('билет $5 и ещё $7')).toBe('билет $5 и ещё $7');
    expect(читаемо('5$, а потом 7$')).toBe('5$, а потом 7$');
    expect(формула('при $x = 5$ (⚠ 12:05: на слух 6) и $y = 2$ тоже')).toBe('при x = 5 (⚠ 12:05: на слух 6) и y = 2 тоже');
  });

  it('формула в ивритском вопросе изолирована слева направо', () => {
    expect(читаемо('מה זה $x_1$?')).toBe('מה זה \u2066x₁\u2069?');
  });

  it('сломанный LaTeX не роняет окно и не показывает обратных слешей', () => {
    for (const плохая of ['$\\dfrac{a$', '$\\foo{x}$', '${a$', '$a^$', '$\\dfrac$', '$\\sqrt[3$', '$\\begin{cases}a\\\\b\\end{cases}$']) {
      expect(формула(плохая)).not.toMatch(/\\|\uE000|\uE001/u);
    }
  });
});
