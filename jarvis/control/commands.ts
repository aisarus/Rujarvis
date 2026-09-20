/**
 * Прямые команды — то, что делается мгновенно, минуя агента.
 *
 * Это и есть разница между «управлением компьютером через голос» и голосовым
 * пультом с задержкой. Задача, отданная агенту, идёт полминуты: он читает
 * запрос, думает, зовёт инструменты, отвечает. Для «прокрути вниз» или «нажми
 * Enter» это непригодно — к моменту ответа человек давно сделал бы сам.
 *
 * Здесь список того, что не требует размышления. Фраза сопоставляется с
 * таблицей и превращается в нажатие клавиш, движение колеса или клик. Всё
 * остальное уходит агенту, как и раньше.
 *
 * ## Правило, ради которого всё это безопасно
 *
 * **Совпадение должно быть точным.** «Найди» — это Ctrl+F, а «найди отчёт за
 * март» — работа для агента. Если в фразе есть хоть что-то сверх команды,
 * значит человек имел в виду не сочетание клавиш. Ошибка в эту сторону стоит
 * секунды ожидания; в обратную — нажатого невпопад Ctrl+F посреди работы.
 */

import { WAKE_WORD_VARIANTS } from '../voice/wakeWord';
import { GRID_CELLS, parseSpokenNumber } from './grid';

export type DirectCommand =
  | { kind: 'key'; keys: string }
  | { kind: 'scroll'; amount: number }
  | { kind: 'click'; button: 'left' | 'right' | 'middle'; double?: boolean }
  | { kind: 'type'; text: string }
  | { kind: 'focus'; title: string }
  | { kind: 'dictation'; on: boolean }
  | { kind: 'clickNamed'; query: string }
  | { kind: 'grid'; on: boolean }
  | { kind: 'gridClick'; cell: number }
  | { kind: 'gridRefine'; sub: number }
  | { kind: 'help'; on: boolean }
  | { kind: 'log'; on: boolean }
  | { kind: 'where' }
  | { kind: 'mode'; show: boolean }
  | { kind: 'longSpeech' }
  | { kind: 'repeat'; times: number; command: RepeatableCommand };

/**
 * Что имеет смысл повторять.
 *
 * Прокрутка и нажатия — да: крутить по одному щелчку голосом невыносимо.
 * Диктовка, сетка и список команд — нет: это режимы, а не действия, и
 * «включить диктовку пять раз» не значит ничего.
 */
export type RepeatableCommand =
  | { kind: 'key'; keys: string }
  | { kind: 'scroll'; amount: number }
  | { kind: 'click'; button: 'left' | 'right' | 'middle'; double?: boolean };

/** Больше этого — почти наверняка ослышка, а не просьба. */
const MAX_REPEAT = 20;

/** Список команд: показать и убрать. */
const HELP_ON = ['что ты умеешь', 'помощь', 'какие команды', 'справка', 'что можно сказать'];
const HELP_OFF = ['убери список', 'закрой список', 'спрячь список', 'убери помощь'];

/**
 * Окно с рассказом о работе: показать и убрать.
 *
 * «Что ты делаешь» разбирается здесь, а не уходит агенту, и это осознанно.
 * Спросить голосом и ждать полминуты, пока агент опишет сам себя, — худший
 * способ ответить на вопрос, ответ на который уже написан в окне.
 */
const LOG_ON = [
  'что ты делаешь', 'покажи лог', 'открой лог', 'покажи что делаешь',
  'покажи работу', 'чем занят', 'что происходит', 'чем занимаешься',
  'что делаешь', 'покажи окно', 'открой окно', 'покажи чем занят',
];
const LOG_OFF = [
  'закрой лог', 'убери лог', 'спрячь лог', 'закрой окно лога', 'убери окно',
  'закрой окно работы',
];

/**
 * «Где ты» — на каком шаге плана.
 *
 * Отвечает одной строкой и мгновенно. Тот же вопрос, отданный агенту, стоил бы
 * полминуты и запуска целой задачи ради того, что уже записано в файле.
 */
const WHERE = [
  'где ты', 'на каком шаге', 'какой план', 'покажи план', 'сколько осталось',
  'далеко ещё',
];

/**
 * Режим работы: на виду или в фоне.
 *
 * «На виду» — блендер открыт, файлы показываются, человек видит каждый шаг.
 * «В фоне» — та же работа, но молча и не лезя на экран: человек занят своим и
 * не хочет, чтобы у него под руками открывались окна.
 */
