import { describe, expect, it } from 'vitest';

import { applyFormulaReply, convertNoteFormulas, formulaCalls, formulaCandidates, formulaPrompt, looksLikeFormula, mergeFormulaLine } from './formulaLines';

describe('атака на проверку: принятое должно считаться так же, как исходное', () => {
  // Независимый расчёт: случайное выражение в двух записях, порча ответа и сравнение значений.
  let зерно = 2026;
  const случ = (n: number): number => {
    зерно = (зерно * 1103515245 + 12345) & 0x7fffffff;
    return зерно % n;
  };
  interface Пара {
    текст: string;
    latex: string;
    /** Выражение можно поставить внизу дроби и в скобки не брать. */
    простое: boolean;
    /** Верх дроби без сложения. */
    безСложения: boolean;
  }
  const лист = (): Пара => {
    const вид = случ(5);
    const текст = вид === 0 ? String(случ(90) + 1) : вид === 1 ? `${случ(9) + 1}.${случ(9) + 1}` : вид === 2 ? `${случ(9) + 1},${случ(9) + 1}` : (['a', 'b', 'x', 'y', 'n'][случ(5)] as string);
    return { текст, latex: текст.replace(',', '{,}'), простое: true, безСложения: true };
  };
  const выражение = (глубина: number): Пара => {
    if (глубина <= 0) return лист();
    const а = выражение(глубина - 1);
    const б = выражение(глубина - 1);
    switch (случ(6)) {
      case 0:
        return { текст: `${а.текст} + ${б.текст}`, latex: `${а.latex} + ${б.latex}`, простое: false, безСложения: false };
      case 1: {
        const справа = б.безСложения ? б : { ...б, текст: `(${б.текст})`, latex: `(${б.latex})` };
        return { текст: `${а.текст} - ${справа.текст}`, latex: `${а.latex} - ${справа.latex}`, простое: false, безСложения: false };
      }
      case 2: {
        const слева = а.безСложения ? а : { ...а, текст: `(${а.текст})`, latex: `(${а.latex})` };
        const справа = б.безСложения ? б : { ...б, текст: `(${б.текст})`, latex: `(${б.latex})` };
        return { текст: `${слева.текст}·${справа.текст}`, latex: `${слева.latex} \\cdot ${справа.latex}`, простое: false, безСложения: true };
      }
      case 3: {
        const верх = а.безСложения ? а.текст : `(${а.текст})`;
        const низ = б.простое ? б.текст : `(${б.текст})`;
        return { текст: `${верх}/${низ}`, latex: `\\dfrac{${а.latex}}{${б.latex}}`, простое: false, безСложения: true };
      }
      case 4: {
        const основание = лист();
        if (!/^[a-z]$/u.test(основание.текст)) return { ...а };
        const степень = случ(4) + 2;
        return { текст: `${основание.текст}^${степень}`, latex: `${основание.текст}^${степень}`, простое: true, безСложения: true };
      }
      default:
        return { текст: `(${а.текст})`, latex: `\\left(${а.latex}\\right)`, простое: true, безСложения: true };
    }
  };
  const значения: Record<string, number> = { a: 1.7, b: 2.3, x: 3.1, y: 0.9, n: 4.3 };
  const посчитать = (js: string): number => {
    const тело = js.replace(/([a-z])/gu, (буква) => String(значения[буква])).replace(/\^/gu, '**');
    return Function(`"use strict"; return (${тело});`)() as number;
  };
  const изТекста = (т: string): string => т.replace(/(\d),(\d)/gu, '$1.$2').replace(/·/gu, '*');
  /** LaTeX → JS. Дробь, степень, скобки: всё, что не поняли, бросит ошибку и попадёт в счёт. */
  function изLatex(т: string): string {
    let с = т.replace(/\{,\}/gu, '.').replace(/\\left|\\right/gu, '').replace(/\\cdot/gu, '*');
    for (;;) {
      const где = с.indexOf('\\dfrac');
      if (где < 0) break;
      const аргумент = (от: number): [string, number] => {
        if (с[от] !== '{') return [с[от] as string, от + 1];
        let глубина = 0;
        for (let и = от; и < с.length; и += 1) {
          if (с[и] === '{') глубина += 1;
          if (с[и] === '}' && (глубина -= 1) === 0) return [с.slice(от + 1, и), и + 1];
        }
        throw new Error('скобка');
      };
      const [верх, после] = аргумент(где + 6);
      const [низ, конец] = аргумент(после);
      с = `${с.slice(0, где)}((${верх})/(${низ}))${с.slice(конец)}`;
    }
    return с.replace(/\{/gu, '(').replace(/\}/gu, ')').replace(/\^(\d)/gu, '**$1').replace(/\^\(/gu, '**(');
  }
  const порча = (s: string): string => {
    const знаки = '0123456789abxyn+-*/^_{}().,= ';
    const вставки = ['\\cdot ', '\\dfrac', '\\left(', '\\right)', '{', '}', '^', '_', '{,}'];
    let т = s;
    for (let n = 1 + случ(2); n > 0; n -= 1) {
      const где = случ(т.length + 1);
      const вид = случ(4);
      if (вид === 0) т = `${т.slice(0, где)}${т.slice(где + 1)}`;
      else if (вид === 1) т = `${т.slice(0, где)}${знаки[случ(знаки.length)]}${т.slice(где + 1)}`;
      else if (вид === 2) т = `${т.slice(0, где)}${вставки[случ(вставки.length)]}${т.slice(где)}`;
      else {
        const j = случ(т.length + 1);
        const [а, б] = [Math.min(где, j), Math.max(где, j)];
        т = `${т.slice(0, а)}${т[б] ?? ''}${т.slice(а + 1, б)}${т[а] ?? ''}${т.slice(б + 1)}`;
      }
    }
    return т;
  };

  it('верная запись принимается, а порча либо отвергнута, либо значение то же', () => {
    let верных = 0;
    let принятаПорча = 0;
    const неверные: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      const { текст, latex } = выражение(1 + случ(3));
      expect(mergeFormulaLine(текст, `$${latex}$`), `${текст} ← ${latex}`).toBe(`$${latex}$`);
      верных += 1;
      for (let к = 0; к < 6; к += 1) {
        const плохая = порча(latex);
        if (плохая === latex || mergeFormulaLine(текст, `$${плохая}$`) === null) continue;
        принятаПорча += 1;
        try {
          const было = посчитать(изТекста(текст));
          const стало = посчитать(изLatex(плохая));
          if (Number.isNaN(было) ? !Number.isNaN(стало) : Math.abs(было - стало) > 1e-9 * Math.max(1, Math.abs(было))) неверные.push(`${текст} ← ${плохая}: ${было} и ${стало}`);
        } catch (error) {
          неверные.push(`${текст} ← ${плохая}: не посчитать (${(error as Error).message})`);
        }
      }
    }
    console.log(`атака: верных ${верных}, принятых порч ${принятаПорча}, неверных из них ${неверные.length}`);
    expect(неверные.slice(0, 12)).toEqual([]);
  });
});

