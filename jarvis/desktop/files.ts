/**
 * Файлы, которые агент отдаёт человеку.
 *
 * До этого модуля у агента не было способа ни показать сделанное, ни достать
 * его обратно. Он писал файл куда придётся и отвечал, что тот «в чате» — в
 * месте, которого не существует. Здесь появляются четыре недостающих действия:
 * узнать свою папку, посмотреть, что в ней лежит, перенести туда результат и
 * показать его человеку на экране.
 *
 * Ловушка, которая тут уже поймана: `explorer.exe` почти всегда завершается с
 * ненулевым кодом, даже когда окно открылось. Кто считает этот код ошибкой,
 * тот докладывает о провале после успеха.
 */

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readdir, rename, copyFile, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Сколько файлов показывать: список длиннее человек всё равно не читает. */
const LIST_LIMIT = 40;

/**
 * Разделы внутри папки ассистента.
 *
 * Одна куча из картинок, роликов и документов перестаёт быть находимой уже на
 * втором десятке файлов. Раскладка по типу — то, что человек сделал бы руками,
 * только делается сразу и без него.
 */
export const OUTPUT_SECTIONS = ['Images', 'Video', 'Docs', 'Files', 'Apps'] as const;

export type OutputSection = (typeof OUTPUT_SECTIONS)[number];

const SECTION_BY_EXTENSION = new Map<string, OutputSection>([
  ...asEntries('Images', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'ico', 'heic', 'avif', 'psd']),
  ...asEntries('Video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'mpg', 'mpeg', 'flv']),
  ...asEntries('Docs', ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'epub']),
  ...asEntries('Apps', ['exe', 'msi', 'msix', 'appx', 'lnk', 'apk', 'dmg']),
]);

function asEntries(section: OutputSection, extensions: string[]): Array<[string, OutputSection]> {
  return extensions.map((extension) => [extension, section]);
}

/**
 * В какой раздел попадает файл.
 *
 * Всё неопознанное идёт в «Files», а не остаётся в корне: корень — витрина, и
 * пусто в нём быть не должно только потому, что тип файла оказался незнакомым.
 */
export function sectionFor(fileName: string): OutputSection {
  const extension = path.extname(fileName).replace(/^\./u, '').toLowerCase();
  return SECTION_BY_EXTENSION.get(extension) ?? 'Files';
}

/**
 * Папка ассистента.
 *
 * Значение приходит из окружения — его задаёт приложение, которое одно и знает
 * настоящий путь к рабочему столу. Запасной вариант нужен на случай запуска
 * сервера руками, иначе инструменты просто не работали бы.
 */
export function outputFolder(): string {
  const configured = process.env.JARVIS_OUTPUT_DIR?.trim();
  if (configured) return configured;
  return path.join(os.homedir(), 'Desktop', 'Джарвис');
}

export async function ensureFolder(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Создаёт разделы заранее: пустая размеченная папка понятнее пустой. */
export async function ensureSections(dir = outputFolder()): Promise<string> {
  await ensureFolder(dir);
  for (const section of OUTPUT_SECTIONS) {
    await ensureFolder(path.join(dir, section));
  }
  return dir;
}

export interface FolderEntry {
  name: string;
  size: number;
  modified: Date;
  isFolder: boolean;
}

export async function readFolder(dir: string): Promise<FolderEntry[]> {
  const names = await readdir(dir);
  const entries = await Promise.all(
    names.map(async (name): Promise<FolderEntry | null> => {
      try {
        const info = await stat(path.join(dir, name));
        return { name, size: info.size, modified: info.mtime, isFolder: info.isDirectory() };
      } catch {
        // Файл мог исчезнуть между перечислением и опросом — не повод падать.
        return null;
      }
    }),
  );
  return entries
    .filter((entry): entry is FolderEntry => entry !== null)
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Список для модели: свежее сверху, потому что искать будут последнее. */
export function formatEntries(entries: readonly FolderEntry[], limit = LIST_LIMIT): string {
  if (entries.length === 0) return 'Папка пуста.';

  const shown = entries.slice(0, limit);
  const lines = shown.map((entry) => {
    const size = entry.isFolder ? 'папка' : formatSize(entry.size);
    return `${entry.name} — ${size} — ${formatWhen(entry.modified)}`;
  });
  if (entries.length > shown.length) {
    lines.push(`…и ещё ${entries.length - shown.length}`);
  }
  return lines.join('\n');
}

/**
 * Вся папка ассистента разом, по разделам.
 *
 * Плоский список по одному каталогу здесь бесполезен: в корне лежат только
 * разделы, и агент, заглянув туда, увидел бы пять папок и ни одного файла.
 */
export async function readOutputTree(dir = outputFolder()): Promise<string> {
  await ensureSections(dir);

  const blocks: string[] = [];
  for (const section of OUTPUT_SECTIONS) {
    const entries = await readFolder(path.join(dir, section));
    if (entries.length === 0) continue;
    blocks.push(`${section}:\n${formatEntries(entries, 15)}`);
  }

  // Человек мог положить что-то в корень руками — это тоже надо видеть.
  const loose = (await readFolder(dir)).filter((entry) => !entry.isFolder);
  if (loose.length > 0) blocks.push(`В корне:\n${formatEntries(loose, 15)}`);

  return blocks.length > 0 ? blocks.join('\n\n') : 'Папка пуста.';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
}

function formatWhen(when: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(when.getDate())}.${pad(when.getMonth() + 1)} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/**
 * Имя, которое не затрёт чужую работу.
 *
 * Перенос в папку не должен уничтожать то, что там уже лежит: вчерашний отчёт
 * с тем же именем — это чья-то работа, а не мусор.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;

  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})${extension}`;
}

/**
 * Переносит файл в нужный раздел папки ассистента и возвращает новый путь.
 *
 * Раздел выбирается по типу файла, а не по тому, что агент о нём думает:
 * картинка попадёт в «Images», даже если задача называлась иначе.
 */
export async function moveIntoFolder(source: string, dir = outputFolder()): Promise<string> {
  await access(source, constants.R_OK);

  const section = path.join(dir, sectionFor(source));
  await ensureFolder(section);

  const taken = new Set(await readdir(section));
  const target = path.join(section, uniqueName(path.basename(source), taken));

  try {
    await rename(source, target);
  } catch {
    // Переименование не работает между дисками — тогда копия и удаление.
    await copyFile(source, target);
    await unlink(source).catch(() => {});
  }
  return target;
}

/**
 * Показывает файл человеку: открывает папку и выделяет в ней файл.
 *
 * Именно выделяет, а не просто открывает каталог, — человек ищет глазами один
 * файл среди тридцати.
 */
export async function revealPath(target: string): Promise<void> {
  const info = await stat(target);
  const args = info.isDirectory() ? [target] : [`/select,${target}`];
  // Код возврата explorer не значит ничего: он ненулевой и при успехе.
  await run('explorer.exe', args, { windowsHide: false }).catch(() => undefined);
}

/** Открывает файл той программой, которой человек открыл бы его сам. */
export async function openPath(target: string): Promise<void> {
  await access(target, constants.R_OK);
  await run('explorer.exe', [target], { windowsHide: false }).catch(() => undefined);
}
