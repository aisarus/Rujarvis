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

export type DictationEdit =
  | { kind: 'key'; keys: string }
  | { kind: 'keys'; keys: string[] }
  | { kind: 'replace'; text: string };

/** Точные фразы: всё остальное — диктуемый текст. */
const EDITS: Record<string, DictationEdit> = {
  'удали последнее слово': { kind: 'key', keys: 'ctrl+backspace' },
  'удали слово': { kind: 'key', keys: 'ctrl+backspace' },
  'сотри слово': { kind: 'key', keys: 'ctrl+backspace' },
  'сотри последнее слово': { kind: 'key', keys: 'ctrl+backspace' },

  // Строка целиком: в начало, выделить до конца, стереть.
  'удали строку': { kind: 'keys', keys: ['home', 'shift+end', 'backspace'] },
  'удали последнюю строку': { kind: 'keys', keys: ['home', 'shift+end', 'backspace'] },

  'новая строка': { kind: 'key', keys: 'enter' },
  'с новой строки': { kind: 'key', keys: 'enter' },
  'перенос строки': { kind: 'key', keys: 'enter' },
  'абзац': { kind: 'keys', keys: ['enter', 'enter'] },
  'новый абзац': { kind: 'keys', keys: ['enter', 'enter'] },
};

/**
 * Начала замены последнего слова.
 *
 * Только однозначные. В живой речи поправляются словами «не» и «вернее» — но
 * «не» самое частое слово в языке, и продиктованное «не надо» стёрло бы
 * предыдущее слово и напечатало «надо». Цена ошибки здесь — испорченный текст,
 * которого человек не видит, потому что смотрит не в экран.
 */
const REPLACE_PREFIXES = ['исправь на', 'замени на'];

export function parseDictationEdit(utterance: string): DictationEdit | null {
  const phrase = normalise(utterance);
  if (!phrase) return null;

  const exact = EDITS[phrase];
  if (exact) return exact;

  for (const prefix of REPLACE_PREFIXES) {
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

function normalise(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
