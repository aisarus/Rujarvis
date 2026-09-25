/**
 * Finding an installed program from the name a person says in Russian.
 *
 * A hand-written alias list loses: there are 281 shortcuts on this machine and
 * the user will ask for whichever one they happen to want. The Start menu
 * already knows every installed program, so the job is to match a spoken
 * Russian name against those names.
 *
 * Two different things have to be bridged, and they are not the same:
 *   - sound: «стим» is Steam written in Cyrillic, so transliteration finds it
 *   - meaning: «лигу» is the Russian word for League, which no amount of
 *     transliteration turns into "league"
 *
 * So both are tried, plus a crude stemmer, because Russian declines the name:
 * the user says «открой лигу», never «открой лига».
 */

import { editDistance } from '../voice/wakeWord';

const TRANSLITERATION: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's',
  т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '',
};

/** Russian words that name a program by meaning rather than by sound. */
const MEANINGS: Readonly<Record<string, string>> = {
  лиг: 'league',
  легенд: 'legends',
  клиент: 'client',
  игр: 'games',
  почт: 'mail',
  музык: 'music',
  браузер: 'browser',
  проводник: 'explorer',
  блокнот: 'notepad',
  калькулятор: 'calculator',
  настройк: 'settings',
  параметр: 'settings',
  магазин: 'store',
  камер: 'camera',
  фот: 'photos',
  диспетчер: 'manager',
  // Letters spelled out loud. Recognition writes «джи-пи-ти» as «джпт», and
  // no transliteration of that reaches "gpt".
  джпт: 'gpt',
  гпт: 'gpt',
  чат: 'chat',
  ии: 'ai',
  // Прозвища и написания, до которых буквы не доводят.
  //
  // «Лол» — это League of Legends, но ни одна перестановка букв «лол» не
  // приближается к "league". «Пауэршелл» пишется буквами как "pauershell", а
  // нужен "powershell": «уэ» и «owe» звучат одинаково и пишутся врозь.
  лол: 'league',
  пауэршелл: 'powershell',
};

/** Endings Russian adds to a name in the accusative and friends. */
const ENDINGS = ['ами', 'ями', 'ом', 'ем', 'ой', 'ей', 'ую', 'ия', 'иу', 'а', 'у', 'ы', 'и', 'е', 'о', 'ю', 'я'];

export function transliterate(word: string): string {
  return [...word].map((letter) => TRANSLITERATION[letter] ?? letter).join('');
}

