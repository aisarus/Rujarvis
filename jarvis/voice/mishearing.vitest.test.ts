import { describe, expect, it } from 'vitest';

import { fixMishearings } from './mishearing';

describe('fixMishearings', () => {
  it.each([
    ['Открой блиндер.', 'открой блендер'],
    ['создая в блиндире красную сферу', 'создая в блендере красную сферу'],
    ['создая в Глендире красную сферу', 'создая в блендере красную сферу'],
    ['Открой Хрум.', 'открой хром'],
    ['Закрою Steam.', 'закрой steam'],
    ['Уромче.', 'громче'],
  ])('«%s» → «%s»', (heard, expected) => {
    // Всё это снято с живого распознавателя, а не придумано.
    expect(fixMishearings(heard).toLowerCase().replace(/[.,]/gu, '').trim()).toBe(expected);
  });

  it('чинит слово остановки', () => {
    // «Хватит» слышится как «Ватя». Человек назвал остановку отдельным
    // требованием, и терять её нельзя.
    expect(fixMishearings('Ватя.').toLowerCase()).toContain('хватит');
  });

  it('чинит вставку, которую слышит по-английски', () => {
    expect(fixMishearings('stuff.').toLowerCase()).toContain('вставь');
  });

  it('разделяет слипшиеся слова команды', () => {
    expect(fixMishearings('Кликсорок 5.').toLowerCase()).toContain('клик сорок');
  });

  it('не трогает то, что распознано верно', () => {
    for (const phrase of [
      'создай в блендере красную сферу',
      'прокрути вниз',
      'что ты умеешь',
      'сделай таблицу с расходами',
    ]) {
      expect(fixMishearings(phrase)).toBe(phrase);
    }
  });

  it('не чинит слова, похожие на исправляемые', () => {
    // «Ватя» чинится только когда это вся фраза: иначе имя в диктовке
    // превратилось бы в команду остановки.
    expect(fixMishearings('передай Ватя привет')).toBe('передай Ватя привет');
    expect(fixMishearings('мне нужен блиндаж')).toBe('мне нужен блиндаж');
  });

  it('переживает пустую строку', () => {
    expect(fixMishearings('')).toBe('');
    expect(fixMishearings('   ')).toBe('   ');
  });
});