const MODE_SHOW = [
  'показывай всё', 'показывай все', 'работай на виду', 'работай при мне',
  'открывай окна', 'на виду',
];
const MODE_QUIET = [
  'работай в фоне', 'работай тихо', 'в фоне', 'фоновый режим', 'не показывай',
  'не открывай окна', 'работай молча',
];

/** Сетка с номерами: показать и убрать. */
const GRID_ON = ['сетка', 'покажи сетку', 'включи сетку', 'номера'];
const GRID_OFF = ['убери сетку', 'спрячь сетку', 'выключи сетку', 'без сетки'];

/**
 * Уточнение — отдельной фразой, а не хвостом к клику.
 *
 * «Клик сорок пять пять» на слух складывается в пятьдесят: составные
 * числительные не дают отличить номер клетки от номера доли. Два шага
 * однозначны и в цифрах, и в словах.
 */
const REFINE_PREFIXES = ['точнее', 'уточни', 'внутри', 'подклетка'];

/**
 * Начала фраз «кликни по чему-то».
 *
 * Названное вслух ищется в дереве доступности окна — том же, которым
 * пользуются экранные читалки, — и клик идёт в центр найденного. Не нашли —
 * задача уходит агенту, который посмотрит на экран.
 */
const CLICK_PREFIXES = ['кликни', 'клик', 'нажми', 'щелкни', 'нажми на'];

/** Слова между глаголом и названием: «кликни по кнопке Войти». */
const CLICK_GLUE = ['по', 'на', 'в', 'кнопке', 'кнопку', 'кнопка', 'ссылке', 'ссылку', 'пункт', 'пункте', 'вкладку', 'вкладке', 'поле'];

/**
 * Начала фраз переключения между окнами.
 *
 * Отдельно от запуска: «открой хром» — запустить программу, «переключись на
 * хром» — показать уже открытое окно. Разница ощутимая, когда Chrome уже
 * работает и запускать второй незачем.
 */
const FOCUS_PREFIXES = [
  'переключись на', 'переключись в', 'перейди в', 'перейди на',
  'покажи окно', 'вернись в', 'вернись на', 'сделай активным',
];

/** Включение и выключение диктовки. */
/**
 * Печать в активное окно.
 *
 * «Диктую» отсюда убрано и отдано длинной мысли: человек попросил именно этим
 * словом предупреждать, что будет говорить долго. Печать осталась на фразах,
 * которые ни с чем не спутать.
 */
const DICTATION_ON = [
  'печатай', 'режим диктовки', 'включи диктовку', 'записывай за мной',
  'печатай за мной', 'пиши за мной',
];

/**
 * Длинная мысль: человек предупреждает, что будет говорить с паузами.
 *
 * Слушатель ждёт пять секунд между кусками вместо двух с половиной и не
 * отдаёт мысль на глаголе просьбы посреди фразы. Держится до конца одного
 * сообщения.
 */
const LONG_SPEECH = [
  'диктую', 'я диктую', 'слушай длинно', 'длинное сообщение', 'длинная мысль',
  'сейчас длинно', 'буду говорить долго',
];
const DICTATION_OFF = ['конец диктовки', 'стоп диктовка', 'хватит диктовать', 'выключи диктовку'];

/**
 * Конец диктовки распознаётся отдельно от остальных команд.
 *
 * Пока идёт диктовка, всё услышанное печатается буква в букву, и разбирать
 * это как команды нельзя — иначе продиктованное слово «вниз» прокрутит
 * страницу вместо того, чтобы попасть в текст. Единственное исключение —
 * фраза выхода, и потому она проверяется сама по себе.
 */
export function endsDictation(utterance: string): boolean {
  return DICTATION_OFF.includes(normalise(utterance));
}

/**
 * Слова вежливости и заполнители, которые ничего не меняют.
 *
 * Список пополнен после живого случая: человек сказал «что ты СЕЙЧАС делаешь»,
 * и окно не открылось. Слово «сейчас» в списке было, но `normalise` убирает
 * заполнители только по краям фразы — а здесь оно стояло в середине.
 */
const FILLER = [
  'пожалуйста', 'плиз', 'давай', 'ну', 'там', 'теперь', 'сейчас', 'ка', 'же',
  'вот', 'уже', 'вообще',
];

