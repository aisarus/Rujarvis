/**
 * Russian text primitives for the router.
 *
 * Russian is heavily inflected — «браузер», «браузере», «браузером» are one
 * word — and spoken input arrives without punctuation, with filler, with
 * English technical terms mixed in and with swearing used as emphasis. A full
 * morphological analyser is far more than the router needs: the router only
 * has to decide which capabilities and which backend a request implies.
 *
 * So matching is stem-prefix based. A rule lists stems; a token matches when it
 * starts with the stem. That handles declension and conjugation without a
 * dictionary, and it degrades gracefully on words nobody anticipated.
 *
 * Nothing here rewrites the user's words. Normalisation is for matching only;
 * the original utterance is always what reaches a strong backend.
 */

/** Lowercases, folds ё→е, and replaces punctuation with spaces. */
export function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function tokenize(text: string): string[] {
  const normalized = normalizeForMatching(text);
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * True when any token starts with `stem`.
 *
 * Stems of one or two characters would match far too much, so they are only
 * ever compared for equality.
 */
export function hasStem(tokens: readonly string[], stem: string): boolean {
  if (stem.length === 0) return false;
  if (stem.length <= 2) return tokens.includes(stem);
  return tokens.some((token) => token.startsWith(stem));
}

export function hasAnyStem(tokens: readonly string[], stems: readonly string[]): boolean {
  return stems.some((stem) => hasStem(tokens, stem));
}

/** Index of the first token matching `stem`, or -1. */
export function indexOfStem(tokens: readonly string[], stem: string): number {
  if (stem.length <= 2) return tokens.indexOf(stem);
  return tokens.findIndex((token) => token.startsWith(stem));
}

/**
 * True when `phrase` (a sequence of stems) appears in order and adjacently.
 *
 * Used for phrases whose individual words are too common to match alone —
 * «что на экране», «не ломай».
 */
export function hasPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0) return false;
  outer: for (let start = 0; start + phrase.length <= tokens.length; start += 1) {
    for (let offset = 0; offset < phrase.length; offset += 1) {
      const token = tokens[start + offset] as string;
      const stem = phrase[offset] as string;
      const matches = stem.length <= 2 ? token === stem : token.startsWith(stem);
      if (!matches) continue outer;
    }
    return true;
  }
  return false;
}

export function hasAnyPhrase(tokens: readonly string[], phrases: readonly (readonly string[])[]): boolean {
  return phrases.some((phrase) => hasPhrase(tokens, phrase));
}

/** Negation words that flip a nearby mention: «не используй клод», «без клода». */
const NEGATION_STEMS = ['не', 'без', 'кроме', 'никак'];

/**
 * True when a negation appears within `window` tokens before `index`.
 *
 * «не используй клод» negates; «клод не смог» does not, because the negation
 * follows the mention rather than preceding it.
 */
export function isNegatedBefore(
  tokens: readonly string[],
  index: number,
  window = 3,
): boolean {
  if (index < 0) return false;
  const start = Math.max(0, index - window);
  for (let position = start; position < index; position += 1) {
    const token = tokens[position] as string;
    if (NEGATION_STEMS.some((stem) => (stem.length <= 2 ? token === stem : token.startsWith(stem)))) {
      return true;
    }
  }
  return false;
}
