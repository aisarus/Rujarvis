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
import { constants, existsSync } from 'node:fs';
import { access, cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { currentLanguage, type Language } from '../locale/language';

const run = promisify(execFile);

/** Сколько файлов показывать: список длиннее человек всё равно не читает. */
const LIST_LIMIT = 40;

/**
 * Разделы внутри папки ассистента.
 *
 * Одна куча из картинок, роликов и документов перестаёт быть находимой уже на
 * втором десятке файлов. Раскладка по типу — то, что человек сделал бы руками,
 * только делается сразу и без него. Названия — на языке человека: папка на его
 * рабочем столе, и «Images» там читается хуже, чем «Картинки».
 */
export const OUTPUT_SECTIONS = [
  'docs',
  'tables',
  'slides',
  'images',
  'video',
  'audio',
  'code',
  'archives',
  'apps',
  'other',
] as const;

export type OutputSection = (typeof OUTPUT_SECTIONS)[number];

const SECTION_NAMES: Record<OutputSection, Record<Language, string>> = {
  docs: { ru: 'Документы', en: 'Documents' },
  tables: { ru: 'Таблицы', en: 'Spreadsheets' },
  slides: { ru: 'Презентации', en: 'Presentations' },
  images: { ru: 'Картинки', en: 'Images' },
  video: { ru: 'Видео', en: 'Video' },
  audio: { ru: 'Аудио', en: 'Audio' },
  code: { ru: 'Код', en: 'Code' },
  archives: { ru: 'Архивы', en: 'Archives' },
  apps: { ru: 'Программы', en: 'Apps' },
  other: { ru: 'Разное', en: 'Other' },
};

const SECTION_BY_EXTENSION = new Map<string, OutputSection>([
  ...asEntries('docs', ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'epub', 'fb2', 'djvu']),
  ...asEntries('tables', ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv']),
  ...asEntries('slides', ['ppt', 'pptx', 'odp', 'key']),
  ...asEntries('images', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'ico', 'heic', 'avif', 'psd', 'kra', 'xcf']),
  ...asEntries('video', ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'mpg', 'mpeg', 'flv']),
  ...asEntries('audio', ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'wma', 'mid', 'midi']),
  ...asEntries('code', [
    'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'htm', 'css', 'json', 'xml', 'yaml', 'yml', 'toml',
    'ps1', 'bat', 'cmd', 'sh', 'sql', 'c', 'cpp', 'h', 'cs', 'java', 'go', 'rs', 'rb', 'php', 'ipynb',
  ]),
  ...asEntries('archives', ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz']),
  ...asEntries('apps', ['exe', 'msi', 'msix', 'appx', 'lnk', 'apk', 'dmg']),
]);

function asEntries(section: OutputSection, extensions: string[]): Array<[string, OutputSection]> {
  return extensions.map((extension) => [extension, section]);
}

/**
 * В какой раздел попадает файл.
 *
 * Всё неопознанное идёт в «Разное», а не остаётся в корне: корень — витрина, и
 * пусто в нём быть не должно только потому, что тип файла оказался незнакомым.
 */
export function sectionFor(fileName: string): OutputSection {
  const extension = path.extname(fileName).replace(/^\./u, '').toLowerCase();
  return SECTION_BY_EXTENSION.get(extension) ?? 'other';
}

export function sectionName(section: OutputSection, language: Language = currentLanguage()): string {
  return SECTION_NAMES[section][language];
}

/** Названия разделов на языке человека — для промпта и подсказок агенту. */
export function outputSectionNames(language: Language = currentLanguage()): string[] {
  return OUTPUT_SECTIONS.map((section) => sectionName(section, language));
}

/** Имя — одно из разделов на любом из языков: такую папку не разбирают. */
function isSectionName(name: string): boolean {
  const lower = name.toLowerCase();
  return OUTPUT_SECTIONS.some((section) =>
    (['ru', 'en'] as const).some((language) => SECTION_NAMES[section][language].toLowerCase() === lower),
  );
}

/**
 * Папка раздела.
 *
 * Если человек сменил язык, а раздел на прежнем языке уже есть и на новом —
 * нет, остаёмся в прежнем: две «Картинки» и «Images» рядом — хуже любой из них.
 */