/** Та же фраза без заполнителей где угодно, а не только по краям. */
function dropFiller(phrase: string): string {
  return phrase
    .split(' ')
    .filter((word) => word && !FILLER.includes(word))
    .join(' ');
}

/** Глаголы нажатия перед самой клавишей: «нажми enter» — это «enter». */
const PRESS_VERBS = ['нажми', 'нажмите', 'жми', 'нажать'];

/**
 * Начала диктовки.
 *
 * «Напечатай», «введи», «печатай» однозначны: человек просит набрать текст.
 *
 * «Напиши» отсюда убрано, и это исправление живой беды. Человек сказал «напиши
 * скиллы для поиска ассетов и звуков и положи в нужную папку» — и Джарвис
 * НАПЕЧАТАЛ эти слова в активное окно вместо того, чтобы сделать работу. В
 * журнале это выглядит как «перестал отвечать»: задача не заводилась вовсе.
 *
 * Защита была: список вещей, которые «пишут» (письмо, отчёт, код). Но он
 * перечисляет то, о чём успели подумать, а человек говорит о чём угодно —
 * «напиши скиллы», «напиши правило», «напиши разбор». Белый список здесь
 * защищает не ту сторону: цена ошибки — текст, набранный в чужое окно, и это
 * та самая необратимость, которой в голосовом помощнике быть не должно.
 *
 * Буквальный набор по-прежнему доступен: «напечатай …» и режим диктовки.
 */
const DICTATION_PREFIXES = ['напечатай', 'введи', 'печатай'];

/**
 * После этих слов «напиши» означает работу, а не диктовку.
 *
 * Разница принципиальная: продиктованное попадает в окно буква в букву, а
 * заказанное — проходит через агента, который это сочиняет.
 */
const WRITTEN_THINGS = [
  'письмо', 'письма', 'документ', 'отчет', 'код', 'программу', 'скрипт',
  'статью', 'текст', 'сообщение', 'план', 'заметку', 'функцию', 'тест',
];

const KEYS: Record<string, string> = {
  // Одиночные клавиши.
  'enter': 'enter', 'ввод': 'enter', 'ентер': 'enter', 'интер': 'enter',
  'escape': 'escape', 'эскейп': 'escape', 'отмена': 'escape', 'закрой это': 'escape',
  'таб': 'tab', 'tab': 'tab',
  'пробел': 'space',
  'удали': 'backspace', 'стереть': 'backspace', 'бекспейс': 'backspace',
  'делит': 'delete', 'delete': 'delete',
  'вниз': 'down', 'вверх': 'up', 'влево': 'left', 'вправо': 'right',
  'страница вниз': 'pagedown', 'страница вверх': 'pageup',
  'в самый низ': 'ctrl+end', 'в самый верх': 'ctrl+home',
  'в начало строки': 'home', 'в конец строки': 'end',

  // Правка текста.
  'скопируй': 'ctrl+c', 'копировать': 'ctrl+c', 'копируй': 'ctrl+c',
  'вставь': 'ctrl+v', 'вставить': 'ctrl+v',
  'вырежи': 'ctrl+x', 'вырезать': 'ctrl+x',
  'отмени действие': 'ctrl+z', 'отмени последнее': 'ctrl+z', 'верни как было': 'ctrl+z',
  'повтори действие': 'ctrl+y',
  'выдели все': 'ctrl+a', 'выделить все': 'ctrl+a',
  'сохрани': 'ctrl+s', 'сохранить': 'ctrl+s',
  'найди': 'ctrl+f', 'поиск': 'ctrl+f',
  'печать': 'ctrl+p',

  // Вкладки и окна.
  'новая вкладка': 'ctrl+t',
  'закрой вкладку': 'ctrl+w',
  'верни вкладку': 'ctrl+shift+t',
  'следующая вкладка': 'ctrl+tab',
  // Одно и то же люди просят по-разному, и каждая несовпавшая формулировка
  // стоит тридцати секунд через агента вместо трёхсот миллисекунд.
  'переключи вкладку': 'ctrl+tab',
  'переключись на следующую вкладку': 'ctrl+tab',
  'следующую вкладку': 'ctrl+tab',
  'дальше вкладка': 'ctrl+tab',
  'предыдущая вкладка': 'ctrl+shift+tab',
  'предыдущую вкладку': 'ctrl+shift+tab',
  'переключись на предыдущую вкладку': 'ctrl+shift+tab',
  'переключись': 'alt+tab', 'переключи окно': 'alt+tab',
  'обнови': 'f5', 'обновить': 'f5', 'перезагрузи страницу': 'f5',
  'закрой окно': 'alt+f4',
  'разверни': 'win+up', 'развернуть': 'win+up', 'на весь экран': 'f11',
  'сверни': 'win+down', 'свернуть': 'win+down',
  'сверни все': 'win+d', 'покажи рабочий стол': 'win+d',

  // Звук и медиа.
  'громче': 'volumeup', 'сделай громче': 'volumeup',
  'тише звук': 'volumedown', 'сделай тише': 'volumedown',
  'выключи звук': 'volumemute', 'без звука': 'volumemute',
  'пауза': 'playpause', 'играй': 'playpause', 'продолжи музыку': 'playpause',
  'следующий трек': 'nexttrack', 'предыдущий трек': 'prevtrack',
};

