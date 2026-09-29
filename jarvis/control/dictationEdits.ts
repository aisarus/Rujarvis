/**
 * Правка прямо во время диктовки.
 *
 * Диктовка без правки нерабочая: распознаватель ошибается, человек оговаривается,
 * и единственный способ исправить — выйти из режима, взять мышь, вернуться. Для
 * того, у кого руки заняты, это значит «не пользоваться диктовкой вообще».
 *
 * ## Чем это отличается от обычных команд
 *
 * В режиме диктовки всё сказанное печатается буква в букву — иначе
 * продиктованное слово «вниз» прокрутит страницу вместо того, чтобы попасть в
 * текст. Поэтому здесь список намеренно крошечный и требует **точного**
 * совпадения: только то, что человек не станет диктовать всерьёз.
 *
 * «Удали последнее слово» — правка. «Удали этот файл завтра» — текст письма, и
 * он должен напечататься целиком.
 */

import { currentLanguage, type Language } from '../locale/language';
import { matchVoiceControl } from '../voice/interrupts';
import { isSilenceRequest } from '../voice/noise';
import { findWakeWord } from '../voice/wakeWord';
import { endsDictation } from './commands';

export type DictationEdit =
  | { kind: 'key'; keys: string }
  | { kind: 'keys'; keys: string[] }
  | { kind: 'replace'; text: string };

const DELETE_WORD: DictationEdit = { kind: 'key', keys: 'ctrl+backspace' };
// Строка целиком: в начало, выделить до конца, стереть.
const DELETE_LINE: DictationEdit = { kind: 'keys', keys: ['home', 'shift+end', 'backspace'] };
const NEW_LINE: DictationEdit = { kind: 'key', keys: 'enter' };
const NEW_PARAGRAPH: DictationEdit = { kind: 'keys', keys: ['enter', 'enter'] };

/**
 * Точные фразы: всё остальное — диктуемый текст.
 *
 * Таблица — на языке диктовки, а не общая. В отличие от «стоп», здесь цена
 * лишнего совпадения — стёртый текст: человек, диктующий по-русски письмо с
 * английской фразой «new line», должен получить её буквами.
 */
const EDITS: Record<Language, Record<string, DictationEdit>> = {
  ru: {
    'удали последнее слово': DELETE_WORD,
    'удали слово': DELETE_WORD,
    'сотри слово': DELETE_WORD,
    'сотри последнее слово': DELETE_WORD,
    'удали строку': DELETE_LINE,
    'удали последнюю строку': DELETE_LINE,
    'новая строка': NEW_LINE,
    'с новой строки': NEW_LINE,
    'перенос строки': NEW_LINE,
    'абзац': NEW_PARAGRAPH,
    'новый абзац': NEW_PARAGRAPH,
  },
  en: {
    'delete last word': DELETE_WORD,
    'delete the last word': DELETE_WORD,
    'delete word': DELETE_WORD,
    'erase last word': DELETE_WORD,
    'delete line': DELETE_LINE,
    'delete the line': DELETE_LINE,
    'delete last line': DELETE_LINE,
    'new line': NEW_LINE,
    'next line': NEW_LINE,
    'line break': NEW_LINE,
    'new paragraph': NEW_PARAGRAPH,
  },
};

/**
 * Начала замены последнего слова.
 *
 * Только однозначные. В живой речи поправляются словами «не» и «вернее» — но
 * «не» самое частое слово в языке, и продиктованное «не надо» стёрло бы
 * предыдущее слово и напечатало «надо». Цена ошибки здесь — испорченный текст,
 * которого человек не видит, потому что смотрит не в экран. По-английски та же
 * беда у «I mean» и «no», поэтому и там только явные глаголы правки.
 */
const REPLACE_PREFIXES: Record<Language, string[]> = {
  ru: ['исправь на', 'замени на'],
  en: ['correct to', 'replace with'],
};

export function parseDictationEdit(
  utterance: string,
  language: Language = currentLanguage(),
): DictationEdit | null {
  const phrase = normalise(utterance);
  if (!phrase) return null;

  const exact = EDITS[language][phrase];
  if (exact) return exact;

  for (const prefix of REPLACE_PREFIXES[language]) {
    if (!phrase.startsWith(`${prefix} `)) continue;

    const text = phrase.slice(prefix.length + 1).trim();
    if (!text) return null;
    // Замена — это одно-два слова. Длинное продолжение человек диктует, а не
    // исправляет.
    if (text.split(' ').length > 2) return null;

    return { kind: 'replace', text };
  }

  return null;
}

/** Что сделать с фразой, пока идёт диктовка. */
export type DictationStep =
  | { kind: 'control' }
  | { kind: 'end' }
  | { kind: 'edit'; edit: DictationEdit }
  | { kind: 'text' };

/**
 * Фраза во время диктовки: остановка, конец, правка — или текст.
 *
 * «Стоп», «пауза», «отмена», «продолжай» — первыми и на обоих языках, как и
 * везде: слова остановки обязаны работать всегда. До 29.09.2026 в диктовке
 * они печатались в текст, а работа агента шла дальше. Узнаётся только фраза
 * целиком, с именем или без: «стоп, я передумал» — продиктованный текст.
 */
export function dictationStep(utterance: string, language: Language = currentLanguage()): DictationStep {
  const найдено = findWakeWord(utterance);
  const безИмени = найдено && найдено.index === 0 && найдено.command ? найдено.command : utterance;
  if (matchVoiceControl(безИмени) ?? matchVoiceControl(utterance)) return { kind: 'control' };
  if (endsDictation(безИмени) || isSilenceRequest(utterance)) return { kind: 'end' };
  const edit = parseDictationEdit(безИмени, language);
  return edit ? { kind: 'edit', edit } : { kind: 'text' };
}

function normalise(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
