/**
 * Скачать и распаковать архив модели `.tar.bz2` с релизов sherpa-onnx.
 *
 * Общее для моделей распознавания и голосов: одни и те же архивы, одна и та
 * же потоковая распаковка. Архивы большие (от 60 МБ до 2 ГБ), поэтому ход
 * загрузки сообщается по мере, а прерванная установка не оставляет
 * полузаписанного.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import tar, { type Headers as TarHeader } from 'tar-stream';
import unbzip2Stream from 'unbzip2-stream';

import { tr } from '../locale/language';

export interface ModelInstallProgress {
  stage: 'downloading' | 'extracting' | 'verifying' | 'complete' | 'error';
  /** 0..1 while downloading, undefined otherwise. */
  ratio?: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface ArchiveInstall {
  url: string;
  /** Куда распаковывать: архив содержит папку `rootDirName`. */
  installRoot: string;
  rootDirName: string;
  /** Размер архива, если сервер его не назовёт. */
  expectedBytes: number;
  isInstalled(): Promise<boolean>;
  onProgress?(progress: ModelInstallProgress): void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /**
   * Чем распаковывать. Настоящая работа — `extractTarBz2`; подменяется в
   * проверках, чтобы показать оборванную распаковку без архива на 2 ГБ.
   */
  extractImpl?(archivePath: string, destinationDir: string): Promise<void>;
  /** Сколько тишины считать зависанием. Подменяется в проверках. */
  stallMs?: number;
  /** Пауза перед повтором номер `попытка` (с единицы). Подменяется в проверках. */
  retryDelayMs?(попытка: number): number;
}

/**
 * Сколько тишины считать зависшей связью.
 *
 * На мобильной раздаче связь чаще не рвётся, а замирает: байты перестают идти,
 * а ошибки нет. Без срока полоска прогресса стояла бы вечно. Полминуты — с
 * запасом на паузы сотовой сети и без вечного ожидания.
 */
const ЗАВИСАНИЕ_МС = 30_000;

/**
 * Сколько провалов ПОДРЯД без продвижения — и сдаёмся.
 *
 * Считаются только попытки, не принёсшие ни байта. Большую модель по раздаче с
 * телефона может рвать много раз, но если каждый раз что-то докачивается, она
 * доедет, и бросать её на пятом обрыве было бы глупо.
 */
const ПРОВАЛОВ_БЕЗ_ПРОДВИЖЕНИЯ = 5;

function паузаПередПовтором(попытка: number): number {
  return Math.min(15_000, 1_000 * 2 ** (попытка - 1));
}

/** Сколько байт уже лежит в недокачанном файле. */
async function размер(путь: string): Promise<number> {
  try {
    return (await stat(путь)).size;
  } catch {
    return 0;
  }
}

/**
 * Rejects archive entries that would escape the destination directory.
 *
 * A tar can name `../../etc/passwd`; extraction must not honour it.
 */
