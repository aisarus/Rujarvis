/**
 * Wake word detection for «Джарвис».
 *
 * Always-listening mode runs a small STT continuously, so the text arriving
 * here is not clean: Russian ASR hears «джарвис» as «джарвес», «жарвис»,
 * «чарвис», «джарвиз», and splits it across a word boundary as «джар вис».
 * Requiring an exact match would mean the assistant ignores its own name
 * several times a day.
 *
 * So matching is fuzzy but bounded: a small set of spelled variants plus an
 * edit-distance check against a single token. The check runs on every
 * transcript chunk, so it must stay cheap — no model, no allocation per frame
 * beyond the tokens themselves.
 */

import { tokenize } from '../router/text';

/** How the wake word is written when it is written correctly. */
export const WAKE_WORD = 'Джарвис';

/**
 * Spellings a Russian ASR actually produces for the wake word.
 *
 * Kept explicit rather than derived, because each one was worth adding: they
 * are the shapes that cost a user a missed activation.
 */
export const WAKE_WORD_VARIANTS = [
  'джарвис',
  'джарвес',
  'джарвиз',
  'джарвись',
  'джарвиc',
  'жарвис',
  'чарвис',
  'дживс',
  'джервис',
  'дарвис',
  // Английское распознавание пишет имя латиницей и тоже путает его.
  'jarvis',
  'jervis',
  'jarviss',
  'jarvus',
  'jarvas',
  'jarves',
  'javis',
];

/** Two-token spellings, for when the recogniser splits the name. */
const SPLIT_VARIANTS: string[][] = [
  ['джар', 'вис'],
  ['джар', 'виз'],
  ['джа', 'рвис'],
  ['jar', 'vis'],
  ['jar', 'viz'],
];

/** Levenshtein distance, capped: anything past `limit` is simply "too far". */
export function editDistance(a: string, b: string, limit = 3): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      current[j] = value;
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length] as number;
}

/** Distance tolerated for a token of this length. */
function toleranceFor(token: string): number {
  if (token.length <= 4) return 0;
  if (token.length <= 6) return 1;
  return 2;
}

/**
 * The word with its vowels removed.
 *
 * Russian ASR mangles the vowels of an isolated name far more than its
 * consonants: «Джарвис» came back from a live microphone as «Жаравес» and
 * «Ужарвес», both three or fewer edits away as written but identical once the
 * vowels are gone. Comparing skeletons catches that family without loosening
 * the whole-word tolerance, which would start admitting ordinary speech.
 */
function consonantSkeleton(token: string): string {
  return token.replace(/[аеёиоуыэюяьъ]/gu, '');
}

const WAKE_SKELETON = consonantSkeleton('джарвис');

/**
 * Латинское написание: одна правка от «jarvis», и только если слово начинается
 * с «j». Без этого условия просыпались бы «travis» и «harvey» — обычные имена,
 * которые звучат в разговоре рядом.
 */
function matchesLatinWakeToken(token: string): boolean {
  if (!token.startsWith('j') || token.length < 5 || token.length > 8) return false;
  return editDistance(token, 'jarvis', 1) <= 1;
}

function matchesWakeToken(token: string): boolean {
  if (WAKE_WORD_VARIANTS.includes(token)) return true;
  if (/^[a-z]+$/u.test(token)) return matchesLatinWakeToken(token);
  // Only test tokens of a plausible length — «да» must never wake Jarvis.
  if (token.length < 5 || token.length > 10) return false;
  if (editDistance(token, 'джарвис', 3) <= toleranceFor(token)) return true;

  const skeleton = consonantSkeleton(token);
  // One consonant may go missing — the leading «д» routinely does.
  if (editDistance(skeleton, WAKE_SKELETON, 2) <= 1) return true;

  // Two may go wrong only when the name's two distinctive marks both survived:
  // the «ж», and one of the «рв» in the middle. «Бжаргес» — a real microphone
  // recording of the name — keeps both. «Джинсы» keeps only the «ж», and
  // without this second condition it wakes the assistant.
  return (
    token.includes('ж') &&
    /[рв]/u.test(skeleton) &&
    editDistance(skeleton, WAKE_SKELETON, 3) <= 2
  );
}

export interface WakeWordMatch {
  /** Where the wake word started, as a token index. */
  index: number;
  /** How many tokens the wake word occupied (2 when it was split). */
  length: number;
  /** The words that followed it, if any. */
  command: string;
}

