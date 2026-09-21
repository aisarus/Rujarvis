/**
 * Красные линии голоса и сторож согласованности справочника.
 *
 * ## Зачем отдельный файл
 *
 * 20.09.2026 человек поймал за день пять поломок, и две были здесь:
 *
 *   - слова «тишина» не было ни в одном списке команд, хотя справочник
 *     обещал его прямым текстом. Джарвис учил слову, которого не понимал;
 *   - заглушение, даже когда срабатывало, ничего не останавливало.
 *
 * Ни одну не поймали полторы тысячи модульных тестов, и это не случайность:
 * каждый слой проверялся отдельно и каждый был прав по-своему. Справочник
 * честно спрашивал `isSilenceRequest` — и получал «да». Разбор команд честно
 * не знал слова «тишина» — и его об этом никто не спрашивал.
 *
 * Поэтому здесь проверяется не слой, а обещание целиком: сказанное человеком
 * проходит фильтр шума, эхо-страж, разбор и доходит до действия. И отдельно —
 * что справочник не обещает ничего, чего система не понимает.
 *
 * ## Что такое красная линия
 *
 * Человек сформулировал сам: «идеально должны работать команды стоп и
 * тишина». Это то, что обязано срабатывать всегда и мгновенно, даже когда не
 * работает больше ничего. Остальное можно чинить завтра; это — нет.
 */

import { describe, expect, it } from 'vitest';

import { spokenCloseTarget, spokenTarget } from '../apps/launch';
import { commandCatalogue } from '../control/catalogue';
import { DOTA_OVERLAY_PHRASES, parseDirectCommand } from '../control/commands';
import { parseDictationEdit } from '../control/dictationEdits';
import { EchoGuard } from './echo';
import {
  applyVoiceControl,
  matchVoiceControl,
  type ControlTarget,
  type VoiceControl,
} from './interrupts';
import { isSilenceRequest, looksLikeChatter, meaningfulSpeech } from './noise';
import { findWakeWord } from './wakeWord';

/**
 * Подставное «что умеет Джарвис».
 *
 * Записывает, что позвали. Проверять возвращённое значение мало: заглушение
 * возвращало «замолчал» и при этом не трогало речь — ядро звало `speak('')`,
 * а та на пустой строке сразу выходила. Ответ был правильный, дела не было.
 */
function spyTarget(): { target: ControlTarget; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    target: {
      cancelForeground: () => {
        calls.push('cancelForeground');
        return true;
      },
      pauseForeground: () => {
        calls.push('pauseForeground');
        return true;
      },
      resumeLast: () => {
        calls.push('resumeLast');
        return true;
      },
      stopSpeaking: () => {
        calls.push('stopSpeaking');
      },
    },
  };
}

interface RedLine {
  /** Что человек сказал вслух. */
  said: string;
  control: VoiceControl;
  /** Что обязано быть позвано на живом Джарвисе. */
  must: string[];
}

const RED_LINES: RedLine[] = [
  { said: 'стоп', control: 'stop', must: ['stopSpeaking', 'cancelForeground'] },
  { said: 'стой', control: 'stop', must: ['stopSpeaking', 'cancelForeground'] },
  { said: 'хватит', control: 'stop', must: ['stopSpeaking', 'cancelForeground'] },
  { said: 'останови всё', control: 'stop', must: ['stopSpeaking', 'cancelForeground'] },
  { said: 'тишина', control: 'mute', must: ['stopSpeaking'] },
  { said: 'тихо', control: 'mute', must: ['stopSpeaking'] },
  { said: 'помолчи', control: 'mute', must: ['stopSpeaking'] },
  { said: 'замолкни', control: 'mute', must: ['stopSpeaking'] },
  { said: 'пауза', control: 'pause', must: ['stopSpeaking', 'pauseForeground'] },
  { said: 'продолжай', control: 'resume', must: ['resumeLast'] },
];

describe('красные линии: разбор', () => {
  it('каждое слово понято как то, чем оно и является', () => {
    for (const line of RED_LINES) {
      const match = matchVoiceControl(line.said);
      expect(match?.control, `«${line.said}» не понято`).toBe(line.control);
    }
  });

  it('и то же самое с обращением по имени', () => {
    // Человек говорит «Джарвис, стоп» — так естественнее, чем голое «стоп».
    // До 20.09.2026 имя в начале ломало вообще всё, что шло следом.
    for (const line of RED_LINES) {
      const match = matchVoiceControl(`джарвис ${line.said}`);
      expect(match?.control, `«джарвис ${line.said}» не понято`).toBe(line.control);
    }
  });

  it('не срабатывает на предложении, которое лишь содержит слово', () => {
    const работа = [
      'останови сервис после тестов',
      'найди стоп слово в тексте',
      'поставь паузу между кадрами в анимации',
      'продолжай искать пока не найдёшь нужный файл',
    ];
    for (const said of работа) {
      expect(matchVoiceControl(said), `«${said}» перехвачено как остановка`).toBeNull();
    }
  });
});

