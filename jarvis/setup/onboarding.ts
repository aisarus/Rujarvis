/**
 * Onboarding.
 *
 * The goal is that a new user runs one command, answers nothing they do not
 * have to, and ends up with a working Russian voice assistant. So this module
 * inspects the machine and produces a plan; the script that runs the plan does
 * not make decisions of its own.
 *
 * Two rules shape it. Nothing is installed silently that costs hundreds of
 * megabytes without saying so first, and a missing subscription CLI is never
 * fatal — Jarvis still works, with fewer backends.
 */

import os from 'node:os';
import {
  DEFAULT_WHISPER_MODEL,
  getWhisperModel,
  recommendWhisperModel,
  type WhisperModelId,
} from '../voice/sttModels';

export interface MachineFacts {
  platform: NodeJS.Platform;
  totalRamMb: number;
  /** Whether a CUDA-capable GPU was detected. Optional everywhere. */
  hasGpu?: boolean;
}

export function readMachineFacts(): MachineFacts {
  return {
    platform: process.platform,
    totalRamMb: Math.round(os.totalmem() / (1024 * 1024)),
  };
}

export interface CliStatus {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
}

export interface OnboardingInput {
  machine: MachineFacts;
  claude: CliStatus;
  codex: CliStatus;
  /** Whisper models already present. */
  installedWhisperModels: WhisperModelId[];
  ttsVoiceInstalled: boolean;
  /** An explicit choice overrides the recommendation. */
  requestedWhisperModel?: WhisperModelId;
}

export interface OnboardingStep {
  id: string;
  /** Russian, imperative, what will happen. */
  title: string;
  /** Bytes this step will download, when it downloads anything. */
  downloadBytes?: number;
  required: boolean;
}

export interface OnboardingPlan {
  whisperModel: WhisperModelId;
  steps: OnboardingStep[];
  /** Lines to print after the plan runs, in Russian. */
  notes: string[];
  totalDownloadBytes: number;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}

/** Bytes for the default Russian Piper voice, as served. */
export const RUSSIAN_VOICE_BYTES = 67_153_308;

export function buildOnboardingPlan(input: OnboardingInput): OnboardingPlan {
  const whisperModel =
    input.requestedWhisperModel ??
    (input.machine.totalRamMb > 0
      ? recommendWhisperModel({ totalRamMb: input.machine.totalRamMb, hasGpu: input.machine.hasGpu })
      : DEFAULT_WHISPER_MODEL);

  const steps: OnboardingStep[] = [];
  const notes: string[] = [];

  if (!input.installedWhisperModels.includes(whisperModel)) {
    const model = getWhisperModel(whisperModel);
    steps.push({
      id: `whisper:${whisperModel}`,
      title: `Скачать модель распознавания речи ${model.label}`,
      downloadBytes: model.downloadBytes,
      required: true,
    });
  }

  if (!input.ttsVoiceInstalled) {
    steps.push({
      id: 'tts:ru',
      title: 'Скачать русский голос для озвучки (Piper Ирина)',
      downloadBytes: RUSSIAN_VOICE_BYTES,
      required: true,
    });
  }

  // Subscription backends are optional: Jarvis works without either of them,
  // just with fewer places to send coding work.
  if (!input.claude.installed) {
    steps.push({
      id: 'claude:install',
      title: 'Установить Claude Code CLI (необязательно, для задач по коду)',
      required: false,
    });
    notes.push(
      'Claude Code не найден. Установите его и выполните вход командой claude — Jarvis не хранит ключи и не читает токены.',
    );
  } else if (!input.claude.loggedIn) {
    steps.push({
      id: 'claude:login',
      title: 'Войти в Claude Code (команда claude)',
      required: false,
    });
    notes.push('Claude Code установлен, но вход не выполнен. Запустите claude и войдите в аккаунт.');
  }

  if (!input.codex.installed) {
    steps.push({
      id: 'codex:install',
      title: 'Установить Codex CLI (необязательно, альтернатива Claude Code)',
      required: false,
    });
    notes.push('Codex не найден. Установите его и войдите через «Sign in with ChatGPT».');
  } else if (!input.codex.loggedIn) {
    steps.push({
      id: 'codex:login',
      title: 'Войти в Codex через ChatGPT (команда codex login)',
      required: false,
    });
    notes.push('Codex установлен, но вход не выполнен. Запустите codex login.');
  }

  if (!input.claude.loggedIn && !input.codex.loggedIn) {
    notes.push(
      'Ни один подписочный backend не подключён. Jarvis будет работать через встроенный Interpreter runtime.',
    );
  }

  if (input.machine.platform !== 'win32') {
    notes.push(
      `Платформа ${input.machine.platform}: Jarvis собирается и запускается, но управление окнами отлажено под Windows 11.`,
    );
  }

  const totalDownloadBytes = steps.reduce((sum, step) => sum + (step.downloadBytes ?? 0), 0);
  return { whisperModel, steps, notes, totalDownloadBytes };
}

/** The plan as the text the installer prints. */
export function renderOnboardingPlan(plan: OnboardingPlan): string {
  const lines: string[] = ['Настройка Jarvis', ''];

  if (plan.steps.length === 0) {
    lines.push('Всё уже готово — модели на месте, backend-ы подключены.');
  } else {
    for (const step of plan.steps) {
      const size = step.downloadBytes ? ` — ${formatBytes(step.downloadBytes)}` : '';
      lines.push(`${step.required ? '•' : '○'} ${step.title}${size}`);
    }
    if (plan.totalDownloadBytes > 0) {
      lines.push('', `Всего будет скачано: ${formatBytes(plan.totalDownloadBytes)}`);
    }
  }

  if (plan.notes.length > 0) {
    lines.push('', ...plan.notes.map((note) => `  ${note}`));
  }
  return lines.join('\n');
}

/** What the user is told once setup finishes. */
export function renderGettingStarted(pushToTalkHotkey: string): string {
  return [
    '',
    'Готово. Как пользоваться:',
    `  • Зажмите ${pushToTalkHotkey} и говорите — отпустите, задача уйдёт в работу.`,
    '  • Или скажите «Джарвис» и после этого — что нужно сделать.',
    '  • «Стоп», «отмена», «пауза», «продолжай» срабатывают мгновенно.',
    '',
    'Говорите обычными словами: «закрой это окно», «посмотри что на экране»,',
    '«почини билд в аегисе через Клод Код», «а пока открой Телеграм».',
    '',
  ].join('\n');
}
