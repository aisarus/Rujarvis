/**
 * Где Джарвис держит свои файлы. Одно правило для приложения, установщика и
 * отладочных скриптов.
 *
 * Всё лежит в одной папке, и её устройство видно с первого взгляда:
 *
 *     %LOCALAPPDATA%\Rujarvis\
 *       src\       исходники и сборка (ставит install.ps1)
 *       data\      настройки, журнал, память, план, «характер»
 *       logs\      jarvis.log
 *       models\    whisper\ — распознавание, voices\ — голоса
 *       profile\   служебный профиль Electron
 *
 * Результаты работы для человека — отдельно, на рабочем столе, чтобы их не
 * приходилось искать.
 *
 * Модуль не знает про Electron: его зовут и из main-процесса, и из `tsx`.
 */

import os from 'node:os';
import path from 'node:path';

type Env = Record<string, string | undefined>;

/** Корень всего. `JARVIS_HOME` переносит его целиком. */
export function jarvisHome(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const explicit = env.JARVIS_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  const home = os.homedir();
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local'), 'Rujarvis');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Rujarvis');
  return path.join(env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share'), 'rujarvis');
}

export interface JarvisPaths {
  home: string;
  source: string;
  data: string;
  logs: string;
  log: string;
  settings: string;
  whisperModels: string;
  voiceModels: string;
  profile: string;
}

export function jarvisPaths(env: Env = process.env, platform: NodeJS.Platform = process.platform): JarvisPaths {
  const home = jarvisHome(env, platform);
  return {
    home,
    source: path.join(home, 'src'),
    data: path.join(home, 'data'),
    logs: path.join(home, 'logs'),
    log: path.join(home, 'logs', 'jarvis.log'),
    settings: path.join(home, 'data', 'settings.json'),
    whisperModels: path.join(home, 'models', 'whisper'),
    voiceModels: path.join(home, 'models', 'voices'),
    profile: path.join(home, 'profile'),
  };
}

/** Данные: журнал, план, ящик правок, разбор прогонов. */
export function jarvisDataRoot(env: Env = process.env): string {
  return jarvisPaths(env).data;
}

/** Корень установки: то же, что `jarvisHome`. */
export function jarvisInstallRoot(env: Env = process.env): string {
  return jarvisHome(env);
}

/**
 * Папка результатов для человека.
 *
 * `folderName` — по языку: «Джарвис» или «Jarvis». Явная настройка или
 * `JARVIS_OUTPUT_DIR` важнее.
 */
export function jarvisOutputDir(
  env: Env = process.env,
  desktop = path.join(os.homedir(), 'Desktop'),
  folderName = 'Джарвис',
): string {
  return env.JARVIS_OUTPUT_DIR?.trim() || path.join(desktop, folderName);
}