export function resolveArchiveEntry(destinationDir: string, entryName: string): string {
  const normalized = path.normalize(entryName).replace(/^([/\\])+/, '');
  const resolved = path.resolve(destinationDir, normalized);
  const root = path.resolve(destinationDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Archive entry escapes the destination directory: ${entryName}`);
  }
  return resolved;
}

export async function extractTarBz2(archivePath: string, destinationDir: string): Promise<void> {
  const extract = tar.extract();

  // Ошибку записи мало сообщить — надо ещё остановить сам разбор архива.
  //
  // Раньше `reject` только отклонял обещание, а `next()` не вызывался: tar
  // ждал продолжения вечно, `pipeline` не завершался, и до `await extractDone`
  // дело не доходило. Получалось два несчастья сразу — установка висела на
  // «распаковываю…», а необработанный отказ в Node 22 роняет весь Электрон.
  // Случай житейский: кончилось место на диске или файл модели занят.
  const extractDone = new Promise<void>((resolve, отклонить) => {
    const reject = (error: unknown): void => {
      const беда = error instanceof Error ? error : new Error(String(error));
      // Рвём разбор: тогда и `pipeline` закончится отказом, а не тишиной.
      extract.destroy(беда);
      отклонить(беда);
    };
    extract.on('entry', (header: TarHeader, stream: Readable, next: () => void) => {
      let destinationPath: string;
      try {
        destinationPath = resolveArchiveEntry(destinationDir, header.name);
      } catch (error) {
        stream.resume();
        reject(error);
        return;
      }

      if (header.type === 'directory') {
        void mkdir(destinationPath, { recursive: true })
          .then(() => {
            stream.resume();
            stream.on('end', () => next());
          })
          .catch(reject);
        return;
      }

      if (header.type !== 'file') {
        stream.resume();
        stream.on('end', () => next());
        return;
      }

      void mkdir(path.dirname(destinationPath), { recursive: true })
        .then(() => {
          const writeStream = createWriteStream(destinationPath, { mode: header.mode ?? 0o644 });
          stream.pipe(writeStream);
          writeStream.on('finish', () => next());
          writeStream.on('error', reject);
          stream.on('error', reject);
        })
        .catch(reject);
    });

    extract.on('finish', () => resolve());
    extract.on('error', reject);
  });

  // Оба обещания ждём вместе, а не по очереди.
  //
  // По очереди отказ распаковки оказывался никем не присмотренным ровно до
  // конца `pipeline` — то есть до никогда. `Promise.all` вешает обработчик
  // сразу на оба и отдаёт первую же ошибку.
  await Promise.all([pipeline(createReadStream(archivePath), unbzip2Stream(), extract), extractDone]);
}

/**
 * Одна попытка: докачать с того места, где лежит недокачанное.
 *
 * Возвращает, сколько байт должно быть в файле целиком, — по ответу сервера.
 * Бросает, если связь оборвалась, замерла или сервер ответил отказом.
 */
async function попытка(
  options: DownloadOptions,
  target: string,
  уже: number,
  прогресс: (получено: number, всего: number) => void,
): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const стояние = options.stallMs ?? ЗАВИСАНИЕ_МС;

  // Своя отмена для зависания и отмена человека — вместе. Отмену человека
  // различаем снаружи: на неё не повторяют.
  const своя = new AbortController();
  const сигнал = options.signal ? AbortSignal.any([options.signal, своя.signal]) : своя.signal;
  let таймер: ReturnType<typeof setTimeout> | null = null;
  const завести = () => {
    if (таймер) clearTimeout(таймер);
    таймер = setTimeout(() => своя.abort(new Error(tr('связь замерла', 'the connection stalled'))), стояние);
  };

  try {
    // Таймер — и на ожидание ответа: сервер, который молчит до заголовков,
    // ничем не лучше замершей середины.
    завести();
    const response = await fetchImpl(options.url, {
      redirect: 'follow',
      signal: сигнал,
      ...(уже > 0 ? { headers: { Range: `bytes=${уже}-` } } : {}),
    });

    // 416: просили с места, которого в файле нет. Значит, лежащее недокачанное
    // не от этого файла или уже целое; решает сверка размера снаружи.
    if (response.status === 416) {
      const всего = Number(/[/](\d+)$/u.exec(response.headers.get('content-range') ?? '')?.[1] ?? 0);
      return всего > 0 ? всего : уже;
    }

    if (!response.ok || !response.body) {
      // Эти строки уходят прямо в окно настроек, под строку модели.
      throw new Error(
        tr(`Не удалось скачать модель: HTTP ${response.status}`, `Could not download the model: HTTP ${response.status}`),
      );
    }

    // 206 — сервер продолжает с нашего места. 200 — отдаёт файл целиком, Range
    // он не услышал: тогда пишем заново, иначе приклеили бы файл к куску.
    const продолжает = response.status === 206;
    let начало = 0;
    let всего = options.expectedBytes;
    if (продолжает) {
      const м = /bytes (\d+)-\d+[/](\d+)/u.exec(response.headers.get('content-range') ?? '');
      начало = Number(м?.[1] ?? уже);
      if (м?.[2]) всего = Number(м[2]);
      if (начало !== уже) {
        throw new Error(`сервер продолжил не с того места: ${начало} вместо ${уже}`);
      }
    } else {
      const длина = Number(response.headers.get('content-length') ?? 0);
      if (длина > 0) всего = длина;
    }

    const writeStream = createWriteStream(target, { flags: продолжает ? 'a' : 'w' });
    // Читаем сами, без упреждения, и каждый прочитанный кусок сразу пишем.
    //
    // Раньше стоял pipeline из Readable.fromWeb: тот читает наперёд, и при
    // обрыве ошибка выбрасывала уже полученный, но ещё не записанный кусок —
    // вместе с недописанным буфером записи. Тест поймал: до обрыва принято
    // 400 000 байт, а к следующей попытке на диске 393 216. Докачка шла с
    // правильного места — с размера файла, — но оборванное скачивалось заново.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let получено = начало;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        завести();
        получено += value.length;
        прогресс(получено, всего);
        if (!writeStream.write(value)) await once(writeStream, 'drain');
      }
    } finally {
      // Принятое — на диск до следующей попытки, и при обрыве тоже.
      writeStream.end();
      await finished(writeStream);
    }
    return всего;
  } finally {
    if (таймер) clearTimeout(таймер);
  }
}

/**
 * Скачать архив так, чтобы это пережила связь с телефона.
 *
 * Недокачанное не стирается: каждая попытка просит у сервера продолжение с
 * того места, где оборвалась прошлая (`Range`). Сервер релизов это умеет —
 * замерено 26.09.2026: на кусок из середины он ответил 206 и
 * `Content-Range: bytes 1000000-1000999/116204861`.
 *
 * Раньше недокачанное стиралось и в начале, и при любой ошибке, повтора не было,
 * а замершая связь не ловилась вовсе. На раздаче с телефона модель в 208 МБ,
 * оборвавшаяся на 180-м, качалась заново руками, а замершая стояла с
 * неподвижной полоской без конца.
 */
/** Что нужно загрузке одного файла — без распаковки. */
export type DownloadOptions = Pick<
  ArchiveInstall,
  'url' | 'expectedBytes' | 'onProgress' | 'signal' | 'fetchImpl' | 'stallMs' | 'retryDelayMs'
>;

/**
 * Скачать один файл с докачкой, повтором и сроком на зависание.
 *
 * Тот же путь, что у архива модели: распознавание на видеокарте ставит zip и
 * файл модели, и учить обрыв связи второй раз незачем.
 */
export async function downloadFile(options: DownloadOptions, target: string): Promise<void> {
  await download(options, target);
}

async function download(options: DownloadOptions, target: string): Promise<void> {
  const задержка = options.retryDelayMs ?? паузаПередПовтором;
  let провалов = 0;
  let всего = options.expectedBytes;

  for (let номер = 1; ; номер++) {
    const уже = await размер(target);
    if (уже > 0 && уже === всего) return;

    try {
      всего = await попытка(options, target, уже, (получено, из) => {
        options.onProgress?.({
          stage: 'downloading',
          ratio: из > 0 ? Math.min(1, получено / из) : undefined,
          receivedBytes: получено,
          totalBytes: из,
        });
      });
      const есть = await размер(target);
      if (есть === всего) return;
      // Больше, чем весь файл, — лежавшее недокачанное было чужим. С нуля.
      if (есть > всего) await rm(target, { force: true });
      throw new Error(
        tr(`Архив скачан не целиком: ${есть} из ${всего} байт.`, `The archive is incomplete: ${есть} of ${всего} bytes.`),
      );
    } catch (error) {
      // Отмена человеком — не обрыв. На неё не повторяют.
      if (options.signal?.aborted) throw error;

      const продвинулись = (await размер(target)) > уже;
      провалов = продвинулись ? 1 : провалов + 1;
      if (провалов >= ПРОВАЛОВ_БЕЗ_ПРОДВИЖЕНИЯ) {
        const причина = error instanceof Error ? error.message : String(error);
        throw new Error(
          tr(
            `Связь не даёт скачать модель: ${причина}. Скачанное сохранено — повторите, и загрузка продолжится с того же места.`,
            `The connection keeps failing: ${причина}. What was downloaded is kept — try again and it will continue from there.`,
          ),
        );
      }

      const ждём = задержка(номер);
      options.onProgress?.({
        stage: 'downloading',
        ratio: всего > 0 ? Math.min(1, (await размер(target)) / всего) : undefined,
        message: tr(
          `Связь оборвалась, продолжаю через ${Math.round(ждём / 1000)} с`,
          `Connection lost, resuming in ${Math.round(ждём / 1000)} s`,
        ),
      });
      await new Promise((resolve) => setTimeout(resolve, ждём));
    }
  }
}

/** Есть ли такая папка. Отсутствие — не ошибка, а ответ. */
async function существует(путь: string): Promise<boolean> {
  try {
    return (await stat(путь)).isDirectory();
  } catch {
    return false;
  }
}

/** Поставить модель или сразу вернуться, если она уже стоит. Возвращает её папку. */
export async function installArchive(options: ArchiveInstall): Promise<string> {
  const modelRoot = path.join(options.installRoot, options.rootDirName);

  if (await options.isInstalled()) {
    options.onProgress?.({ stage: 'complete', message: modelRoot });
    return modelRoot;
  }

  await mkdir(options.installRoot, { recursive: true });
  const archivePath = path.join(options.installRoot, `${options.rootDirName}.tar.bz2.partial`);
  const перевалка = path.join(options.installRoot, `${options.rootDirName}.unpacking`);

  // Докачанное не трогаем: с него и продолжим. Стирается оно только когда
  // своё дело сделало или оказалось испорченным — см. ниже.
  let архивЦел = false;
  try {
    await download(options, archivePath);
    архивЦел = true;

    options.onProgress?.({ stage: 'extracting' });
    // Распаковываем В СТОРОНУ, а въезжаем на место переименованием.
    //
    // Раньше распаковка шла прямо в `modelRoot`. Убитый посреди записи
    // процесс оставлял обрезанный файл, а `isInstalled` смотрит только на
    // наличие файлов — и следующий запуск считал модель установленной.
    // Переустановка не начиналась, загрузка в worker падала, и выбраться
    // человек мог только удалив папку руками. Шапка файла обещает, что
    // «прерванная установка не оставляет полузаписанного»; теперь так и есть:
    // переименование на одной файловой системе либо случилось, либо нет.
    await rm(перевалка, { recursive: true, force: true });
    try {
      await (options.extractImpl ?? extractTarBz2)(archivePath, перевалка);
    } catch (беда) {
      // Не распаковался — значит, испорчен. Такой докачивать нельзя: следующая
      // попытка приклеила бы новое к порче. Только с нуля.
      await rm(archivePath, { force: true }).catch(() => undefined);
      throw беда;
    }

    const распакованное = path.join(перевалка, options.rootDirName);
    if (!(await существует(распакованное))) {
      throw new Error(
        tr(
          `В архиве нет папки ${options.rootDirName}.`,
          `The archive has no ${options.rootDirName} folder.`,
        ),
      );
    }

    // Остатки прошлой распаковки убираем, чтобы повтор не смешал две версии.
    await rm(modelRoot, { recursive: true, force: true });
    await rename(распакованное, modelRoot);

    options.onProgress?.({ stage: 'verifying' });
    if (!(await options.isInstalled())) {
      throw new Error(
        tr(
          `Модель распакована, но файлы не найдены: ${modelRoot}`,
          `The model was unpacked but its files are missing: ${modelRoot}`,
        ),
      );
    }

    options.onProgress?.({ stage: 'complete', message: modelRoot });
    return modelRoot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onProgress?.({ stage: 'error', message });
    throw error;
  } finally {
    // Скачан целиком — архив своё отслужил (или испорчен и уже стёрт выше).
    // Оборвалась загрузка — архив остаётся недокачанным, и следующая попытка
    // продолжит с того же места, хоть после перезапуска Джарвиса.
    if (архивЦел) await rm(archivePath, { force: true }).catch(() => undefined);
    await rm(перевалка, { recursive: true, force: true }).catch(() => undefined);
  }
}
