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

import { tr } from '../locale/language';
import { normalizeForMatching, tokenize } from '../router/text';
import { stripFiller } from './filler';
import { editDistance } from './wakeWord';

export type VoiceControl = 'stop' | 'cancel' | 'pause' | 'resume' | 'mute';

export interface ControlMatch {
  /**
   * Просили остановить ВСЁ, а не только то, что на переднем плане.
   *
   * «Останови всё», «stop everything». Прежде «всё» при сопоставлении
   * отбрасывалось как слово-вставка, и фраза становилась обычным «стоп», а
   * тот гасит только переднюю работу: человек говорил «останови всё», а
   * фоновая работа шла дальше.
   */
  всё?: boolean;
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
      // Английские — всегда, в любом режиме: остановка не должна зависеть от
      // того, какой язык выбран в настройках.
      'stop', 'stop it', 'stop that', 'stop now', 'stop stop', 'stop jarvis', 'jarvis stop',
      'enough', 'halt', 'abort', 'stop everything', 'stop all',
    ],
  },
  {
    control: 'cancel',
    phrases: [
      'отмена', 'отмени', 'отменяй', 'не надо', 'не делай это', 'не делай',
      'забудь', 'отбой', 'отставить',
      'cancel', 'cancel that', 'cancel it', 'never mind', 'nevermind', 'forget it', 'don t',
    ],
  },
  {
    control: 'pause',
    phrases: [
      'пауза', 'паузу', 'на паузу', 'поставь на паузу', 'поставь паузу',
      'подожди', 'погоди', 'секунду', 'минуту', 'притормози', 'обожди',
      'pause', 'pause it', 'wait', 'hold on', 'hang on', 'one second', 'one moment',
    ],
  },
  {
    control: 'resume',
    phrases: [
      'продолжай', 'продолжи', 'дальше', 'давай дальше', 'поехали',
      'продолжаем', 'продолжай дальше',
      'continue', 'resume', 'go on', 'keep going', 'carry on',
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
      'silence', 'quiet', 'be quiet', 'shut up', 'shush', 'hush', 'stop talking',
      'mute', 'no voice',
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
const IGNORABLE_HERE = ['так', 'ладно', 'okay', 'ок', 'окей', 'да', 'нет', 'все', 'ok', 'yes', 'no', 'right', 'please'];

const MAX_CONTROL_TOKENS = 4;

const ВСЁ = ['все', 'всё', 'everything', 'all'];

/**
 * «Всё» ПОСЛЕ глагола — это «всё», а ДО — это «хватит».
 *
 * «Останови всё» и «stop everything» просят погасить всю работу. «Всё,
 * останови» и «all right, stop» — просто остановка: там «всё» значит «хватит»,
 * и гасить из-за него фоновую работу, которую человек не называл, нельзя.
 */
function проВсё(tokens: readonly string[]): boolean {
  const глагол = tokens.findIndex((t) => !ВСЁ.includes(t) && !IGNORABLE_HERE.includes(t));
  return глагол >= 0 && tokens.slice(глагол + 1).some((t) => ВСЁ.includes(t));
}

/**
 * Главные слова красных линий — для узнавания по ЗВУЧАНИЮ.
 *
 * Замер 26.09.2026 синтезом Piper → Whisper: на «Тишина» распознаватель
 * выдавал то «Дишина», то «Дышина», на «Пауза» — «бауза». Каждый прогон давал
 * новую ошибку: синтез каждый раз звучит чуть иначе. Ловить их списком по
 * одной — бесконечно, а пропуск здесь самый дорогой из всех: человек просит
 * замолчать, а Джарвис продолжает.
 *
 * Здесь только слова, у которых промах по звучанию НАБЛЮДАЛСЯ. Первая версия
 * брала ещё «продолжай» и английские — «для полноты», — и сторож тут же
 * поймал беду: собственный ответ Джарвиса «Продолжаю.» отстоит от
 * «продолжай» на одну букву и читался бы как команда. Свой голос из колонок
 * запускал бы сам себя.
 *
 * «Стоп» и «stop» тут нет тоже нарочно: четыре буквы, слишком много
 * настоящих соседей в одну ошибку («стол», «сток»), а на «top» уже стоит
 * поправка целой фразой в `mishearing.ts`. Единственный английский промах
 * красной линии — «4s» вместо «pause» — не созвучие, и он живёт там же.
 */
const ГЛАВНЫЕ_СЛОВА: ReadonlyArray<readonly [VoiceControl, string]> = [
  ['mute', 'тишина'],
  ['pause', 'пауза'],
];

/**
 * Как слово звучит, а не как пишется.
 *
 * Whisper путает то, что и на слух близко: звонкую и глухую пару («дышина»,
 * «бауза») и безударные гласные («тешина», «тишена»). Сводим их к одному
 * написанию и уже потом считаем ошибки.
 *
 * Без этого допуск пришлось бы давать в две буквы, и тогда «машина» — ответ,
 * который человек вполне может дать в разговоре, — заглушала бы Джарвиса: от
 * «тишины» она отстоит на те же две буквы, что и «дышина». По звучанию
 * «машина» остаётся на двух ошибках (м — не пара «т»), а «дышина» сходится в
 * ноль.
 */
function звучание(слово: string): string {
  return слово
    .toLowerCase()
    .replace(/[ёеэы]/gu, 'и')
    .replace(/о/gu, 'а')
    .replace(/д/gu, 'т')
    .replace(/б/gu, 'п')
    .replace(/з/gu, 'с')
    .replace(/г/gu, 'к')
    .replace(/в/gu, 'ф')
    .replace(/ж/gu, 'ш');
}

/**
 * Красная линия по звучанию: одно слово, близкое к главному.
 *
 * Одна ошибка после сведения звучания. Ложное срабатывание здесь дешёвое —
 * Джарвис замолчит или подождёт, — а пропуск нет.
 */
export function главноеСловоПоЗвучанию(слово: string): VoiceControl | null {
  const услышано = звучание(слово);
  for (const [control, главное] of ГЛАВНЫЕ_СЛОВА) {
    if (editDistance(услышано, звучание(главное), 2) <= 1) return control;
  }
  return null;
}

/**
 * Что сильнее, когда слова управления сказаны подряд.
 *
 * Остановка глушит речь и гасит работу, пауза глушит речь и держит работу,
 * заглушение только глушит речь. Из «тишина, стоп» исполняется «стоп»: он
 * делает и то, о чём просит «тишина». «Продолжай» в такой смеси не участвует:
 * «стоп, продолжай» противоречит само себе, и угадывать здесь нельзя.
 */
const СИЛА: readonly VoiceControl[] = ['stop', 'cancel', 'pause', 'mute'];

/** Фраза списка → чем она управляет; порядок списков тот же, что у точной сверки. */
function управлениеФразы(фраза: string): VoiceControl | null {
  for (const { control, phrases } of CONTROL_PHRASES) if (phrases.includes(фраза)) return control;
  return null;
}

/**
 * Фраза, целиком составленная из слов управления: «тишина стоп», «стоп,
 * хватит говорить», «silence, stop».
 *
 * Живая запись 28.09.2026: человек сказал «тишина стоп» — и не сработало
 * ничего. Каждое слово по отдельности — красная линия, а вместе они не
 * совпадали ни с одной фразой списка и уходили дальше, к разбору команд.
 * Каждый кусок здесь — фраза списка или одно слово, узнанное по звучанию, как
 * и в одиночку; из найденного исполняется самое сильное.
 */
function управлениеПодряд(слова: readonly string[]): VoiceControl | null {
  if (слова.length < 2) return null;
  const разбор = (от: number): VoiceControl[] | null => {
    if (от === слова.length) return [];
    for (let до = слова.length; до > от; до -= 1) {
      const кусок = слова.slice(от, до);
      const control =
        управлениеФразы(кусок.join(' ')) ?? (кусок.length === 1 ? главноеСловоПоЗвучанию(кусок[0] as string) : null);
      if (!control || control === 'resume') continue;
      const дальше = разбор(до);
      if (дальше) return [control, ...дальше];
    }
    return null;
  };
  const найдено = разбор(0);
  return найдено ? (СИЛА.find((c) => найдено.includes(c)) ?? null) : null;
}

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

  // Вопросительный знак приезжает от `tokenize` отдельным токеном — он несёт
  // интонацию, а не слово. Здесь он только мешал: «Джарвис, хватит?» давало
  // осмысленное «хватит ?», ни с чем не совпадало, и остановка не срабатывала.
  // А остановка — одна из четырёх красных линий, она обязана работать всегда.
  const tokens = tokenize(transcript).filter((token) => token !== '?');
  if (tokens.length > MAX_CONTROL_TOKENS) return null;

  // Обёртки снимаются тем же списком, что и в разборе команд. Раньше здесь был
  // свой, и он не знал ни «быстро», ни «а теперь»: из 36 естественных форм
  // «стоп» и «тишины» не доходили 24.
  const meaningful = stripFiller(tokens, IGNORABLE_HERE);
  const candidates = [normalized, meaningful.join(' ')].filter(Boolean);

  for (const { control, phrases } of CONTROL_PHRASES) {
    for (const phrase of phrases) {
      if (candidates.includes(phrase)) {
        const остановка = control === 'stop' || control === 'cancel';
        return остановка && проВсё(tokens) ? { control, phrase, всё: true } : { control, phrase };
      }
    }
  }

  const подряд = управлениеПодряд(meaningful);
  if (подряд) {
    const остановка = подряд === 'stop' || подряд === 'cancel';
    const phrase = meaningful.join(' ');
    return остановка && проВсё(tokens) ? { control: подряд, phrase, всё: true } : { control: подряд, phrase };
  }

  // Точного совпадения нет — одно слово, близкое по звучанию к главному.
  // Только одно: «продолжай искать» с ошибкой в первом слове — уже задача.
  if (meaningful.length === 1) {
    const слово = meaningful[0] as string;
    const control = главноеСловоПоЗвучанию(слово);
    if (control) return { control, phrase: слово };

    // «Стоп» с одной лишней буквой на конце. Замер 26.09.2026 синтезом
    // Piper → Whisper base: «Стопк». Распознаватель приклеивает к короткому
    // слову лишний согласный, и какой — каждый раз свой. Созвучием «стоп» не
    // ловим (четыре буквы, у него слишком много соседей), поэтому правило
    // узкое: сама основа и не больше одной буквы после. «Стопка» — две, мимо.
    if (/^(?:стоп|stop)\p{L}?$/u.test(слово)) return { control: 'stop', phrase: слово };
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
  /** Stops every active task, foreground and background. Whether any was. */
  cancelAll(): boolean;
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
      // Голое «стоп» гасит переднюю работу и не трогает убранную в фон — так
      // задумано в диспетчере задач. «Останови всё» гасит всё: так сказано.
      const stopped = match.всё ? target.cancelAll() : target.cancelForeground();
      if (!stopped) return { action: 'nothing', spoken: tr('Нечего останавливать.', 'Nothing to stop.') };
      return {
        action: 'stopped',
        spoken: match.всё ? tr('Остановил всё.', 'Stopped everything.') : tr('Остановил.', 'Stopped.'),
      };
    }
    case 'pause': {
      target.stopSpeaking();
      const paused = target.pauseForeground();
      return paused
        // Ответ нарочно не «Пауза»: эхо-страж спрашивает разбор управления
        // ПЕРВЫМ, и собственное слово «пауза», вернувшееся из колонок, он за
        // своё не считал. Управление срабатывало второй раз, пауза на уже
        // остановленной задаче не ставилась, и человек слышал «нечего ставить
        // на паузу», хотя она стоит. У «Остановил.» и «Продолжаю.» такого
        // совпадения нет — и здесь быть не должно.
        ? { action: 'paused', spoken: tr('Приостановил.', 'On hold.') }
        : { action: 'nothing', spoken: tr('Сейчас нечего ставить на паузу.', 'Nothing to pause right now.') };
    }
    case 'resume': {
      const resumed = target.resumeLast();
      return resumed
        ? { action: 'resumed', spoken: tr('Продолжаю.', 'Resuming.') }
        : { action: 'nothing', spoken: tr('Нечего продолжать.', 'Nothing to resume.') };
    }
    case 'mute': {
      target.stopSpeaking();
      return { action: 'muted', spoken: '' };
    }
  }
}
