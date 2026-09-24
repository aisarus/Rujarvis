import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WakeWordListener,
  editDistance,
  findWakeWord,
} from './wakeWord';
import {
  applyVoiceControl,
  matchVoiceControl,
  type ControlTarget,
} from './interrupts';
import {
  spokenFailure,
  splitSentences,
  stripUnspeakable,
  toSpokenResponse,
} from './spokenResponse';
import { acknowledgementFor, clarificationFor } from './acknowledgement';
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODELS,
  getWhisperDownloadUrl,
  recommendWhisperModel,
  whisperModelFiles,
} from './sttModels';
import { resampleTo16k, resolveWhisperPaths } from './whisperRecognizer';
import { resolveArchiveEntry } from './whisperInstall';
import { route } from '../router/router';

describe('wake word', () => {
  it('hears the wake word spoken correctly', () => {
    expect(findWakeWord('Джарвис')).toMatchObject({ index: 0, command: '' });
  });

  it('takes the command spoken in the same breath', () => {
    expect(findWakeWord('Джарвис, закрой это окно')?.command).toBe('закрой это окно');
    expect(findWakeWord('Эй, джарвис открой хром')?.command).toBe('открой хром');
  });

  it('tolerates the spellings Russian recognition actually produces', () => {
    // Every Whisper size tested against synthesised Russian heard "Жарвис".
    for (const variant of ['Жарвис', 'джарвес', 'Джарвиз', 'Джервис', 'jarvis']) {
      expect(findWakeWord(`${variant} открой хром`)?.command).toBe('открой хром');
    }
  });

  it('handles the name split across two tokens', () => {
    expect(findWakeWord('джар вис закрой окно')?.length).toBe(2);
    expect(findWakeWord('джар вис закрой окно')?.command).toBe('закрой окно');
  });

  it('hears the manglings a live microphone actually produced', () => {
    // Every one of these was recorded from real speech into the room mic and
    // was missed: the person said the name and nothing happened.
    for (const heard of ['Жаравес', 'Ужарвес', 'жарвес', 'Джарвес', 'Бжаргес']) {
      expect(findWakeWord(heard), heard).not.toBeNull();
    }
  });

  it('still refuses words that merely rhyme', () => {
    // The consonant skeleton is deliberately tight: widening it until
    // «Жаравес» matched must not drag ordinary speech in with it.
    for (const other of [
      'сервис', 'дерево', 'привет', 'джинсы', 'нравится',
      // These do contain the «ж» the matcher leans on, and must still fail on
      // the shape of the word.
      'скажи', 'можешь', 'жизнь', 'пожалуйста', 'уже', 'джинсы',
    ]) {
      expect(findWakeWord(other), other).toBeNull();
    }
  });

  it('does not wake on short or unrelated words', () => {
    for (const phrase of ['да', 'сервис', 'привет', 'джаз', 'нарвись на неприятности']) {
      expect(findWakeWord(phrase)).toBeNull();
    }
  });

  it('measures edit distance with an early exit past the limit', () => {
    expect(editDistance('джарвис', 'жарвис')).toBe(1);
    expect(editDistance('джарвис', 'джарвес')).toBe(1);
    expect(editDistance('джарвис', 'совершенно другое', 3)).toBeGreaterThan(3);
  });
});

describe('WakeWordListener', () => {
  it('runs a command spoken together with the wake word', () => {
    const listener = new WakeWordListener();
    expect(listener.accept('Джарвис, открой Chrome')).toEqual({
      type: 'wake',
      command: 'открой Chrome',
    });
  });

  it('waits for the command when the wake word came alone', () => {
    let clock = 0;
    const listener = new WakeWordListener({ awakeWindowMs: 5_000, now: () => clock });

    expect(listener.accept('Джарвис')).toEqual({ type: 'wake' });
    expect(listener.currentState).toBe('awake');

    clock += 1_000;
    expect(listener.accept('закрой это окно')).toEqual({
      type: 'command',
      command: 'закрой это окно',
    });
  });

  it('keeps the conversation open, so the name is said once and not per sentence', () => {
    let clock = 0;
    const listener = new WakeWordListener({ awakeWindowMs: 5_000, now: () => clock });
    listener.accept('Джарвис');

    // Each thing said refreshes the window: a person mid-task should not have
    // to name the assistant again between two sentences.
    for (const command of ['открой хром', 'теперь закрой окно', 'открой телеграм']) {
      clock += 4_000;
      expect(listener.accept(command)).toEqual({ type: 'command', command });
      expect(listener.currentState).toBe('awake');
    }

    // Silence, not speech, is what ends the conversation.
    clock += 6_000;
    expect(listener.accept('закрой это окно')).toEqual({ type: 'ignored' });
    expect(listener.currentState).toBe('idle');
  });

  it('closes the window on its own so an overheard name does not arm the mic', () => {
    let clock = 0;
    const listener = new WakeWordListener({ awakeWindowMs: 5_000, now: () => clock });
    listener.accept('Джарвис');

    clock += 6_000;
    expect(listener.accept('закрой это окно')).toEqual({ type: 'ignored' });
    expect(listener.currentState).toBe('idle');
  });

  it('ignores ambient speech when it was never woken', () => {
    const listener = new WakeWordListener();
    expect(listener.accept('да я вчера ходил в магазин')).toEqual({ type: 'ignored' });
  });

  it('can be armed directly, which is what push-to-talk does', () => {
    const listener = new WakeWordListener();
    listener.wake();
    expect(listener.accept('открой телеграм')).toEqual({
      type: 'command',
      command: 'открой телеграм',
    });
  });
});

