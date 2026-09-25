import { describe, expect, it, vi } from 'vitest';
import { BackendManager } from '../backends/manager';
import { EventChannel } from '../backends/process';
import type {
  AgentBackend,
  BackendEvent,
  BackendResult,
  BackendRun,
} from '../backends/types';
import { WorldStateStore } from '../context/worldState';
import { DEFAULT_JARVIS_SETTINGS, JarvisCore } from '../core';
import { JarvisMemory } from '../memory/store';
import { TaskManager } from '../tasks/manager';
import {
  VoiceSession,
  type AudioCapture,
  type SpeechPlayback,
  type VoiceStatus,
} from './session';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function hangingBackend(): AgentBackend {
  return {
    id: 'codex',
    name: 'codex',
    capabilities: new Set(),
    checkAvailability: async () => ({
      id: 'codex' as const,
      installed: true,
      authenticated: true,
      ready: true,
      checkedAt: 0,
    }),
    run: (): BackendRun => {
      const channel = new EventChannel<BackendEvent>();
      const cancelled: BackendResult = {
        ok: false,
        backend: 'codex',
        text: '',
        durationMs: 1,
        filesChanged: [],
        commands: [],
        cancelled: true,
        error: 'Отменено',
      };
      return {
        id: 'run',
        backend: 'codex',
        events: channel,
        cancel: () => {
          channel.push({ type: 'completed', backend: 'codex', result: cancelled });
          channel.close();
        },
        result: () => Promise.resolve(cancelled),
      };
    },
  } as unknown as AgentBackend;
}

interface Harness {
  session: VoiceSession;
  statuses: VoiceStatus[];
  capture: AudioCapture & { started: number; stopped: number };
  transcript: { value: string };
  playback: SpeechPlayback & { spoken: string[]; stops: number };
  transcripts: string[];
  errors: string[];
}

function harness(options: { mode?: 'push-to-talk' | 'always-listening' | 'off' } = {}): Harness {
  const backends = new BackendManager();
  backends.register(hangingBackend());
  const core = new JarvisCore({
    backends,
    tasks: new TaskManager({ backends }),
    memory: new JarvisMemory(),
    world: new WorldStateStore(),
    settings: () => DEFAULT_JARVIS_SETTINGS,
  });

  const transcript = { value: 'открой хром' };
  let capturing = false;
  const capture = {
    started: 0,
    stopped: 0,
    start() {
      capture.started += 1;
      capturing = true;
    },
    async stop() {
      capture.stopped += 1;
      capturing = false;
      return { samples: new Float32Array(16_000), sampleRate: 16_000 };
    },
    isCapturing: () => capturing,
  };

  let speaking = false;
  const playback = {
    spoken: [] as string[],
    stops: 0,
    async speak(text: string) {
      speaking = true;
      playback.spoken.push(text);
      speaking = false;
    },
    stop() {
      playback.stops += 1;
      speaking = false;
    },
    isSpeaking: () => speaking,
  };

  const statuses: VoiceStatus[] = [];
  const transcripts: string[] = [];
  const errors: string[] = [];

  const session = new VoiceSession({
    core,
    capture,
    transcriber: { transcribe: async () => ({ text: transcript.value }) },
    playback,
    mode: options.mode,
    onStatus: (status) => statuses.push({ ...status }),
    onTranscript: (text) => transcripts.push(text),
    onError: (message) => errors.push(message),
  });

  return { session, statuses, capture, transcript, playback, transcripts, errors };
}

