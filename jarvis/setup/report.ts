/**
 * Отчёт для разработчика — один текстовый файл.
 *
 * Первый живой тестер 20.10.2026 присылал журнал шестью снимками экрана
 * PowerShell, и половину строк приходилось угадывать по обрезанным краям.
 * Теперь кнопка в настройках кладёт в папку Джарвиса файл: версия, система,
 * настройки, агенты и хвост журнала, — а человек сам решает, отправлять ли
 * его. Джарвис ничего никуда не шлёт: без телеметрии.
 *
 * Модуль не знает про Электрон.
 */

import { tr } from '../locale/language';
import type { UpdateCheck, Version } from './update';

export interface ReportInput {
  when: Date;
  version: Version | null;
  installedCopy: boolean;
  update: UpdateCheck | null;
  platform: string;
  osRelease: string;
  arch: string;
  totalRamMb: number;
  versions: Record<string, string | undefined>;
  settings: object;
  agents: Record<string, unknown>;
  log: string;
  /** Сколько последних строк журнала взять. */
  logLines?: number;
}

/** Похожее на секрет в настройках не выносится из машины даже в отчёте. */
const СЕКРЕТ = /key|token|secret|password|пароль/iu;

export function безСекретов(settings: object): Record<string, unknown> {
  const итог: Record<string, unknown> = {};
  for (const [ключ, значение] of Object.entries(settings)) {
    итог[ключ] = СЕКРЕТ.test(ключ) && значение ? tr('(скрыто)', '(hidden)') : значение;
  }
  return итог;
}

export function хвост(текст: string, строк: number): string {
  const все = текст.split(/\r?\n/u);
  if (все.at(-1) === '') все.pop();
  return все.slice(-строк).join('\n');
}

/** Имя файла: латиница и время — отчётов может быть несколько за день. */
export function имяОтчёта(when: Date): string {
  const д = (n: number) => String(n).padStart(2, '0');
  return `rujarvis-report-${when.getFullYear()}-${д(when.getMonth() + 1)}-${д(when.getDate())}-${д(when.getHours())}${д(when.getMinutes())}.txt`;
}

export function buildReport(input: ReportInput): string {
  const строк = input.logLines ?? 400;
  const обновление = !input.update
    ? tr('не проверялось', 'not checked')
    : input.update.state === 'available'
      ? tr(
          `есть новая версия (изменений: ${input.update.changes.length}${input.update.more ? '+' : ''})`,
          `a new version is available (${input.update.changes.length}${input.update.more ? '+' : ''} changes)`,
        )
      : input.update.state === 'current'
        ? tr('последняя версия', 'up to date')
        : `${tr('не проверено', 'not checked')}: ${input.update.reason}`;
  const строки = [
    tr('Rujarvis — отчёт для разработчика', 'Rujarvis — report for the developer'),
    `${tr('Создан', 'Created')}: ${input.when.toISOString()}`,
    '',
    `## ${tr('Версия', 'Version')}`,
    input.version
      ? `${input.version.short} ${tr('от', 'of')} ${input.version.date}: ${input.version.subject}`
      : tr('неизвестна (нет git)', 'unknown (no git)'),
    `${tr('Установленная копия', 'Installed copy')}: ${input.installedCopy ? tr('да', 'yes') : tr('нет (копия разработчика)', 'no (developer copy)')}`,
    `${tr('Обновление', 'Update')}: ${обновление}`,
    '',
    `## ${tr('Система', 'System')}`,
    `${input.platform} ${input.osRelease} ${input.arch}, ${tr('память', 'memory')} ${Math.round(input.totalRamMb / 1024)} ${tr('ГБ', 'GB')}`,
    ...Object.entries(input.versions)
      .filter(([, v]) => v)
      .map(([имя, v]) => `${имя}: ${v}`),
    '',
    `## ${tr('Агенты', 'Agents')}`,
    JSON.stringify(input.agents, null, 2),
    '',
    `## ${tr('Настройки', 'Settings')}`,
    JSON.stringify(безСекретов(input.settings), null, 2),
    '',
    `## ${tr(`Журнал (последние ${строк} строк)`, `Log (last ${строк} lines)`)}`,
    хвост(input.log, строк) || tr('(журнал пуст)', '(the log is empty)'),
    '',
  ];
  return строки.join('\n');
}
