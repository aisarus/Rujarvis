import { describe, expect, it } from 'vitest';

import {
LAUNCH_NAMES,
WINDOW_NAMES,
aliasTarget,
matchAppLaunch,
spokenCloseTarget,
spokenTarget,
windowAlias,
} from './launch';

describe('matchAppLaunch', () => {
  it('recognises the plain request', () => {
    expect(matchAppLaunch('открой хром')?.target).toBe('chrome');
    expect(matchAppLaunch('запусти телеграм')?.target).toBe('telegram');
    expect(matchAppLaunch('включи блокнот')?.target).toBe('notepad');
  });

  it('takes the spellings recognition actually returns', () => {
    // All of these came back from a live microphone for the same two words.
    expect(matchAppLaunch('Открой Edge')?.target).toBe('msedge');
    expect(matchAppLaunch('открой эдж')?.target).toBe('msedge');
    expect(matchAppLaunch('Открой Chrome.')?.target).toBe('chrome');
  });

  it('looks past filler words', () => {
    expect(matchAppLaunch('открой мне пожалуйста хром')?.target).toBe('chrome');
  });

  it('leaves real tasks to the agent', () => {
    // A launch verb does not make something a launch: these are jobs.
    for (const task of [
      'открой файл отчёт и посчитай сумму',
      'запусти тесты в проекте aegis',
      'открой почту и найди письмо от банка',
      'посмотри что на экране',
    ]) {
      expect(matchAppLaunch(task), task).toBeNull();
    }
  });

  it('ignores an unknown program rather than guessing', () => {
    expect(matchAppLaunch('открой квазимодо')).toBeNull();
    expect(matchAppLaunch('')).toBeNull();
  });
});

describe('spokenCloseTarget', () => {
  it('recognises a request to close something', () => {
    expect(spokenCloseTarget('закрой хром')).toBe('хром');
    expect(spokenCloseTarget('выключи лигу')).toBe('лигу');
    expect(spokenCloseTarget('убей стим')).toBe('стим');
  });

  it('is not confused by the opening verb', () => {
    expect(spokenCloseTarget('открой хром')).toBeNull();
  });

  it('leaves descriptions of work alone', () => {
    expect(spokenCloseTarget('закрой все вкладки и выключи компьютер')).toBeNull();
  });

  it('resolves a spoken name to the executable, which no transliteration would', () => {
    // «хром» transliterates to "hrom"; the process is called chrome.exe.
    expect(aliasTarget('хром')).toBe('chrome');
    expect(aliasTarget('эдж')).toBe('msedge');
  });
});

describe('местоимения — не названия программ', () => {
  it.each([
    'открой его обратно',
    'открой это снова',
    'открой её',
    'запусти то же самое',
    'открой обратно',
  ])('«%s» не даёт названия программы', (phrase) => {
    // Из лога: «открой его обратно» дало цель «его обратно», и Джарвис нечётко
    // сопоставил её с установленной программой Overtune и запустил её.
    expect(spokenTarget(phrase)).toBe(null);
  });

  it('настоящее название по-прежнему находится', () => {
    expect(spokenTarget('открой блендер')).toBe('блендер');
    expect(spokenTarget('запусти стим')).toBe('стим');
    expect(spokenTarget('открой гугл хром')).toBe('гугл хром');
  });
});

describe('две таблицы, а не одна', () => {
  it('каждое пусковое имя разбирается и отдаёт своё значение', () => {
    // Таблица, которую некому перебрать, проверяется только теми строчками,
    // про которые кто-то вспомнил написать тест.
    for (const [spoken, target] of LAUNCH_NAMES) {
      expect(aliasTarget(spoken)).toBe(target);
      expect(matchAppLaunch(`открой ${spoken}`)?.target).toBe(target);
    }
  });

  it('каждое оконное имя разбирается и отдаёт своё значение', () => {
    for (const [spoken, target] of WINDOW_NAMES) {
      expect(windowAlias(spoken)).toBe(target);
      expect(spokenCloseTarget(`закрой ${spoken}`)).toBe(spoken);
    }
  });

  it('дискорд запускается ярлыком, а не выдуманной командой', () => {
    // `start discord` не работает: Discord не кладёт себя ни в PATH, ни в «App
    // Paths». Строчка в пусковой таблице перехватывала фразу раньше поиска по
    // ярлыкам и гарантировала отказ — та же поломка, что «блендер → blender».
    expect(aliasTarget('дискорд')).toBeNull();
    expect(matchAppLaunch('открой дискорд')).toBeNull();
    // При этом окно и процесс называются, и закрытие с переключением работают.
    expect(windowAlias('дискорд')).toBe('Discord');
  });

  it('блендер тоже не имеет пускового имени', () => {
    expect(aliasTarget('блендер')).toBeNull();
    expect(windowAlias('блендер')).toBe('blender');
  });

  it('пусковое и оконное имя совпадают не всегда', () => {
    // У Chrome совпали случайно, и это совпадение сбило с толку.
    expect(aliasTarget('хром')).toBe('chrome');
    expect(windowAlias('хром')).toBe('chrome');
    // А у терминала — нет.
    expect(aliasTarget('терминал')).toBe('wt');
    expect(windowAlias('терминал')).toBe('WindowsTerminal');
  });
});
