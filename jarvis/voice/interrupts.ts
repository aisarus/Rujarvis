/**
 * Local voice controls.
 *
 * «Стоп» has to stop things *now*. Routing it through a large model means the
 * user watches the assistant keep typing into their editor for two more
 * seconds while a token stream catches up — which is exactly the moment that
 * destroys trust in a voice assistant.
 *
 * So control words are recognised here, synchronously, with no model and no
 * network. The match is deliberately strict: these words cancel work, so a
 * false positive is expensive, and «стоп» inside a longer sentence («стоп
 * слово», «останови сервис после тестов») must not fire.
 */

import { normalizeForMatching, tokenize } from '../router/text';
import { stripFiller } from './filler';

export type VoiceControl = 'stop' | 'cancel' | 'pause' | 'resume' | 'mute';

export interface ControlMatch {
  control: VoiceControl;
  /** The phrase that matched, for the UI. */
  phrase: string;
}

/**
 * Phrases that map to a control, as whole utterances.
 *
 * Each entry is a complete short utterance, not a substring: a control fires
 * only when the user said essentially nothing else.
 */
const CONTROL_PHRASES: Array<{ control: VoiceControl; phrases: string[] }> = [
  {
    control: 'stop',
    phrases: [
      'стоп', 'стой', 'хватит', 'прекрати', 'остановись', 'стопэ',
      // «Останови всё» человек кричал живьём, и оно не сработало: фраза ушла
      // в ящик правок и приклеилась к просьбе сделать ракету. Агент получил
      // приказ сделать и тут же остановить.
      'останови', 'останови все', 'останови всё', 'остановите', 'отставить',
      'все хватит', 'да хватит', 'блядь хватит', 'стоп стоп', 'стоп стоп стоп',
      'тормози', 'заткнись', 'молчи', 'стоп джарвис', 'джарвис стоп',
    ],
  },
  {
    control: 'cancel',
    phrases: [
      'отмена', 'отмени', 'отменяй', 'не надо', 'не делай это', 'не делай',
      'забудь', 'отбой', 'отставить',
    ],
  },
  {
    control: 'pause',
    phrases: [
      'пауза', 'паузу', 'на паузу', 'поставь на паузу', 'поставь паузу',
      'подожди', 'погоди', 'секунду', 'минуту', 'притормози', 'обожди',
    ],
  },
  {
    control: 'resume',
    phrases: [
      'продолжай', 'продолжи', 'дальше', 'давай дальше', 'поехали',
      'продолжаем', 'продолжай дальше',
    ],
  },
  {
    control: 'mute',
    // «Тишина» здесь не было, хотя справочник команд обещал её человеку прямым
    // текстом. То есть Джарвис сам учил слову, которого не понимал, и на
    // просьбу замолчать продолжал говорить. Заглушение — красная линия: оно
    // обязано срабатывать всегда и мгновенно.
    //
    // «Выключи звук» здесь нет, хотя просьба похожая. Справочник обещает этой
    // фразой системную громкость, а слова остановки разбираются раньше
    // таблицы команд — то есть до громкости фраза не доезжала никогда, и
    // справочник врал, сам того не зная. Заглушить Джарвиса есть чем и без
    // неё; отобрать у человека громкость было нечем.
    phrases: [
      'тишина', 'тишину', 'тихо', 'тише', 'помолчи', 'помолчите', 'молчание',
      'не говори', 'не говори ничего', 'без голоса',
      'замолкни', 'прекрати говорить', 'хватит говорить',
    ],
  },
];

/** Filler that may surround a control word without changing it. */
/**
 * Своя добавка к общим заполнителям.
 *
 * «Да», «нет», «всё», «ладно» безвредны рядом со «стоп», но не везде:
 * «показывай всё» — настоящая команда, и общим списком их выбрасывать нельзя.
 * Поэтому они живут здесь, а не в `SPEECH_FILLER`.
 */
const IGNORABLE_HERE = ['так', 'ладно', 'okay', 'ок', 'окей', 'да', 'нет', 'все'];

const MAX_CONTROL_TOKENS = 4;

/**
 * Recognises a control utterance.
 *
 * Returns null for anything that is not clearly one of them, including a
 * sentence that merely *contains* a control word — «останови сервис после
 * тестов» is a task, not an interrupt.
 */
export function matchVoiceControl(transcript: string): ControlMatch | null {
  const normalized = normalizeForMatching(transcript);
  if (!normalized) return null;

  const tokens = tokenize(transcript);
  if (tokens.length > MAX_CONTROL_TOKENS) return null;

  // Обёртки снимаются тем же списком, что и в разборе команд. Раньше здесь был
  // свой, и он не знал ни «быстро», ни «а теперь»: из 36 естественных форм
  // «стоп» и «тишины» не доходили 24.
  const meaningful = stripFiller(tokens, IGNORABLE_HERE);
  const candidates = [normalized, meaningful.join(' ')].filter(Boolean);

  for (const { control, phrases } of CONTROL_PHRASES) {
    for (const phrase of phrases) {
      if (candidates.includes(phrase)) {
        return { control, phrase };
      }
    }
  }
  return null;
}

export type ControlOutcome =
  | { action: 'stopped'; spoken: string }
  | { action: 'paused'; spoken: string }
  | { action: 'resumed'; spoken: string }
  | { action: 'muted'; spoken: string }
  | { action: 'nothing'; spoken: string };

/** What Jarvis is able to do when a control word arrives. */
export interface ControlTarget {
  /** Stops the foreground task. Returns whether anything was stopped. */
  cancelForeground(): boolean;
  /** Pauses the foreground task, keeping its session. */
  pauseForeground(): boolean;
  /** Resumes the most recently paused task. */
  resumeLast(): boolean;
  /** Stops speech playback. */
  stopSpeaking(): void;
}

/**
 * Applies a control immediately.
 *
 * Note the ordering for «стоп»: speech is stopped first, then the task. The
 * assistant going quiet is the feedback the user is waiting for, and it costs
 * nothing.
 */
export function applyVoiceControl(match: ControlMatch, target: ControlTarget): ControlOutcome {
  switch (match.control) {
    case 'stop':
    case 'cancel': {
      target.stopSpeaking();
      const stopped = target.cancelForeground();
      return stopped
        ? { action: 'stopped', spoken: 'Остановил.' }
        : { action: 'nothing', spoken: 'Нечего останавливать.' };
    }
    case 'pause': {
      target.stopSpeaking();
      const paused = target.pauseForeground();
      return paused
        ? { action: 'paused', spoken: 'Пауза.' }
        : { action: 'nothing', spoken: 'Сейчас нечего ставить на паузу.' };
    }
    case 'resume': {
      const resumed = target.resumeLast();
      return resumed
        ? { action: 'resumed', spoken: 'Продолжаю.' }
        : { action: 'nothing', spoken: 'Нечего продолжать.' };
    }
    case 'mute': {
      target.stopSpeaking();
      return { action: 'muted', spoken: '' };
    }
  }
}
