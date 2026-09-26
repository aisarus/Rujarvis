import { describe, expect, it } from 'vitest';

import { parseDirectCommand } from '../control/commands';
import { fixMishearings } from './mishearing';
import { findWakeWord } from './wakeWord';

describe('fixMishearings', () => {
  it.each([
    ['Открой блиндер.', 'открой блендер'],
    ['создая в блиндире красную сферу', 'создая в блендере красную сферу'],
    ['создая в Глендире красную сферу', 'создая в блендере красную сферу'],
    ['Открой Хрум.', 'открой хром'],
    ['Закрою Steam.', 'закрой steam'],
    ['Уромче.', 'громче'],
  ])('«%s» → «%s»', (heard, expected) => {
    // Всё это снято с живого распознавателя, а не придумано.
    expect(fixMishearings(heard).toLowerCase().replace(/[.,]/gu, '').trim()).toBe(expected);
  });

  it('чинит слово остановки', () => {
    // «Хватит» слышится как «Ватя». Человек назвал остановку отдельным
    // требованием, и терять её нельзя.
    expect(fixMishearings('Ватя.').toLowerCase()).toContain('хватит');
  });

  it('чинит вставку, которую слышит по-английски', () => {
    expect(fixMishearings('stuff.').toLowerCase()).toContain('вставь');
  });

  it('разделяет слипшиеся слова команды', () => {
    expect(fixMishearings('Кликсорок 5.').toLowerCase()).toContain('клик сорок');
  });

  it('не трогает то, что распознано верно', () => {
    for (const phrase of [
      'создай в блендере красную сферу',
      'прокрути вниз',
      'что ты умеешь',
      'сделай таблицу с расходами',
    ]) {
      expect(fixMishearings(phrase)).toBe(phrase);
    }
  });

  it('не чинит слова, похожие на исправляемые', () => {
    // «Ватя» чинится только когда это вся фраза: иначе имя в диктовке
    // превратилось бы в команду остановки.
    expect(fixMishearings('передай Ватя привет')).toBe('передай Ватя привет');
    expect(fixMishearings('мне нужен блиндаж')).toBe('мне нужен блиндаж');
  });

  it('переживает пустую строку', () => {
    expect(fixMishearings('')).toBe('');
    expect(fixMishearings('   ')).toBe('   ');
  });
});

/**
 * Замолчать — красная линия, и она ломалась молча.
 *
 * В живом логе 20.09.2026 «Тешина» встречается четыре раза, «Тишина» — тоже
 * четыре. То есть половину просьб замолчать распознаватель писал с ошибкой в
 * одну букву, командой они не признавались, и человек в ответ на «замолчи»
 * получал разговор.
 */
describe('ослышки команд остановки', () => {
  it.each([
    ['Тешина', 'тишина'],
    ['тишена', 'тишина'],
    ['Молкин', 'молчи'],
  ])('«%s» — это «%s»', (сказано, ожидаем) => {
    expect(fixMishearings(сказано).toLowerCase()).toBe(ожидаем);
  });

  // Замена целой фразой, а не словом: иначе «тишина в библиотеке» поедет.
  it('внутри фразы ничего не меняется', () => {
    expect(fixMishearings('тешина в библиотеке')).toBe('тешина в библиотеке');
  });
});

import { collapseRepeats } from './mishearing';

describe('recogniser loops and English mishearings', () => {
  it('turns a looped phrase back into what was said', () => {
    expect(collapseRepeats('Silence. Silence. Silence. Silence')).toBe('Silence');
    expect(collapseRepeats('Pause. Pause. Pause. Pause')).toBe('Pause');
    expect(collapseRepeats('тишина тишина тишина')).toBe('тишина');
    expect(collapseRepeats('Открой хром. Открой хром.')).toBe('Открой хром');
  });

  it('leaves ordinary speech alone', () => {
    expect(collapseRepeats('Стоп, стоп, подожди')).toBe('Стоп, стоп, подожди');
    expect(collapseRepeats('open chrome')).toBe('open chrome');
  });

  it('repairs the lost first consonant of a short English command, and only as a whole phrase', () => {
    expect(fixMishearings('Top.')).toBe('stop');
    expect(fixMishearings('Crawl down.')).toBe('scroll down');
    expect(fixMishearings('put it on top of the list')).toBe('put it on top of the list');
    expect(fixMishearings('Silence. Silence. Silence.')).toBe('Silence');
  });
});

