/**
 * Downloading and unpacking a Whisper speech model.
 *
 * Mirrors how the Workstation installs its speech-synthesis voices: same
 * release channel, same `.tar.bz2` archives, same streamed extraction with
 * `tar-stream` and `unbzip2-stream`, both of which the app already depends on.
 *
 * Archives are large (200 MB to 2 GB), so progress is reported as it goes and
 * an interrupted install leaves nothing half-written behind.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar, { type Headers as TarHeader } from 'tar-stream';
import unbzip2Stream from 'unbzip2-stream';
import {
  getWhisperDownloadUrl,
  getWhisperModel,
  type WhisperModelId,
} from './sttModels';
import { isWhisperModelInstalled } from './whisperRecognizer';

export interface WhisperInstallProgress {
  stage: 'downloading' | 'extracting' | 'verifying' | 'complete' | 'error';
  /** 0..1 while downloading, undefined otherwise. */
  ratio?: number;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface InstallWhisperOptions {
  installRoot: string;
  modelId: WhisperModelId;
  onProgress?(progress: WhisperInstallProgress): void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
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

async function extractTarBz2(archivePath: string, destinationDir: string): Promise<void> {
  const extract = tar.extract();

  const extractDone = new Promise<void>((resolve, reject) => {
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

  await pipeline(createReadStream(archivePath), unbzip2Stream(), extract);
  await extractDone;
}

async function downloadArchive(options: InstallWhisperOptions, target: string): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = getWhisperDownloadUrl(options.modelId);
  const response = await fetchImpl(url, { redirect: 'follow', signal: options.signal });

  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать модель: HTTP ${response.status}`);
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  const totalBytes = declared > 0 ? declared : getWhisperModel(options.modelId).downloadBytes;
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

/**
 * Installs a Whisper model, or returns immediately when it is already there.
 *
 * Returns the directory the model was unpacked into.
 */
export async function installWhisperModel(options: InstallWhisperOptions): Promise<string> {
  const model = getWhisperModel(options.modelId);
  const modelRoot = path.join(options.installRoot, model.rootDirName);

  if (await isWhisperModelInstalled(options.installRoot, options.modelId)) {
    options.onProgress?.({ stage: 'complete', message: modelRoot });
    return modelRoot;
  }

  await mkdir(options.installRoot, { recursive: true });
  const archivePath = path.join(options.installRoot, `${model.assetName}.partial`);

  try {
    await rm(archivePath, { force: true });
    await downloadArchive(options, archivePath);

    const downloaded = await stat(archivePath);
    if (downloaded.size < 1_000_000) {
      throw new Error('Скачанный архив слишком мал — вероятно, загрузка прервалась.');
    }

    options.onProgress?.({ stage: 'extracting' });
    // Remove a partial previous unpack so a retry cannot mix two versions.
    await rm(modelRoot, { recursive: true, force: true });
    await extractTarBz2(archivePath, options.installRoot);

    options.onProgress?.({ stage: 'verifying' });
    if (!(await isWhisperModelInstalled(options.installRoot, options.modelId))) {
      throw new Error(`Модель распакована, но файлы не найдены: ${modelRoot}`);
    }

    options.onProgress?.({ stage: 'complete', message: modelRoot });
    return modelRoot;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onProgress?.({ stage: 'error', message });
    throw error;
  } finally {
    await rm(archivePath, { force: true }).catch(() => undefined);
  }
}

export async function uninstallWhisperModel(
  installRoot: string,
  modelId: WhisperModelId,
): Promise<void> {
  await rm(path.join(installRoot, getWhisperModel(modelId).rootDirName), {
    recursive: true,
    force: true,
  });
}
