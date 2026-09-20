import { describe, expect, it } from 'vitest';

import { matchVoiceControl } from './interrupts';
import { isPleasantry, isSilenceRequest, looksLikeChatter, meaningfulSpeech } from './noise';

describe('meaningfulSpeech', () => {
  it('drops what Whisper writes when nobody spoke', () => {
    // All observed on a live microphone in an ordinary room.
    for (const noise of ['[музыка]', '(звук пилот)', '[BLANK_AUDIO]', '[звук от бензона', '(шум)']) {
      expect(meaningfulSpeech(noise)).toBeNull();
    }
  });

  it('drops empty and near-empty transcripts', () => {
    for (const noise of ['', '   ', '.', '…', 'а']) {
      expect(meaningfulSpeech(noise)).toBeNull();
    }
  });

  it('keeps a real command untouched', () => {
    expect(meaningfulSpeech('открой хром')).toBe('открой хром');
    expect(meaningfulSpeech('Джарвис, закрой это окно')).toBe('Джарвис закрой это окно');
  });

  it('keeps the words when someone speaks over noise', () => {
    // The tag is what Whisper heard besides the person, not instead of them.
    expect(meaningfulSpeech('(музыка) открой хром')).toBe('открой хром');
    expect(meaningfulSpeech('[музыка] Джарвис открой телеграм')).toBe('Джарвис открой телеграм');
  });

  it('keeps hyphens and apostrophes, which occur inside words', () => {
    expect(meaningfulSpeech('какой-то файл')).toBe('какой-то файл');
  });
});

describe('looksLikeChatter', () => {
  it('узнаёт разговор не с ассистентом — прямо из журнала', () => {
    // Эти две фразы Джарвис действительно выполнил как команды: они попали в
    // микрофон из комнаты, пока он был разбужен.
    expect(looksLikeChatter('Потому что мы все знаем что Чек у нас есть в сайте Проблема')).toBe(true);
    expect(looksLikeChatter('Это грая-класс но они просто не спрашивают')).toBe(true);
  });

  it('узнаёт пересказ уже случившегося', () => {
    expect(looksLikeChatter('Так блендер открыл')).toBe(true);
  });

  it('не трогает команду, даже начатую со связки', () => {
    // «Так, открой блендер» — это команда, и слово-связка ничего не меняет.
    expect(looksLikeChatter('Так открой блендер')).toBe(false);
    expect(looksLikeChatter('Ну сделай уже шар в блендере')).toBe(false);
  });

  it('не трогает обычную команду', () => {
    expect(looksLikeChatter('открой блендер')).toBe(false);
    expect(looksLikeChatter('сделай в блендере красный шар')).toBe(false);
    expect(looksLikeChatter('закрой стим')).toBe(false);
  });

  it('не трогает вопрос к ассистенту', () => {
    expect(looksLikeChatter('что сейчас на экране')).toBe(false);
    expect(looksLikeChatter('где лежит тот файл')).toBe(false);
  });

  it('считает болтовнёй рассказ, начатый как рассказ', () => {
    const long = 'вчера мы с ним договорились что поедем туда в субботу если погода будет нормальная и всё получится';
    expect(looksLikeChatter(long)).toBe(true);
  });

  it('не считает болтовнёй длинную, но осмысленную просьбу', () => {
    const long = 'открой блендер и сделай там красный шар с подразделением а потом отрендери его в картинку';
    expect(looksLikeChatter(long)).toBe(false);
  });

  it('не отсекает длинную фразу только за длину', () => {
    // Раньше всё длиннее двенадцати слов без глагола из списка молча
    // выбрасывалось. Человек сказал прямо: «длинные реплики тоже плохо
    // регает». Длина — не признак того, что говорят мимо: люди так говорят.
    const long =
      'мне нужно чтобы на этой картинке было три дерева слева озеро справа и тёплый вечерний свет';
    expect(looksLikeChatter(long)).toBe(false);
  });
});

describe('isPleasantry', () => {
  it('узнаёт короткую вежливость', () => {
    for (const phrase of ['спасибо', 'ага', 'ну ладно', 'окей', 'Спасибо!']) {
      expect(isPleasantry(phrase)).toBe(true);
    }
  });

  it('не принимает за вежливость ход разговора', () => {
    // Эти фразы — продолжение начатой работы, и терять их нельзя.
    for (const phrase of ['а теперь синюю', 'нет, другую', 'сделай её зелёной']) {
      expect(isPleasantry(phrase)).toBe(false);
    }
  });

  it('не принимает за вежливость просьбу, начатую с вежливости', () => {
    expect(isPleasantry('спасибо, а теперь открой блендер')).toBe(false);
  });

  it('переживает пустую строку', () => {
    expect(isPleasantry('')).toBe(false);
  });
});

