import { describe, expect, it } from 'vitest';

import { parseDictationEdit } from './dictationEdits';

describe('правка во время диктовки', () => {
  it('удаляет последнее слово', () => {
    expect(parseDictationEdit('удали последнее слово')).toEqual({
      kind: 'key',
      keys: 'ctrl+backspace',
    });
    expect(parseDictationEdit('сотри слово')).toEqual({ kind: 'key', keys: 'ctrl+backspace' });
  });

  it('удаляет строку целиком', () => {
    const command = parseDictationEdit('удали строку');
    expect(command?.kind).toBe('keys');
  });

  it('переносит на новую строку', () => {
    expect(parseDictationEdit('новая строка')).toEqual({ kind: 'key', keys: 'enter' });
    expect(parseDictationEdit('с новой строки')).toEqual({ kind: 'key', keys: 'enter' });
    expect(parseDictationEdit('абзац')).toEqual({ kind: 'keys', keys: ['enter', 'enter'] });
  });

  it('заменяет последнее слово на сказанное', () => {
    expect(parseDictationEdit('исправь на встречу')).toEqual({
      kind: 'replace',
      text: 'встречу',
    });
    expect(parseDictationEdit('замени на понедельник')).toEqual({
      kind: 'replace',
      text: 'понедельник',
    });
  });

  it('не принимает за правку продиктованный текст', () => {
    // Всё это должно попасть в документ буквами, а не выполниться.
    expect(parseDictationEdit('удали этот файл завтра')).toBe(null);
    expect(parseDictationEdit('исправь отчёт до среды')).toBe(null);
    expect(parseDictationEdit('спасибо за встречу')).toBe(null);
    expect(parseDictationEdit('')).toBe(null);
  });

  it('не срабатывает на замене без текста', () => {
    expect(parseDictationEdit('исправь на')).toBe(null);
  });
});

describe('опасные совпадения', () => {
  it('не считает заменой обычное «не»', () => {
    // «Не» — самое частое слово в языке. Приняв его за правку, диктовка
    // стирала бы предыдущее слово посреди фразы.
    expect(parseDictationEdit('не надо')).toBe(null);
    expect(parseDictationEdit('не сегодня')).toBe(null);
    expect(parseDictationEdit('вернее сказать')).toBe(null);
  });

  it('длинное продолжение после «исправь на» — это диктовка', () => {
    expect(parseDictationEdit('исправь на следующей неделе в среду')).toBe(null);
  });
});
