/**
 * Настройки приложения: один JSON в `data/settings.json`.
 *
 * Их меняет окно настроек и онбординг; голосовой мост читает их при запуске,
 * а язык и голос — на каждую фразу, чтобы смена действовала сразу.
 * Неизвестные и сломанные поля не роняют приложение: вместо них берутся
 * значения по умолчанию.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isPrivateEndpoint, normaliseEndpoint } from '../backends/localModel';
import { DEFAULT_WHISPER_MODEL, WHISPER_MODEL_IDS, type WhisperModelId } from '../voice/sttModels';
import { DEFAULT_VOICE, VOICES } from '../voice/tts';

import type { Language } from '../locale/language';
import { NOTES_STYLES, type NotesStyle } from '../notes/style';

export type { Language, NotesStyle };

/**
 * Вид окон: тетрадь в клетку, белый лист с маркерами, кольцо Джарвиса.
 *
 * Выбирает человек, а не мы: владелец посмотрел три варианта и попросил все
 * три — переключаемыми (20.10.2026).
 */
export type Look = 'tetrad' | 'marker' | 'ring';
export const LOOKS: readonly Look[] = ['tetrad', 'marker', 'ring'];

/** Тема: как в системе, светлая или тёмная. */
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEMES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

/**
 * Что из речи писать в лог.
 *
 * `commands` — только обращённое к Джарвису (по умолчанию); `all` — и фон, и
 * диктовку, для разбора, почему он не расслышал; `off` — ничего из сказанного.
 */
export type SpeechLogging = 'off' | 'commands' | 'all';

/**
 * Сколько хранить звук лекций: неделю (потом удаляется сам — конспект и
 * расшифровка остаются) или пока человек не удалит сам. Пара — около 280 МБ,
 * семестр — 15–19 ГБ (`jarvis/lecture/recordings.ts`).
 */
export type RecordingsKeep = 'week' | 'forever';

/**
 * Что поставлено: Джарвис целиком или только конспекты.
 *
 * «Только конспекты» — для студента, которому нужен конспектор, а не
 * голосовой помощник (первые тестеры на маке, 26.10.2026): кнопки конспекта
 * на плашке, «Учёба», разбор документов. Ни слуха команд, ни голоса, ни
 * агента с руками на компьютере; микрофон берётся только на время лекции.
 * Одна программа, а не отдельная ветка: исправления и обновления приходят
 * обоим вариантам сразу.
 */
export type Edition = 'full' | 'notes';

export interface AppSettings {
  language: Language;
  voiceId: string;
  whisperModel: WhisperModelId;
  /** Рабочая папка задач по умолчанию. Пусто — папка результатов. */
  workspace: string;
  /** Папка результатов. Пусто — «Джарвис»/«Jarvis» на рабочем столе. */
  outputDir: string;
  speechLogging: SpeechLogging;
  /**
   * Распознавать речь в облаке ElevenLabs вместо Whisper на этом компьютере.
   *
   * Выключено по умолчанию и включается только здесь, руками. До 28.09.2026
   * облако включалось само, стоило в системе оказаться ключу
   * ELEVENLABS_API_KEY: у владельца так полтора дня каждый отрезок звука из
   * микрофона — и обращённый к Джарвису, и нет — уходил в ElevenLabs, а
   * настройки и журнал показывали «whisper-small».
   */
  cloudSpeech: boolean;
  /** Модель Claude Code: пусто — выбор самого CLI. */
  claudeModel: string;
  /**
   * Свой сервер модели (Ollama, LM Studio, llama.cpp) вместо подписки: адрес
   * и имя модели. Пусто — подписка. Принимается только адрес на этом
   * компьютере или в домашней сети (`backends/localModel.ts`).
   */
  localModelUrl: string;
  localModelName: string;
  /** Пройден ли первый запуск. */
  onboarded: boolean;

