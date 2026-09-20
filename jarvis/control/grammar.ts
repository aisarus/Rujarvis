/**
 * Грамматика команд: шаблон со слотами вместо списка фраз.
 *
 * ## Зачем
 *
 * Таблица точных фраз не масштабируется. 20.09.2026 выяснилось, что из 62
 * обещанных команд надёжно не работала ни одна: каждая срабатывала слово в
 * слово и разваливалась от одного естественного слова рядом. «Сверни окно»
 * закрывало окно, «кликни правой кнопкой» искало кнопку с такой надписью.
 * Починили 21 семейство формулировок руками — и назавтра нашлось бы новое.
 *
 * Шаблон описывает не строку, а форму просьбы:
 *
 *     [пожалуйста] (сверни|убери) [это] окно
 *
 * Скобки — выбор, квадратные — необязательное, `{имя}` — слот, куда попадает
 * сказанное человеком. Слова сверяются по основе, поэтому «сверни»,
 * «свернуть» и «сворачивай» совпадают сами, без перечисления.
 *
 * ## Чем это не является
 *
 * Здесь нет вероятностей и нет «похоже подходит». Шаблон либо покрывает фразу
 * целиком, либо не совпадает. Частичное совпадение — это то, из-за чего
 * «закрой эту вкладку» уходило искать программу по имени «эту вкладку»:
 * правило съело половину фразы и объявило успех.
 */

import { основа, основы } from './morph';

/** Что получилось из шаблона: имя слота → сказанные слова. */
export type Slots = Record<string, string>;

type Token =
  | { kind: 'word'; stems: string[] }
  | { kind: 'optional'; inner: Token }
  | { kind: 'slot'; name: string; max: number };

/**
 * Слова, с которых имя не начинается.
 *
 * Предлог принадлежит шаблону, а не слоту: без этого «переключи вкладку на
 * Edge» давало цель «на edge», и окно не находилось никогда.
 */
const СЛУЖЕБНЫЕ = new Set(['на', 'в', 'во', 'к', 'ко', 'по', 'до', 'из', 'от', 'у', 'о', 'об']);

/** Слот по умолчанию берёт не больше трёх слов: имя окна, а не пересказ. */
const SLOT_WORDS = 3;

/**
 * Разбор шаблона в последовательность частей.
 *
 * Формат нарочно беден: выбор, необязательность, слот. Всё, чего не хватает,
 * выражается вторым шаблоном — два простых правила читаются лучше одного
 * хитрого.
 */
export function parsePattern(pattern: string): Token[] {
  const tokens: Token[] = [];
  for (const piece of pattern.trim().split(/\s+/u).filter(Boolean)) {
    const optional = piece.startsWith('[') && piece.endsWith(']');
    const body = optional ? piece.slice(1, -1) : piece;

    let token: Token;
    if (body.startsWith('{') && body.endsWith('}')) {
      const name = body.slice(1, -1);
      const all = name.endsWith('*');
      token = { kind: 'slot', name: all ? name.slice(0, -1) : name, max: all ? 99 : SLOT_WORDS };
    } else {
      const alts = body.replace(/^\(|\)$/gu, '').split('|').filter(Boolean);
      token = { kind: 'word', stems: alts.map((w) => основа(w)) };
    }
    tokens.push(optional ? { kind: 'optional', inner: token } : token);
  }
  return tokens;
}

/**
 * Совпадает ли, и что попало в слоты.
 *
 * Возвращает `null`, когда шаблон не покрывает фразу ЦЕЛИКОМ. Именно целиком:
 * частичное совпадение — это половина сделанного дела, выданная за целое.
 */
export function matchPattern(pattern: string, phrase: string): Slots | null {
  const words = phrase
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s+]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  return walkInner(parsePattern(pattern), words, основы(phrase));
}

/** Обход шаблона с откатом: короткие прочтения пробуются первыми. */
function walkInner(tokens: Token[], words: string[], stems: string[]): Slots | null {
  const go = (ti: number, wi: number, slots: Slots): Slots | null => {
    if (ti >= tokens.length) return wi === words.length ? slots : null;
    const token = tokens[ti] as Token;

    if (token.kind === 'optional') {
      const без = go(ti + 1, wi, slots);
      if (без) return без;
      const inner = token.inner;
      if (inner.kind === 'word') {
        if (wi < words.length && inner.stems.includes(stems[wi] as string)) {
          return go(ti + 1, wi + 1, slots);
        }
        return null;
      }
      return null;
    }

    if (token.kind === 'word') {
      if (wi >= words.length) return null;
      if (!token.stems.includes(stems[wi] as string)) return null;
      return go(ti + 1, wi + 1, slots);
    }

    // Слот не начинается с предлога: иначе «переключи вкладку на Edge» даёт
    // цель «на edge». Предлог — часть шаблона, а не имени окна.
    if (СЛУЖЕБНЫЕ.has(words[wi] as string)) return null;

    for (let take = 1; take <= token.max && wi + take <= words.length; take += 1) {
      const дальше = go(ti + 1, wi + take, {
        ...slots,
        [token.name]: words.slice(wi, wi + take).join(' '),
      });
      if (дальше) return дальше;
    }
    return null;
  };

  return go(0, 0, {});
}

/** Правило: форма просьбы и что из неё получается. */
export interface Rule<T> {
  pattern: string;
  make: (slots: Slots) => T;
}

/**
 * Первое подошедшее правило.
 *
 * Порядок значим: правила с большим числом обязательных слов ставятся раньше,
 * иначе общее правило перехватит частное. «Переключи вкладку на хром» должно
 * попасть в переход к программе, а не в «переключи вкладку».
 */
export function firstMatch<T>(rules: readonly Rule<T>[], phrase: string): T | null {
  for (const rule of rules) {
    const slots = matchPattern(rule.pattern, phrase);
    if (slots) return rule.make(slots);
  }
  return null;
}
