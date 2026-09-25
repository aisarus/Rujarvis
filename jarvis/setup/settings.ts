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
import { WHISPER_MODEL_IDS, type WhisperModelId } from '../voice/sttModels';
import { DEFAULT_VOICE, VOICES } from '../voice/tts';

import type { Language } from '../locale/language';

export type { Language };

/**
 * Что из речи писать в лог.
 *
 * `commands` — только обращённое к Джарвису (по умолчанию); `all` — и фон, и
 * диктовку, для разбора, почему он не расслышал; `off` — ничего из сказанного.
 */
export type SpeechLogging = 'off' | 'commands' | 'all';

export interface AppSettings {
  language: Language;
  voiceId: string;
  whisperModel: WhisperModelId;
  /** Рабочая папка задач по умолчанию. Пусто — папка результатов. */
  workspace: string;
  /** Папка результатов. Пусто — «Джарвис»/«Jarvis» на рабочем столе. */
  outputDir: string;
  speechLogging: SpeechLogging;
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
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'ru',
  voiceId: DEFAULT_VOICE.ru,
  whisperModel: 'base',
  workspace: '',
  outputDir: '',
  speechLogging: 'commands',
  claudeModel: '',
  localModelUrl: '',
  localModelName: '',
  onboarded: false,
  wakeAck: true,
  speechSpeed: 1,
  speechVolume: 1,
  bigMode: false,
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
  };
}

export class SettingsStore {
  private current: AppSettings;
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
      return normaliseSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
}
