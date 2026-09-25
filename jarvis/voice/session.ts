/**
 * The voice session.
 *
 * Between the microphone and {@link JarvisCore} sits a small amount of state
 * that decides what the assistant is doing right now: idle, listening,
 * transcribing, thinking, working, speaking. The overlay reads exactly these
 * states, and the desktop layer only has to feed it three kinds of input —
 * the hotkey, audio, and a transcript.
 *
 * Keeping it here rather than in the Electron layer means the part that is
 * easy to get subtly wrong — a hotkey released before capture started, a wake
 * word arriving mid-task, «стоп» during playback — is testable without a
 * desktop.
 */

import type { JarvisCore, JarvisTurn } from '../core';
import { matchVoiceControl } from './interrupts';
import { WakeWordListener, type WakeWordListenerOptions } from './wakeWord';
import { byLanguage, tr } from '../locale/language';

export type VoiceIndicator =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  /**
   * Разговор, а не поручение.
   *
   * Человек попросил видеть разницу с одного взгляда: жёлтый — значит его
   * поняли как разговор и сейчас ответят словами; другой цвет — значит поняли
   * как команду и сейчас будут делать. Без этого он узнавал о неверном
   * понимании только по тому, что ничего не произошло.
   */
  | 'chatting'
  | 'working'
  | 'speaking';

export type VoiceMode = 'push-to-talk' | 'always-listening' | 'off';

/** What the overlay renders. */
export interface VoiceStatus {
  indicator: VoiceIndicator;
  /** Russian one-liner: «Слушаю…», «Работаю: починить билд Aegis». */
  label: string;
  /** True while Jarvis is awake after the wake word. */
  awake: boolean;
  /** Set while a task is running. */
  activeTaskTitle?: string;
}

const INDICATOR_LABELS_RU: Record<VoiceIndicator, string> = {
  idle: '',
  listening: 'Слушаю…',
  transcribing: 'Распознаю…',
  thinking: 'Думаю…',
  chatting: 'Разговариваю',
  working: 'Работаю',
  speaking: 'Отвечаю…',
};

const INDICATOR_LABELS_EN: Record<VoiceIndicator, string> = {
  idle: '',
  listening: 'Listening…',
  transcribing: 'Recognising…',
  thinking: 'Thinking…',
  chatting: 'Talking',
  working: 'Working',
  speaking: 'Answering…',
};

/** Captures microphone audio. Supplied by the desktop layer. */
export interface AudioCapture {
  start(): Promise<void> | void;
  /** Stops capture and returns what was recorded. */
  stop(): Promise<{ samples: Float32Array; sampleRate: number } | null>;
  /** True while capturing. */
  isCapturing(): boolean;
}

export interface Transcriber {
  transcribe(samples: Float32Array, sampleRate: number): Promise<{ text: string }>;
}

export interface SpeechPlayback {
  speak(text: string): Promise<void> | void;
  stop(): void;
  isSpeaking(): boolean;
}

export interface VoiceSessionOptions {
  core: JarvisCore;
  capture: AudioCapture;
  transcriber: Transcriber;
  playback?: SpeechPlayback;
  mode?: VoiceMode;
  wakeWord?: WakeWordListenerOptions;
  onStatus?(status: VoiceStatus): void;
  /** Surfaces a transcript to the UI as soon as it exists. */
  onTranscript?(text: string): void;
  onError?(message: string): void;
}

export class VoiceSession {
  private indicator: VoiceIndicator = 'idle';
  /**
   * Счётчик просьб замолчать.
   *
   * Речь, начатая до просьбы, не должна на своём завершении снова открыть окно
   * слушания. Сравнивается билет, а не время: остановка речи и её завершение
   * приходят в одну микрозадачу, и порогом по часам их не разделить.
   */
  private silenceTicket = 0;
  private activeTaskTitle: string | undefined;
  private mode: VoiceMode;
  private readonly wake: WakeWordListener;
  /** Set while a push-to-talk capture is in flight. */
  private pushToTalkHeld = false;

