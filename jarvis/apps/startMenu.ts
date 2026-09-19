/**
 * Finding an installed program from the name a person says in Russian.
 *
 * A hand-written alias list loses: there are 281 shortcuts on this machine and
 * the user will ask for whichever one they happen to want. The Start menu
 * already knows every installed program, so the job is to match a spoken
 * Russian name against those names.
 *
 * Two different things have to be bridged, and they are not the same:
 *   - sound: «стим» is Steam written in Cyrillic, so transliteration finds it
 *   - meaning: «лигу» is the Russian word for League, which no amount of
 *     transliteration turns into "league"
 *
 * So both are tried, plus a crude stemmer, because Russian declines the name:
 * the user says «открой лигу», never «открой лига».
 */

import { editDistance } from '../voice/wakeWord';

const TRANSLITERATION: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '',
};

/** Russian words that name a program by meaning rather than by sound. */
const MEANINGS: Readonly<Record<string, string>> = {
  лиг: 'league',
  легенд: 'legends',
  клиент: 'client',
  игр: 'games',
  почт: 'mail',
  музык: 'music',
  браузер: 'browser',
  проводник: 'explorer',
  блокнот: 'notepad',
  калькулятор: 'calculator',
  настройк: 'settings',
  параметр: 'settings',
  магазин: 'store',
  камер: 'camera',
  фот: 'photos',
  диспетчер: 'manager',
  // Letters spelled out loud. Recognition writes «джи-пи-ти» as «джпт», and
  // no transliteration of that reaches "gpt".
  джпт: 'gpt',
  гпт: 'gpt',
  чат: 'chat',
  ии: 'ai',
};

/** Endings Russian adds to a name in the accusative and friends. */
const ENDINGS = ['ами', 'ями', 'ом', 'ем', 'ой', 'ей', 'ую', 'ия', 'иу', 'а', 'у', 'ы', 'и', 'е', 'о', 'ю', 'я'];

export function transliterate(word: string): string {
  return [...word].map((letter) => TRANSLITERATION[letter] ?? letter).join('');
}

/** Cuts a Russian ending so «лигу» and «лига» reduce to the same stem. */
export function stem(word: string): string {
  for (const ending of ENDINGS) {
    if (word.length - ending.length >= 3 && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Every Latin form the spoken name might take. */
export function candidateKeys(spoken: string): string[] {
  const keys = new Set<string>();
  for (const word of normalise(spoken).split(' ')) {
    if (!word) continue;
    const stemmed = stem(word);
    keys.add(word);
    keys.add(stemmed);
    keys.add(transliterate(word));
    keys.add(transliterate(stemmed));

    for (const [russian, english] of Object.entries(MEANINGS)) {
      if (stemmed.startsWith(russian) || russian.startsWith(stemmed)) keys.add(english);
    }
  }
  // Names said as several words are often written as one: «чат джпт» is
  // "ChatGPT". Without the joined form, «чат» alone matched "Cheat Engine" —
  // same consonants, kht — while ChatGPT scored nothing at all.
  const joined = normalise(spoken)
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const stemmed = stem(word);
      for (const [russian, english] of Object.entries(MEANINGS)) {
        if (stemmed === russian || word === russian) return english;
      }
      return transliterate(word);
    })
    .join('');
  if (joined.length >= 4) keys.add(joined);

  return [...keys].filter((key) => key.length >= 3);
}

/**
 * A word reduced to the consonants it sounds like.
 *
 * Transliteration is lossy about vowels above all: «стим» becomes "stim" while
 * the shortcut says "steam" — two edits apart as spelling, the same word as
 * sound. Dropping the vowels and folding the letters that share a sound makes
 * them equal, without loosening the edit distance until unrelated words start
 * matching.
 */
function soundSkeleton(word: string): string {
  return word
    .replace(/ph/gu, 'f')
    .replace(/ck/gu, 'k')
    .replace(/[cq]/gu, 'k')
    .replace(/z/gu, 's')
    .replace(/w/gu, 'v')
    .replace(/[aeiouy]/gu, '');
}

/**
 * How well one spoken word matches one word of a program's name.
 *
 * The grading matters more than the numbers. «Стим» and "Steam" reduce to the
 * *same* sound, "stm" — that is a match. «Хром» and "Home" reduce to "hrm" and
 * "hm", which are merely *close* — and acting on that is how «открой хром»
 * opened "Dev Home" while Chrome was not installed at all. So a shared sound
 * counts, a similar one does not.
 */
function scoreWord(key: string, word: string): number {
  if (key === word) return 3;

  // A prefix counts only when it is most of the word. Otherwise «дискорд»
  // matches "Диск восстановления" and «стим» matches "Sid Meier's" — both
  // observed against the real list on this machine.
  const shorter = Math.min(key.length, word.length);
  const longer = Math.max(key.length, word.length);
  if (shorter >= 4 && shorter / longer >= 0.75 && (word.startsWith(key) || key.startsWith(word))) {
    return 3;
  }

  const keySound = soundSkeleton(key);
  const wordSound = soundSkeleton(word);
  if (keySound.length >= 3 && keySound === wordSound) return 2;
  if (key.length >= 4 && editDistance(key, word, 2) <= 1) return 2;

  // Near-misses are reported but never acted on alone.
  if (keySound.length >= 3 && editDistance(keySound, wordSound, 2) <= 1) return 1;
  return 0;
}

export interface ShortcutChoice<T> {
  item: T;
  score: number;
  /**
   * True when this match can be acted on without asking.
   *
   * A weak match is one that only sounded similar. Acting on it is how «открой
   * хром» opened "Dev Home": Chrome is not in the Start menu at all, and the
   * nearest sound won by default. Opening the wrong program is worse than
   * saying the name was not recognised, so a weak match counts only when it is
   * clearly ahead of everything else.
   */
  confident: boolean;
}

/**
 * Picks the shortcut that best matches what was said, or null.
 *
 * Ties go to the shorter name: asked for «риот», "Riot Client" is a better
 * answer than "Riot Client Services Diagnostics", because the short name is
 * the one people mean.
 */
export function chooseShortcut<T>(
  spoken: string,
  items: readonly T[],
  nameOf: (item: T) => string,
): ShortcutChoice<T> | null {
  const keys = candidateKeys(spoken);
  if (keys.length === 0) return null;

  let best: { item: T; raw: number; total: number } | null = null;
  let runnerUp = 0;

  for (const item of items) {
    const words = normalise(nameOf(item)).split(' ').filter(Boolean);
    if (words.length === 0) continue;

    let score = 0;
    for (const key of keys) {
      let bestForKey = 0;
      for (const word of words) {
        const value = scoreWord(key, word);
        if (value > bestForKey) bestForKey = value;
      }
      score += bestForKey;
    }
    // One solid word is enough. Dividing by the shortcut's length would sink
    // «эпик» inside "Epic Games Launcher" — one word of three — even though it
    // is exactly the program meant.
    if (score < 2) continue;

    // Length only breaks ties: asked for «риот», the short "Riot Client" beats
    // a longer name that merely contains the same word.
    const total = score - words.length * 0.1;

    if (!best || total > best.total) {
      if (best) runnerUp = best.total;
      best = { item, raw: score, total };
    } else if (total > runnerUp) {
      runnerUp = total;
    }
  }

  if (!best) return null;

  // A word that actually matched is enough on its own. A merely similar sound
  // has to be the clear winner.
  const confident = best.raw >= 2;
  return { item: best.item, score: best.total, confident };
}
