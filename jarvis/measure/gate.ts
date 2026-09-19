/**
 * Трёхзначные ворота: прошло / не прошло / нечем мерить.
 *
 * ## Откуда это
 *
 * Принцип взят из Aegis (`C:\Users\ariel\AegisAutopilot`), где он записан
 * главным правилом дома:
 *
 * > Ложный провал дороже ложного успеха. Прибор, который молчит вместо «не
 * > знаю», — хуже отсутствующего.
 *
 * Джарвису он нужен не меньше. Весь день ушёл на ошибки одного вида: команда
 * отчиталась успехом, а результат неверный. Окно блендера «открылось» и не
 * появилось. Проверка здоровья объявила мёртвым MCP-сервер, отвечавший за
 * двести миллисекунд. Четыре раза подряд текст доезжал испорченным, и каждый
 * раз всё сообщало «ok».
 *
 * Общее у всех этих случаев одно: **прибор не различал «плохо» и «не смог
 * измерить»** — и сваливал второе в первое или, что хуже, в «хорошо».
 *
 * ## Почему это тип, а не соглашение
 *
 * Потому что соглашение сворачивается само. `if (!ворота.прошло)` читается как
 * «не прошло», а срабатывает и на «нечем мерить»: в JavaScript `!null` —
 * истина. Ровно так Aegis ловил `Number(null) === 0`, из-за чего «нечем
 * мерить» превращалось в обвинение «ноль процентов».
 *
 * Поэтому здесь нет поля, которое можно случайно прочитать как булево. Есть
 * `passed: true | false | null` и три функции, которые спрашивают ровно об
 * одном. Написать неправильно можно, но для этого придётся постараться.
 */

/** Прошло. Мерили и убедились. */
export interface GatePassed {
  passed: true;
  why?: string;
}

/** Не прошло. Мерили и убедились в обратном. */
export interface GateFailed {
  passed: false;
  why: string;
}

/**
 * Нечем мерить.
 *
 * Не «плохо» и не «хорошо»: прибор не смог. Страница не открылась, файла нет,
 * снимков меньше, чем нужно для сравнения. Это отдельная новость, и путать её
 * с провалом нельзя: на провал чинят работу, а на «нечем мерить» чинят прибор.
 */
export interface GateUnknown {
  passed: null;
  why: string;
}

export type Gate = GatePassed | GateFailed | GateUnknown;

export function passed(why?: string): GatePassed {
  return why ? { passed: true, why } : { passed: true };
}

export function failed(why: string): GateFailed {
  return { passed: false, why };
}

/** Нечем мерить. Причина обязательна: молчащий прибор хуже отсутствующего. */
export function cannotMeasure(why: string): GateUnknown {
  return { passed: null, why };
}

/**
 * Провал ли это.
 *
 * Отдельной функцией, потому что `!gate.passed` здесь — ошибка: `!null` даёт
 * истину, и «нечем мерить» превращается в обвинение.
 */
export function isFailure(gate: Gate): gate is GateFailed {
  return gate.passed === false;
}

export function isPassed(gate: Gate): gate is GatePassed {
  return gate.passed === true;
}

export function isUnknown(gate: Gate): gate is GateUnknown {
  return gate.passed === null;
}

/**
 * Итог по нескольким воротам.
 *
 * Порядок важен и он не про строгость, а про честность:
 *
 *   1. Хоть одно не прошло — не прошло. Это главная новость.
 *   2. Иначе хоть одно нечем мерить — нечем мерить. Объявлять успехом то,
 *      что наполовину не измерено, — ровно та ложь, ради которой всё это.
 *   3. Всё прошло — прошло.
 *
 * Пустой список — «нечем мерить», а не «прошло»: ворота, которых не было, не
 * подтверждают ничего.
 */
export function allGates(gates: readonly Gate[]): Gate {
  if (gates.length === 0) return cannotMeasure('ни одного замера не было');

  const broken = gates.filter(isFailure);
  if (broken.length > 0) {
    return failed(broken.map((gate) => gate.why).join('; '));
  }

  const unknown = gates.filter(isUnknown);
  if (unknown.length > 0) {
    return cannotMeasure(unknown.map((gate) => gate.why).join('; '));
  }

  return passed();
}

/** Ворота словами — для журнала, окна и голоса. */
export function describeGate(gate: Gate): string {
  if (isPassed(gate)) return gate.why ? `прошло: ${gate.why}` : 'прошло';
  if (isFailure(gate)) return `не прошло: ${gate.why}`;
  return `нечем мерить: ${gate.why}`;
}

/**
 * Число, пришедшее неизвестно откуда.
 *
 * `Number(null)` — это ноль, а `Number.isFinite(Number(null))` — истина. На
 * этом Aegis дважды терял приборы: «нечем мерить» превращалось в «ноль
 * процентов», а рычаг нажатия без координат жал в угол 0,0 и отчитывался, что
 * страница изменилась.
 *
 * Поэтому тип проверяется ДО приведения, а не после.
 */
export function measured(value: unknown, why: string): Gate & { value?: number } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ...cannotMeasure(why) };
  }
  return { ...passed(), value };
}