describe('красные линии: действие', () => {
  it('каждое слово правда зовёт то, что должно', () => {
    // Самая дорогая поломка дня была здесь: слово понималось, ответ звучал
    // уверенно, и ничего не происходило.
    for (const line of RED_LINES) {
      const match = matchVoiceControl(line.said);
      expect(match, `«${line.said}» не понято`).not.toBeNull();

      const { target, calls } = spyTarget();
      const outcome = applyVoiceControl(match!, target);

      expect(calls, `«${line.said}» не сделало ${line.must.join(' и ')}`).toEqual(line.must);
      expect(outcome.action, `«${line.said}» отчиталось бездействием`).not.toBe('nothing');
    }
  });

  it('заглушение останавливает речь, а не отвечает на просьбу молчать', () => {
    const { target, calls } = spyTarget();
    const outcome = applyVoiceControl(matchVoiceControl('тишина')!, target);

    expect(calls).toEqual(['stopSpeaking']);
    expect(outcome.action).toBe('muted');
    // Отвечать голосом на просьбу замолчать — издевательство.
    expect(outcome.spoken).toBe('');
  });

  it('остановка глушит речь раньше, чем отменяет работу', () => {
    // Молчание — это и есть ответ, которого человек ждёт, и оно бесплатно.
    const { target, calls } = spyTarget();
    applyVoiceControl(matchVoiceControl('стоп')!, target);
    expect(calls[0]).toBe('stopSpeaking');
  });
});

describe('красные линии: путь от микрофона', () => {
  it('крик человека остаётся командой', () => {
    // У человека чувствительный микрофон и музыка за окном, и Whisper
    // подписывает неречевой звук заглавными. Но заглавными человек ещё и
    // кричит — а съесть крик «СТОП» хуже любой лишней задачи.
    for (const line of RED_LINES) {
      const shouted = line.said.toUpperCase();
      const heard = meaningfulSpeech(shouted);
      expect(heard, `крик «${shouted}» съеден фильтром шума`).not.toBeNull();
      expect(matchVoiceControl(heard ?? ''), `крик «${shouted}» не понят`).not.toBeNull();
    }
  });

  it('фильтр болтовни не трогает красные линии', () => {
    for (const line of RED_LINES) {
      expect(looksLikeChatter(line.said), `«${line.said}» отсеяно как болтовня`).toBe(false);
    }
  });

  it('эхо-страж пропускает перебивание, даже когда Джарвис сказал то же слово', () => {
    // Слова остановки говорят поверх речи нарочно. Страж, который глушит их
    // за похожесть на собственную реплику, отнимает у человека единственный
    // способ прекратить происходящее.
    for (const line of RED_LINES) {
      const echo = new EchoGuard();
      echo.spoke(line.said);
      expect(echo.isOwnVoice(line.said), `«${line.said}» принято за собственный голос`).toBe(false);
    }
  });

  it('музыка за окном красной линией не становится', () => {
    for (const noise of ['ДИНАМИЧНАЯ МУЗЫКА', 'МУЗЫКА', 'АПЛОДИСМЕНТЫ', 'СМЕХ ЗА КАДРОМ']) {
      expect(meaningfulSpeech(noise), `«${noise}» прошло как речь`).toBeNull();
    }
  });
});

const catalogue = commandCatalogue();
const items = catalogue.flatMap((group) => group.items);

/** Тот слой, который в живой системе и обрабатывает эту фразу. */
function handledByLayer(say: string, layer: string): boolean {
  switch (layer) {
    case 'direct':
      return parseDirectCommand(say) !== null;
    case 'launch':
      return spokenTarget(say) !== null;
    case 'close':
      return spokenCloseTarget(say) !== null;
    case 'wake':
      return findWakeWord(say) !== null;
    case 'dictation':
      return parseDictationEdit(say) !== null;
    case 'control':
      return matchVoiceControl(say) !== null;
    case 'silence':
      return isSilenceRequest(say);
    default:
      return false;
  }
}