describe('какие строки показать модели', () => {
  it('формулы и символы — да; обычный текст, время и ссылки — нет', () => {
    for (const строка of ['- Me = L0 + n·(N/2 − F)/f', 'медиана: x2 и F1', '> цена P растёт', '| 5 + 3 | восемь |', 'площадь = a*b', '- f(x) — функция', 'x ≈ 12', 'доля 1/2 от всех', 'Обозначим n — число наблюдений']) {
      expect(looksLikeFormula(строка), строка).toBe(true);
    }
    for (const строка of ['- Обычная фраза про спрос и цены.', '### Спрос (12:40–17:55)', 'Расшифровка: [[2026-10-13 — расшифровка]] · [[Математика А]]', '![[2026-10-13.wav]]', '> [!quote] Лектор, 12:05', '- лекция 2026-10-13 в аудитории', 'A plain English sentence with a word.', 'I think a tree is tall.', '*Звук лекции удалён 04.11.2026*', '- переменная: `total = 5` и `print(x)`', '- сумма: `=SUM(B2:B10)`']) {
      expect(looksLikeFormula(строка), строка).toBe(false);
    }
  });

  it('свойства, заголовки, блоки кода и строки с $ не трогаются', () => {
    const текст = [
      '---',
      'курс: x = 5',
      '---',
      '# x = 5',
      '',
      '```mermaid',
      'flowchart LR',
      '  A["x = 5"] --> B',
      '```',
      '%% y = 6 %%',
      '- уже $x = 5$ и y = 6',
      '- новая y = 6',
    ].join('\n');
    expect(formulaCandidates(текст)).toEqual([{ index: 11, line: '- новая y = 6' }]);
  });

  it('в промпте только эти строки и правило формул', () => {
    const промпт = formulaPrompt([{ index: 7, line: '- y = 6' }]);
    expect(промпт).toContain('1| - y = 6');
    expect(промпт).toContain('Формулы — в LaTeX');
    expect(промпт).not.toContain('Спрос');
  });
});

