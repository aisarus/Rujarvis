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

describe('dictation edits in English', () => {
  it('deletes the last word and the line', () => {
    expect(parseDictationEdit('delete last word', 'en')).toEqual({ kind: 'key', keys: 'ctrl+backspace' });
    expect(parseDictationEdit('Delete line.', 'en')?.kind).toBe('keys');
  });

  it('breaks lines and paragraphs', () => {
    expect(parseDictationEdit('new line', 'en')).toEqual({ kind: 'key', keys: 'enter' });
    expect(parseDictationEdit('new paragraph', 'en')).toEqual({ kind: 'keys', keys: ['enter', 'enter'] });
  });

  it('replaces the last word only with an explicit verb', () => {
    expect(parseDictationEdit('correct to Monday', 'en')).toEqual({ kind: 'replace', text: 'monday' });
    // «I mean» и «no» — обычные слова текста, а не правка.
    expect(parseDictationEdit('i mean monday', 'en')).toBeNull();
    expect(parseDictationEdit('replace with the whole new sentence', 'en')).toBeNull();
  });

  it('держит таблицы языков раздельно: чужая фраза печатается буквами', () => {
    expect(parseDictationEdit('new line', 'ru')).toBeNull();
    expect(parseDictationEdit('новая строка', 'en')).toBeNull();
  });
});
