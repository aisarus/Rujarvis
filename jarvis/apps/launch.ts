/**
 * Recognising «открой хром» without asking a model.
 *
 * Launching an application is the most common thing said to a voice assistant
 * and the least ambiguous. Routing it through the agent turned out to cost
 * minutes and to fail silently: the runtime shells out to its own CLI through
 * two nested shells on Windows, the JSON argument is destroyed by quoting, the
 * CLI still exits 0, and the model reports success for something that never
 * happened. Observed, not theorised — twice, with an apology in between.
 *
 * So this path stays deterministic: match the phrase, resolve the name, start
 * the process. No model, no shell, no chance of a confident lie.
 */

/** Verbs that mean "stop this program". */
const CLOSE_VERBS = [
  'закрой', 'закройте', 'закрыть',
  'выключи', 'выключите',
  'останови', 'остановите',
  'убей', 'прикрой', 'сверни',
];

/** Verbs that mean "start this program". */
const LAUNCH_VERBS = [
  'открой', 'открать', 'откройте', 'отткрой',
  'запусти', 'запускай', 'запустите',
  'включи', 'включите',
];

/**
 * Слова, которые не могут быть названием программы.
 *
 * «Открой его обратно» дало цель «его обратно», нечётко сопоставилось с
 * установленной программой Overtune — и Джарвис её запустил. Это записано в
 * журнале живой сессии.
 *
 * Местоимение указывает на то, о чём шла речь, и требует памяти о разговоре, а
 * не поиска по ярлыкам. Пусть такую фразу разбирает агент.
 */
const REFERENTIAL = [
  'его', 'её', 'ее', 'их', 'это', 'этот', 'эту', 'эта', 'тот', 'ту', 'то',
  'там', 'туда', 'обратно', 'снова', 'опять', 'назад', 'же', 'самое', 'самый',
  'всё', 'все', 'что-нибудь', 'нибудь', 'какой-нибудь',
];

/** Words between the verb and the name that carry no meaning here. */
const FILLER = ['мне', 'пожалуйста', 'давай', 'ка', 'мой', 'моё', 'мою', 'приложение', 'программу'];

/**
 * Spoken names mapped to what Windows actually starts.
 *
 * Speech recognition returns these transliterated and declined, so the keys are
 * the shapes people say, not the vendors' spellings.
 */
const APP_ALIASES: ReadonlyArray<readonly [readonly string[], string]> = [
  [['хром', 'хрома', 'хроме', 'chrome', 'гугл хром', 'гуглхром'], 'chrome'],
  [['эдж', 'эдже', 'едж', 'edge', 'майкрософт эдж', 'мсэдж'], 'msedge'],
  [['телеграм', 'телега', 'телеграмм', 'telegram'], 'telegram'],
  [['фаерфокс', 'файрфокс', 'фокс', 'firefox'], 'firefox'],
  [['блокнот', 'нотпад', 'notepad'], 'notepad'],
  [['калькулятор', 'калькулятр', 'calc'], 'calc'],
  [['проводник', 'эксплорер', 'explorer'], 'explorer'],
  [['терминал', 'консоль', 'командную строку', 'cmd'], 'wt'],
  [['код', 'вскод', 'вс код', 'вижуал студио код', 'vscode', 'code'], 'code'],
  [['спотифай', 'спотик', 'spotify'], 'spotify'],
  // Дискорда здесь нет намеренно, хотя он установлен.
  //
  // `start discord` не работает: Discord не кладёт себя ни в PATH, ни в «App
  // Paths» реестра, а живёт ярлыком в меню «Пуск». Строчка в этой таблице
  // перехватывала фразу раньше поиска по ярлыкам и гарантировала отказ — та же
  // поломка, что «блендер → blender». Пусть ищется среди установленного.
  [['ворд', 'word'], 'winword'],
  [['эксель', 'ексель', 'excel'], 'excel'],
  [['ворд пад', 'вордпад', 'wordpad'], 'wordpad'],
  [['настройки', 'параметры', 'settings'], 'ms-settings:'],
];

