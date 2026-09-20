import { describe, expect, it } from 'vitest';

import { endsDictation, parseDirectCommand } from './commands';

/** Короткая запись: что за действие получилось. */
function act(phrase: string): string | null {
  const command = parseDirectCommand(phrase);
  if (!command) return null;
  switch (command.kind) {
    case 'key':
      return `key:${command.keys}`;
    case 'scroll':
      return `scroll:${command.amount}`;
    case 'click':
      return `click:${command.button}${command.double ? ':2' : ''}`;
    case 'type':
      return `type:${command.text}`;
  }
}

describe('клавиши', () => {
  it.each([
    ['enter', 'key:enter'],
    ['ввод', 'key:enter'],
    ['нажми enter', 'key:enter'],
    ['escape', 'key:escape'],
    ['отмена', 'key:escape'],
    ['таб', 'key:tab'],
    ['пробел', 'key:space'],
    ['удали', 'key:backspace'],
    ['вниз', 'key:down'],
    ['вверх', 'key:up'],
    ['влево', 'key:left'],
    ['вправо', 'key:right'],
  ])('«%s» → %s', (phrase, expected) => {
    expect(act(phrase)).toBe(expected);
  });
});

describe('сочетания', () => {
  it.each([
    ['скопируй', 'key:ctrl+c'],
    ['копировать', 'key:ctrl+c'],
    ['вставь', 'key:ctrl+v'],
    ['вырежи', 'key:ctrl+x'],
    ['отмени действие', 'key:ctrl+z'],
    ['выдели всё', 'key:ctrl+a'],
    ['сохрани', 'key:ctrl+s'],
    ['новая вкладка', 'key:ctrl+t'],
    ['закрой вкладку', 'key:ctrl+w'],
    ['переключись', 'key:alt+tab'],
    ['обнови', 'key:f5'],
    ['закрой окно', 'key:alt+f4'],
    ['разверни', 'key:win+up'],
    ['сверни', 'key:win+down'],
  ])('«%s» → %s', (phrase, expected) => {
    expect(act(phrase)).toBe(expected);
  });
});

describe('прокрутка', () => {
  it('крутит вниз и вверх', () => {
    expect(act('прокрути вниз')).toBe('scroll:-3');
    expect(act('прокрути вверх')).toBe('scroll:3');
  });

  it('понимает «ниже» и «выше»', () => {
    expect(act('ниже')).toBe('scroll:-3');
    expect(act('выше')).toBe('scroll:3');
  });

  it('в самый низ — это клавиша, а не колесо', () => {
    expect(act('в самый низ')).toBe('key:ctrl+end');
    expect(act('в самый верх')).toBe('key:ctrl+home');
  });
});

describe('мышь', () => {
  it.each([
    ['кликни', 'click:left'],
    ['клик', 'click:left'],
    ['правый клик', 'click:right'],
    ['двойной клик', 'click:left:2'],
  ])('«%s» → %s', (phrase, expected) => {
    expect(act(phrase)).toBe(expected);
  });
});

describe('звук и медиа', () => {
  it.each([
    ['громче', 'key:volumeup'],
    ['тише звук', 'key:volumedown'],
    ['выключи звук', 'key:volumemute'],
    ['пауза', 'key:playpause'],
    ['следующий трек', 'key:nexttrack'],
  ])('«%s» → %s', (phrase, expected) => {
    expect(act(phrase)).toBe(expected);
  });
});

describe('диктовка', () => {
  it('печатает продиктованное', () => {
    expect(act('напечатай привет как дела')).toBe('type:привет как дела');
  });

  it('«напиши» больше не печатает, а отдаёт работу агенту', () => {
    // Живой случай: человек сказал «напиши скиллы для поиска ассетов и звуков
    // и положи в нужную папку», и Джарвис НАПЕЧАТАЛ эти слова в активное окно.
    // В журнале это выглядело как «перестал отвечать»: задача не заводилась.
    //
    // Защита была списком вещей, которые «пишут» (письмо, отчёт, код), — но он
    // перечисляет то, о чём успели подумать, а человек говорит о чём угодно.
    // Буквальный набор остался за «напечатай» и режимом диктовки.
    expect(act('напиши спасибо за встречу')).toBe(null);
    expect(act('напиши скиллы для поиска ассетов')).toBe(null);
  });

  it('но «напечатай» печатает по-прежнему', () => {
    expect(act('напечатай спасибо за встречу')).toBe('type:спасибо за встречу');
    expect(act('введи пароль от вайфая')).toBe('type:пароль от вайфая');
  });

  it('не печатает пустоту', () => {
    expect(act('напечатай')).toBe(null);
  });
});

