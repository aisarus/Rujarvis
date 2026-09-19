/**
 * Splitting a response into what is shown and what is said.
 *
 * An agent that finishes a five-paragraph analysis and then reads all five
 * paragraphs out loud is unusable. The screen gets the full answer; the voice
 * gets one to three short sentences — the outcome, not the reasoning.
 *
 * A backend is asked to lead with a one-sentence outcome, so the first
 * sentences are usually already the right thing to say. This module makes that
 * robust rather than assumed: it strips the parts that make no sense aloud
 * (code blocks, paths, bullet syntax, URLs) and falls back to a generated
 * summary when nothing speakable survives.
 */

export interface SpokenSplit {
  /** Everything, for the UI. */
  full: string;
  /** One to three short sentences, for TTS. */
  spoken: string;
}

export interface SpokenSplitOptions {
  /** How many sentences to speak. */
  maxSentences?: number;
  /** Hard ceiling on spoken characters. */
  maxChars?: number;
}

/**
 * Сколько говорить вслух.
 *
 * Было три предложения и 280 знаков, и это оказалось мало до вреда. Замер из
 * журнала: на вопрос «какие три вопроса в конце брейншторма» ответ обрывался
 * на первом же пункте, посреди фразы — человек услышал огрызок и решил, что
 * помощник не понял вопроса.
 *
 * Восемь предложений и девятьсот знаков — это около минуты речи. Много для
 * подтверждения «готово», в самый раз для ответа на вопрос. Перебить можно в
 * любой момент: достаточно заговорить.
 */
const DEFAULT_MAX_SENTENCES = 8;
const DEFAULT_MAX_CHARS = 900;

/** Чем сказать, что сказано не всё. Молчаливый обрыв читается как поломка. */
const THERE_IS_MORE = 'Дальше — на экране.';

/** Removes anything that is noise when read aloud. */
export function stripUnspeakable(text: string): string {
  return text
    // Fenced code: never read code out loud.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    // Markdown emphasis and headings.
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    // Bullets and numbering become sentence breaks, not spoken symbols.
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    // Links: keep the label, drop the target.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Splits into sentences, treating a newline as a boundary too. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * True when a sentence is worth saying out loud.
 *
 * Lines that are really data — a path, a diff header, a bare filename — read
 * terribly and carry nothing the screen is not already showing better.
 */
function isSpeakable(sentence: string): boolean {
  if (sentence.length < 2) return false;
  if (/^[\s\p{P}]+$/u.test(sentence)) return false;
  // A line that is mostly path separators or punctuation is data, not speech.
  const letters = (sentence.match(/\p{L}/gu) ?? []).length;
  if (letters < sentence.length * 0.4) return false;
  if (/^[A-Za-z]:[\\/]/.test(sentence)) return false;
  if (/^[\w./\\-]+\.(ts|tsx|js|json|py|rs|go|md|yml|yaml|toml)$/i.test(sentence)) return false;
  return true;
}

/** Shortens an over-long sentence at a clause boundary, not mid-word. */
function shorten(sentence: string, limit: number): string {
  if (sentence.length <= limit) return sentence;
  const clause = sentence.slice(0, limit);
  const cut = Math.max(clause.lastIndexOf(', '), clause.lastIndexOf('; '), clause.lastIndexOf(' — '));
  if (cut > limit * 0.5) return `${clause.slice(0, cut)}.`;
  const space = clause.lastIndexOf(' ');
  return `${clause.slice(0, space > 0 ? space : limit)}…`;
}

/**
 * Produces the spoken version of a response.
 *
 * `fallback` is used when the text contains nothing speakable at all — a
 * response that is entirely a code block, for example.
 */
export function toSpokenResponse(
  full: string,
  options: SpokenSplitOptions & { fallback?: string } = {},
): SpokenSplit {
  const maxSentences = options.maxSentences ?? DEFAULT_MAX_SENTENCES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const speakableText = stripUnspeakable(full);
  const sentences = splitSentences(speakableText).filter(isSpeakable);

  const picked: string[] = [];
  let length = 0;
  let dropped = false;

  for (const sentence of sentences) {
    if (picked.length >= maxSentences) {
      dropped = true;
      break;
    }
    const remaining = maxChars - length;
    if (remaining <= 20) {
      dropped = true;
      break;
    }

    // Целыми предложениями, а не по знакам.
    //
    // Обрыв посреди фразы — худший вид ответа: человек слышит огрызок и не
    // может отличить его от поломки. Длинное предложение всё же режем, но
    // только если оно первое: иначе сказать было бы вовсе нечего.
    if (sentence.length > remaining) {
      if (picked.length === 0) {
        picked.push(shorten(sentence, remaining));
      }
      dropped = true;
      break;
    }

    picked.push(sentence);
    length += sentence.length + 1;
  }

  if (dropped && picked.length > 0) picked.push(THERE_IS_MORE);

  const spoken = picked.join(' ').trim();
  return {
    full,
    spoken: spoken || options.fallback || 'Готово. Подробности на экране.',
  };
}

/** The spoken line for a task that failed. */
export function spokenFailure(error: string | undefined): string {
  if (!error) return 'Не получилось. Подробности на экране.';
  const cleaned = stripUnspeakable(error);
  const first = splitSentences(cleaned)[0] ?? '';
  return isSpeakable(first) ? `Не получилось. ${shorten(first, 160)}` : 'Не получилось. Подробности на экране.';
}