  /**
   * Отзываться ли голосом, когда позвали по имени без команды.
   *
   * Тому, кто не видит плашку, отклик необходим: иначе он не знает, услышали
   * его или нет, а ответа на саму задачу ждать до десяти секунд. Тому, кто
   * зовёт Джарвиса полсотни раз за день, лишнее «да?» мешает. Поэтому
   * настройка, а не выбор за всех.
   */
  wakeAck: boolean;
  /** Скорость речи: 0,5 — вдвое медленнее, 2 — вдвое быстрее. */
  speechSpeed: number;
  /** Громкость речи, от 0 до 1. */
  speechVolume: number;
  /**
   * Крупный режим: плашка вдвое больше, шрифт крупнее, контраст выше.
   *
   * Плашка 320×84 со шрифтом 15 пикселей — единственный способ увидеть
   * состояние, и для слабого зрения он не работает.
   */
  bigMode: boolean;
  /**
   * Язык лекций для конспекта — код, который понимает Whisper («ru», «en»,
   * «he»…). Пусто — язык интерфейса. Конспект пишется на языке интерфейса;
   * если лекция на другом, термины идут в скобках так, как их сказал лектор.
   */
  lectureLanguage: string;
  /** Вид окон и плашки. */
  look: Look;
  /** Светлая, тёмная или как в системе — для всех окон сразу. */
  theme: ThemeChoice;
  /** Как оформлять конспект лекции в Obsidian (`jarvis/notes/style.ts`). */
  notesStyle: NotesStyle;
  /** Сколько хранить звук лекций. */
  recordingsKeep: RecordingsKeep;
  /** Джарвис целиком или только конспекты. */
  edition: Edition;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'ru',
  voiceId: DEFAULT_VOICE.ru,
  // Одно умолчание на всех: своя строка здесь уже разошлась бы с распознаванием.
  whisperModel: DEFAULT_WHISPER_MODEL,
  workspace: '',
  outputDir: '',
  speechLogging: 'commands',
  cloudSpeech: false,
  claudeModel: '',
  localModelUrl: '',
  localModelName: '',
  onboarded: false,
  wakeAck: true,
  speechSpeed: 1,
  speechVolume: 1,
  bigMode: false,
  lectureLanguage: '',
  look: 'ring',
  theme: 'system',
  notesStyle: 'razbor',
  // Владелец 21.10.2026: «пусть удаляет сам через неделю».
  recordingsKeep: 'week',
  edition: 'full',
};

/** Пределы, за которые голосовая настройка не уводит. */
export const SPEECH_SPEED_RANGE = { min: 0.5, max: 2, step: 0.15 } as const;
export const SPEECH_VOLUME_RANGE = { min: 0.2, max: 1, step: 0.15 } as const;

/** Привести что угодно к корректным настройкам. */
/**
 * Число в границах — или значение по умолчанию.
 *
 * Голосом эти числа и меняются («громче», «медленнее»), поэтому за границы
 * они уходить не должны: нулевая громкость — это молчащий помощник, который
 * выглядит сломанным, а скорость 0,1 превращает речь в нечитаемое.
 */
function вЧисло(raw: unknown, fallback: number, range: { min: number; max: number }): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

