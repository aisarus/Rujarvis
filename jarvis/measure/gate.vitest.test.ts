import { describe, expect, it } from 'vitest';

import {
  allGates,
  cannotMeasure,
  describeGate,
  failed,
  isFailure,
  isPassed,
  isUnknown,
  measured,
  passed,
} from './gate';

describe('трёхзначные ворота', () => {
  it('различают три ответа, а не два', () => {
    expect(isPassed(passed())).toBe(true);
    expect(isFailure(failed('пусто'))).toBe(true);
    expect(isUnknown(cannotMeasure('страница не открылась'))).toBe(true);
  });

  it('не считают «нечем мерить» провалом', () => {
    // Главное, ради чего всё это. `!gate.passed` здесь дало бы истину, и
    // неизмеренное превратилось бы в обвинение. Ровно так Джарвис сегодня
    // объявил мёртвым MCP-сервер, отвечавший за двести миллисекунд.
    const gate = cannotMeasure('снимков меньше, чем нужно для сравнения');

    expect(isFailure(gate)).toBe(false);
    expect(isPassed(gate)).toBe(false);
  });

  it('требуют причину там, где её нельзя не назвать', () => {
    // Молчащий прибор хуже отсутствующего: без причины непонятно, чинить
    // работу или чинить прибор.
    expect(failed('чернил ноль').why).toBe('чернил ноль');
    expect(cannotMeasure('файла нет').why).toBe('файла нет');
  });
});

describe('allGates', () => {
  it('провал перевешивает всё', () => {
    const gate = allGates([passed(), cannotMeasure('нет снимка'), failed('пустая страница')]);

    expect(isFailure(gate)).toBe(true);
    expect(gate.why).toContain('пустая страница');
  });

  it('неизмеренное не превращается в успех', () => {
    // Половина замеров прошла, половина не сделалась — это не «прошло». Ровно
    // такой отчёт и есть та ложь, против которой ворота придуманы.
    const gate = allGates([passed(), cannotMeasure('страница не открылась')]);

    expect(isUnknown(gate)).toBe(true);
    expect(gate.why).toContain('не открылась');
  });

  it('всё прошло — прошло', () => {
    expect(isPassed(allGates([passed(), passed('чернил 34%')]))).toBe(true);
  });

  it('пустой список — не успех', () => {
    // Ворота, которых не было, не подтверждают ничего.
    expect(isUnknown(allGates([]))).toBe(true);
  });

  it('называет все причины, а не первую', () => {
    const gate = allGates([failed('нет заголовка'), failed('нет картинок')]);

    expect(gate.why).toContain('нет заголовка');
    expect(gate.why).toContain('нет картинок');
  });
});

describe('measured', () => {
  it.each([null, undefined, 'семь', Number.NaN, Number.POSITIVE_INFINITY, {}])(
    'не принимает %s за число',
    (value) => {
      // `Number(null) === 0`, и `Number.isFinite` от него — истина. Проверять
      // тип надо ДО приведения, иначе «нечем мерить» станет «ноль процентов».
      const gate = measured(value, 'замера нет');

      expect(isUnknown(gate)).toBe(true);
      expect(gate.value).toBeUndefined();
    },
  );

  it('пропускает настоящее число, включая ноль', () => {
    // Ноль — это измеренный ноль, и он отличается от неизмеренного.
    const gate = measured(0, 'замера нет');

    expect(isPassed(gate)).toBe(true);
    expect(gate.value).toBe(0);
  });
});

describe('describeGate', () => {
  it('говорит человеческими словами', () => {
    expect(describeGate(passed())).toBe('прошло');
    expect(describeGate(passed('чернил 34%'))).toBe('прошло: чернил 34%');
    expect(describeGate(failed('пусто'))).toBe('не прошло: пусто');
    expect(describeGate(cannotMeasure('нет снимка'))).toBe('нечем мерить: нет снимка');
  });
});
