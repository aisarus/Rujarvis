import { describe, expect, it } from 'vitest';

import { applyFormulaReply, convertNoteFormulas, formulaCalls, formulaCandidates, formulaPrompt, looksLikeFormula, mergeFormulaLine } from './formulaLines';

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
    expect(итог).toMatchObject({ lines: 130, rejected: 0 });
    expect(итог.text.split('\n')[129]).toBe('- $x129 = 129$');

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

  it('«нет формул» — без изменений; неразборчивый ответ — ошибка', () => {
    const текст = '- x = 5\n';
    const строки = formulaCandidates(текст);
    expect(applyFormulaReply(текст, строки, 'НЕТ')).toEqual({ text: текст, lines: 0, rejected: 0 });
    expect(() => applyFormulaReply(текст, строки, 'Вот конспект, всё готово.')).toThrow(/не разобран/u);
  });
});