/**
 * Finds the wake word in a transcript.
 *
 * Returns the command that followed it in the same breath, which is how people
 * actually talk: «Джарвис, закрой это окно» is one utterance, not a wake
 * followed by a pause.
 */
export function findWakeWord(transcript: string): WakeWordMatch | null {
  const tokens = tokenize(transcript);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;

    if (matchesWakeToken(token)) {
      return {
        index,
        length: 1,
        command: rebuildCommand(transcript, tokens, index + 1),
      };
    }

    const next = tokens[index + 1];
    if (next && SPLIT_VARIANTS.some(([a, b]) => token === a && next === b)) {
      return {
        index,
        length: 2,
        command: rebuildCommand(transcript, tokens, index + 2),
      };
    }
  }
  return null;
}

/**
 * Recovers the tail of the original transcript, with its own casing and
 * punctuation, starting at token `from`.
 *
 * The user's words are what reaches a backend, so the tail is cut out of the
 * original string rather than rebuilt from normalised tokens — «открой Chrome»
 * must not come back as «открой chrome».
 */
function rebuildCommand(original: string, tokens: readonly string[], from: number): string {
  if (from >= tokens.length) return '';

  // После имени остался один вопросительный знак — значит, команды не было.
  //
  // `tokenize` добавляет '?' отдельным токеном, и «Джарвис?» возвращало
  // команду '?': мост считал её непустой и нёс в ядро знак препинания.
  if (tokens.slice(from).every((token) => token === '?')) return '';

  // `tokenize` splits on exactly these runs, so the n-th run in the original
  // string is the n-th token.
  const runs = [...original.matchAll(/[\p{L}\p{N}]+/gu)];
  const run = runs[from];
  if (!run || run.index === undefined) {
    return tokens.slice(from).join(' ');
  }
  return original.slice(run.index).trim();
}

export type WakeState = 'idle' | 'awake';

export interface WakeEvent {
  type: 'wake' | 'command' | 'ignored';
  /** Present for 'wake' (when spoken in the same breath) and for 'command'. */
  command?: string;
}

export interface WakeWordListenerOptions {
  /** How long the assistant stays awake after the word, in milliseconds. */
  awakeWindowMs?: number;
  now?: () => number;
}

/**
 * Tracks whether Jarvis is currently awake.
 *
 * Two shapes are supported because both happen constantly:
 *   «Джарвис, закрой это окно»   — one breath, command included
 *   «Джарвис.» … «Закрой окно.»  — wake, pause, command
 *
 * The awake window closes on its own, so a wake word overheard on a video does
 * not leave the microphone armed for the rest of the day.
 */
export class WakeWordListener {
  private state: WakeState = 'idle';
  private awakeUntil = 0;
  private readonly now: () => number;

  constructor(private readonly options: WakeWordListenerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  get currentState(): WakeState {
    return this.isAwake() ? 'awake' : 'idle';
  }

  private isAwake(): boolean {
    if (this.state !== 'awake') return false;
    if (this.now() > this.awakeUntil) {
      this.state = 'idle';
      return false;
    }
    return true;
  }

  /** Feeds one transcript chunk and returns what should happen. */
  accept(transcript: string): WakeEvent {
    const match = findWakeWord(transcript);

    if (match) {
      if (match.command) {
        // Named and instructed in one breath: run it, stay awake for a
        // follow-up like «нет, другой».
        this.arm();
        return { type: 'wake', command: match.command };
      }
      this.arm();
      return { type: 'wake' };
    }

    if (this.isAwake()) {
      const command = transcript.trim();
      if (!command) return { type: 'ignored' };
      // Speaking keeps the conversation open. Naming the assistant before
      // every sentence is fine for a one-off command and unusable for someone
      // working by voice, so the window is ended by silence, not by having
      // been used once.
      this.arm();
      return { type: 'command', command };
    }

    return { type: 'ignored' };
  }

  private arm(): void {
    this.state = 'awake';
    this.awakeUntil = this.now() + (this.options.awakeWindowMs ?? 8_000);
  }

  /** Arms the listener directly — this is what push-to-talk does. */
  wake(): void {
    this.arm();
  }

  reset(): void {
    this.state = 'idle';
    this.awakeUntil = 0;
  }
}