describe('сторож согласованности справочника', () => {
  it('каждая обещанная фраза разбирается своим слоем', () => {
    // Новая запись в справочнике без разбора обязана валить сборку. Именно
    // отсутствие этой проверки на всех слоях сразу стоило сегодня «тишины».
    for (const item of items) {
      expect(
        handledByLayer(item.say, item.layer),
        `«${item.say}» обещано, но слой «${item.layer}» её не разбирает`,
      ).toBe(true);
    }
  });

  it('каждая обещанная фраза переживает фильтр шума', () => {
    // Разбор может знать фразу сколько угодно хорошо — до него надо дойти.
    for (const item of items) {
      expect(meaningfulSpeech(item.say), `«${item.say}» съедено фильтром шума`).not.toBeNull();
    }

    // И то же самое криком: человек повышает голос, когда его не слышат.
    for (const item of items) {
      const shouted = item.say.toUpperCase();
      expect(meaningfulSpeech(shouted), `крик «${shouted}» съеден фильтром шума`).not.toBeNull();
    }
  });

  it('обещание тишины понимают оба слоя, а не один', () => {
    // Дырка была ровно тут: справочник спрашивал `isSilenceRequest`, получал
    // «да» и был зелёным. Разбор команд слова не знал, и его не спросили.
    for (const item of items.filter((i) => i.layer === 'silence')) {
      expect(isSilenceRequest(item.say), `«${item.say}» не закрывает разговор`).toBe(true);
      expect(matchVoiceControl(item.say)?.control, `«${item.say}» не заглушает речь`).toBe('mute');
      // И с обращением по имени: человек говорит «Джарвис, тишина».
      expect(
        isSilenceRequest(`джарвис ${item.say}`),
        `«джарвис ${item.say}» не закрывает разговор`,
      ).toBe(true);
    }
  });

  it('обещанное как прямая команда не перехватывается остановкой', () => {
    // Мост проверяет слова остановки раньше таблицы команд. Значит фраза,
    // обещанная справочником как нажатие клавиши, но известная остановке,
    // никогда до клавиши не доедет — и справочник врёт, сам того не зная.
    for (const item of items.filter((i) => i.layer === 'direct')) {
      const intercepted = matchVoiceControl(item.say);
      expect(
        intercepted,
        `«${item.say}» обещано как «${item.does}», но перехватывается как «${intercepted?.control}»`,
      ).toBeNull();

      // И просьбой замолчать тоже: она разбирается ещё раньше. «Тише звук»
      // уводило Джарвиса в сон вместо того, чтобы убавить громкость.
      expect(
        isSilenceRequest(item.say),
        `«${item.say}» обещано как «${item.does}», но перехватывается как тишина`,
      ).toBe(false);
    }
  });

  it('справочник обещает красные линии — их человек ищет первыми', () => {
    const promised = new Set(items.map((item) => item.say));
    for (const must of ['стоп', 'тишина']) {
      expect(promised.has(must), `«${must}» не обещано вообще нигде`).toBe(true);
    }
  });

  it('не обещает одну фразу дважды', () => {
    const said = items.map((item) => item.say);
    expect(new Set(said).size).toBe(said.length);
  });
});

/**
 * Сторож: оверлей не отнимает у человека заглушение.
 *
 * Слова остановки разбираются первым шагом `handleUtterance`, раньше таблицы
 * команд. Значит фраза оверлея, совпавшая с заглушением, до оверлея не доедет
 * никогда — а фраза заглушения, попавшая в таблицу оверлея, отнимет у человека
 * красную линию.
 *
 * Проверка идёт по экспортированному списку, а не по переписанному сюда: новая
 * фраза оверлея попадает под сторож сама, без чьей-либо памяти. Это и есть
 * приём, который у Aegis ловил ошибки дважды за сутки.
 *
 * Повод не выдуманный: «без голоса» я чуть не взял в оверлей, не заметив, что
 * оно уже двенадцать дней означает «замолчи».
 */
describe('оверлей и красные линии', () => {
  it('ни одна фраза оверлея не похожа на просьбу замолчать', () => {
    const украденные = DOTA_OVERLAY_PHRASES
      .map((фраза) => ({ фраза, control: matchVoiceControl(фраза) }))
      .filter((п) => п.control !== null);

    expect(украденные.map((п) => `${п.фраза} → ${п.control?.control}`)).toEqual([]);
  });

  it('каждая фраза оверлея доезжает до разбора команд', () => {
    const немые = DOTA_OVERLAY_PHRASES
      .filter((фраза) => parseDirectCommand(фраза)?.kind !== 'dotaOverlay');

    expect(немые).toEqual([]);
  });

  it('просьба замолчать по-прежнему глушит, а не включает оверлей', () => {
    for (const фраза of ['тишина', 'помолчи', 'без голоса', 'не говори', 'замолкни']) {
      expect(matchVoiceControl(фраза)?.control).toBe('mute');
    }
  });
});