export interface AppLaunch {
  /** What to hand to the shell. */
  target: string;
  /** What the person called it, for saying back to them. */
  spokenName: string;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The program name in «открой <name>», or null when this was not a request to
 * start something.
 *
 * Kept separate from the alias lookup so an unknown name can still be searched
 * for among the programs actually installed, instead of being silently
 * dropped for not being on a list.
 */
export function spokenTarget(utterance: string): string | null {
  return targetAfterVerb(utterance, LAUNCH_VERBS);
}

/** The program name in «закрой <name>», or null. */
export function spokenCloseTarget(utterance: string): string | null {
  return targetAfterVerb(utterance, CLOSE_VERBS);
}

function targetAfterVerb(utterance: string, verbs: readonly string[]): string | null {
  const normalised = normalise(utterance);
  if (!normalised) return null;

  const words = normalised.split(' ');
  const verbIndex = words.findIndex((word) => verbs.includes(word));
  if (verbIndex === -1) return null;

  const rest = words
    .slice(verbIndex + 1)
    .filter((word) => !FILLER.includes(word));

  // More than a name is a description of work: «открой файл отчёт и посчитай
  // сумму» is a job for the agent, not a program to start.
  if (rest.length === 0 || rest.length > 3) return null;

  // Остались одни указательные слова — программы с таким названием не бывает.
  // Нечёткий поиск по ярлыкам всё равно что-нибудь найдёт, и запустит не то.
  if (rest.every((word) => REFERENTIAL.includes(word))) return null;

  return rest.join(' ');
}

/**
 * The executable an alias points at, if the spoken name is a known one.
 *
 * Closing needs this as much as opening does: «хром» has to become "chrome"
 * before it can be matched against a running process, and transliteration
 * alone turns it into "hrom".
 */
/**
 * Имена ОКОН и процессов — отдельно от пусковых.
 *
 * Эти две вещи легко спутать, и я спутал: добавил сюда «блендер» ради поиска
 * окна, а таблица пусковая — Джарвис стал пытаться выполнить команду `blender`
 * вместо поиска ярлыка в меню «Пуск», и перестал открывать то, что открывал.
 *
 * Разница простая. Пусковое имя — то, что Windows умеет запустить. Оконное —
 * то, что написано в заголовке окна или в имени процесса. У Chrome они совпали
 * случайно, и это совпадение сбило с толку.
 */
const WINDOW_ALIASES: ReadonlyArray<readonly [readonly string[], string]> = [
  [['блендер', 'блендере', 'blender'], 'blender'],
  [['клод', 'клода', 'клауд', 'claude'], 'claude'],
  [['джарвис', 'жарвис', 'jarvis'], 'Jarvis'],
  [['риот', 'риот клиент', 'riot'], 'Riot'],
  [['лига', 'лигу', 'лол', 'league'], 'League'],
  [['дота', 'доту', 'dota'], 'dota2'],
  [['стим', 'steam'], 'steam'],
  [['обс', 'obs'], 'obs64'],
  [['дискорд', 'discord'], 'Discord'],
  [['эдж', 'эдже', 'едж', 'edge'], 'msedge'],
  [['хром', 'хрома', 'хроме', 'chrome'], 'chrome'],
  [['телеграм', 'телега', 'телеграмм'], 'telegram'],
  [['повершелл', 'павершелл', 'пауэршелл', 'powershell'], 'powershell'],
  [['терминал', 'консоль'], 'WindowsTerminal'],
  [['проводник', 'эксплорер'], 'explorer'],
  // «Закрой настройки» уходило в ms-settings: — это протокол ЗАПУСКА, а не имя
  // процесса, и закрытие искало программу с таким именем. Окно «Параметров»
  // принадлежит SystemSettings.
  [['настройки', 'параметры'], 'SystemSettings'],
];

/** Как окно называется на самом деле. Для переключения и закрытия. */
export function windowAlias(phrase: string): string | null {
  const wanted = phrase.trim().toLowerCase();
  for (const [names, target] of WINDOW_ALIASES) {
    if (names.includes(wanted)) return target;
  }
  return null;
}

export function aliasTarget(phrase: string): string | null {
  for (const [names, target] of APP_ALIASES) {
    if (names.includes(phrase)) return target;
  }
  return null;
}

export function matchAppLaunch(utterance: string): AppLaunch | null {
  const phrase = spokenTarget(utterance);
  if (!phrase) return null;

  const target = aliasTarget(phrase);
  return target ? { target, spokenName: phrase } : null;
}

/**
 * Обе таблицы целиком — чтобы проверка могла пройти каждое имя.
 *
 * Таблица, которую некому перебрать, проверяется только теми строчками, про
 * которые кто-то вспомнил написать тест. Так и уехало «блендер → blender»:
 * такой команды в системе нет, а заметили это не тесты, а человек, у которого
 * перестало открываться.
 */
export const LAUNCH_NAMES: ReadonlyArray<readonly [string, string]> =
  APP_ALIASES.flatMap(([names, target]) => names.map((name) => [name, target] as const));

export const WINDOW_NAMES: ReadonlyArray<readonly [string, string]> =
  WINDOW_ALIASES.flatMap(([names, target]) => names.map((name) => [name, target] as const));