describe('push-to-talk', () => {
  it('walks listening → transcribing → thinking → working', async () => {
    const h = harness();

    await h.session.pressPushToTalk();
    expect(h.session.status.indicator).toBe('listening');
    expect(h.session.status.label).toBe('Слушаю…');

    const turn = await h.session.releasePushToTalk();
    await tick();

    expect(h.statuses.map((status) => status.indicator)).toEqual([
      'listening',
      'transcribing',
      'thinking',
      'working',
    ]);
    expect(turn?.kind).toBe('task');
    expect(h.session.status.label).toContain('Работаю:');
  });

  it('stops speech the moment the key goes down', async () => {
    const h = harness();
    await h.session.pressPushToTalk();
    expect(h.playback.stops).toBe(1);
  });

  it('ignores a release that never had a press', async () => {
    const h = harness();
    expect(await h.session.releasePushToTalk()).toBeNull();
    expect(h.capture.stopped).toBe(0);
  });

  it('ignores a second press while already holding', async () => {
    const h = harness();
    await h.session.pressPushToTalk();
    await h.session.pressPushToTalk();
    expect(h.capture.started).toBe(1);
  });

  it('goes back to idle on an empty transcript rather than dispatching nothing', async () => {
    const h = harness();
    h.transcript.value = '   ';
    await h.session.pressPushToTalk();

    expect(await h.session.releasePushToTalk()).toBeNull();
    expect(h.session.status.indicator).toBe('idle');
    expect(h.transcripts).toHaveLength(0);
  });

  it('surfaces the transcript to the UI before dispatching it', async () => {
    const h = harness();
    await h.session.pressPushToTalk();
    await h.session.releasePushToTalk();
    expect(h.transcripts).toEqual(['открой хром']);
  });

  it('reports a capture failure and returns to idle', async () => {
    const h = harness();
    h.capture.start = () => {
      throw new Error('микрофон занят');
    };

    await h.session.pressPushToTalk();
    expect(h.session.status.indicator).toBe('idle');
    expect(h.errors).toEqual(['микрофон занят']);

    // The failed press must not leave the session stuck holding the key.
    h.capture.start = () => {
      h.capture.started += 1;
    };
    await h.session.pressPushToTalk();
    expect(h.session.status.indicator).toBe('listening');
  });

  it('does nothing at all when voice is turned off', async () => {
    const h = harness({ mode: 'off' });
    await h.session.pressPushToTalk();
    expect(h.capture.started).toBe(0);
  });
});

describe('always listening', () => {
  it('ignores speech until the wake word', async () => {
    const h = harness({ mode: 'always-listening' });
    expect(await h.session.acceptAmbientTranscript('да я вчера ходил в магазин')).toBeNull();
    expect(h.transcripts).toHaveLength(0);
  });

  it('runs a command spoken with the wake word in one breath', async () => {
    const h = harness({ mode: 'always-listening' });
    const turn = await h.session.acceptAmbientTranscript('Джарвис, открой хром');
    expect(turn?.kind).toBe('task');
    expect(h.transcripts).toEqual(['открой хром']);
  });

  /**
   * На имя отзываются голосом, а не только плашкой.
   *
   * Тот, ради кого это делается, может не видеть плашку вовсе. Без отклика он
   * оставался в тишине и не знал, услышали его или нет, — а ответа на саму
   * задачу ждать до десяти секунд (замерено: 8,9 / 10,4 / 11,4 / 11,8 с).
   * Две секунды тишины человек терпит, двенадцать — считает поломкой.
   */
  it('отзывается голосом, когда позвали по имени', async () => {
    const h = harness({ mode: 'always-listening' });
    await h.session.acceptAmbientTranscript('Джарвис');

    // Отклик отложен на тик нарочно: иначе он гасит «слушаю».
    expect(h.session.status.indicator).toBe('listening');
    expect(h.playback.spoken).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.playback.spoken).toEqual(['Да?']);
    // И после отклика состояние возвращается: человек ещё говорит.
    expect(h.session.status.indicator).toBe('listening');
  });

  it('на имя с командой в одном вдохе отклика нет: сразу дело', async () => {
    const h = harness({ mode: 'always-listening' });
    await h.session.acceptAmbientTranscript('Джарвис, открой хром');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.playback.spoken).not.toContain('Да?');
  });

  it('waits for the command when the wake word came alone', async () => {
    const h = harness({ mode: 'always-listening' });

    expect(await h.session.acceptAmbientTranscript('Джарвис')).toBeNull();
    expect(h.session.status.awake).toBe(true);
    expect(h.session.status.indicator).toBe('listening');

    const turn = await h.session.acceptAmbientTranscript('открой хром');
    expect(turn?.kind).toBe('task');
  });

  it('honours «стоп» without the wake word, because that is the point of it', async () => {
    const h = harness({ mode: 'always-listening' });
    const turn = await h.session.acceptAmbientTranscript('стоп');
    expect(turn?.kind).toBe('control');
  });

  it('stops listening ambiently once the mode changes', async () => {
    const h = harness({ mode: 'always-listening' });
    await h.session.acceptAmbientTranscript('Джарвис');
    h.session.setMode('push-to-talk');

    expect(h.session.status.awake).toBe(false);
    expect(await h.session.acceptAmbientTranscript('открой хром')).toBeNull();
  });
});

