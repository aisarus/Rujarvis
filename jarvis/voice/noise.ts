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
const HALLUCINATIONS = [
  'продолжение следует',
  'продолжение в следующей серии',
  'субтитры делал',
  'субтитры сделал',
  'субтитры создавал',
  'субтитры подготовил',
  'редактор субтитров',
  'корректор',
  'dimatorzok',
  'спасибо за просмотр',
  'спасибо за внимание',
  'подписывайтесь на канал',
  'ставьте лайки',
  'thanks for watching',
  'subtitles by',
  'subscribe',
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
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (cleaned.length < MIN_MEANINGFUL_LENGTH) return null;
  if (!/\p{L}/u.test(cleaned)) return null;

  const lowered = cleaned.toLowerCase();
  if (HALLUCINATIONS.some((phrase) => lowered.includes(phrase))) return null;

  return cleaned;
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
];

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
const FILLERS = ['ну', 'да', 'а', 'вот', 'так', 'э', 'эм'];

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
// Граница слова здесь не \b: в JavaScript он считает словом только
// латиницу, и после кириллического «тишина» границы нет — команда не
// срабатывала вообще. Проверяем, что дальше не идёт буква.
const SILENCE = /^\s*(тишина|тише|замолчи|молчи|хватит слушать|спи|отбой)(?!\p{L})/iu;

export function isSilenceRequest(text: string): boolean {
  return SILENCE.test(text);
}
