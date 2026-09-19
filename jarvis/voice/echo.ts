/**
 * Защита от собственного голоса.
 *
 * Микрофон слышит колонки. Джарвис сказал «Открываю блендер», распознаватель
 * это записал, и ассистент выполнил свою же реплику как команду — в журнале
 * действий это видно прямой записью «сделал: Открываю блендер».
 *
 * Отключать микрофон на время речи нельзя: тогда исчезает перебивание, ради
 * которого он и слушает. Поэтому услышанное сверяется с только что сказанным,
 * и совпавшее отбрасывается.
 *
 * Слова остановки — исключение, и это не мелочь: их говорят поверх речи
 * нарочно, и они обязаны доходить всегда, даже когда звучат похоже на то, что
 * произносит сам Джарвис.
 */

import { transliterate } from '../apps/startMenu';

/** Перебивание должно работать всегда. */
const INTERRUPTIONS = /^\s*(стоп|стой|тишина|тише|хватит|замолчи|молчи|отбой|спи)\b/iu;

export interface EchoOptions {
  now?: () => number;
  /** Сколько сказанное считается свежим. */
  windowMs?: number;
  /** Сколько последних реплик помнить. */
  keep?: number;
  /** Доля совпавших слов, после которой это эхо. */
  threshold?: number;
}

interface Spoken {
  at: number;
  keys: Set<string>;
  joined: string;
}

export class EchoGuard {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly keep: number;
  private readonly threshold: number;
  private recent: Spoken[] = [];

  constructor(options: EchoOptions = {}) {
    this.now = options.now ?? Date.now;
    this.windowMs = options.windowMs ?? 15_000;
    this.keep = options.keep ?? 3;
    this.threshold = options.threshold ?? 0.6;
  }

  /** Запоминает, что Джарвис только что произнёс. */
  spoke(text: string): void {
    const words = keysOf(text);
    if (words.length === 0) return;

    this.recent.push({ at: this.now(), keys: new Set(words), joined: words.join(' ') });
    if (this.recent.length > this.keep) this.recent = this.recent.slice(-this.keep);
  }

  /** Это то, что Джарвис сам только что сказал? */
  isOwnVoice(heard: string): boolean {
    // Перебивание проходит всегда — иначе человек не может остановить речь.
    if (INTERRUPTIONS.test(heard)) return false;

    const words = keysOf(heard);
    if (words.length === 0) return false;

    const joined = words.join(' ');
    const fresh = this.now() - this.windowMs;

    for (const item of this.recent) {
      if (item.at < fresh) continue;

      // Одного слова мало, чтобы отличить эхо от короткой команды: «да»,
      // «нет», «стим» глушить нельзя. Поэтому одиночное слово считается эхом
      // только тогда, когда вся реплика Джарвиса из него и состояла —
      // «Готово.» возвращается из колонок именно так.
      if (words.length < 2) {
        if (item.joined === joined) return true;
        continue;
      }

      // Целиком сказанное — самый частый случай: короткая реплика ассистента
      // возвращается из колонок дословно.
      if (item.joined.includes(words.join(' '))) return true;

      const matched = words.filter((word) => item.keys.has(word)).length;
      if (matched / words.length >= this.threshold) return true;
    }
    return false;
  }
}

/**
 * Слова в виде, устойчивом к распознаванию.
 *
 * «Закрыл Steam» приходит обратно как «закрыл стим»: распознаватель пишет
 * кириллицей то, что синтезатор произнёс по-английски. Транслитерация сводит
 * оба написания к латинице, а выброшенные гласные — к общему скелету.
 */
function keysOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[«»"'`.,!?;:()\-—–]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .map(soundKey)
    .filter(Boolean);
}

function soundKey(word: string): string {
  const latin = transliterate(word);
  const skeleton = latin.replace(/[aeiouy]/gu, '');
  // Совсем короткие слова без гласных превращаются в одну букву и начинают
  // совпадать со всем подряд — их берём как есть.
  return skeleton.length >= 2 ? skeleton : latin;
}
