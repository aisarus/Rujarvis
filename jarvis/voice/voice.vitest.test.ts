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

  it('speaks one to three short sentences from a long answer', () => {
    const full = [
      'Нашёл проблему.',
      'Она в конфигурации запуска: vite.config.ts указывал на несуществующий алиас.',
      'Исправление уже внесено и билд проходит.',
      'Дополнительно я проверил зависимости и обновил lock-файл.',
      'Ещё я прогнал тесты, все зелёные.',
    ].join(' ');

    const split = toSpokenResponse(full);
    expect(split.full).toBe(full);
    expect(splitSentences(split.spoken)).toHaveLength(3);
    expect(split.spoken).toContain('Нашёл проблему.');
    expect(split.spoken).not.toContain('прогнал тесты');
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
  it('keeps entries inside the destination directory', () => {
    expect(resolveArchiveEntry('/models', 'sherpa-onnx-whisper-base/base-encoder.onnx')).toBe(
      '/models/sherpa-onnx-whisper-base/base-encoder.onnx',
    );
  });

  it('refuses an entry that climbs out of it', () => {
    expect(() => resolveArchiveEntry('/models', '../../etc/passwd')).toThrow(/escapes/);
    expect(() => resolveArchiveEntry('/models', '/etc/passwd')).not.toThrow();
    expect(resolveArchiveEntry('/models', '/etc/passwd')).toBe('/models/etc/passwd');
  });
});
