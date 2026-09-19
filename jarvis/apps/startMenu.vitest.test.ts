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