const SCROLLS: Record<string, number> = {
  'прокрути вниз': -3, 'промотай вниз': -3, 'ниже': -3, 'листай вниз': -3,
  'прокрути вверх': 3, 'промотай вверх': 3, 'выше': 3, 'листай вверх': 3,
};

const CLICKS: Record<string, { button: 'left' | 'right' | 'middle'; double?: boolean }> = {
  'кликни': { button: 'left' },
  'клик': { button: 'left' },
  'щелкни': { button: 'left' },
  'правый клик': { button: 'right' },
  'правой кнопкой': { button: 'right' },
  'двойной клик': { button: 'left', double: true },
  'кликни дважды': { button: 'left', double: true },
};

export function parseDirectCommand(utterance: string): DirectCommand | null {
  const exact = normalise(utterance);
  if (!exact) return null;

  // Сперва как сказано, потом без слов-вставок. Порядок важен: «стоп» и «назад»
  // должны находиться сразу, а очистка нужна только тем фразам, которые её
  // переживают без потери смысла.
  return readDirect(exact) ?? readDirect(dropFiller(exact));
}

function readDirect(phrase: string): DirectCommand | null {
  if (!phrase) return null;

  const repeated = readRepeat(phrase);
  if (repeated) return repeated;

  // Диктовка проверяется до таблиц: у неё есть хвост, и точное совпадение
  // здесь неприменимо.
  const dictated = readDictation(phrase);
  if (dictated) return dictated;

  const key = KEYS[stripPressVerb(phrase)] ?? KEYS[phrase];
  if (key) return { kind: 'key', keys: key };

  const amount = SCROLLS[phrase];
  if (amount !== undefined) return { kind: 'scroll', amount };

  const click = CLICKS[phrase];
  if (click) return { kind: 'click', ...click };

  if (LONG_SPEECH.includes(phrase)) return { kind: 'longSpeech' };
  if (DICTATION_ON.includes(phrase)) return { kind: 'dictation', on: true };
  if (DICTATION_OFF.includes(phrase)) return { kind: 'dictation', on: false };

  const focus = readFocus(phrase);
  if (focus) return focus;

  if (HELP_ON.includes(phrase)) return { kind: 'help', on: true };
  if (HELP_OFF.includes(phrase)) return { kind: 'help', on: false };

  if (LOG_ON.includes(phrase)) return { kind: 'log', on: true };
  if (LOG_OFF.includes(phrase)) return { kind: 'log', on: false };

  if (WHERE.includes(phrase)) return { kind: 'where' };

  if (MODE_SHOW.includes(phrase)) return { kind: 'mode', show: true };
  if (MODE_QUIET.includes(phrase)) return { kind: 'mode', show: false };

  if (GRID_ON.includes(phrase)) return { kind: 'grid', on: true };
  if (GRID_OFF.includes(phrase)) return { kind: 'grid', on: false };

  const refine = readRefine(phrase);
  if (refine) return refine;

  const named = readClickNamed(phrase);
  if (named) return named;

  return null;
}

/**
 * «Прокрути вниз три раза» — та же команда, выполненная несколько раз.
 *
 * Хвост «N раз» отрезается, а остаток разбирается обычным путём. Диктовка
 * проверяется раньше, поэтому «напечатай три раза» остаётся диктовкой.
 */