describe('voice controls', () => {
  it('recognises the interrupt words', () => {
    expect(matchVoiceControl('стоп')?.control).toBe('stop');
    expect(matchVoiceControl('Хватит!')?.control).toBe('stop');
    expect(matchVoiceControl('отмена')?.control).toBe('cancel');
    expect(matchVoiceControl('не делай это')?.control).toBe('cancel');
    expect(matchVoiceControl('пауза')?.control).toBe('pause');
    expect(matchVoiceControl('продолжай')?.control).toBe('resume');
  });

  it('looks past filler around a control word', () => {
    expect(matchVoiceControl('ну всё, хватит')?.control).toBe('stop');
    expect(matchVoiceControl('Джарвис, стоп')?.control).toBe('stop');
  });

  it('does not fire on a sentence that merely contains a control word', () => {
    expect(matchVoiceControl('останови сервис после тестов')).toBeNull();
    expect(matchVoiceControl('добавь стоп слово в конфиг')).toBeNull();
    expect(matchVoiceControl('продолжай работу над проектом aegis завтра')).toBeNull();
  });

  it('ignores an empty transcript', () => {
    expect(matchVoiceControl('')).toBeNull();
    expect(matchVoiceControl('   ')).toBeNull();
  });

  it('stops speech before stopping work, and says so', () => {
    const calls: string[] = [];
    const target: ControlTarget = {
      cancelForeground: () => {
        calls.push('cancel');
        return true;
      },
      pauseForeground: () => false,
      resumeLast: () => false,
      stopSpeaking: () => calls.push('stopSpeaking'),
    };

    const outcome = applyVoiceControl({ control: 'stop', phrase: 'стоп' }, target);
    expect(calls).toEqual(['stopSpeaking', 'cancel']);
    expect(outcome).toEqual({ action: 'stopped', spoken: 'Остановил.' });
  });

  it('says plainly when there was nothing to stop', () => {
    const target: ControlTarget = {
      cancelForeground: () => false,
      pauseForeground: () => false,
      resumeLast: () => false,
      stopSpeaking: () => {},
    };
    expect(applyVoiceControl({ control: 'stop', phrase: 'стоп' }, target).action).toBe('nothing');
    expect(applyVoiceControl({ control: 'resume', phrase: 'продолжай' }, target).action).toBe('nothing');
  });
});

