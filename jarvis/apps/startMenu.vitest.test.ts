import { describe, expect, it } from 'vitest';

import { chooseShortcut, candidateKeys, stem, transliterate } from './startMenu';

/** Real shortcut names taken from the Start menu of the machine this targets. */
const INSTALLED = [
  'League of Legends',
  'Riot Client',
  'Клиент Riot',
  'Epic Games Launcher',
  'Steam',
  'Google Chrome',
  'Microsoft Edge',
  'Telegram Desktop',
  'Visual Studio Code',
  'Блокнот',
  'Калькулятор',
  'Диспетчер задач',
];

const pick = (spoken: string) => chooseShortcut(spoken, INSTALLED, (name) => name)?.item ?? null;

describe('spoken name to installed program', () => {
  it('bridges meaning, not just sound', () => {
    // «лигу» is the Russian word for League; no transliteration reaches it.
    expect(pick('лигу')).toBe('League of Legends');
    expect(pick('лига легенд')).toBe('League of Legends');
  });

  it('bridges sound for names written in Cyrillic', () => {
    expect(pick('стим')).toBe('Steam');
    expect(pick('телеграм')).toBe('Telegram Desktop');
    expect(pick('эпик')).toBe('Epic Games Launcher');
  });

  it('refuses a name that is only close, rather than opening the wrong thing', () => {
    // «стин» is a misheard "Steam" and one consonant away from it. Acting on
    // that class of match is what opened "Dev Home" for «хром» and "Диск
    // восстановления" for «дискорд», so a near miss is now a miss: the
    // assistant says it did not find it instead of guessing.
    expect(pick('стин')).toBeNull();
    // The same sound, though, is still a match: «стим» reduces to "stm", and
    // so does "Steam".
    expect(pick('стим')).toBe('Steam');
  });

  it('handles names already spoken in English', () => {
    expect(pick('steam')).toBe('Steam');
    expect(pick('chrome')).toBe('Google Chrome');
  });

  it('matches Russian shortcut names directly', () => {
    expect(pick('блокнот')).toBe('Блокнот');
    expect(pick('калькулятор')).toBe('Калькулятор');
  });

  it('prefers the short specific name over a longer one containing it', () => {
    expect(pick('риот')).toBe('Riot Client');
  });

  it('refuses rather than guessing when nothing fits', () => {
    expect(pick('квазимодо')).toBeNull();
    expect(pick('')).toBeNull();
    // Loosening the sound comparison must not make short words interchangeable.
    expect(pick('сон')).toBeNull();
    expect(pick('дом')).toBeNull();
  });
});

describe('word shaping', () => {
  it('strips the endings Russian adds to a name', () => {
    expect(stem('лигу')).toBe('лиг');
    expect(stem('лига')).toBe('лиг');
    // Too short to strip: what is left would match anything.
    expect(stem('код')).toBe('код');
  });

  it('transliterates Cyrillic to the Latin the shortcut uses', () => {
    expect(transliterate('стим')).toBe('stim');
    expect(transliterate('дискорд')).toBe('diskord');
  });

  it('offers the translated form among its candidates', () => {
    expect(candidateKeys('лигу')).toContain('league');
  });
});

/**
 * Список с этой машины — тот самый, на котором ложные совпадения и нашлись.
 *
 * Имена здесь настоящие, включая скучные: без «Источников данных ODBC» и
 * «Cloud Tools for PowerShell» проверять нечего, потому что ломалось именно о
 * них.
 */
const REAL = [
  'Epic Games Launcher',
  'Blender 5.2',
  'Steam',
  'OBS Studio (64bit)',
  'Riot Client',
  'Клиент Riot',
  'League of Legends',
  'Windows PowerShell',
  'Windows PowerShell ISE',
  'Cloud Tools for PowerShell',
  'Google Cloud SDK Shell',
  'ODBC Data Sources (32-bit)',
  'ODBC Data Sources (64-bit)',
  'Источники данных ODBC (32-разрядная версия)',
  'AutoHotkey Dash',
  'Divinity Original Sin 2',
  'Discord',
  'Discord',
  'Dev Home',
];

const fromReal = (spoken: string) => chooseShortcut(spoken, REAL, (name) => name)?.item ?? null;