function readRepeat(phrase: string): DirectCommand | null {
  const match = new RegExp('^(.+?)\\s+раз(?:а|ов)?$', 'u').exec(phrase);
  if (!match) return null;

  const words = (match[1] as string).split(' ');

  // Число стоит в конце и может быть составным: «двадцать три раза». Сначала
  // пробуем два слова, потом одно — и берём тот разбор, при котором остаток
  // оказывается настоящей командой.
  for (const take of [2, 1]) {
    if (words.length <= take) continue;

    const times = parseSpokenNumber(words.slice(-take).join(' '));
    if (times === null || times < 2) continue;

    const inner = parseDirectCommand(words.slice(0, -take).join(' '));
    if (!inner) continue;
    if (inner.kind !== 'key' && inner.kind !== 'scroll' && inner.kind !== 'click') return null;

    return { kind: 'repeat', times: Math.min(times, MAX_REPEAT), command: inner };
  }

  return null;
}

function readRefine(phrase: string): DirectCommand | null {
  const words = phrase.split(' ');
  if (!REFINE_PREFIXES.includes(words[0] ?? '')) return null;

  const sub = parseSpokenNumber(words.slice(1).join(' '));
  if (sub === null || sub < 1 || sub > 9) return null;
  return { kind: 'gridRefine', sub };
}

function readClickNamed(phrase: string): DirectCommand | null {
  const words = phrase.split(' ');
  const verb = words[0] ?? '';
  if (!CLICK_PREFIXES.includes(verb)) return null;

  const rest = words.slice(1).filter((word) => !CLICK_GLUE.includes(word));
  if (rest.length === 0) return null;

  // Длинный хвост — это описание работы, а не название кнопки: «кликни туда,
  // где написано, что доставка бесплатная» разбирать здесь нечем.
  if (rest.length > 4) return null;

  // Число — это номер клетки сетки, а не название кнопки.
  const cell = parseSpokenNumber(rest.join(' '));
  if (cell !== null && cell >= 1 && cell <= GRID_CELLS) return { kind: 'gridClick', cell };

  return { kind: 'clickNamed', query: rest.join(' ') };
}

function readFocus(phrase: string): DirectCommand | null {
  for (const prefix of FOCUS_PREFIXES) {
    if (!phrase.startsWith(`${prefix} `)) continue;

    const title = phrase.slice(prefix.length + 1).trim();
    // Длинный хвост — это описание работы, а не имя окна.
    if (!title || title.split(' ').length > 3) return null;
    return { kind: 'focus', title };
  }
  return null;
}


function readDictation(phrase: string): DirectCommand | null {
  for (const prefix of DICTATION_PREFIXES) {
    if (!phrase.startsWith(`${prefix} `)) continue;

    const text = phrase.slice(prefix.length + 1).trim();
    if (!text) return null;

    // «Напиши письмо» — это заказ, а не диктовка. Такое уходит агенту.
    const first = text.split(' ')[0] ?? '';
    if (WRITTEN_THINGS.includes(first)) return null;

    return { kind: 'type', text };
  }
  return null;
}

function stripPressVerb(phrase: string): string {
  const space = phrase.indexOf(' ');
  if (space === -1) return phrase;
  const first = phrase.slice(0, space);
  return PRESS_VERBS.includes(first) ? phrase.slice(space + 1) : phrase;
}

/**
 * Приводит услышанное к виду, в котором его можно сравнивать.
 *
 * Знаки препинания распознаватель расставляет как хочет, «ё» пишет то так, то
 * эдак, и вежливость вставляет человек. На смысл команды ничто из этого не
 * влияет.
 */
function normalise(utterance: string): string {
  let words = utterance
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s+]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  // Имя в начале — обращение, а не часть команды.
  //
  // Живой случай 20.09.2026: окно бодрствования уже открыто, человек всё
  // равно говорит «Джарвис, переключись на Riot Client» — так естественнее.
  // Имя оставалось в тексте, ни одна прямая команда не совпадала, и всё
  // уходило агенту: тридцать секунд вместо трёхсот миллисекунд. В журнале
  // это выглядело как «не переключает вкладки, не работает ничего».
  //
  // Режем только в начале: «напечатай джарвис молодец» — это содержание,
  // и трогать его нельзя.
  while (words.length > 1 && WAKE_WORD_VARIANTS.includes(words[0] as string)) {
    words = words.slice(1);
  }

  // Диктовка сохраняет слова как есть: в продиктованном тексте «пожалуйста»
  // может быть частью фразы.
  if (words.length > 0 && DICTATION_PREFIXES.includes(words[0] as string)) {
    return words.join(' ');
  }

  return words.filter((word) => !FILLER.includes(word)).join(' ');
}