describe('заполнители в середине фразы', () => {
  it('«что ты сейчас делаешь» открывает окно работы', () => {
    // Живой случай: человек сказал именно так, и окно не открылось — таблицы
    // сверяются точным совпадением, а «сейчас» стояло в середине.
    expect(parseDirectCommand('что ты сейчас делаешь')).toEqual({ kind: 'log', on: true });
    expect(parseDirectCommand('ну что ты там делаешь')).toEqual({ kind: 'log', on: true });
  });

  it('заполнители не превращают просьбу в команду', () => {
    // Очистка не должна открывать дорогу перехвату: «найди отчёт за март»
    // остаётся работой для агента и после неё.
    expect(act('найди сейчас отчёт за март')).toBe(null);
    expect(act('сохрани там таблицу в папку джарвис')).toBe(null);
  });
});

describe('что НЕ должно перехватываться', () => {
  it('не путает задачу с сочетанием клавиш', () => {
    // Иначе «найди отчёт за март» нажмёт Ctrl+F вместо того, чтобы искать.
    expect(act('найди отчёт за март')).toBe(null);
    expect(act('сохрани таблицу в папку джарвис')).toBe(null);
    expect(act('скопируй файл на флешку')).toBe(null);
  });

  it('длинное описание клика оставляет агенту', () => {
    // Название кнопки — это пара слов. Всё длиннее нужно смотреть глазами.
    expect(act('кликни туда где написано что доставка бесплатная')).toBe(null);
  });

  it('не трогает запуск программ — это делает свой слой', () => {
    expect(act('открой хром')).toBe(null);
  });

  it('отличает диктовку от заказа текста', () => {
    // Продиктованное попадает в окно буква в букву; заказанное сочиняет агент.
    expect(act('напиши письмо Ивану про встречу')).toBe(null);
    expect(act('напиши отчет за сентябрь')).toBe(null);
    expect(act('напиши код который считает сумму')).toBe(null);
  });

  it('молчит на обычной речи', () => {
    expect(act('расскажи что нового')).toBe(null);
    expect(act('')).toBe(null);
  });

  it('не срабатывает на «вниз» внутри длинной фразы', () => {
    expect(act('прокрути вниз до самого конца страницы и найди итог')).toBe(null);
  });
});

describe('распознавание бывает неточным', () => {
  it('прощает лишнюю вежливость и знаки', () => {
    expect(act('нажми, пожалуйста, enter')).toBe('key:enter');
    expect(act('Скопируй!')).toBe('key:ctrl+c');
  });

  it('не зависит от регистра', () => {
    expect(act('ВВЕРХ')).toBe('key:up');
  });
});

describe('переключение между окнами', () => {
  it('понимает, на что переключиться', () => {
    const command = parseDirectCommand('переключись на хром');
    expect(command).toEqual({ kind: 'focus', title: 'хром' });
  });

  it.each([
    'перейди в блендер',
    'покажи окно блендер',
    'вернись в блендер',
  ])('«%s» тоже переключение', (phrase) => {
    const command = parseDirectCommand(phrase);
    expect(command?.kind).toBe('focus');
    expect((command as { title: string }).title).toBe('блендер');
  });

  it('без цели остаётся обычным alt+tab', () => {
    expect(parseDirectCommand('переключись')).toEqual({ kind: 'key', keys: 'alt+tab' });
  });

  it('не путает переключение с запуском', () => {
    // «Переключись» показывает уже открытое окно и разбирается здесь;
    // «открой» запускает и уходит своему слою в мосте.
    expect(parseDirectCommand('переключись на хром')).toEqual({ kind: 'focus', title: 'хром' });
    expect(parseDirectCommand('открой хром')).toBe(null);
  });
});

describe('режим диктовки', () => {
  it('включается', () => {
    // «Диктую» отсюда ушло: человек попросил этим словом предупреждать о
    // длинной мысли, а не включать печать. Печать — на «печатай».
    expect(parseDirectCommand('режим диктовки')).toEqual({ kind: 'dictation', on: true });
    expect(parseDirectCommand('печатай')).toEqual({ kind: 'dictation', on: true });
  });

  it('выключается', () => {
    expect(parseDirectCommand('конец диктовки')).toEqual({ kind: 'dictation', on: false });
    expect(parseDirectCommand('стоп диктовка')).toEqual({ kind: 'dictation', on: false });
  });
});