describe('indicators around speech and tasks', () => {
  it('shows speaking while it talks, then returns to the running task', async () => {
    const h = harness();
    await h.session.pressPushToTalk();
    await h.session.releasePushToTalk();
    await tick();
    expect(h.session.status.indicator).toBe('working');

    await h.session.speak('Открываю.');
    expect(h.playback.spoken).toEqual(['Открываю.']);
    expect(h.session.status.indicator).toBe('working');
  });

  it('returns to idle after speaking when nothing is running', async () => {
    const h = harness();
    await h.session.speak('Готово.');
    expect(h.session.status.indicator).toBe('idle');
  });

  it('clears the working indicator when the task finishes', async () => {
    const h = harness();
    await h.session.pressPushToTalk();
    await h.session.releasePushToTalk();
    await tick();

    h.session.taskFinished();
    expect(h.session.status.indicator).toBe('idle');
    expect(h.session.status.activeTaskTitle).toBeUndefined();
  });

  it('the interrupt button stops playback', async () => {
    const h = harness();
    h.session.stopSpeaking();
    expect(h.playback.stops).toBe(1);
  });

  it('a control word leaves the session idle, not thinking', async () => {
    const h = harness();
    const turn = await h.session.submitText('стоп');
    expect(turn?.kind).toBe('control');
    expect(h.session.status.indicator).toBe('idle');
  });
});

describe('typed input', () => {
  it('goes through the same pipeline as speech', async () => {
    const h = harness();
    const turn = await h.session.submitText('открой хром');
    expect(turn?.kind).toBe('task');
  });

  it('ignores an empty submission', async () => {
    const h = harness();
    expect(await h.session.submitText('   ')).toBeNull();
  });
});

describe('robustness', () => {
  it('reports a transcription failure instead of hanging on "Распознаю…"', async () => {
    const backends = new BackendManager();
    backends.register(hangingBackend());
    const errors: string[] = [];
    const session = new VoiceSession({
      core: new JarvisCore({
        backends,
        tasks: new TaskManager({ backends }),
        memory: new JarvisMemory(),
        world: new WorldStateStore(),
        settings: () => DEFAULT_JARVIS_SETTINGS,
      }),
      capture: {
        start: () => {},
        stop: async () => ({ samples: new Float32Array(16_000), sampleRate: 16_000 }),
        isCapturing: () => false,
      },
      transcriber: {
        transcribe: vi.fn(async () => {
          throw new Error('модель не загружена');
        }),
      },
      onError: (message) => errors.push(message),
    });

    await session.pressPushToTalk();
    expect(await session.releasePushToTalk()).toBeNull();
    expect(session.status.indicator).toBe('idle');
    expect(errors).toEqual(['модель не загружена']);
  });

  it('works with no playback configured at all', async () => {
    const backends = new BackendManager();
    backends.register(hangingBackend());
    const session = new VoiceSession({
      core: new JarvisCore({
        backends,
        tasks: new TaskManager({ backends }),
        memory: new JarvisMemory(),
        world: new WorldStateStore(),
        settings: () => DEFAULT_JARVIS_SETTINGS,
      }),
      capture: {
        start: () => {},
        stop: async () => ({ samples: new Float32Array(16_000), sampleRate: 16_000 }),
        isCapturing: () => false,
      },
      transcriber: { transcribe: async () => ({ text: 'открой хром' }) },
    });

    await expect(session.speak('Готово.')).resolves.toBeUndefined();
    session.stopSpeaking();
    await session.pressPushToTalk();
    expect((await session.releasePushToTalk())?.kind).toBe('task');
  });
});

