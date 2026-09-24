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

/**
 * Замолчать — красная линия, и она ломалась молча.
 *
 * В живом логе 20.09.2026 «Тешина» встречается четыре раза, «Тишина» — тоже
 * четыре. То есть половину просьб замолчать распознаватель писал с ошибкой в
 * одну букву, командой они не признавались, и человек в ответ на «замолчи»
 * получал разговор.
 */
describe('ослышки команд остановки', () => {
  it.each([
    ['Тешина', 'тишина'],
    ['тишена', 'тишина'],
    ['Молкин', 'молчи'],
  ])('«%s» — это «%s»', (сказано, ожидаем) => {
    expect(fixMishearings(сказано).toLowerCase()).toBe(ожидаем);
  });

  // Замена целой фразой, а не словом: иначе «тишина в библиотеке» поедет.
  it('внутри фразы ничего не меняется', () => {
    expect(fixMishearings('тешина в библиотеке')).toBe('тешина в библиотеке');
  });
});

import { collapseRepeats } from './mishearing';

describe('recogniser loops and English mishearings', () => {
  it('turns a looped phrase back into what was said', () => {
    expect(collapseRepeats('Silence. Silence. Silence. Silence')).toBe('Silence');
    expect(collapseRepeats('Pause. Pause. Pause. Pause')).toBe('Pause');
    expect(collapseRepeats('тишина тишина тишина')).toBe('тишина');
    expect(collapseRepeats('Открой хром. Открой хром.')).toBe('Открой хром');
  });

  it('leaves ordinary speech alone', () => {
    expect(collapseRepeats('Стоп, стоп, подожди')).toBe('Стоп, стоп, подожди');
    expect(collapseRepeats('open chrome')).toBe('open chrome');
  });

  it('repairs the lost first consonant of a short English command, and only as a whole phrase', () => {
    expect(fixMishearings('Top.')).toBe('stop');
    expect(fixMishearings('Crawl down.')).toBe('scroll down');
    expect(fixMishearings('put it on top of the list')).toBe('put it on top of the list');
    expect(fixMishearings('Silence. Silence. Silence.')).toBe('Silence');
  });
});
