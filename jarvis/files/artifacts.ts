/**
 * Что из сделанного человек должен увидеть.
 *
 * Агент отчитывается словами, и слова бывают выдуманные: на вопрос «где
 * картинка» он однажды ответил, что она «в чате с Джарвисом» — в месте,
 * которого не существует. Единственный надёжный источник — то, что бэкенд
 * наблюдал на диске: список изменённых файлов. Здесь он превращается в одну
 * фразу, которую можно произнести, и в список путей, которые можно открыть.
 *
 * Правка исходников сюда не попадает. Когда человек просит починить код, файлы
 * меняются десятками, и объявлять их подарком — врать про суть работы.
 */

import type { BackendFileChange } from '../backends/types';
import { tr } from '../locale/language';

export interface ArtifactReport {
  /** Абсолютные пути: сначала то, что в папке ассистента, потом остальное. */
  paths: string[];
  /** Одна фраза для голоса — где искать результат. */
  spoken: string;
}

export interface ArtifactOptions {
  /** Папка ассистента: всё, что туда легло, предназначено человеку. */
  outputDir?: string;
  /** Рабочая папка проекта: правки в ней — работа, а не результат. */
  workspace?: string;
}

/** Больше трёх имён подряд на слух не удерживаются. */
const MAX_SPOKEN_NAMES = 3;

/** Временное живёт в Temp и человеку не нужно. */
const TEMP_MARKERS = [/[\\/]temp[\\/]/iu, /[\\/]tmp[\\/]/iu];

export function describeArtifacts(
  changes: readonly BackendFileChange[],
  options: ArtifactOptions = {},
): ArtifactReport | null {
  const seen = new Set<string>();
  const inFolder: string[] = [];
  const elsewhere: string[] = [];

  for (const change of changes) {
    // Удаление — не результат, показывать нечего.
    if (change.action === 'deleted') continue;

    const key = normalise(change.path);
    if (seen.has(key)) continue;

    if (isInside(change.path, options.outputDir)) {
      seen.add(key);
      inFolder.push(change.path);
      continue;
    }

    // За пределами папки ассистента считается только новое: изменённый чужой
    // файл человек и так знает, а новый он иначе не найдёт.
    if (change.action !== 'created') continue;
    if (isInside(change.path, options.workspace)) continue;
    if (TEMP_MARKERS.some((marker) => marker.test(change.path))) continue;

    seen.add(key);
    elsewhere.push(change.path);
  }

  if (inFolder.length === 0 && elsewhere.length === 0) return null;

  const sentences: string[] = [];

  if (inFolder.length > 0 && options.outputDir) {
    const where = folderPhrase(options.outputDir);
    const names = inFolder.map(baseName);
    if (names.length === 1) {
      // Раздел называется вслух: «в папке Джарвис» мало, когда разделов десять.
      const section = sectionOf(inFolder[0], options.outputDir);
      const inSection = section ? tr(`, раздел «${section}»`, `, section ${section}`) : '';
      sentences.push(tr(`Файл «${names[0]}» — ${where}${inSection}.`, `The file ${names[0]} is ${where}${inSection}.`));
    } else {
      sentences.push(`${capitalise(where)}: ${listNames(names)}.`);
    }
  }

  if (elsewhere.length > 0) {
    // Тут имени файла мало: человек не знает каталога, поэтому путь целиком.
    const shown = elsewhere.slice(0, MAX_SPOKEN_NAMES);
    const tail = elsewhere.length > shown.length ? tr(` и ещё ${elsewhere.length - shown.length}`, ` and ${elsewhere.length - shown.length} more`) : '';
    sentences.push(
      shown.length === 1
        ? tr(`Файл «${baseName(shown[0])}» лежит здесь: ${shown[0]}.`, `The file ${baseName(shown[0])} is here: ${shown[0]}.`)
        : tr(`Файлы лежат здесь: ${shown.join(', ')}${tail}.`, `The files are here: ${shown.join(', ')}${tail}.`),
    );
  }

  return { paths: [...inFolder, ...elsewhere], spoken: sentences.join(' ') };
}

/** Windows не различает регистр и оба вида слешей — сравнение тоже не должно. */
function normalise(value: string): string {
  return value.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '').toLowerCase();
}

function isInside(child: string, parent: string | undefined): boolean {
  if (!parent) return false;
  const inner = normalise(child);
  const outer = normalise(parent);
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * Раздел внутри папки ассистента, если файл лежит в нём.
 *
 * Возвращает пусто для файла прямо в корне — говорить «раздел» про корень
 * значит отправить человека искать несуществующую папку.
 */
function sectionOf(filePath: string, outputDir: string): string | undefined {
  const inner = normalise(filePath);
  const outer = normalise(outputDir);
  if (!inner.startsWith(`${outer}/`)) return undefined;

  const rest = inner.slice(outer.length + 1).split('/');
  if (rest.length < 2) return undefined;

  // Регистр вернуть из исходного пути: normalise его потерял.
  const original = filePath.replace(/[\\/]+/gu, '/').split('/');
  return original[original.length - rest.length];
}

function baseName(value: string): string {
  const parts = value.replace(/[\\/]+$/u, '').split(/[\\/]/u);
  return parts[parts.length - 1] ?? value;
}

/**
 * «На рабочем столе» говорится, только если папка действительно там: человек
 * пойдёт искать туда, куда ему сказали.
 */
function folderPhrase(outputDir: string): string {
  const label = baseName(outputDir);
  const parent = baseName(outputDir.replace(/[\\/]+$/u, '').replace(/[\\/][^\\/]+$/u, ''));
  const onDesktop = /^(desktop|рабочий стол)$/iu.test(parent);
  return onDesktop
    ? tr(`в папке «${label}» на рабочем столе`, `in the ${label} folder on the desktop`)
    : tr(`в папке «${label}»`, `in the ${label} folder`);
}

function listNames(names: string[]): string {
  if (names.length <= MAX_SPOKEN_NAMES) return names.join(', ');
  const head = names.slice(0, MAX_SPOKEN_NAMES).join(', ');
  return tr(`${head} и ещё ${names.length - MAX_SPOKEN_NAMES}`, `${head} and ${names.length - MAX_SPOKEN_NAMES} more`);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
