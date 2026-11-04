/**
 * Куда класть конспекты лекций.
 *
 * Конспекты — в Obsidian, в открытое хранилище, в папку «Лекции» («Lectures»
 * у английского интерфейса). Obsidian хранит заметки обычными файлами `.md`, и Джарвис
 * дописывает в них напрямую, а открытая заметка обновляется на глазах —
 * никакого облака и никаких ключей.
 *
 * Какое хранилище открыто, Obsidian пишет в свой obsidian.json. Нет Obsidian
 * или ни одно хранилище не открыто — папка «Лекции» в папке результатов
 * Джарвиса: конспект не пропадает оттого, что нет приложения.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Где Obsidian хранит список хранилищ. */
export function obsidianConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'obsidian', 'obsidian.json');
}

/**
 * Открытое хранилище Obsidian; иначе — последнее открывавшееся.
 *
 * Только те, что есть на диске. Obsidian помнит и удалённые хранилища — у
 * владельца «открытым» числилось хранилище из распакованного в «Загрузки»
 * архива, которого уже не было (29.09.2026). Взять такое — значит создать
 * папку-призрак, которую никто не откроет, и конспект в ней потерять.
 */
export function openObsidianVault(configText: string, exists: (dir: string) => boolean = existsSync): string | null {
  let config: { vaults?: Record<string, { path?: string; open?: boolean; ts?: number }> };
  try {
    config = JSON.parse(configText) as typeof config;
  } catch {
    return null;
  }
  const хранилища = Object.values(config.vaults ?? {}).filter(
    (х): х is { path: string; open?: boolean; ts?: number } => typeof х.path === 'string' && exists(х.path),
  );
  const открытое = хранилища.find((х) => х.open);
  if (открытое) return открытое.path;
  const последнее = [...хранилища].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0];
  return последнее?.path ?? null;
}

export interface LectureFolder {
  folder: string;
  /** В хранилище Obsidian — или запасная папка, когда Obsidian нет. */
  vault: string | null;
}

/** Папка лекций: в открытом хранилище Obsidian, иначе — в папке результатов. */
export function lectureFolder(
  outputDir: string,
  notes: 'ru' | 'en' = 'ru',
  readConfig: () => string | null = () => {
    try {
      return readFileSync(obsidianConfigPath(), 'utf8');
    } catch {
      return null;
    }
  },
  exists: (dir: string) => boolean = existsSync,
): LectureFolder {
  const текст = readConfig();
  const vault = текст ? openObsidianVault(текст, exists) : null;
  return { folder: path.join(vault ?? outputDir, notes === 'en' ? 'Lectures' : 'Лекции'), vault };
}

/**
 * Имя файла конспекта: дата и предмет, без знаков, которые Windows не пускает
 * в имена файлов.
 */
export function lectureFileBase(subject: string, when: Date, notes: 'ru' | 'en' = 'ru'): string {
  const дата = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
  const время = `${String(when.getHours()).padStart(2, '0')}${String(when.getMinutes()).padStart(2, '0')}`;
  const предмет = subject.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 60);
  return предмет ? `${дата} ${предмет}` : `${дата} ${время} ${notes === 'en' ? 'Lecture' : 'Лекция'}`;
}

/** Хранилище Obsidian, в котором лежит папка: ближайшая сверху с `.obsidian`; нет такой — null. */
export function vaultOfFolder(folder: string, exists: (dir: string) => boolean = existsSync): string | null {
  for (let папка = folder; ; папка = path.dirname(папка)) {
    if (exists(path.join(папка, '.obsidian'))) return папка;
    if (path.dirname(папка) === папка) return null;
  }
}

export type ObsidianState = 'running' | 'closed' | 'unknown';

/**
 * Открыт ли Obsidian. Не вышло спросить систему — `unknown`, а не «закрыт»: по
 * этому ответу пишут настройки, которые открытый Obsidian затёр бы.
 */
export function obsidianState(platform: NodeJS.Platform = process.platform): Promise<ObsidianState> {
  return new Promise((resolve) => {
    if (platform === 'win32') {
      // Сообщение «таких задач нет» — на языке системы, поэтому ищется имя процесса.
      execFile('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
        if (error) resolve('unknown');
        else resolve(/"obsidian\.exe"/iu.test(stdout) ? 'running' : 'closed');
      });
      return;
    }
    execFile('pgrep', ['-x', platform === 'darwin' ? 'Obsidian' : 'obsidian'], { timeout: 15_000 }, (error) => {
      if (!error) resolve('running');
      // pgrep: 1 — такого процесса нет, остальное — не смог спросить.
      else resolve(error.code === 1 ? 'closed' : 'unknown');
    });
  });
}

/** Ссылка, которая открывает заметку в Obsidian. */
export function obsidianOpenUrl(file: string): string {
  return `obsidian://open?path=${encodeURIComponent(file)}`;
}