  constructor(private readonly options: VoiceSessionOptions) {
    this.mode = options.mode ?? 'push-to-talk';
    this.wake = new WakeWordListener(options.wakeWord);
  }

  get status(): VoiceStatus {
    const label =
      this.indicator === 'working' && this.activeTaskTitle
        ? `${tr('Работаю', 'Working')}: ${this.activeTaskTitle}`
        : byLanguage({ ru: INDICATOR_LABELS_RU, en: INDICATOR_LABELS_EN })[this.indicator];
    return {
      indicator: this.indicator,
      label,
      awake: this.wake.currentState === 'awake',
      activeTaskTitle: this.activeTaskTitle,
    };
  }

  setMode(mode: VoiceMode): void {
    this.mode = mode;
    if (mode !== 'always-listening') this.wake.reset();
    if (mode === 'off' && this.indicator === 'listening') {
      void this.options.capture.stop();
      this.setIndicator('idle');
    }
  }

  /**
   * Показать, чем занят, снаружи.
   *
   * Ядро решает, разговор это или поручение, а видит человека сессия. Отсюда
   * один узкий проход вместо доступа ко всему внутреннему состоянию.
   */
  showIndicator(indicator: VoiceIndicator): void {
    this.setIndicator(indicator);
  }

  private setIndicator(indicator: VoiceIndicator, taskTitle?: string): void {
    this.indicator = indicator;
    this.activeTaskTitle = indicator === 'working' ? taskTitle : undefined;
    this.options.onStatus?.(this.status);
  }

  /**
   * Hotkey pressed.
   *
   * Speaking stops the moment the key goes down: the user pressing it while
   * Jarvis talks means they want to say something, not to be talked over.
   */
  async pressPushToTalk(): Promise<void> {
    if (this.mode === 'off') return;
    if (this.pushToTalkHeld) return;

    this.options.playback?.stop();
    this.pushToTalkHeld = true;
    try {
      await this.options.capture.start();
      this.setIndicator('listening');
    } catch (error) {
      this.pushToTalkHeld = false;
      this.fail(error);
    }
  }

  /**
   * Hotkey released.
   *
   * A release that arrives before capture ever started is ignored rather than
   * treated as an empty utterance — a stray keypress should do nothing.
   */
  async releasePushToTalk(): Promise<JarvisTurn | null> {
    if (!this.pushToTalkHeld) return null;
    this.pushToTalkHeld = false;

    let audio: Awaited<ReturnType<AudioCapture['stop']>>;
    try {
      audio = await this.options.capture.stop();
    } catch (error) {
      this.fail(error);
      return null;
    }

    if (!audio || audio.samples.length === 0) {
      this.setIndicator('idle');
      return null;
    }

    this.setIndicator('transcribing');
    let transcript: string;
    try {
      transcript = (await this.options.transcriber.transcribe(audio.samples, audio.sampleRate)).text;
    } catch (error) {
      this.fail(error);
      return null;
    }

    if (!transcript.trim()) {
      this.setIndicator('idle');
      return null;
    }

    this.options.onTranscript?.(transcript);
    return this.dispatch(transcript);
  }

  /**
   * A transcript from always-listening mode.
   *
   * Control words are honoured whether or not Jarvis was woken: «стоп» has to
   * work without saying its name first.
   */
  async acceptAmbientTranscript(transcript: string): Promise<JarvisTurn | null> {
    if (this.mode !== 'always-listening') return null;

    if (matchVoiceControl(transcript)) {
      this.options.onTranscript?.(transcript);
      return this.dispatch(transcript);
    }

    const event = this.wake.accept(transcript);
    if (event.type === 'ignored') return null;
    if (event.type === 'wake' && !event.command) {
      this.setIndicator('listening');
      this.options.onStatus?.(this.status);
      return null;
    }

    const command = event.command;
    if (!command) return null;
    this.options.onTranscript?.(command);
    return this.dispatch(command);
  }

  /** Sends text straight through, e.g. from the composer. */
  async submitText(text: string): Promise<JarvisTurn | null> {
    if (!text.trim()) return null;
    return this.dispatch(text);
  }

