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
import { pipeline } from 'node:stream/promises';
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

async function download(options: ArchiveInstall, target: string): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(options.url, { redirect: 'follow', signal: options.signal });

  if (!response.ok || !response.body) {
    // Эти строки уходят прямо в окно настроек, под строку модели.
    throw new Error(
      tr(`Не удалось скачать модель: HTTP ${response.status}`, `Could not download the model: HTTP ${response.status}`),
    );
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  const totalBytes = declared > 0 ? declared : options.expectedBytes;
  let receivedBytes = 0;

  const writeStream = createWriteStream(target);
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length;
    options.onProgress?.({
      stage: 'downloading',
      ratio: totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : undefined,
      receivedBytes,
      totalBytes,
    });
  });

  await pipeline(source, writeStream);
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

  try {
    await rm(archivePath, { force: true });
    await download(options, archivePath);

    const downloaded = await stat(archivePath);
    if (downloaded.size < 1_000_000) {
      throw new Error(
        tr(
          'Скачанный архив слишком мал — вероятно, загрузка прервалась.',
          'The downloaded archive is too small — the download was probably cut off.',
        ),
      );
    }

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
    await (options.extractImpl ?? extractTarBz2)(archivePath, перевалка);

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
    await rm(archivePath, { force: true }).catch(() => undefined);
    await rm(перевалка, { recursive: true, force: true }).catch(() => undefined);
  }
}
