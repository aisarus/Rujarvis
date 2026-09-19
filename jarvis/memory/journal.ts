/**
 * Память о том, что Джарвис уже делал.
 *
 * Без неё каждая фраза человека висит в пустоте: «а где он?», «переделай»,
 * «закрой его» — всё это указывает на то, что было минуту назад, и ассистент,
 * не помнящий своих действий, честно не понимает, о чём речь.
 *
 * Помнить всё подряд нельзя: журнал за день не поместится ни в какой запрос и
 * вытеснит собой саму задачу. Поэтому память не плоская, а с градиентом —
 * чем старше событие, тем короче от него остаётся:
 *
 *   только что   → дословно, как было записано
 *   до этого     → сводка: что запускал, что делал, сколько
 *   ранее        → одно число
 *
 * Свежее человек помнит сам и спросит именно про него; старое нужно лишь для
 * ощущения, что разговор продолжается, а не начинается заново.
 */

export type EventKind = 'launch' | 'close' | 'command' | 'result' | 'file' | 'note' | 'error';

export interface JarvisEvent {
  /** Когда произошло. */
  at: number;
  kind: EventKind;
  /** Короткая фраза по-русски: «открыл Chrome», «сделал закат.png». */
  text: string;
  /** О чём событие, если это нельзя вывести из текста. */
  subject?: string;
}

export interface GradientOptions {
  now?: number;
  /** До этого возраста событие передаётся дословно. */
  freshMs?: number;
  /** До этого возраста — сводкой; всё старше превращается в число. */
  recentMs?: number;
  /** Сколько дословных событий поместится, прежде чем начнётся «и ещё». */
  maxFresh?: number;
}

const FRESH_MS = 10 * 60_000;
const RECENT_MS = 120 * 60_000;
const MAX_FRESH = 8;
const MAX_NAMES = 5;

/** Глаголы, которыми Джарвис описывает свои действия. */
const VERBS = new Set([
  'открыл', 'закрыл', 'запустил', 'сделал', 'создал', 'сохранил', 'нашёл',
  'нашел', 'записал', 'запомнил', 'показал', 'отрендерил', 'скачал', 'перенёс',
  'перенес', 'отправил', 'прочитал',
]);

const LABELS: Record<EventKind, string> = {
  launch: 'запускал',
  close: 'закрывал',
  command: 'просил',
  result: 'делал',
  file: 'файлы',
  note: 'запоминал',
  error: 'не получилось',
};

export function contextGradient(
  events: readonly JarvisEvent[],
  options: GradientOptions = {},
): string[] {
  const now = options.now ?? Date.now();
  const freshMs = options.freshMs ?? FRESH_MS;
  const recentMs = options.recentMs ?? RECENT_MS;
  const maxFresh = options.maxFresh ?? MAX_FRESH;

  const sorted = [...events].sort((a, b) => b.at - a.at);

  const fresh: JarvisEvent[] = [];
  const recent: JarvisEvent[] = [];
  let older = 0;

  for (const item of sorted) {
    const age = now - item.at;
    if (age <= freshMs) fresh.push(item);
    else if (age <= recentMs) recent.push(item);
    else older += 1;
  }

  const lines: string[] = [];

  if (fresh.length > 0) {
    // Повтор одного действия — это одно намерение, а не несколько фактов.
    const unique = dedupe(fresh.map((item) => item.text));
    const shown = unique.slice(0, maxFresh);
    const rest = unique.length - shown.length;
    lines.push(`Только что: ${shown.join('; ')}${rest > 0 ? ` и ещё ${rest}` : ''}.`);
  }

  if (recent.length > 0) {
    lines.push(`До этого: ${summarise(recent)}.`);
  }

  if (older > 0) {
    lines.push(`Ранее: ещё ${older} ${plural(older)}.`);
  }

  return lines;
}

/**
 * Сводка считает, а не пересказывает.
 *
 * «запускал Steam, Dota» вместо трёх строк «открыл Steam» — то же знание в
 * пятой части места.
 */
function summarise(events: readonly JarvisEvent[]): string {
  const groups = new Map<EventKind, string[]>();
  for (const item of events) {
    const names = groups.get(item.kind) ?? [];
    names.push(item.subject ?? subjectOf(item.text));
    groups.set(item.kind, names);
  }

  const parts: string[] = [];
  for (const [kind, names] of groups) {
    const unique = dedupe(names);
    const shown = unique.slice(0, MAX_NAMES);
    const rest = unique.length - shown.length;
    parts.push(`${LABELS[kind]} ${shown.join(', ')}${rest > 0 ? ` и ещё ${rest}` : ''}`);
  }
  return parts.join('; ');
}

/**
 * Что осталось от фразы, если убрать глагол.
 *
 * Глаголы Джарвис пишет сам, поэтому список закрытый и надёжный. Чужую фразу,
 * начинающуюся незнакомым словом, трогать нельзя — из неё выбросится смысл.
 */
function subjectOf(text: string): string {
  const space = text.indexOf(' ');
  if (space === -1) return text;

  const first = text.slice(0, space).toLowerCase();
  if (!VERBS.has(first)) return text;
  return text.slice(space + 1).trim() || text;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function plural(count: number): string {
  const tens = count % 100;
  if (tens >= 11 && tens <= 14) return 'действий';
  switch (count % 10) {
    case 1:
      return 'действие';
    case 2:
    case 3:
    case 4:
      return 'действия';
    default:
      return 'действий';
  }
}