describe('окно слушания и речь', () => {
  it('открывается заново, когда помощник договорил', async () => {
    // Замер из журнала: Джарвис говорил двенадцать секунд при восьмисекундном
    // окне, и следующая реплика человека пришла при awake=false — была
    // выброшена молча. Человек решил, что потерян контекст; потерян был его
    // вопрос. Пока помощник говорит, человек и не может ответить.
    const h = harness({ mode: 'always-listening' });
    h.session.sleep();
    expect(h.session.status.awake).toBe(false);

    await h.session.speak('Длинный ответ про три вопроса в конце брейншторма.');

    expect(h.session.status.awake).toBe(true);
  });

  it('не открывается, если за время речи попросили тишины', async () => {
    // «Тишина» обрывает фразу. Обещание тут же снова начать слушать отменило
    // бы ровно то, о чём попросили.
    const h = harness({ mode: 'always-listening' });
    const speaking = h.session.speak('Очень длинный ответ, который перебивают.');
    h.session.sleep();
    await speaking;

    expect(h.session.status.awake).toBe(false);
  });

  it('молчание окна не открывает', async () => {
    const h = harness({ mode: 'always-listening' });
    h.session.sleep();

    await h.session.speak('   ');

    expect(h.session.status.awake).toBe(false);
  });
});

describe('клавиша отпущена не вовремя', () => {
  // Замечания CodeRabbit по куску 4 (PR №43). Оба случая — про микрофон,
  // который остаётся включённым, хотя человек ничего не держит.

  it('отпускание во время подъёма захвата ждёт подъёма и не врёт про «Слушаю»', async () => {
    const h = harness();

    // Пустышка вместо `null`: подстановка идёт внутри замыкания, и вывод
    // типов считает переменную навсегда пустой — `поднять?.()` тогда не
    // вызвать вовсе.
    let поднять: () => void = () => undefined;
    let подняли = false;
    h.capture.start = () =>
      new Promise<void>((resolve) => {
        поднять = () => {
          подняли = true;
          resolve();
        };
      });

    let остановленПослеПодъёма: boolean | null = null;
    h.capture.stop = async () => {
      остановленПослеПодъёма = подняли;
      h.capture.stopped += 1;
      return { samples: new Float32Array(0), sampleRate: 16_000 };
    };

    const нажатие = h.session.pressPushToTalk();
    const отпускание = h.session.releasePushToTalk();
    поднять();
    const [, итог] = await Promise.all([нажатие, отпускание]);

    // Останавливать то, что ещё не поднялось, бессмысленно: захват оставался
    // работать, а индикатор застревал на «Слушаю…» навсегда.
    expect(остановленПослеПодъёма).toBe(true);
    expect(h.session.status.indicator).not.toBe('listening');
    expect(итог).toBeNull();
  });

  it('выключение голоса при зажатой клавише не отправляет запись в ядро', async () => {
    const h = harness();

    await h.session.pressPushToTalk();
    expect(h.session.status.indicator).toBe('listening');

    h.session.setMode('off');
    const итог = await h.session.releasePushToTalk();

    expect(итог).toBeNull();
    // Ровно одна остановка — та, что сделало выключение. Вторая означала бы,
    // что отпускание прошло дальше и отправило запись при выключенном голосе.
    expect(h.capture.stopped).toBe(1);
    expect(h.transcripts).toEqual([]);
  });
});

describe('речь не должна терять состояние задачи', () => {
  /**
   * Замечание CodeRabbit (кусок 4, PR №43). Показ во время речи становится
   * «Говорю», и состояние задачи по нему уже не восстановить.
   */
  it('после речи «Работаю» возвращается С ИМЕНЕМ задачи', async () => {
    const h = harness();
    await h.session.pressPushToTalk();
    await h.session.releasePushToTalk();
    expect(h.session.status.indicator).toBe('working');
    const имя = h.session.status.activeTaskTitle;
    expect(имя).toBeTruthy();

    await h.session.speak('Работаю над этим.');

    expect(h.session.status.indicator).toBe('working');
    expect(h.session.status.activeTaskTitle).toBe(имя);
    expect(h.session.status.label).toMatch(/^Работаю: .+/u);
  });

  it('задача, кончившаяся во время речи, не оставляет «Работаю» навсегда', async () => {
    const h = harness();
    await h.session.pressPushToTalk();
    await h.session.releasePushToTalk();
    expect(h.session.status.indicator).toBe('working');

    // Задача заканчивается, пока Джарвис говорит: показ в этот момент
    // «Говорю», и старый код молчал, а потом возвращал «Работаю».
    const речь = h.session.speak('Готово.');
    h.session.taskFinished();
    await речь;

    expect(h.session.status.indicator).toBe('idle');
  });
});