describe('«диктую» и «печатай» — разные вещи', () => {
  it('«диктую» включает длинную мысль, а не печать', () => {
    // Человек просил именно этим словом предупреждать, что будет говорить с
    // паузами: «максимальный перерыв между словами становится 5 секунд».
    expect(parseDirectCommand('диктую')).toEqual({ kind: 'longSpeech' });
    expect(parseDirectCommand('буду говорить долго')).toEqual({ kind: 'longSpeech' });
  });

  it('«печатай» включает печать в окно', () => {
    expect(parseDirectCommand('печатай')).toEqual({ kind: 'dictation', on: true });
    expect(parseDirectCommand('пиши за мной')).toEqual({ kind: 'dictation', on: true });
    expect(parseDirectCommand('режим диктовки')).toEqual({ kind: 'dictation', on: true });
  });

  it('«печатай что-то» по-прежнему печатает это что-то', () => {
    // Односложная форма не должна съесть форму с текстом.
    expect(parseDirectCommand('печатай привет как дела')).toEqual({
      kind: 'type',
      text: 'привет как дела',
    });
  });
});

describe('выход из диктовки распознаётся отдельно', () => {
  it('знает фразы окончания', () => {
    expect(endsDictation('конец диктовки')).toBe(true);
    expect(endsDictation('стоп диктовка')).toBe(true);
    expect(endsDictation('хватит диктовать')).toBe(true);
  });

  it('не принимает за конец обычный текст', () => {
    expect(endsDictation('и на этом всё, спасибо за встречу')).toBe(false);
    expect(endsDictation('конец рабочего дня')).toBe(false);
  });
});

describe('клик по названию', () => {
  it('понимает, по чему кликнуть', () => {
    expect(parseDirectCommand('кликни по кнопке войти')).toEqual({
      kind: 'clickNamed',
      query: 'войти',
    });
  });

  it.each(['нажми на сохранить', 'щелкни по ссылке подробнее', 'клик вкладку файл'])(
    '«%s» — тоже клик по названию',
    (phrase) => {
      expect(parseDirectCommand(phrase)?.kind).toBe('clickNamed');
    },
  );

  it('без названия остаётся кликом на месте курсора', () => {
    expect(parseDirectCommand('кликни')).toEqual({ kind: 'click', button: 'left' });
  });
});

describe('сетка', () => {
  it('показывается и убирается', () => {
    expect(parseDirectCommand('сетка')).toEqual({ kind: 'grid', on: true });
    expect(parseDirectCommand('покажи сетку')).toEqual({ kind: 'grid', on: true });
    expect(parseDirectCommand('убери сетку')).toEqual({ kind: 'grid', on: false });
  });

  it('кликает по номеру клетки цифрами и словами', () => {
    expect(parseDirectCommand('клик 45')).toEqual({ kind: 'gridClick', cell: 45 });
    expect(parseDirectCommand('кликни сорок пять')).toEqual({ kind: 'gridClick', cell: 45 });
  });

  it('уточняет отдельной фразой — иначе на слух неоднозначно', () => {
    // «Клик сорок пять пять» складывается в пятьдесят, а не в «45, доля 5».
    expect(parseDirectCommand('точнее 5')).toEqual({ kind: 'gridRefine', sub: 5 });
    expect(parseDirectCommand('уточни три')).toEqual({ kind: 'gridRefine', sub: 3 });
  });

  it('не принимает за клетку номер вне сетки', () => {
    expect(parseDirectCommand('кликни 500')?.kind).toBe('clickNamed');
  });

  it('не мешает клику по названию', () => {
    expect(parseDirectCommand('кликни войти')?.kind).toBe('clickNamed');
  });
});

describe('повторение', () => {
  it('повторяет команду столько раз, сколько сказали', () => {
    // Прокручивать по одному щелчку голосом невыносимо.
    expect(parseDirectCommand('прокрути вниз три раза')).toEqual({
      kind: 'repeat',
      times: 3,
      command: { kind: 'scroll', amount: -3 },
    });
  });

  it('понимает цифры и слова', () => {
    expect(parseDirectCommand('вниз 5 раз')).toEqual({
      kind: 'repeat',
      times: 5,
      command: { kind: 'key', keys: 'down' },
    });
    expect(parseDirectCommand('удали два раза')).toEqual({
      kind: 'repeat',
      times: 2,
      command: { kind: 'key', keys: 'backspace' },
    });
  });

  it('не повторяет бесконечно', () => {
    // «Сто раз» по ошибке распознавания — это сто нажатий в чужом документе.
    const command = parseDirectCommand('вниз сто раз');
    expect(command?.kind === 'repeat' && command.times).toBeLessThanOrEqual(20);
  });

  it('без числа остаётся обычной командой', () => {
    expect(parseDirectCommand('прокрути вниз')).toEqual({ kind: 'scroll', amount: -3 });
  });

  it('не принимает за повтор диктовку с числом', () => {
    expect(parseDirectCommand('напечатай три раза')).toEqual({ kind: 'type', text: 'три раза' });
  });

  it('не повторяет то, что повторять нельзя', () => {
    // Диктовка, сетка и список — не те вещи, которые делают пять раз подряд.
    expect(parseDirectCommand('режим диктовки два раза')).toBe(null);
  });
});