describe('ответ модели: принимается только запись формулы', () => {
  it('формула в LaTeX: дробь, индекс, знаки и греческие буквы — та же запись', () => {
    expect(mergeFormulaLine('- Me = L0 + n·(N/2 − F)/f', '- $Me = L_0 + \\dfrac{n \\cdot (N/2 - F)}{f}$')).toBe('- $Me = L_0 + \\dfrac{n \\cdot (N/2 - F)}{f}$');
    expect(mergeFormulaLine('x² ≤ α', '$x^2 \\le \\alpha$')).toBe('$x^2 \\le \\alpha$');
    expect(mergeFormulaLine('∑ x = 22,5', '$\\sum x = 22{,}5$')).toBe('$\\sum x = 22{,}5$');
    expect(mergeFormulaLine('цена ≠ 5 при Q = 3', 'цена $\\neq 5$ при $Q = 3$')).toBe('цена $\\neq 5$ при $Q = 3$');
  });

  it('кусок текста встречается и внутри формулы: подходит то место, где она доказана', () => {
    expect(mergeFormulaLine('- Для Q1 (доля n/4) получили Q1≈437.5.', '- Для Q1 (доля $n/4$) получили $Q1\\approx437.5$.')).toBe('- Для Q1 (доля $n/4$) получили $Q1\\approx437.5$.');
    expect(mergeFormulaLine('- итог 1.5 и конец.', '- итог $15$ и конец.')).toBeNull();
  });

  it('с пробелом у знака доллара и с цифрой сразу за формулой Obsidian не рисует: отказ', () => {
    expect(mergeFormulaLine('x = 5', '$ x = 5 $')).toBeNull();
    expect(mergeFormulaLine('a = b2 и', '$a = b$2 и')).toBeNull();
  });

  it('буква ℓ из конспекта статистики — та же, что \\ell', () => {
    expect(mergeFormulaLine('L₀ + (ℓ / f_xm)', '$L_0 + (\\ell / f_{xm})$')).toBe('$L_0 + (\\ell / f_{xm})$');
  });

  it('текст вне формул — байты исходной строки, с её пробелами', () => {
    expect(mergeFormulaLine('  - L0  —  граница, x = 5 (⚠ 12:05: на слух 6)  ', '- $L_0$ — граница, $x = 5$ (⚠ 12:05: на слух 6)')).toBe(null);
    expect(mergeFormulaLine('  - L0 — граница, x = 5 (⚠ 12:05: на слух 6)  ', '- $L_0$ — граница, $x = 5$ (⚠ 12:05: на слух 6)')).toBe('  - $L_0$ — граница, $x = 5$ (⚠ 12:05: на слух 6)  ');
    expect(mergeFormulaLine('> | a/b | коротко |', '> | $\\dfrac{a}{b}$ | коротко |')).toBe('> | $\\dfrac{a}{b}$ | коротко |');
  });

  it('изменённые слова, числа, буквы, знаки и порядок — отказ', () => {
    const плохие: Array<[string, string]> = [
      ['цена x = 5', 'стоимость $x = 5$'], // слово
      ['x = 5, y = 6', '$x = 5$, $y = 7$'], // число
      ['x = 1200', '$x = 1250$'], // «поправила» число
      ['a + b', '$a - b$'], // знак
      ['a/b', '$\\dfrac{b}{a}$'], // порядок
      ['n/2', '$N/2$'], // регистр
      ['α = 1', '$\\beta = 1$'], // греческая буква
      ['x = 5', '$x = 5$ и ещё текст'], // дописано
      ['x = 5 и y', '$x = 5$'], // потеряно
      ['до x = 5', '$x = 5$'], // потеряно спереди
      ['x = 5', '$x = 5'], // незакрытая формула
      ['цена x = 5', '$цена x = 5$'], // слово внутри формулы
      ['x = 5', '$x = 5$ $\\cdot$'], // символ из ниоткуда
      ['x = 5, где', '$x = 5$, где $y$'], // формула из ниоткуда
      ['a + b', '$a + b + c$'], // добавлена буква
      ['код `total = 5` здесь', 'код $total = 5$ здесь'], // код в обратных кавычках
      ['код `x == 5` здесь', 'код $x == 5$ здесь'], // и это код
      ['ячейки `B2:B10` тут', 'ячейки $B2:B10$ тут'], // и это
    ];
    for (const [исходная, ответ] of плохие) expect(mergeFormulaLine(исходная, ответ), `${исходная} → ${ответ}`).toBeNull();
  });

  it('математика в обратных кавычках становится формулой, кавычки уходят', () => {
    expect(looksLikeFormula('- разность квадратов — `a² − b²`')).toBe(true);
    expect(mergeFormulaLine('- куб суммы — `(a+b)³ = a³ + 3a²b + 3ab² + b³`.', '- куб суммы — $(a+b)^3 = a^3 + 3a^2b + 3ab^2 + b^3$.')).toBe('- куб суммы — $(a+b)^3 = a^3 + 3a^2b + 3ab^2 + b^3$.');
    expect(mergeFormulaLine('- `x = 5` и `sin(y)`', '- $x = 5$ и $\\sin(y)$')).toBe('- $x = 5$ и $\\sin(y)$');
    expect(mergeFormulaLine('- квадрат `a² − b²`', '- квадрат $a^2 + b^2$')).toBeNull();
  });

  it('длинная заметка идёт пачками; не вышла одна — не применяется ничего', async () => {
    const текст = Array.from({ length: 130 }, (_, i) => `- x${i} = ${i}`).join('\n');
    expect(formulaCalls(текст)).toBe(3);
    const вызовы: number[] = [];
    const итог = await convertNoteFormulas(текст, async (prompt) => {
      const строки = (prompt.split('Строки:\n')[1] ?? '').split('\n');
      вызовы.push(строки.length);
      return строки.map((с) => с.replace(/^(\d+\| - )(.*)$/u, '$1$$$2$$')).join('\n');
    });
    expect(вызовы).toEqual([60, 60, 10]);
    expect(итог).toMatchObject({ lines: 130, rejected: 0, missing: 0 });
    expect(итог.text.split('\n')[129]).toBe('- $x129 = 129$');
    expect(итог.changes[129]).toEqual({ index: 129, before: '- x129 = 129', after: '- $x129 = 129$' });

    let номер = 0;
    await expect(
      convertNoteFormulas(текст, async () => {
        номер += 1;
        if (номер === 2) throw new Error('лимит');
        return '1| - $x0 = 0$';
      }),
    ).rejects.toThrow(/лимит/u);
  });

  it('ответ без формул: та же строка — без изменений, другая — отказ', () => {
    expect(mergeFormulaLine('x = 5', 'x = 5')).toBe('x = 5');
    expect(mergeFormulaLine('x = 5', 'x = 6')).toBeNull();
  });

  it('заметка меняется только в принятых строках, остальное — побайтно, с её переводами строк', () => {
    const текст = '---\r\nкурс: Физика\r\n---\r\n# Тема\r\n\r\n- первая x = 5\r\n- обычная строка\r\n- вторая y = 6\r\n- третья z = 7\r\n';
    const строки = formulaCandidates(текст);
    expect(строки.map((с) => с.line)).toEqual(['- первая x = 5', '- вторая y = 6', '- третья z = 7']);
    const итог = applyFormulaReply(текст, строки, '```\n1| - первая $x = 5$\n2| - вторая $y = 7$\n```\n9| - чужая $q$');
    expect(итог.text).toBe('---\r\nкурс: Физика\r\n---\r\n# Тема\r\n\r\n- первая $x = 5$\r\n- обычная строка\r\n- вторая y = 6\r\n- третья z = 7\r\n');
    expect(итог).toMatchObject({ lines: 1, rejected: 2 });
  });

  it('«номер|» — формул нет; пропущенные строки считаются; неразборчивый ответ — ошибка', () => {
    const текст = '- x = 5\n- y = 6\n- z = 7\n';
    const строки = formulaCandidates(текст);
    expect(applyFormulaReply(текст, строки, '1|\n2|\n3|')).toMatchObject({ text: текст, lines: 0, rejected: 0, missing: 0 });
    expect(applyFormulaReply(текст, строки, '1| - $x = 5$')).toMatchObject({ lines: 1, rejected: 0, missing: 2 });
    expect(() => applyFormulaReply(текст, строки, 'НЕТ')).toThrow(/не разобран/u);
    expect(() => applyFormulaReply(текст, строки, 'Вот конспект, всё готово.')).toThrow(/не разобран/u);
  });
});