describe('spoken response', () => {
  it('strips what makes no sense read aloud', () => {
    const stripped = stripUnspeakable(
      'Нашёл проблему.\n\n```ts\nconst x = 1;\n```\n\n- Смотри [конфиг](https://example.com/a)',
    );
    expect(stripped).not.toContain('const x');
    expect(stripped).not.toContain('https://');
    expect(stripped).toContain('Смотри конфиг');
  });

  it('обычный ответ читает целиком, а не первые три фразы', () => {
    // Предел был три предложения, и это резало ответы на вопросы. Замер из
    // журнала: на «какие три вопроса в конце брейншторма» человек услышал
    // первый пункт, оборванный посреди фразы, и решил, что его не поняли.
    const full = [
      'Нашёл проблему.',
      'Она в конфигурации запуска: vite.config.ts указывал на несуществующий алиас.',
      'Исправление уже внесено и билд проходит.',
      'Дополнительно я проверил зависимости и обновил lock-файл.',
      'Ещё я прогнал тесты, все зелёные.',
    ].join(' ');

    const split = toSpokenResponse(full);
    expect(split.full).toBe(full);
    expect(split.spoken).toContain('Нашёл проблему.');
    expect(split.spoken).toContain('прогнал тесты');
    expect(split.spoken).not.toContain('на экране');
  });

  it('длинный ответ режет по границам предложений и говорит, что есть ещё', () => {
    // Молчаливый обрыв читается как поломка. Если сказано не всё, об этом надо
    // сказать.
    const long = Array.from(
      { length: 40 },
      (_, index) => `Пункт номер ${index}, и в нём достаточно слов, чтобы занять место.`,
    ).join(' ');

    const split = toSpokenResponse(long);

    expect(split.spoken.length).toBeLessThan(1_100);
    expect(split.spoken).toContain('Дальше — на экране.');
    // Ни одно предложение не оборвано на полуслове.
    expect(split.spoken).not.toContain('…');
  });

  it('одно очень длинное предложение всё же сокращает', () => {
    // Иначе сказать было бы вовсе нечего.
    const single = `Это одно предложение без единой точки ${'и очень длинное '.repeat(80)}конец`;
    const split = toSpokenResponse(single);

    expect(split.spoken.length).toBeGreaterThan(50);
    expect(split.spoken.length).toBeLessThan(1_100);
  });

  it('keeps the spoken part under the character budget', () => {
    const full = `${'Очень длинное предложение без конца и края, которое продолжается и продолжается. '.repeat(10)}`;
    expect(toSpokenResponse(full, { maxChars: 120 }).spoken.length).toBeLessThanOrEqual(130);
  });

  it('falls back when the answer is entirely unspeakable', () => {
    const split = toSpokenResponse('```\nnpm ERR! code ELIFECYCLE\n```');
    expect(split.spoken).toBe('Готово. Подробности на экране.');
  });

  it('skips lines that are really data', () => {
    const split = toSpokenResponse('D:\\Projects\\aegis\\vite.config.ts\nБилд снова проходит.');
    expect(split.spoken).toBe('Билд снова проходит.');
  });

  it('phrases a failure without reading a stack trace aloud', () => {
    expect(spokenFailure('Не удалось запустить Claude Code: spawn ENOENT')).toContain('Не получилось');
    expect(spokenFailure(undefined)).toBe('Не получилось. Подробности на экране.');
  });
});

describe('acknowledgements', () => {
  const first = (options: readonly string[]): string => options[0] as string;

  it('answers immediately with something fitting the intent', () => {
    expect(acknowledgementFor(route('Открой Chrome'), { pick: first })).toBe('Открываю браузер.');
    expect(acknowledgementFor(route('Посмотри что на экране'), { pick: first })).toBe('Смотрю на экран.');
    expect(acknowledgementFor(route('Закрой это окно'), { pick: first })).toBe('Сейчас.');
  });

  it('names the backend the user asked for', () => {
    expect(acknowledgementFor(route('сделай это через Клод Код'))).toBe('Передаю Клод Коду.');
    expect(acknowledgementFor(route('отдай это Кодексу'))).toBe('Передаю Кодексу.');
  });

  it('mentions the project for coding work', () => {
    const decision = route('посмотри почему билд падает', {
      context: { knownProjects: [{ name: 'aegis', path: 'D:\\aegis' }] },
    });
    decision.project = 'aegis';
    expect(acknowledgementFor(decision, { pick: first })).toContain('проект aegis');
  });

  it('never claims the work is finished', () => {
    for (const utterance of ['Открой Chrome', 'почини билд', 'что на экране']) {
      const line = acknowledgementFor(route(utterance), { pick: first });
      expect(line.toLowerCase()).not.toContain('готово');
      expect(line.toLowerCase()).not.toContain('сделал');
    }
  });

  it('asks instead of guessing when the rules recognised almost nothing', () => {
    expect(clarificationFor(route('ну это'))).toBe('Не понял, что именно сделать. Уточни?');
    expect(clarificationFor(route('Открой Chrome'))).toBeNull();
    // «Продолжай» is low-confidence by nature but perfectly clear in context.
    expect(clarificationFor(route('Продолжай'))).toBeNull();
  });
});

