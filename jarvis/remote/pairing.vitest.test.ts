import { describe, expect, it } from 'vitest';

import { createPairing, isPaired, matchesToken, shortCode } from './pairing';

describe('createPairing', () => {
  it('выдаёт длинный непредсказуемый ключ', () => {
    // Через этот канал управляют всем компьютером. Короткий ключ здесь — это
    // не неудобство, а открытая дверь.
    const first = createPairing();
    const second = createPairing();

    expect(first.token).toHaveLength(64);
    expect(first.token).toMatch(/^[0-9a-f]+$/u);
    expect(first.token).not.toBe(second.token);
  });

  it('помнит, когда его выдали', () => {
    const before = Date.now();
    const pairing = createPairing();
    expect(pairing.createdAt).toBeGreaterThanOrEqual(before);
  });
});

describe('matchesToken', () => {
  it('принимает верный ключ', () => {
    const pairing = createPairing();
    expect(matchesToken(pairing, pairing.token)).toBe(true);
  });

  it('отвергает неверный, пустой и отсутствующий', () => {
    const pairing = createPairing();
    expect(matchesToken(pairing, 'нет')).toBe(false);
    expect(matchesToken(pairing, '')).toBe(false);
    expect(matchesToken(pairing, undefined)).toBe(false);
  });

  it('отвергает ключ верной длины, но чужой', () => {
    const pairing = createPairing();
    const other = createPairing();
    expect(matchesToken(pairing, other.token)).toBe(false);
  });

  it('не выдаёт правильную длину по времени ответа', () => {
    // Сравнение, которое обрывается на первом несовпавшем символе, выдаёт ключ
    // по времени. Проверяем, что длина чужого ключа не ломает сравнение.
    const pairing = createPairing();
    expect(matchesToken(pairing, `${pairing.token}хвост`)).toBe(false);
    expect(matchesToken(pairing, pairing.token.slice(0, 10))).toBe(false);
  });
});

describe('isPaired', () => {
  it('без выданного ключа связь закрыта', () => {
    // Отсутствие пары — это не «пускать всех», а «не пускать никого».
    expect(isPaired(null, 'что угодно')).toBe(false);
  });
});

describe('shortCode', () => {
  it('даёт короткий код для человека, а не сам ключ', () => {
    const pairing = createPairing();
    const code = shortCode(pairing);

    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[0-9]+$/u);
    // Код — это хеш ключа, а не его кусок: показанный на экране, он не
    // приближает к самому ключу.
    expect(code).not.toBe(pairing.token.slice(0, 6));
  });

  it('один и тот же ключ даёт один и тот же код', () => {
    const pairing = createPairing();
    expect(shortCode(pairing)).toBe(shortCode(pairing));
  });
});
