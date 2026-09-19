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
    id: 'interpreter',
    name: 'interpreter',
    capabilities: new Set(),
    checkAvailability: async () => ({
      id: 'interpreter' as const,
      installed: true,
      authenticated: true,
      ready: true,
      checkedAt: 0,
    }),
    run: (): BackendRun => {
      const channel = new EventChannel<BackendEvent>();
      const cancelled: BackendResult = {
        ok: false,
        backend: 'interpreter',
        text: '',
        durationMs: 1,
        filesChanged: [],
        commands: [],
        cancelled: true,
        error: 'Отменено',
      };
      return {
        id: 'run',
        backend: 'interpreter',
        events: channel,
        cancel: () => {
          channel.push({ type: 'completed', backend: 'interpreter', result: cancelled });
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