/** Cuts a Russian ending so «лигу» and «лига» reduce to the same stem. */
export function stem(word: string): string {
  for (const ending of ENDINGS) {
    if (word.length - ending.length >= 3 && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Every Latin form the spoken name might take. */
export function candidateKeys(spoken: string): string[] {
  const keys = new Set<string>();
  for (const word of normalise(spoken).split(' ')) {
    if (!word) continue;
    const stemmed = stem(word);
    keys.add(word);
    keys.add(stemmed);
    keys.add(transliterate(word));
    keys.add(transliterate(stemmed));

    for (const [russian, english] of Object.entries(MEANINGS)) {
      // «Слово короче трёх букв не называет программу».
      //
      // Проверка `russian.startsWith(stemmed)` ловила служебные словечки:
      // «и» давало ключи `ai` (от «ии») и `games` (от «игр»), «на» давало
      // `settings` (от «настройк»). Такие ключи совпадают с именем программы
      // буквально, scoreWord отдаёт 3, `exact` становится true — и защита от
      // неоднозначности пропускает результат. Любая фраза с «и» или «на»
      // могла открыть «Параметры» или «Игры».
      //
      // Обратное направление, `stemmed.startsWith(russian)`, остаётся без
      // длины: там сказанное слово ДЛИННЕЕ записи, и короткой записи «ии»
      // это не мешает — «ии» по-прежнему даёт `ai`.
      if (stemmed.startsWith(russian)) {
        keys.add(english);
        continue;
      }
      if (stemmed.length >= 3 && russian.startsWith(stemmed)) keys.add(english);
    }
  }
  // Names said as several words are often written as one: «чат джпт» is
  // "ChatGPT". Without the joined form, «чат» alone matched "Cheat Engine" —
  // same consonants, kht — while ChatGPT scored nothing at all.
  const joined = normalise(spoken)
    .split(' ')
    .filter(Boolean)
    .map((word) => {
      const stemmed = stem(word);
      for (const [russian, english] of Object.entries(MEANINGS)) {
        if (stemmed === russian || word === russian) return english;
      }
      return transliterate(word);
    })
    .join('');
  if (joined.length >= 4) keys.add(joined);

  return [...keys].filter((key) => key.length >= 3);
}

/**
 * Буквы, которые пишутся по-разному, а звучат одинаково, сведены к одной.
 *
 * Это разница написания, а не слова: «эпик» переводится буквами как "epik", а
 * пишется "Epic" — то же слово. Гласные остаются на месте, они различают слова.
 */
function spellingFold(word: string): string {
  return word
    .replace(/ph/gu, 'f')
    .replace(/ck/gu, 'k')
    .replace(/[cq]/gu, 'k')
    .replace(/z/gu, 's')
    .replace(/w/gu, 'v');
}

/** Только гласные, в том же порядке. Ими слова и различаются. */
function vowelsOf(word: string): string {
  return word.replace(/[^aeiouy]/gu, '');
}

/**
 * A word reduced to the consonants it sounds like.
 *
 * Transliteration is lossy about vowels above all: «стим» becomes "stim" while
 * the shortcut says "steam" — two edits apart as spelling, the same word as
 * sound. Dropping the vowels and folding the letters that share a sound makes
 * them equal, without loosening the edit distance until unrelated words start
 * matching.
 */
function soundSkeleton(word: string): string {
  return spellingFold(word).replace(/[aeiouy]/gu, '');
}

/**
 * How well one spoken word matches one word of a program's name.
 *
 * The grading matters more than the numbers. «Стим» and "Steam" reduce to the
 * *same* sound, "stm" — that is a match. «Хром» and "Home" reduce to "hrm" and
 * "hm", which are merely *close* — and acting on that is how «открой хром»
 * opened "Dev Home" while Chrome was not installed at all. So a shared sound
 * counts, a similar one does not.
 */
function scoreWord(key: string, word: string): number {
  if (key === word) return 3;

  // A prefix counts only when it is most of the word. Otherwise «дискорд»
  // matches "Диск восстановления" and «стим» matches "Sid Meier's" — both
  // observed against the real list on this machine.
  const shorter = Math.min(key.length, word.length);
  const longer = Math.max(key.length, word.length);
  if (shorter >= 4 && shorter / longer >= 0.75 && (word.startsWith(key) || key.startsWith(word))) {
    return 3;
  }

  const keyFold = spellingFold(key);
  const wordFold = spellingFold(word);
  const keySound = soundSkeleton(key);
  const wordSound = soundSkeleton(word);

  // Один и тот же остов согласных — но только если слово ещё и начинается
  // так же.
  //
  // Отбрасывание гласных съедает и начало слова: «эдж» это "edzh", остов
  // "dsh" — ровно как у "Dash", и меню «Пуск» на «переключись на эдж»
  // предлагало AutoHotkey Dash. Первый звук имени человек слышит лучше всего и
  // никогда не путает; сводить слово с гласной в начале и слово с согласной —
  // значит подменять программу.
  if (keySound.length >= 3 && keySound === wordSound && keyFold[0] === wordFold[0]) return 2;

  // Расхождение в одну букву — либо в согласной, либо в самом хвосте.
  //
  // «Дота» отличается от "Data" одной буквой и находила «Источники данных
  // ODBC» (ODBC Data Sources), пока Dota 2 не попадала в список. Подмена
  // гласной делает слово ДРУГИМ словом: программу "Data" по-русски назвали бы
  // «дата», а не «дота». Согласная же расходится от письма, а не от звука:
  // «эпик» → "epik" против "Epic" — та же буква, другое написание.
  //
  // Хвост — исключение, и ровно по той причине, по которой в этом файле вообще
  // есть отсечение окончаний: русский склоняет конец слова. «Доту» и «дота»
  // отличаются последней буквой и означают одно.
  //
  // Оба слова должны быть длиной хотя бы в четыре буквы. Для трёхбуквенного
  // одна буква — это треть слова: «стин» (недослышанное «стим») находило
  // "Divinity Original Sin 2".
  const declension = keyFold.length === wordFold.length && keyFold.slice(0, -1) === wordFold.slice(0, -1);
  const sameVowels = vowelsOf(keyFold) === vowelsOf(wordFold);
  if (
    key.length >= 4 &&
    word.length >= 4 &&
    (sameVowels || declension) &&
    editDistance(key, word, 2) <= 1
  ) {
    return 2;
  }

  // Near-misses are reported but never acted on alone.
  if (keySound.length >= 3 && editDistance(keySound, wordSound, 2) <= 1) return 1;
  return 0;
}

export interface ShortcutChoice<T> {
  item: T;
  score: number;
  /**
   * Совпало ли хоть одно слово имени в точности, а не на слух.
   *
   * Отдаётся наружу для журнала: по нему видно, чем именно программа найдена.
   * Решение принимает сама функция — слабое совпадение она не возвращает.
   */
  exact: boolean;
}

/**
 * Picks the shortcut that best matches what was said, or null.
 *
 * Ties go to the shorter name: asked for «риот», "Riot Client" is a better
 * answer than "Riot Client Services Diagnostics", because the short name is
 * the one people mean.
 *
 * Возвращённому совпадению можно верить без переспроса.
 *
 * Раньше рядом ехало поле `confident`, и звали его «можно действовать». Не
 * звал никто: мост открывал то, что вернули, не глядя. Поле, которое некому
 * читать, не защищает ни от чего — поэтому отказ теперь выражен единственным
 * способом, который нельзя пропустить: null.
 */
export function chooseShortcut<T>(
  spoken: string,
  items: readonly T[],
  nameOf: (item: T) => string,
): ShortcutChoice<T> | null {
  const keys = candidateKeys(spoken);
  if (keys.length === 0) return null;

  let best: { item: T; name: string; exact: boolean; total: number } | null = null;
  // Имена, набравшие лучший счёт, — множеством, а не одним «вторым местом».
  //
  // Со «вторым местом» порядок [X, X, Y] при равном счёте прятал Y: второй X
  // занимал место второго, а Y его уже не отбирал — счёт-то равный. Выходило
  // «совпадение единственное» там, где их было два разных.
  let лучшиеИмена = new Set<string>();

  for (const item of items) {
    const name = normalise(nameOf(item));
    const words = name.split(' ').filter(Boolean);
    if (words.length === 0) continue;

    let score = 0;
    let exact = false;
    for (const key of keys) {
      let bestForKey = 0;
      for (const word of words) {
        const value = scoreWord(key, word);
        if (value > bestForKey) bestForKey = value;
      }
      if (bestForKey === 3) exact = true;
      score += bestForKey;
    }
    // One solid word is enough. Dividing by the shortcut's length would sink
    // «эпик» inside "Epic Games Launcher" — one word of three — even though it
    // is exactly the program meant.
    if (score < 2) continue;

    // Length only breaks ties: asked for «риот», the short "Riot Client" beats
    // a longer name that merely contains the same word.
    const total = score - words.length * 0.1;

    if (!best || total > best.total + 1e-9) {
      best = { item, name, exact, total };
      лучшиеИмена = new Set([name]);
    } else if (Math.abs(total - best.total) < 1e-9) {
      лучшиеИмена.add(name);
    }
  }

  if (!best) return null;

  // Совпадение на слух обязано быть единственным.
  //
  // Оба ложных попадания, найденных на живой машине, выглядели одинаково: два
  // РАЗНЫХ имени набрали поровну, и победило то, что раньше лежит в списке.
  //
  //   «клод»  → Cloud Tools for PowerShell 1.60 | Google Cloud SDK Shell 1.60
  //   «дота»  → Источники данных ODBC (32) 1.50 | то же самое (64)      1.50
  //
  // Ровный счёт — это не выбор, это монетка. Открыть не то хуже, чем честно
  // сказать «не нашёл»: человек услышит отказ и повторит, а запущенную не ту
  // программу он заметит не сразу и не поймёт, почему.
  //
  // На точное совпадение слова это не распространяется. «Риот» находит и
  // "Riot Client", и «Клиент Riot» — тоже поровну, но там сказанное слово
  // стоит в имени буквально, и обе записи ведут в одну программу.
  //
  // И одно имя дважды — это не выбор между программами. Discord лежит в меню
  // «Пуск» двумя одинаковыми ярлыками, и на «дискорд» отказ по неоднозначности
  // означал бы «не могу выбрать между Discord и Discord».
  const ambiguous = лучшиеИмена.size > 1;
  if (!best.exact && ambiguous) return null;

  return { item: best.item, score: best.total, exact: best.exact };
}
