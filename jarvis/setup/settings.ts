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

import { WHISPER_MODEL_IDS, type WhisperModelId } from '../voice/sttModels';
import { DEFAULT_VOICE, VOICES } from '../voice/tts';

export type Language = 'ru' | 'en';

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
  /** Пройден ли первый запуск. */
  onboarded: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'ru',
  voiceId: DEFAULT_VOICE.ru,
  whisperModel: 'base',
  workspace: '',
  outputDir: '',
  speechLogging: 'commands',
  claudeModel: '',
  onboarded: false,
};

/** Привести что угодно к корректным настройкам. */
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
    onboarded: input.onboarded === true,
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
