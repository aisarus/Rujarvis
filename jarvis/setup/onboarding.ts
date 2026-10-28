/**
 * Что знает установка о машине и как она называет размеры.
 *
 * Здесь же жил план установки прежней архитектуры (`buildOnboardingPlan`,
 * `renderOnboardingPlan`, `renderGettingStarted`) — с «встроенным Interpreter
 * runtime», которого давно нет, и «управление окнами отлажено под Windows 11».
 * Звал его только собственный тест: установку ведут `install.ps1`,
 * `install.sh` и `jarvis:setup`, а первый запуск — мастер в окне настроек.
 * Удалён 28.10.2026; история — в git.
 */

import os from 'node:os';

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

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} МБ`;
  return `${Math.round(bytes / 1024)} КБ`;
}