export function sectionDir(dir: string, section: OutputSection, language: Language = currentLanguage()): string {
  const own = path.join(dir, sectionName(section, language));
  if (existsSync(own)) return own;
  const other = path.join(dir, sectionName(section, language === 'ru' ? 'en' : 'ru'));
  return existsSync(other) ? other : own;
}

/**
 * Имя подпапки, которое примет Windows.
 *
 * Название придумывает модель, и в нём бывают двоеточия, кавычки и слеши;
 * слеш к тому же увёл бы файл из раздела. Пустое после чистки — подпапки нет.
 */
export function safeFolderName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/u, '')
    .slice(0, 80)
    .trim();
  if (!cleaned || /^\.+$/u.test(cleaned)) return undefined;
  // Зарезервированные имена Windows: папку «CON» создать нельзя.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/iu.test(cleaned)) return `${cleaned}_`;
  return cleaned;
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
    await ensureFolder(sectionDir(dir, section));
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
    const where = sectionDir(dir, section);
    const entries = await readFolder(where);
    if (entries.length === 0) continue;
    blocks.push(`${path.basename(where)}:\n${formatEntries(entries, 15)}`);
  }

  // Человек мог положить что-то в корень руками — это тоже надо видеть.
  const loose = (await readFolder(dir)).filter((entry) => !entry.isFolder || !isSectionName(entry.name));
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
 * картинка попадёт в «Картинки», даже если задача называлась иначе. `topic` —
 * подпапка внутри раздела: десять кадров одной задачи лежат вместе, а не
 * вперемешку со вчерашними.
 */
export async function moveIntoFolder(source: string, dir = outputFolder(), topic?: string): Promise<string> {
  await access(source, constants.R_OK);

  const subfolder = safeFolderName(topic);
  const section = sectionDir(dir, sectionFor(source));
  const target = await freeTarget(subfolder ? path.join(section, subfolder) : section, path.basename(source));
  await moveEntry(source, target);
  return target;
}

async function freeTarget(folder: string, name: string): Promise<string> {
  await ensureFolder(folder);
  const taken = new Set(await readdir(folder));
  return path.join(folder, uniqueName(name, taken));
}

async function moveEntry(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch {
    // Переименование не работает между дисками — тогда копия и удаление.
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
    await rm(source, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Разбирает по разделам то, что агент оставил в корне папки ассистента.
 *
 * Промпт просит класть через move_to_output, но модель не всегда слушается и
 * пишет файл прямо в корень. Порядок в папке — обещание человеку, и держится
 * оно кодом, а не просьбой. Трогается только сделанное агентом в этом прогоне:
 * то, что человек положил в корень сам, — его решение.
 *
 * Файл уходит в раздел по типу. Папка, которую агент завёл в корне, уходит
 * целиком подпапкой в раздел, к которому относится большинство её файлов.
 * Возвращает, что куда переехало, — чтобы назвать человеку новый путь.
 */
export async function tidyOutput(dir: string, changed: readonly string[]): Promise<Map<string, string>> {
  const moves = new Map<string, string>();
  const rootFiles = new Set<string>();
  const rootFolders = new Map<string, string[]>();

  for (const file of changed) {
    const relative = path.relative(dir, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const [head, ...rest] = relative.split(/[\\/]/u);
    if (rest.length === 0) {
      rootFiles.add(head);
    } else if (!isSectionName(head)) {
      rootFolders.set(head, [...(rootFolders.get(head) ?? []), file]);
    }
  }

  for (const name of rootFiles) {
    const source = path.join(dir, name);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) continue;
    moves.set(source, await moveIntoFolder(source, dir));
  }

  for (const [name, files] of rootFolders) {
    const source = path.join(dir, name);
    const info = await stat(source).catch(() => null);
    if (!info?.isDirectory()) continue;
    const target = await freeTarget(sectionDir(dir, majoritySection(files)), name);
    await moveEntry(source, target);
    for (const file of files) moves.set(file, path.join(target, path.relative(source, file)));
  }

  return moves;
}

/** Раздел для папки: по большинству файлов; ничьей нет — «Разное». */
function majoritySection(files: readonly string[]): OutputSection {
  const counts = new Map<OutputSection, number>();
  for (const file of files) {
    const section = sectionFor(file);
    counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return 'other';
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return 'other';
  return ranked[0][0];
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