describe('обычные слова чинятся только в начале фразы', () => {
  /**
   * Замечание CodeRabbit (кусок 4, PR №43). «Закрою» и «открою» — обычные
   * русские слова, а замена шла по всей фразе. «я потом сам закрою»
   * превращалось в «я потом сам закрой», разбор видел просьбу, и Джарвис
   * закрывал программу посреди разговора в комнате.
   */
  it('в начале фразы будущее время всё ещё чинится', () => {
    expect(fixMishearings('Закрою Steam')).toBe('Закрой Steam');
    expect(fixMishearings('открою хром')).toBe('открой хром');
  });

  it('в середине фразы слово остаётся словом', () => {
    expect(fixMishearings('я потом сам закрою')).toBe('я потом сам закрою');
    expect(fixMishearings('давай я открою окно')).toBe('давай я открою окно');
  });
});

describe('начало команды — и после имени тоже', () => {
  it.each([
    ['Закрою Steam', 'Закрой Steam'],
    ['Джарвис, закрою Steam', 'Джарвис, закрой Steam'],
    ['Джарвис открыл хром', 'Джарвис открой хром'],
    ['Жарвис открою блендер', 'Жарвис открой блендер'],
  ])('«%s» → «%s»', (услышано, ждём) => {
    // Прежде «начало» было буквально первым словом, и «Джарвис, закрою Steam»
    // не правилось, хотя так и говорят, пока окно слушания закрыто.
    expect(fixMishearings(услышано)).toBe(ждём);
  });

  it.each([
    'я потом сам закрою',
    'Джарвис, я потом закрою',
    'Джарвис, ты открыл?',
    'Он открыл окно',
  ])('«%s» — настоящее слово не в начале команды, не трогаем', (фраза) => {
    // «Закрою», «открою», «открыл» — обычные русские слова. Замена внутри
    // фразы превращала рассказ человека в команду и закрывала программу
    // посреди разговора в комнате.
    expect(fixMishearings(фраза)).toBe(фраза);
  });
});

describe('ослышки, замеренные 26.09.2026 синтезом Piper → Whisper', () => {
  it.each([
    ['Дишина', 'тишина'],
    ['4s', 'pause'],
    ['Pro down', 'scroll down'],
    ['Прокрутив низ', 'прокрути вниз'],
  ])('«%s» целиком → «%s»', (услышано, ждём) => {
    expect(fixMishearings(услышано)).toBe(ждём);
  });

  it('«загрой» — не слово, чинится везде', () => {
    expect(fixMishearings('Загрой спатифы')).toBe('Закрой спатифы');
  });
});

describe('«switch to» с потерянным началом', () => {
  // Замер 27.09.2026: «Switch to Telegram» у Whisper small — «which / witch /
  // Pitch / Twitch / Pwych to Telegram»; запас тишины и смена голоса не помогают.
  it.each([
    ['Which to telegram.', 'Switch to telegram.'],
    ['Pwych to Telegram.', 'Switch to Telegram.'],
    ['twitch to Telegram', 'switch to Telegram'],
    ['Pitch to Telegram', 'Switch to Telegram'],
    ['Jarvis, which to Telegram', 'Jarvis, switch to Telegram'],
  ])('«%s» → «%s»', (heard, fixed) => {
    expect(fixMishearings(heard)).toBe(fixed);
  });

  it.each([
    ['Troll down.', 'Scroll down.'],
    ['Prol down', 'Scroll down'],
    ['Jarvis, troll up', 'Jarvis, scroll up'],
  ])('прокрутка по звучанию: «%s» → «%s»', (heard, fixed) => {
    expect(fixMishearings(heard)).toBe(fixed);
  });

  it.each(['Calm down', 'Roll down the window please now', 'Hold down', 'Troll'])(
    'прокрутка не выдумывается: «%s»',
    (phrase) => {
      expect(fixMishearings(phrase)).toBe(phrase);
    },
  );

  it('исправленное разбирается как переключение окна', () => {
    expect(parseDirectCommand(fixMishearings('Which to telegram.'))).toEqual({ kind: 'focus', title: 'telegram' });
  });

  it.each([
    'Which to choose between these two options',
    'which one to pick',
    'Which is better',
    'switch to Telegram',
    'Pitch to the investors right now',
    'Переключись на телеграм',
    'Kitchen to go',
  ])('«%s» не трогается', (phrase) => {
    expect(fixMishearings(phrase)).toBe(phrase);
  });
});

describe('правила по звучанию не будят и не выдумывают команд', () => {
  it.each([
    'Which to choose between these two options',
    'which one to pick',
    'good job today',
    'low battery warning',
    'Calm down',
    'the kitchen is to the left',
  ])('«%s» — ни побудки, ни команды', (phrase) => {
    const fixed = fixMishearings(phrase);
    expect(findWakeWord(fixed)).toBeNull();
    expect(parseDirectCommand(fixed)).toBeNull();
  });
});
