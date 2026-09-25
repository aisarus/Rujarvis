/**
 * Telling speech apart from what Whisper writes when there is no speech.
 *
 * Asked to transcribe a fan, a door or a bar of music, Whisper does not return
 * an empty string — it narrates: «[музыка]», «(звук пилот)», «[BLANK_AUDIO]».
 * Harmless while the assistant is asleep, and not harmless at all once it is
 * awake, because every one of those becomes a command. Observed on a live
 * microphone: a wake word matched, and the next three room noises were
 * dispatched as instructions and kept the listening window open indefinitely.
 *
 * Transcription is also unreliable for very short sounds, so a single
 * character is treated as noise too — no Russian command is one letter.
 */

import { matchVoiceControl } from './interrupts';
import { stripFiller } from './filler';

/** Bracketed narration, including the unbalanced form Whisper often emits. */
const ANNOTATION = /[[(【][^\])】]*[\])】]?/gu;

const MIN_MEANINGFUL_LENGTH = 2;

/**
 * Phrases Whisper writes when it hears no speech at all.
 *
 * Large models were trained on subtitled video and fill silence with the
 * captions that ended those videos. Observed on this machine: «Продолжение
 * следует» arriving repeatedly from an empty room, dispatched as a command,
 * and answered by the assistant in earnest.
 */
/**
 * То, что распознаватель выдумывает на тишине.
 *
 * Whisper обучен на субтитрах к видео, и в тишине он «слышит» их концовки.
 * Это не догадка: всё ниже снято с живого журнала этой машины.
 *
 * ## Почему по вхождению, а не по началу
 *
 * Было по началу — и не сработало дважды подряд. «Субтитры ДЕЛАЛ DimaTorzok»
 * не совпало с «субтитры сделал», а «СМОТРИТЕ продолжение в следующей серии»
 * не начиналось с «продолжение следует». Обе выдумки прошли насквозь.
 *
 * Хуже того, они не просто прошли: сборщик приклеил их к настоящей просьбе
 * человека, и агент получил задачу «Субтитры делал DimaTorzok. Создай в
 * открытом от книги» — и честно работал над ней. Человек в это время смотрел
 * на экран, где ничего не происходило.
 *
 * Поэтому здесь фразы целиком и сверка по вхождению. Каждая из них — та, что
 * человек не скажет своему помощнику ни при каких обстоятельствах.
 */
/**
 * Выдумки, которые сами по себе — обычные слова.
 *
 * Их нельзя ловить вхождением: «корректор» в середине фразы встречается в
 * «открой корректор» и «позови корректора», и такая речь молча пропадала —
 * человек видел, что команда не выполнена, и причины не узнавал. Выдумка
 * Whisper имеет вид «Корректор А. Егорова», то есть стоит первой.
 */
const HALLUCINATIONS_AT_START = ['корректор'];

const HALLUCINATIONS = [
  'продолжение следует',
  // Без хвоста нарочно.
  //
  // Записано было «в следующей серии», а в живом логе распознаватель двадцать
  // раз выдал именно её и дважды — «в следующей части». Точная фраза ловила
  // первую и пропускала вторую: список вариантов концовки не кончается, а
  // общая часть у них одна.
  'продолжение в следующей',
  'субтитры делал',
  'субтитры сделал',
  'субтитры создавал',
  'субтитры подготовил',
  // «Субтитры подогнал Симон» — из живого лога. Просьбу «сделай субтитры»
  // ничто из этого не задевает: здесь глагол прошедшего времени, а не просьба.
  'субтитры подогнал',
  'субтитры перевел',
  'редактор субтитров',
  'dimatorzok',
  'спасибо за просмотр',
  'спасибо за внимание',
  'подписывайтесь на канал',
  'ставьте лайки',
  'thanks for watching',
  'thank you for watching',
  'subtitles by',
  'subscribe',
  'see you in the next video',
  'see you next time',
  'transcribed by',
  'captions by',
];

/**
 * Strips narration and returns what the person actually said.
 *
 * Returns null when nothing is left, which is the signal to act on nothing.
 * A tag alongside real words keeps the words: «(музыка) открой хром» is
 * someone speaking over music, not music.
 */