describe('isSilenceRequest', () => {
  it('узнаёт просьбу замолчать', () => {
    // Эта команда была сломана с самого добавления: «\b» в JavaScript считает
    // словом только латиницу, и после кириллицы границы нет.
    expect(isSilenceRequest('тишина')).toBe(true);
    expect(isSilenceRequest('замолчи')).toBe(true);
    expect(isSilenceRequest('Тишина!')).toBe(true);
    expect(isSilenceRequest('хватит слушать')).toBe(true);
  });

  it('не срабатывает на слове, которое лишь начинается так же', () => {
    expect(isSilenceRequest('тишиной наслаждаюсь')).toBe(false);
    expect(isSilenceRequest('спикер')).toBe(false);
  });

  it('не трогает обычную речь', () => {
    expect(isSilenceRequest('открой блендер')).toBe(false);
    expect(isSilenceRequest('')).toBe(false);
  });
});

describe('вежливость — не команда', () => {
  it.each(['спасибо', 'Спасибо!', 'пока', 'привет', 'ага', 'окей', 'ладно', 'понятно', 'ясно'])(
    '«%s» не становится задачей',
    (phrase) => {
      // Ровно это и случилось: человек ждал две минуты, сказал «спасибо» и
      // «пока», и каждая фраза запустила новую задачу.
      expect(looksLikeChatter(phrase)).toBe(true);
    },
  );

  it('не глушит вежливость с просьбой внутри', () => {
    expect(looksLikeChatter('спасибо, а теперь открой блендер')).toBe(false);
    expect(looksLikeChatter('ладно, сохрани файл')).toBe(false);
  });

  it('не глушит короткую команду', () => {
    expect(looksLikeChatter('стоп')).toBe(false);
    expect(looksLikeChatter('продолжай')).toBe(false);
  });
});

describe('слова остановки не перехватываются ничем', () => {
  it('«отмена» доходит до отмены задачи, а не жмёт Escape', () => {
    // Прямой слой разбирал «отмену» как клавишу Escape, и задача продолжала
    // идти. Человек назвал остановку отдельным требованием.
    expect(matchVoiceControl('отмена')).not.toBe(null);
  });

  it.each(['стоп', 'стой', 'хватит', 'отмена', 'отмени'])(
    '«%s» — это остановка',
    (phrase) => {
      expect(matchVoiceControl(phrase)).not.toBe(null);
    },
  );

  it('обычная работа остановкой не считается', () => {
    expect(matchVoiceControl('открой блендер')).toBe(null);
    expect(matchVoiceControl('отмени действие')).toBe(null);
  });
});

describe('выдумки распознавателя', () => {
  it.each([
    'Субтитры делал DimaTorzok',
    'Смотрите продолжение в следующей серии',
    'Продолжение следует...',
    'Спасибо за просмотр!',
    'Редактор субтитров А.Кулакова',
    'Подписывайтесь на канал',
  ])('«%s» — это не речь человека', (phrase) => {
    // Всё снято с живого журнала. Whisper обучен на субтитрах и в тишине
    // «слышит» их концовки. Сверка была по началу фразы, и две из этих выдумок
    // прошли насквозь — а сборщик приклеил их к настоящей просьбе. Агент
    // получил «Субтитры делал DimaTorzok. Создай в открытом от книги» и честно
    // над этим работал.
    expect(meaningfulSpeech(phrase)).toBeNull();
  });

  it('не глотает настоящую речь', () => {
    for (const phrase of [
      'открой блендер и сделай ракету',
      'что там дальше по плану',
      'продолжай работу',
    ]) {
      expect(meaningfulSpeech(phrase)).not.toBeNull();
    }
  });
});

describe('подписи Whisper под неречевой звук', () => {
  // У человека очень чувствительный микрофон и музыка за окном. Whisper не
  // выдумывает — он честно подписывает то, что слышит, заглавными буквами.
  // В журнале 20.09.2026 «ДИНАМИЧНАЯ МУЗЫКА» дважды стала задачей.
  it('музыка за окном не становится задачей', () => {
    expect(meaningfulSpeech('ДИНАМИЧНАЯ МУЗЫКА')).toBeNull();
    expect(meaningfulSpeech('МУЗЫКА')).toBeNull();
    expect(meaningfulSpeech('ЗВУЧИТ ТРЕВОЖНАЯ МУЗЫКА')).toBeNull();
    expect(meaningfulSpeech('АПЛОДИСМЕНТЫ')).toBeNull();
    expect(meaningfulSpeech('СМЕХ ЗА КАДРОМ')).toBeNull();
  });

  // Граница, которую нельзя перейти: человек может крикнуть, и крик обязан
  // сработать. Команда остановки заглавными — самый важный случай из всех.
  it('крик человека остаётся командой', () => {
    expect(meaningfulSpeech('СТОП')).toBe('СТОП');
    expect(meaningfulSpeech('ОСТАНОВИСЬ НЕМЕДЛЕННО')).toBe('ОСТАНОВИСЬ НЕМЕДЛЕННО');
    expect(meaningfulSpeech('ДЖАРВИС ОТКРОЙ ХРОМ')).toBe('ДЖАРВИС ОТКРОЙ ХРОМ');
  });

  it('сказанное обычно про музыку — по-прежнему просьба', () => {
    expect(meaningfulSpeech('включи музыку')).toBe('включи музыку');
    expect(meaningfulSpeech('найди мне музыку для ролика')).toBe('найди мне музыку для ролика');
  });
});
