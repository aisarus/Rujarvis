/**
 * Установка модели распознавания Whisper.
 *
 * Архивы и распаковка — общие с голосами (`modelArchive.ts`).
 */

import { rm } from 'node:fs/promises';
import path from 'node:path';

import { installArchive, type ModelInstallProgress } from './modelArchive';
import { getWhisperDownloadUrl, getWhisperModel, type WhisperModelId } from './sttModels';
import { isWhisperModelInstalled } from './whisperRecognizer';

export { resolveArchiveEntry } from './modelArchive';
export type WhisperInstallProgress = ModelInstallProgress;

export interface InstallWhisperOptions {
  installRoot: string;
  modelId: WhisperModelId;
  onProgress?(progress: WhisperInstallProgress): void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function installWhisperModel(options: InstallWhisperOptions): Promise<string> {
  const model = getWhisperModel(options.modelId);
  return installArchive({
    url: getWhisperDownloadUrl(options.modelId),
    installRoot: options.installRoot,
    rootDirName: model.rootDirName,
    expectedBytes: model.downloadBytes,
    isInstalled: () => isWhisperModelInstalled(options.installRoot, options.modelId),
    onProgress: options.onProgress,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
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