  /**
   * Завести работу по просьбе разговора.
   *
   * Мимо пробуждения и слов остановки нарочно: разговор уже выслушал человека
   * и уже решил. Второй раз спрашивать «а обращались ли ко мне» не у кого.
   */
  async work(utterance: string): Promise<JarvisTurn | null> {
    return this.dispatch(utterance, { asWork: true });
  }

  private async dispatch(
    utterance: string,
    options: { asWork?: boolean } = {},
  ): Promise<JarvisTurn | null> {
    this.setIndicator('thinking');
    let turn: JarvisTurn;
    try {
      turn = await this.options.core.handleUtterance(utterance, options);
    } catch (error) {
      this.fail(error);
      return null;
    }

    switch (turn.kind) {
      case 'task':
        this.setIndicator('working', turn.task.title);
        break;
      case 'control':
      case 'clarify':
      case 'refused':
        this.setIndicator('idle');
        break;
    }
    return turn;
  }

  /** Called by the desktop layer when the active task finishes. */
  taskFinished(): void {
    if (this.indicator === 'working') this.setIndicator('idle');
  }

  /**
   * Keeps the conversation open after work the desktop layer did itself.
   *
   * Some things are answered without the core — launching a program is one —
   * and those turns never reach the wake listener. Without this the assistant
   * falls asleep in the middle of a conversation: observed as «открой Steam»
   * working, and the «закрой Steam» that followed being ignored in silence.
   */
  keepAwake(): void {
    this.wake.wake();
    this.options.onStatus?.(this.status);
  }

  /**
   * Closes the listening window at once, without waiting for it to expire.
   *
   * «Тишина» — the assistant stops listening for commands until it is named
   * again. Speech that is already playing stops too: being told to be quiet
   * and then finishing the sentence would be its own kind of rude.
   */
  sleep(): void {
    // Билет меняется первым: речь, оборванная этой просьбой, не должна на
    // своём завершении снова открыть окно слушания.
    this.silenceTicket += 1;
    this.options.playback?.stop();
    this.wake.reset();
    if (this.indicator !== 'working') this.setIndicator('idle');
    this.options.onStatus?.(this.status);
  }

  /** The interrupt button, and what «стоп» reaches when speech is playing. */
  stopSpeaking(): void {
    this.options.playback?.stop();
    if (this.indicator === 'speaking') this.setIndicator('idle');
  }

  /** Plays a line, keeping the indicator honest while it does. */
  async speak(text: string): Promise<void> {
    if (!this.options.playback || !text.trim()) return;
    const previous = this.indicator;
    const ticket = this.silenceTicket;
    this.setIndicator('speaking');
    try {
      await this.options.playback.speak(text);
    } finally {
      // Work that is still running should go back to showing that it is.
      this.setIndicator(previous === 'working' ? 'working' : 'idle', this.activeTaskTitle);

      // Окно слушания отсчитывается заново от конца фразы, а не от её начала.
      //
      // Замер из журнала: Джарвис говорил двенадцать секунд, окно у него
      // восьмисекундное, и следующая реплика человека — «Что внутри
      // брейншторма, в конце там три вопроса, да» — пришла при `awake=false` и
      // была выброшена молча. Человек решил, что потерян контекст; на деле
      // потерян был его вопрос.
      //
      // Пока помощник говорит, человек и не может ответить. Считать это время
      // его молчанием — значит закрывать окно ровно тогда, когда он наконец
      // получил возможность заговорить.
      //
      // Кроме одного случая: если за время речи его попросили замолчать.
      // «Тишина» обрывает фразу, и обещание тут же снова начать слушать
      // отменило бы ровно то, о чём попросили. Билет сравнивается, а не время:
      // остановка и завершение речи приходят в одну и ту же микрозадачу, и
      // никакой порог по часам их не разделит.
      if (this.silenceTicket === ticket) this.keepAwake();
    }
  }

  private fail(error: unknown): void {
    this.setIndicator('idle');
    this.options.onError?.(error instanceof Error ? error.message : String(error));
  }
}