describe('whisper model catalog', () => {
  it('points at the real sherpa-onnx release assets', () => {
    expect(getWhisperDownloadUrl('base')).toBe(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-base.tar.bz2',
    );
    for (const model of WHISPER_MODELS) {
      expect(model.assetName).toBe(`${model.rootDirName}.tar.bz2`);
      expect(model.downloadBytes).toBeGreaterThan(1_000_000);
    }
  });

  it('names the files as they appear inside the archive', () => {
    expect(whisperModelFiles('base')).toEqual({
      encoder: 'base-encoder.int8.onnx',
      decoder: 'base-decoder.int8.onnx',
      tokens: 'base-tokens.txt',
    });
    expect(whisperModelFiles('small', false).encoder).toBe('small-encoder.onnx');
  });

  it('defaults to base — small is three times slower on CPU for no reliable gain', () => {
    expect(DEFAULT_WHISPER_MODEL).toBe('base');
  });

  it('recommends a model that fits the machine', () => {
    expect(recommendWhisperModel({ totalRamMb: 4_000 })).toBe('tiny');
    expect(recommendWhisperModel({ totalRamMb: 8_000 })).toBe('base');
    expect(recommendWhisperModel({ totalRamMb: 32_000 })).toBe('small');
    expect(recommendWhisperModel({ totalRamMb: 32_000, hasGpu: true })).toBe('turbo');
  });

  it('resolves install paths under the install root', () => {
    const paths = resolveWhisperPaths('/models', 'base');
    expect(paths.encoder).toContain('sherpa-onnx-whisper-base');
    expect(paths.tokens.endsWith('base-tokens.txt')).toBe(true);
  });
});

describe('audio handling', () => {
  it('leaves 16 kHz audio alone', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1]);
    expect(resampleTo16k(samples, 16_000)).toBe(samples);
  });

  it('downsamples 22.05 kHz Piper output to what Whisper expects', () => {
    const samples = new Float32Array(22_050);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin((index / 22_050) * Math.PI * 2);
    }
    const resampled = resampleTo16k(samples, 22_050);
    expect(resampled.length).toBe(16_000);
    expect(Number.isFinite(resampled[8_000] as number)).toBe(true);
  });
});

describe('archive extraction safety', () => {
  // Пути сравниваются через `path.join`, а не строками в стиле Unix.
  //
  // Раньше здесь стояло «/models/...», и на Windows оно превращалось в
  // «C:\models\...» — тесты падали всегда. Сама защита при этом работала,
  // но постоянно красный набор приучает не смотреть на падения, и настоящая
  // поломка в нём потерялась бы незамеченной.
  const root = path.join(path.sep, 'models');

  it('keeps entries inside the destination directory', () => {
    expect(resolveArchiveEntry(root, 'sherpa-onnx-whisper-base/base-encoder.onnx')).toBe(
      path.resolve(root, 'sherpa-onnx-whisper-base', 'base-encoder.onnx'),
    );
  });

  it('refuses an entry that climbs out of it', () => {
    expect(() => resolveArchiveEntry(root, '../../etc/passwd')).toThrow(/escapes/);
  });

  it('обезвреживает ведущий слеш, а не отвергает его', () => {
    // Запись «/etc/passwd» внутри архива — обычное дело; она должна лечь
    // внутрь назначенной папки, а не в корень диска.
    expect(resolveArchiveEntry(root, '/etc/passwd')).toBe(path.resolve(root, 'etc', 'passwd'));
  });

  it('не выпускает наружу через обратные слеши', () => {
    // На Windows разделителем работает и «\», и попытка выхода выглядит иначе.
    const climb = ['..', '..', 'windows', 'system32'].join(path.sep);
    expect(() => resolveArchiveEntry(root, climb)).toThrow(/escapes/);
  });
});

describe('тишина обязана срабатывать', () => {
  // Справочник команд обещал человеку слово «тишина», а разбор его не знал:
  // Джарвис учил слову, которого не понимал, и продолжал говорить.
  it.each([
    'тишина', 'тишину', 'тихо', 'помолчи', 'замолкни',
    'джарвис тишина', 'ну тишина', 'хватит говорить',
  ])('«%s» заглушает', (said) => {
    expect(matchVoiceControl(said)?.control).toBe('mute');
  });

  // Граница: «тише звук» — это громкость, а не приказ замолчать, и оно
  // разбирается прямой командой раньше. Здесь проверяем, что заглушение не
  // перехватывает целые просьбы.
  it('не перехватывает обычную речь', () => {
    expect(matchVoiceControl('расскажи потише про тишину в горах')).toBeNull();
  });
});

describe('resampleTo16k filters what it cannot represent', () => {
  const tone = (hz: number, rate: number, seconds = 0.5) =>
    Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));
  const rms = (samples: Float32Array) => {
    // Края отрезаем: там у фильтра неполное окно.
    const middle = samples.subarray(200, samples.length - 200);
    return Math.sqrt(middle.reduce((sum, value) => sum + value * value, 0) / middle.length);
  };

  it('keeps speech-band tones', () => {
    expect(rms(resampleTo16k(tone(1_000, 44_100), 44_100))).toBeGreaterThan(0.6);
  });

  it('removes tones above 8 kHz instead of folding them into the speech band', () => {
    // Линейная интерполяция оставляла тут почти всю громкость — на 6 кГц.
    expect(rms(resampleTo16k(tone(10_000, 44_100), 44_100))).toBeLessThan(0.1);
  });
});
