/**
 * Где Джарвис держит свои файлы на этой машине.
 *
 * Одно правило на всех: приложение, установщик и отладочные скрипты должны
 * находить одни и те же журнал, план и папку результатов. Пока каждый скрипт
 * держал свой путь, в них оказывался путь одной конкретной машины.
 *
 * Модуль не знает про Electron: его зовут и из main-процесса, и из `tsx`.
 */

import os from 'node:os';
import path from 'node:path';

type Env = Record<string, string | undefined>;

/** `%LOCALAPPDATA%\Rujarvis` — корень установки и данных. */
export function jarvisInstallRoot(env: Env = process.env): string {
  const local = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Rujarvis');
}

/** Данные: журнал, план, ящик правок, разбор прогонов. */
export function jarvisDataRoot(env: Env = process.env): string {
  const explicit = env.JARVIS_DATA_ROOT?.trim();
  return explicit ? path.resolve(explicit) : path.join(jarvisInstallRoot(env), 'data');
}

/** Папка, куда агент кладёт результаты для человека. */
export function jarvisOutputDir(env: Env = process.env, desktop = path.join(os.homedir(), 'Desktop')): string {
  return env.JARVIS_OUTPUT_DIR?.trim() || path.join(desktop, 'Джарвис');
}
