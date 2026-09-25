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

import { execFile, spawn } from 'node:child_process';
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

/**
 * Разделы прежней раскладки.
 *
 * До разделов на языке человека их было пять: Images, Video, Docs, Files,
 * Apps. Три имени совпали с нынешними английскими, а «Docs» и «Files» — нет,
 * и на диске у людей эти папки остались.
 *
 * Знать их надо не ради красоты. `isSectionName` решает, можно ли утащить
 * папку в раздел. Стоило агенту записать файл внутрь старой «Docs» — и уборка
 * уносила ВСЮ папку в «Документы\Docs», вместе с чужой работой за месяц.
 * Замерено на папке человека 25.09.2026: там лежат оба набора разделов сразу.
 */
const LEGACY_SECTION_NAMES = ['images', 'video', 'docs', 'files', 'apps'] as const;

/** Имя — один из разделов на любом из языков: такую папку не разбирают. */
export function isSectionName(name: string): boolean {
  const lower = name.toLowerCase();
  if (LEGACY_SECTION_NAMES.includes(lower as (typeof LEGACY_SECTION_NAMES)[number])) return true;
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
/**
 * Разобрать корень папки по разделам — по просьбе человека, не самовольно.
 *
 * `tidyOutput` разбирает только то, что агент трогал в этой задаче, и это
 * правильно: положенное человеком своими руками трогать нельзя, так и обещано
 * в README. Но накопившееся всё равно остаётся лежать — на папке человека
 * 25.09.2026 в корне нашлось 8 файлов, часть из них старше самой уборки.
 *
 * Поэтому отдельное действие, которое делается только когда попросили.
 * Возвращает, что куда уехало: человеку надо видеть, что с его файлами стало,
 * а не «готово».
 */
/**
 * Что обязано остаться в корне, даже когда разбирают.
 *
 * Две разные причины, обе дорогие:
 *
 *   - `desktop.ini` — не файл человека, а настройки самой папки: значок, вид,
 *     имя. Унести его — значит испортить папку, и человек не поймёт, почему.
 *     То же с `Thumbs.db`.
 *   - «о папке.txt» — объяснение, что это за папка. Его писала прежняя версия,
 *     и на дисках оно осталось. Объяснение, уехавшее в «Документы», больше не
 *     объясняет ничего.
 *
 * Замерено на папке человека 25.09.2026: разбор унёс «о папке.txt» в
 * «Документы», и корень остался без единого слова о себе.
 */
function остаётсяВКорне(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === 'desktop.ini' ||
    lower === 'thumbs.db' ||
    lower === 'о папке.txt' ||
    lower === 'about this folder.txt'
  );
}

