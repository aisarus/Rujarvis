import { describe, expect, it } from 'vitest';

import { flagWord } from './flagWord';

describe('flagWord', () => {
  it('читает «false» как ложь, а не как непустую строку', () => {
    // Ровно та беда, ради которой прибор существует: Boolean("false") — это
    // истина, и модель, честно сказавшая «нет», получала «да».
    expect(flagWord('false')).toBe(false);
    expect(flagWord('нет')).toBe(false);
    expect(flagWord('0')).toBe(false);
    expect(flagWord('off')).toBe(false);
  });

  it('читает согласие во всех видах, в каких его пишут', () => {
    for (const word of ['true', 'да', '1', 'yes', 'вкл', 'ИСТИНА']) {
      expect(flagWord(word)).toBe(true);
    }
  });

  it('не спорит с настоящим булевым', () => {
    expect(flagWord(true)).toBe(true);
    expect(flagWord(false)).toBe(false);
  });

  it('число ноль — это ложь, а не «есть число»', () => {
    expect(flagWord(0)).toBe(false);
    expect(flagWord(1)).toBe(true);
    expect(flagWord(Number.NaN)).toBe(false);
  });

  it('незнакомое слово уходит в умолчание, а не в «да»', () => {
    // «Может быть» — это не «да». И не «нет»: решает тот, кто спрашивал.
    expect(flagWord('может быть')).toBe(false);
    expect(flagWord('может быть', true)).toBe(true);
  });

  it('молчание — это умолчание', () => {
    expect(flagWord(null)).toBe(false);
    expect(flagWord(undefined, true)).toBe(true);
    expect(flagWord('')).toBe(false);
  });

  it('не спотыкается о пробелы и регистр', () => {
    expect(flagWord('  FALSE  ')).toBe(false);
    expect(flagWord('  Да ')).toBe(true);
  });
});
