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
    //
    // 'edge', а не 'msedge': это ПУСКОВАЯ таблица, и совпадать надо с
    // названием программы («Microsoft Edge»). Слова «msedge» нет ни в одном
    // названии, и «открой эдж» не находило ничего. Поймано живым прогоном
    // 26.09.2026; имя процесса осталось в оконной таблице, где оно и нужно.
    expect(matchAppLaunch('Открой Edge')?.target).toBe('edge');
    expect(matchAppLaunch('открой эдж')?.target).toBe('edge');
    expect(matchAppLaunch('Открой Chrome.')?.target).toBe('chrome');
  });

  it('looks past filler words', () => {
    expect(matchAppLaunch('открой мне пожалуйста хром')?.target).toBe('chrome');
    // «моё» до таблицы пустых слов доезжает как «мое»: normalise заменяет ё
    // на е раньше. Со старой записью «моё» фраза не находила цель вовсе.
    expect(matchAppLaunch('открой моё приложение хром')?.target).toBe('chrome');
  });

  it('не запускает то, что просили не запускать', () => {
    // «Не запускай хром» содержит «запускай», и без проверки отрицания
    // браузер открывался вопреки прямому запрету.
    for (const фраза of [
      'не запускай хром',
      'не открывай телеграм',
      'пожалуйста не открывай хром',
      'не надо запускать блокнот',
      'do not open chrome',
      "don't launch telegram",
    ]) {
      expect(matchAppLaunch(фраза), фраза).toBeNull();
    }
  });

  it('«сверни» не закрывает программу', () => {
    // Свернуть окно и закрыть программу — разные вещи. «Сверни» — прямая
    // команда win+down, и попав в список закрытия, она убивала браузер.
    expect(spokenCloseTarget('сверни хром')).toBeNull();
    expect(spokenCloseTarget('закрой хром')).toBe('хром');
  });

  it('leaves real tasks to the agent', () => {
    // Глагол запуска сам по себе команды не делает: всё это — работа, а не
    // название программы. Нечёткий поиск по ярлыкам на такой фразе всегда
    // что-нибудь находит и запускает не то — так «открой его обратно»
    // запустило Overtune. Пусть разбирает агент.
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
    // «хром» transliterates to "hrom"; the program is called Google Chrome.
    expect(aliasTarget('хром')).toBe('chrome');
    // Пусковая таблица ведёт к СЛОВУ из названия, а не к имени процесса.
    expect(aliasTarget('эдж')).toBe('edge');
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

  it('пусковые имена ведут туда, куда надо, а не туда, что записано', () => {
    // Перебор выше берёт ожидаемое значение из той же таблицы, по которой и
    // ищет: впиши в неё «хром → firefox» — и он останется зелёным. Здесь
    // значения записаны отдельно и сверяются с таблицей, а не с собой.
    // Замеры 26.09.2026 на живой машине изменили два из этих значений, и оба
    // прежних были ошибкой, которую эта проверка поймать не могла: она сверяет
    // таблицу с записанным здесь, а записано здесь было то же неверное.
    //
    //   «эдж» → 'msedge'  — слова «msedge» нет ни в одном НАЗВАНИИ программы,
    //                       и «открой эдж» не находило ничего.
    //   «калькулятор» → 'calc' — ТОЧНО совпадало со словом «Calc» в
    //                       «LibreOffice Calc» и открывало таблицу.
    //
    // Что найдено в итоге правда то, проверяет storeNames.vitest.test.ts: он
    // смотрит на выбранную программу, а не на значение псевдонима.
    const ЖДЁМ: ReadonlyArray<readonly [string, string]> = [
      ['хром', 'chrome'],
      ['телеграм', 'telegram'],
      ['блокнот', 'notepad'],
      ['эдж', 'edge'],
      ['калькулятор', 'calculator'],
    ];
    for (const [сказано, цель] of ЖДЁМ) {
      expect(aliasTarget(сказано), сказано).toBe(цель);
    }
  });

  it('оконные имена ведут к настоящим окнам, а не к записанным', () => {
    const ЖДЁМ: ReadonlyArray<readonly [string, string]> = [
      ['дискорд', 'Discord'],
      ['хром', 'chrome'],
      ['телеграм', 'telegram'],
    ];
    for (const [сказано, окно] of ЖДЁМ) {
      expect(windowAlias(сказано), сказано).toBe(окно);
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