/** Пропало, пока мы смотрели, — не беда. Всё остальное — беда. */
function этоПропажа(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export interface РазборКорня {
  /** Что и куда уехало. */
  moves: Map<string, string>;
  /** На чём споткнулись: путь и причина. */
  failures: Array<{ file: string; why: string }>;
}

/**
 * Чем переносить. Обычно — `moveIntoFolder`.
 *
 * Шов нужен ради проверки. Отказ ОДНОГО переноса в настоящей файловой системе
 * не подстроить: занятое имя перенос обходит сам, раздел-файл уезжает раньше
 * блокируемого, а открытый файл Windows переносить всё равно даёт — всё
 * проверено. Без шва поведение «споткнулись на одном, остальные перенесены»
 * осталось бы непроверяемым, а значит и недоказанным.
 */
export type Перенос = (source: string, dir: string) => Promise<string>;

export async function tidyRoot(
  dir = outputFolder(),
  перенести: Перенос = (source, куда) => moveIntoFolder(source, куда),
): Promise<РазборКорня> {
  const moves = new Map<string, string>();
  const failures: Array<{ file: string; why: string }> = [];

  // Раньше здесь стояло `.catch(() => [])`, и «нет доступа к папке»
  // становилось неотличимо от «в папке пусто»: человек слышал «разбирать
  // нечего» там, где на самом деле не смогли даже заглянуть.
  const names = await readdir(dir).catch((error: unknown) => {
    if (этоПропажа(error)) return [] as string[];
    throw error;
  });

  for (const name of names) {
    if (остаётсяВКорне(name)) continue;
    const source = path.join(dir, name);

    const info = await stat(source).catch((error: unknown) => {
      // Файл мог исчезнуть между перечислением и опросом — это бывает. А вот
      // отказ в доступе молчать не должен: файл есть, и мы его теряем.
      if (этоПропажа(error)) return null;
      throw error;
    });
    // Папки не трогаем вовсе: разделы — на месте, задачи — тоже.
    if (!info?.isFile()) continue;

    // Споткнулись на одном — остальные уже переехали, и человек должен знать
    // куда. Раньше исключение уносило с собой весь список, и найти уже
    // перенесённое было негде.
    try {
      moves.set(source, await перенести(source, dir));
    } catch (error) {
      failures.push({ file: source, why: error instanceof Error ? error.message : String(error) });
    }
  }

  return { moves, failures };
}

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
 *
 * Пробел в пути ломал это молча. Node сам берёт в кавычки любой аргумент с
 * пробелом, и explorer получал `"/select,C:\…\файл с пробелом.txt"` целиком в
 * кавычках — разобрать такое он не умеет и открывал не ту папку. Замерено
 * 25.09.2026: путь с пробелами открывал «Документы», через cmd с кавычками —
 * «Рабочий стол», и оба раза инструмент отчитывался «Показал». А темы задач с
 * пробелами — обычное дело: «Картинки\Логотип кафе».
 *
 * Поэтому командная строка собирается дословно (`windowsVerbatimArguments`):
 * кавычки стоят вокруг ПУТИ, а не вокруг всего аргумента. В этом написании
 * проводник открыл нужную папку во всех трёх опытах.
 */
export interface КомандаПоказа {
  file: string;
  args: string[];
  /** Командная строка собирается дословно: Windows иначе всё переупакует. */
  verbatim: boolean;
}

/**
 * Чем показать файл на этой платформе.
 *
 * Вынесено отдельно потому, что ошибка была именно здесь — в том, как
 * собирается командная строка, а не в том, что делается дальше. Чистую
 * функцию можно проверить на любой машине, живой проводник — только на своей.
 */
export function командаПоказа(
  target: string,
  каталог: boolean,
  platform: NodeJS.Platform = process.platform,
): КомандаПоказа {
  if (platform === 'darwin') {
    // -R показывает файл в Finder, а не открывает его.
    return { file: 'open', args: каталог ? [target] : ['-R', target], verbatim: false };
  }
  if (platform !== 'win32') {
    return { file: 'xdg-open', args: [каталог ? target : path.dirname(target)], verbatim: false };
  }
  // Кавычки стоят вокруг ПУТИ, а не вокруг всего аргумента: именно на этом
  // ломался показ файла, лежащего в папке с пробелом в имени.
  return {
    file: 'explorer.exe',
    args: [каталог ? `"${target}"` : `/select,"${target}"`],
    verbatim: true,
  };
}

export async function revealPath(target: string): Promise<void> {
  const info = await stat(target);
  const команда = командаПоказа(target, info.isDirectory());

  const дитя = spawn(команда.file, команда.args, {
    windowsVerbatimArguments: команда.verbatim,
    windowsHide: false,
    detached: true,
    stdio: 'ignore',
  });

  // Не запустилось — значит не показали.
  //
  // Раньше здесь стоял `on('error', () => undefined)`, и отсутствие самой
  // программы (на Linux `xdg-open` есть не везде) проглатывалось: инструмент
  // отвечал «Показал в проводнике», а на экране не появлялось ничего. Это тот
  // же обман, что и «Открыл» без окна, только тише.
  await new Promise<void>((resolve, reject) => {
    дитя.once('error', reject);
    дитя.once('spawn', resolve);
  });

  // Дальше платформы расходятся. Код возврата explorer не значит ничего: он
  // ненулевой и при успехе. А `open` и `xdg-open` — короткие запускалки, и их
  // код как раз значит: ненулевой там и есть «не смог».
  if (process.platform === 'win32') {
    дитя.unref();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    дитя.once('error', reject);
    дитя.once('exit', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`${команда.file} не смог показать файл (код ${code})`));
    });
  });
}