export function meaningfulSpeech(transcript: string): string | null {
  const withoutAnnotations = transcript.replace(ANNOTATION, ' ');

  // Keep letters, digits and the punctuation that carries meaning in speech;
  // drop the rest so a line of stray marks cannot pass as a command.
  const cleaned = withoutAnnotations
    // Знак вопроса остаётся. В русском вопрос без вопросительного слова
    // отличается ТОЛЬКО интонацией — «ты сделал?» и «ты сделал.» это разные
    // просьбы, — а распознаватель записывает услышанную интонацию именно
    // знаком. Стирать его значит своими руками выбрасывать единственный
    // признак вопроса, который у нас есть.
    .replace(/[^\p{L}\p{N}\s'’?-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (cleaned.length < MIN_MEANINGFUL_LENGTH) return null;
  if (!/\p{L}/u.test(cleaned)) return null;

  const lowered = cleaned.toLowerCase();
  if (HALLUCINATIONS.some((phrase) => lowered.includes(phrase))) return null;
  if (HALLUCINATIONS_AT_START.some((phrase) => lowered.startsWith(phrase))) return null;
  if (isSoundCaption(cleaned)) return null;

  return cleaned;
}

/**
 * Красная линия: то, что обязано доходить всегда.
 *
 * Спрашивается у тех же слоёв, что и решают, — своего списка здесь нет
 * нарочно. Четвёртый список слов остановки это четвёртое место, где он
 * разойдётся с остальными, а расхождение уже стоило человеку «тишины».
 */
function isRedLine(cleaned: string): boolean {
  return matchVoiceControl(cleaned) !== null || isSilenceRequest(cleaned);
}

/**
 * Звуки, которые Whisper подписывает вместо того, чтобы промолчать.
 *
 * Это не выдумка распознавателя: он честно слышит музыку за окном и честно
 * её называет. Беда в том, что подпись выглядит как сказанная фраза, и в
 * журнале 20.09.2026 «ДИНАМИЧНАЯ МУЗЫКА» дважды стала задачей.
 */
const SOUND_WORDS = [
  'музыка', 'музыки', 'музыкa', 'аплодисменты', 'апплодисменты', 'смех',
  'шум', 'шорох', 'звук', 'звуки', 'гудок', 'звонок', 'тишина', 'пение',
  'вздох', 'кашель', 'свист', 'гул', 'скрип', 'стук',
  'music', 'applause', 'laughter', 'silence', 'noise',
];

/**
 * Подпись под звуком, а не сказанное.
 *
 * Два условия разом, и оба нужны. Заглавные буквы — потому что Whisper
 * набирает подписи именно так. Звуковое слово — потому что человек тоже
 * кричит, и крик обязан сработать: «СТОП» заглавными это команда, самая
 * важная из всех, и съесть её было бы хуже любой лишней задачи.
 */
function isSoundCaption(cleaned: string): boolean {
  const words = cleaned.split(' ').filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;

  const shouted = cleaned === cleaned.toUpperCase() && /\p{Lu}/u.test(cleaned);
  if (!shouted) return false;

  // Крик человека — не подпись под звуком.
  //
  // «ТИШИНА» съедалась целиком: слово стоит в списке звуков, и правда —
  // Whisper подписывает им пустую комнату. Но им же человек прекращает
  // разговор, и красная линия оказалась перерезана фильтром шума. То же с
  // «ВЫКЛЮЧИ ЗВУК»: подписи про звук человек не произносит — он просит
  // сделать со звуком что-нибудь, и просит громко, потому что громко играет.
  //
  // Цена ошибки несимметрична, и это решает спор: лишняя задача — досада на
  // минуту, съеденный крик «СТОП» — потеря единственного способа прекратить
  // происходящее.
  if (isRedLine(cleaned)) return false;

  const lowered = cleaned.toLowerCase().split(' ');
  if (lowered.some((word) => SHOUTED_REQUEST.has(word))) return false;

  return lowered.some((word) => SOUND_WORDS.includes(word));
}

/**
 * Слова, с которых начинают рассказ, а не просьбу.
 *
 * Разбуженный Джарвис принимает за команду всё, что услышит, и в журнале
 * действий осталось две таких: «Потому что мы все знаем…» и «Это грая-класс,
 * но они просто не спрашивают». Обе были выполнены как задачи.
 */
const CHATTER_OPENERS = [
  'потому', 'это', 'но', 'а', 'и', 'так', 'ну', 'вот', 'значит', 'короче',
  'типа', 'кстати', 'просто', 'да', 'нет', 'ладно', 'вчера', 'сегодня',
  'он', 'она', 'они', 'мы', 'я', 'там', 'тут',
  'because', 'but', 'well', 'like', 'yeah', 'actually', 'anyway', 'basically',
  'he', 'she', 'they', 'we', 'i', 'there', 'yesterday', 'today',
];

/**
 * Глаголы просьбы и вопросительные слова.
 *
 * Их наличие важнее любого признака болтовни: фраза «Так, открой блендер»
 * начинается со связки, но остаётся командой.
 */
const REQUEST_WORDS = [
  'открой', 'открой', 'закрой', 'запусти', 'включи', 'выключи', 'убей',
  'сделай', 'сделайте', 'создай', 'нарисуй', 'начерти', 'построй', 'собери',
  'найди', 'поищи', 'покажи', 'открывай', 'напиши', 'запиши', 'посчитай',
  'переделай', 'повтори', 'продолжай', 'останови', 'отмени', 'поставь',
  'отправь', 'прочитай', 'переведи', 'скачай', 'сохрани', 'удали', 'перенеси',
  'отрендери', 'смени', 'поменяй', 'добавь', 'убери', 'проверь', 'скажи',
  'open', 'close', 'launch', 'start', 'run', 'kill', 'quit', 'make', 'create',
  'draw', 'build', 'find', 'search', 'look', 'show', 'write', 'count', 'redo',
  'repeat', 'continue', 'stop', 'cancel', 'put', 'send', 'read', 'translate',
  'download', 'save', 'delete', 'move', 'render', 'change', 'add', 'remove',
  'check', 'tell', 'play', 'type', 'click', 'scroll', 'switch', 'fix', 'go',
];

/**
 * Слова, после которых заглавные буквы — это крик, а не подпись под звуком.
 *
 * Подпись звук называет. Человек звук не называет — он просит с ним что-то
 * сделать, и просит громко ровно тогда, когда громко играет. «ТИШЕ ЗВУК»
 * съедалось как подпись, и громкость оставалась прежней.
 */
const SHOUTED_REQUEST = new Set([...REQUEST_WORDS, 'тише', 'громче', 'потише', 'погромче', 'louder', 'quieter', 'volume']);

/**
 * Вопросительные слова — но только в начале фразы.
 *
 * «Что сейчас на экране» — вопрос к ассистенту. «Потому что мы все знаем, что
 * у нас есть…» — рассказ, и слово «что» в нём встречается дважды. Считать их
 * где угодно значило бы принимать за вопрос любую придаточную речь.
 */
const QUESTION_OPENERS = [
  'что', 'где', 'когда', 'сколько', 'какой', 'какая', 'как', 'почему', 'кто',
  'куда', 'зачем', 'можешь', 'можно', 'умеешь',
  'what', 'where', 'when', 'how', 'why', 'who', 'which', 'can', 'could', 'would',
  'is', 'are', 'do', 'does', 'did', 'will',
];

/**
 * Вежливость и междометия.
 *
 * Человек, прождавший ответа две минуты, говорит «спасибо», «пока», «ладно» —
 * и каждая такая фраза уходила задачей агенту. В логе это видно тремя
 * «Работаю» подряд, пока настоящая задача ещё считалась.
 *
 * Отдельно от слов-связок: эти короткие, ни с чего не начинаются и по общему
 * правилу проходили насквозь.
 */
const PLEASANTRIES = [
  'спасибо', 'спасибочки', 'пожалуйста', 'привет', 'здравствуй', 'здравствуйте',
  'пока', 'ага', 'угу', 'окей', 'ок', 'хорошо', 'ладно', 'понятно', 'ясно',
  'класс', 'отлично', 'супер', 'круто', 'ух', 'ого', 'всё', 'все',
  'понял', 'поняла', 'принял', 'договорились', 'спасибки', 'угушки',
  'thanks', 'thank', 'you', 'hello', 'hi', 'bye', 'goodbye', 'okay', 'good',
  'great', 'cool', 'nice', 'alright', 'awesome', 'perfect', 'got', 'it', 'sure',
];

/**
 * Одна вежливость и ничего больше.
 *
 * Отдельно от общего фильтра болтовни и намеренно уже его: этой проверкой
 * пользуется разговор, где почти всё остальное — законный ход. «Спасибо» ходом
 * не является: поднимать ради него целый запуск агента долго и незачем.
 */
export function isPleasantry(transcript: string): boolean {
  let words = wordsOf(transcript);

  // Заминка в начале — не содержание: «ну ладно» это то же «ладно».
  while (words.length > 1 && FILLERS.includes(words[0])) words = words.slice(1);

  if (words.length === 0 || words.length > 2) return false;
  return words.every((word) => PLEASANTRIES.includes(word));
}

/** Слова, которыми начинают говорить, пока не начали. */
const FILLERS = ['ну', 'да', 'а', 'вот', 'так', 'э', 'эм', 'well', 'um', 'uh', 'so', 'oh', 'yeah'];

function wordsOf(transcript: string): string[] {
  return transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

/**
 * Похоже ли это на разговор мимо ассистента.
 *
 * Применяется только когда Джарвис уже разбужен и слушает без имени: там, где
 * имя прозвучало, намерение подтверждено человеком и фильтровать нечего.
 *
 * Правило намеренно узкое. Ошибка в одну сторону — пропущенная болтовня, в
 * другую — проигнорированная команда, и вторая обходится человеку дороже.
 */
export function looksLikeChatter(transcript: string): boolean {
  const words = wordsOf(transcript);

  if (words.length === 0) return false;

  // Просьба есть — значит к нам, чем бы фраза ни начиналась.
  if (words.some((word) => REQUEST_WORDS.includes(word))) return false;
  if (QUESTION_OPENERS.includes(words[0])) return false;

  // Короткая вежливость целиком: «спасибо», «ладно, понятно». Длинная фраза
  // так не проверяется — в ней может быть просьба, которую мы уже искали выше.
  if (isPleasantry(transcript)) return true;

  return CHATTER_OPENERS.includes(words[0]);
}

/**
 * Просьба замолчать и закончить разговор.
 *
 * Жила в мосте обычной регулярностью и потому не проверялась ничем. Слова
 * остановки — то, чем человек прекращает происходящее, и они обязаны работать
 * всегда; такое стоит держать там, где на него можно написать тест.
 */
const SILENCE_PHRASES = [
  'тишина', 'тишину', 'тише', 'замолчи', 'молчи', 'хватит слушать', 'спи', 'отбой',
  // Английские — в любом режиме, как и слова остановки.
  'silence', 'quiet', 'be quiet', 'shut up', 'stop listening', 'go to sleep', 'sleep',
];

/**
 * Что можно сказать вокруг просьбы, не меняя её.
 *
 * Имя — главное: человек говорит «Джарвис, тишина», а не голое «тишина».
 * Просьба замолчать разбирается в мосте раньше, чем снимается имя, поэтому
 * снимать его приходится здесь — иначе обещанная справочником фраза с
 * обращением по имени не работает.
 */
/** Своя добавка: «да» рядом с «замолчи» безвредно, но общим списком — нет. */
const SILENCE_FILLER = ['да'];

/**
 * Сверка целой фразой, а не началом.
 *
 * Было по началу — и «тише звук» уходило в сон вместо убавления громкости:
 * справочник обещал громкость, а Джарвис замолкал и переставал слушать.
 * Целая фраза разводит эти два случая без единого исключения в правиле.
 *
 * (Раньше здесь была регулярность с `\b`. В JavaScript `\b` считает словом
 * только латиницу, и после кириллического «тишина» границы нет — команда не
 * срабатывала вообще.)
 */
export function isSilenceRequest(text: string): boolean {
  // Тот же список, что у команд и прерываний. Свой здесь был третьим, и он не
  // знал «быстро замолчи» и «а теперь тишина».
  const words = stripFiller(wordsOf(text), SILENCE_FILLER);
  return SILENCE_PHRASES.includes(words.join(' '));
}