describe('ложные совпадения в меню «Пуск»', () => {
  // Каждое из этих трёх поймано на живой машине. Открыть не ту программу хуже,
  // чем честно не найти: отказ человек слышит и повторяет, а чужую запущенную
  // программу замечает не сразу.
  it('«дота» не открывает «Источники данных ODBC», когда Dota 2 не в списке', () => {
    expect(fromReal('дота')).toBeNull();
    expect(fromReal('доту')).toBeNull();
  });

  it('«клод» не открывает Cloud Tools for PowerShell', () => {
    expect(fromReal('клод')).toBeNull();
    expect(fromReal('клода')).toBeNull();
  });

  it('«эдж» не открывает AutoHotkey Dash', () => {
    // Отбрасывание гласных съедало начало слова: «эдж» это "edzh", остов
    // "dsh" — ровно как у "Dash".
    expect(fromReal('эдж')).toBeNull();
  });

  it('«стин» не открывает Divinity Original Sin 2', () => {
    // Недослышанное «стим». Для трёхбуквенного "Sin" одна буква разницы — это
    // треть слова.
    expect(fromReal('стин')).toBeNull();
  });

  it('«хром» не открывает Dev Home', () => {
    expect(fromReal('хром')).toBeNull();
  });
});

describe('верные совпадения, которые обязаны остаться', () => {
  it.each([
    ['эпик', 'Epic Games Launcher'],
    ['блендер', 'Blender 5.2'],
    ['стим', 'Steam'],
    ['обс', 'OBS Studio (64bit)'],
    ['риот', 'Riot Client'],
    ['повершелл', 'Windows PowerShell'],
    ['павершелл', 'Windows PowerShell'],
    ['пауэршелл', 'Windows PowerShell'],
    ['лол', 'League of Legends'],
    ['лигу', 'League of Legends'],
  ])('«%s» находит «%s»', (spoken, want) => {
    expect(fromReal(spoken)).toBe(want);
  });

  it('одно имя дважды — это не выбор между программами', () => {
    // Discord лежит в меню «Пуск» двумя одинаковыми ярлыками. Отказ по
    // неоднозначности означал бы «не могу выбрать между Discord и Discord».
    expect(fromReal('дискорд')).toBe('Discord');
  });

  it('склонённое имя находит ту же программу', () => {
    // Русский склоняет хвост: «доту» и «дота» отличаются последней буквой.
    expect(chooseShortcut('доту', ['Dota 2'], (n) => n)?.item).toBe('Dota 2');
    expect(chooseShortcut('дота', ['Dota 2'], (n) => n)?.item).toBe('Dota 2');
    expect(chooseShortcut('клод', ['Claude', ...REAL], (n) => n)?.item).toBe('Claude');
  });
});

/**
 * Две поломки, найденные разбором, а не на живой машине.
 */
describe('счёт вничью и короткие слова', () => {
  it('одно имя дважды не прячет третью, другую программу', () => {
    // Порядок [X, X, Y] при равном счёте: со «вторым местом» второй X
    // занимал место второго, Y его уже не отбирал — счёт-то равный, — и
    // выходило «совпадение единственное» там, где их два разных.
    // Ярлыки-дубли в меню «Пуск» обычны: у Discord их два.
    const список = ['Cloud Tools for PowerShell', 'Cloud Tools for PowerShell', 'Cloud Shell for Google'];
    expect(chooseShortcut('клауд', список, (n) => n)).toBeNull();
  });

  it('одно и то же имя дважды выбором не считается', () => {
    // Отказ здесь означал бы «не могу выбрать между Discord и Discord».
    expect(chooseShortcut('дискорд', ['Discord', 'Discord'], (n) => n)?.item).toBe('Discord');
  });

  it('служебное словечко не открывает «Параметры»', () => {
    // «И» давало ключ ai (от «ии») и games (от «игр»), «на» давало settings
    // (от «настройк»). Ключ совпадал с именем буквально, exact становился
    // true, и защита от неоднозначности пропускала результат.
    expect(chooseShortcut('и', ['Параметры', 'Games', 'AI Studio'], (n) => n)).toBeNull();
    expect(chooseShortcut('на', ['Параметры', 'Settings'], (n) => n)).toBeNull();
  });

  it('«ии» по-прежнему находит AI', () => {
    // Длина ограничена только в ту сторону, где сказанное КОРОЧЕ записи.
    expect(chooseShortcut('ии студия', ['AI Studio', 'Блокнот'], (n) => n)?.item).toBe('AI Studio');
  });
});