/**
 * Знает ли Windows, чем открыть такой файл.
 *
 * Спрашиваем реестр: раздел `HKEY_CLASSES_ROOT\<расширение>` есть у знакомых
 * системе типов и отсутствует у незнакомых. Стоит 40 мс против ~700 мс у
 * `FindExecutable` через PowerShell, а ответ для нашего вопроса тот же.
 */
/** Значение по умолчанию у раздела реестра, или null. */
async function значениеПоУмолчанию(раздел: string): Promise<string | null> {
  try {
    const { stdout } = await run('reg.exe', ['query', раздел, '/ve'], { windowsHide: true });
    // Строка вида «    (По умолчанию)    REG_SZ    txtfile». Имя значения
    // переведено на язык системы, поэтому цепляемся за тип, а не за имя.
    const [, хвост] = stdout.split(/REG_(?:SZ|EXPAND_SZ)/u);
    const значение = хвост?.trim().split(/\r?\n/u)[0]?.trim();
    return значение ? значение : null;
  } catch {
    return null;
  }
}

/**
 * Знает ли Windows, чем открыть такой файл.
 *
 * Мало спросить, есть ли раздел расширения: он бывает и пустым. У `.foo` может
 * лежать ProgId, за которым нет ни одной программы, — тогда открытие снова
 * ничего не делает, а инструмент снова отчитывается «Открыл». Поэтому путь
 * проходится до конца: расширение → ProgId → команда открытия.
 *
 * Сначала выбор человека (`UserChoice`): он главнее общесистемной связки —
 * именно его Windows и слушается, когда человек однажды выбрал программу сам.
 */
async function естьЧемОткрыть(target: string): Promise<boolean> {
  const ext = path.extname(target);
  if (!ext) return false;

  // У UserChoice значение именованное (`ProgId`), а не по умолчанию.
  const выборЧеловека = await run(
    'reg.exe',
    [
      'query',
      `HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${ext}\\UserChoice`,
      '/v',
      'ProgId',
    ],
    { windowsHide: true },
  )
    .then(({ stdout }) => stdout.split(/REG_SZ/u)[1]?.trim().split(/\r?\n/u)[0]?.trim() ?? null)
    .catch(() => null);

  const progId = выборЧеловека ?? (await значениеПоУмолчанию(`HKEY_CLASSES_ROOT\\${ext}`));
  if (!progId) return false;

  return run('reg.exe', ['query', `HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`], {
    windowsHide: true,
  })
    .then(() => true)
    .catch(() => false);
}

/**
 * Открывает файл той программой, которой человек открыл бы его сам.
 *
 * Бросает, если открывать нечем. Это важнее, чем кажется: `explorer.exe` на
 * незнакомом расширении не делает НИЧЕГО и не жалуется — замерено 25.09.2026,
 * ни одного нового окна, а инструмент отвечал «Открыл». Человек ждал окна,
 * окна не было, и виноватым оказывался он.
 */
export async function openPath(target: string): Promise<void> {
  await access(target, constants.R_OK);

  if (process.platform === 'darwin') {
    // `open` на маке честно возвращает ненулевой код, когда открыть нечем.
    await run('open', [target]);
    return;
  }
  if (process.platform !== 'win32') {
    await run('xdg-open', [target]);
    return;
  }

  if (!(await естьЧемОткрыть(target))) {
    throw new Error(`Windows не знает, чем открыть «${path.extname(target) || path.basename(target)}»`);
  }
  await run('explorer.exe', [target], { windowsHide: false }).catch(() => undefined);
}