describe('имя в начале фразы не мешает команде', () => {
  // Живой случай 20.09.2026: человек говорит «Джарвис, переключись на Riot
  // Client», окно бодрствования уже открыто, имя остаётся в тексте — и ни одна
  // прямая команда не совпадает. Всё уходит агенту: тридцать секунд вместо
  // трёхсот миллисекунд. В журнале это выглядело как «не работает ничего».
  it('«джарвис» перед командой отбрасывается', () => {
    expect(parseDirectCommand('джарвис переключись на риот клиент')).toEqual({
      kind: 'focus',
      title: 'риот клиент',
    });
  });

  it('с запятой и заглавными — то же самое', () => {
    expect(parseDirectCommand('Джарвис, следующая вкладка')).toEqual({
      kind: 'key',
      keys: 'ctrl+tab',
    });
  });

  it('имя внутри фразы не трогаем: это может быть содержание', () => {
    expect(parseDirectCommand('напечатай джарвис молодец')).toEqual({
      kind: 'type',
      text: 'джарвис молодец',
    });
  });

  it('одно имя без команды командой не становится', () => {
    expect(parseDirectCommand('джарвис')).toBeNull();
  });
});

describe('вкладки', () => {
  it('понимает разные способы сказать одно', () => {
    for (const phrase of ['следующая вкладка', 'переключи вкладку', 'переключись на следующую вкладку']) {
      expect(parseDirectCommand(phrase)).toEqual({ kind: 'key', keys: 'ctrl+tab' });
    }
  });

  it('предыдущая вкладка — отдельная клавиша', () => {
    expect(parseDirectCommand('предыдущая вкладка')).toEqual({
      kind: 'key',
      keys: 'ctrl+shift+tab',
    });
  });
});

describe('запуск программы остаётся своему слою', () => {
  // Здесь его намеренно нет. В мосте запуск уже сделан лучше: там псевдонимы
  // («хром» → Chrome) и поиск по меню «Пуск», так что находится и то, чего в
  // таблице никогда не будет. Перехватывать его тут значило бы потерять оба.
  it('таблица запуск не разбирает', () => {
    expect(parseDirectCommand('открой хром')).toBeNull();
    expect(parseDirectCommand('запусти блендер')).toBeNull();
  });

  // Но имя обязано слетать и здесь: дальше по мосту фраза попадёт в слой
  // запуска, и «джарвис открой стим» должно дойти туда как «открой стим».
  it('имя впереди не мешает фразе дойти до слоя запуска', () => {
    expect(parseDirectCommand('джарвис открой стим')).toBeNull();
  });

  it('но занятое другими командами остаётся за ними', () => {
    expect(parseDirectCommand('открой лог')?.kind).toBe('log');
    expect(parseDirectCommand('джарвис открой лог')?.kind).toBe('log');
  });
});

describe('вкладка с названием — это переход в программу', () => {
  // Живой случай 20.09.2026: «Переключи вкладку на Edge» ушло агенту, и он
  // 75 секунд писал на C# код подъёма окна. Одно мгновенное действие вместо
  // минуты — вся разница между управлением голосом и голосовым пультом.
  it('с названием — переключение окна', () => {
    expect(parseDirectCommand('переключи вкладку на Edge')).toEqual({
      kind: 'focus',
      title: 'edge',
    });
    expect(parseDirectCommand('джарвис переключи вкладку на хром')).toEqual({
      kind: 'focus',
      title: 'хром',
    });
  });

  // Граница: без названия это по-прежнему Ctrl+Tab внутри текущего окна.
  it('без названия — по-прежнему Ctrl+Tab', () => {
    expect(parseDirectCommand('переключи вкладку')).toEqual({ kind: 'key', keys: 'ctrl+tab' });
    expect(parseDirectCommand('следующая вкладка')).toEqual({ kind: 'key', keys: 'ctrl+tab' });
  });
});

describe('включение диктовки важнее диктуемого текста', () => {
  // Сквозная проверка поймала: «печатай за мной» печатало слова «за мной»
  // вместо включения режима, потому что разбор текста стоял первым.
  it.each(['печатай за мной', 'пиши за мной', 'записывай за мной', 'джарвис печатай за мной'])(
    '«%s» включает режим',
    (said) => {
      expect(parseDirectCommand(said)).toEqual({ kind: 'dictation', on: true });
    },
  );

  // Граница: с настоящим текстом «печатай» по-прежнему печатает.
  it('но «печатай привет» печатает', () => {
    expect(parseDirectCommand('печатай привет как дела')).toEqual({
      kind: 'type',
      text: 'привет как дела',
    });
  });
});