export function normaliseSettings(raw: unknown): AppSettings {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = (key: string, fallback: string): string =>
    typeof input[key] === 'string' ? (input[key] as string).trim() : fallback;

  const language: Language = input.language === 'en' ? 'en' : 'ru';
  const voice = VOICES.find((entry) => entry.id === input.voiceId && entry.language === language);
  const whisper = WHISPER_MODEL_IDS.includes(input.whisperModel as WhisperModelId)
    ? (input.whisperModel as WhisperModelId)
    : DEFAULT_SETTINGS.whisperModel;
  const logging: SpeechLogging = ['off', 'commands', 'all'].includes(input.speechLogging as string)
    ? (input.speechLogging as SpeechLogging)
    : DEFAULT_SETTINGS.speechLogging;

  return {
    language,
    // Голос другого языка читал бы английский текст русской фонетикой.
    voiceId: voice?.id ?? DEFAULT_VOICE[language],
    whisperModel: whisper,
    workspace: text('workspace', ''),
    outputDir: text('outputDir', ''),
    speechLogging: logging,
    // Только явное «да»: что угодно другое — звук остаётся на этом компьютере.
    cloudSpeech: input.cloudSpeech === true,
    claudeModel: text('claudeModel', ''),
    // Публичный адрес сюда не пройдёт даже руками в settings.json: это был бы
    // чужой шлюз, а Джарвис не ходит в платные API.
    localModelUrl: isPrivateEndpoint(normaliseEndpoint(text('localModelUrl', '')))
      ? normaliseEndpoint(text('localModelUrl', ''))
      : '',
    localModelName: text('localModelName', ''),
    onboarded: input.onboarded === true,
    // Отклик на имя по умолчанию включён: без него тот, кто не видит плашку,
    // остаётся в тишине и не знает, услышали его.
    wakeAck: input.wakeAck !== false,
    speechSpeed: вЧисло(input.speechSpeed, DEFAULT_SETTINGS.speechSpeed, SPEECH_SPEED_RANGE),
    speechVolume: вЧисло(input.speechVolume, DEFAULT_SETTINGS.speechVolume, SPEECH_VOLUME_RANGE),
    bigMode: input.bigMode === true,
    // Только код языка: всё прочее ушло бы в запрос к серверу распознавания.
    lectureLanguage: /^[a-z]{2,3}$/u.test(text('lectureLanguage', '').toLowerCase()) ? text('lectureLanguage', '').toLowerCase() : '',
    look: LOOKS.includes(input.look as Look) ? (input.look as Look) : DEFAULT_SETTINGS.look,
    theme: THEMES.includes(input.theme as ThemeChoice) ? (input.theme as ThemeChoice) : DEFAULT_SETTINGS.theme,
    notesStyle: NOTES_STYLES.includes(input.notesStyle as NotesStyle) ? (input.notesStyle as NotesStyle) : DEFAULT_SETTINGS.notesStyle,
    recordingsKeep: input.recordingsKeep === 'forever' ? 'forever' : 'week',
    edition: input.edition === 'notes' ? 'notes' : 'full',
  };
}

export class SettingsStore {
  private current: AppSettings;
  /** Почему настройки не прочитались. Пустая строка — прочитались. */
  private неПрочитался = '';
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(private readonly file: string) {
    this.current = this.read();
  }

  get(): AppSettings {
    return this.current;
  }

  /** Сохранить изменения. Запись атомарная: оборванная не портит файл. */
  update(patch: Partial<AppSettings>): AppSettings {
    const next = normaliseSettings({ ...this.current, ...patch });
    mkdirSync(path.dirname(this.file), { recursive: true });

    // Нечитаемый файл сначала откладываем в сторону, а не затираем.
    //
    // Человек сможет достать из копии то, что пропало, а по имени файла
    // поймёт, что случилось.
    if (this.неПрочитался) {
      const копия = `${this.file}.broken-${Date.now()}`;
      try {
        renameSync(this.file, копия);
        console.error(`[jarvis] нечитаемые настройки отложены в ${копия}`);
      } catch {
        // Не вышло отложить — значит файла уже нет или он занят. Писать
        // поверх всё равно придётся: без настроек Джарвис не работает.
      }
      this.неПрочитался = '';
    }
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temp, this.file);
    this.current = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  subscribe(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private read(): AppSettings {
    if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS };
    try {
      this.неПрочитался = '';
      return normaliseSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (error) {
      // «Файла нет» и «файл не прочитался» — разные вещи.
      //
      // Раньше обе давали значения по умолчанию, и ПЕРВАЯ ЖЕ правка
      // записывала их поверх настоящих: пропадали рабочая папка, адрес
      // локальной модели, выбранная модель Клода, а `onboarded` становился
      // ложью — человеку заново показывали онбординг. Ни одного слова при
      // этом он не видел. Файл мог всего лишь оказаться занят антивирусом.
      this.неПрочитался = error instanceof Error ? error.message : String(error);
      console.error(`[jarvis] настройки не прочитались (${this.file}): ${this.неПрочитался}`);
      return { ...DEFAULT_SETTINGS };
    }
  }
}
