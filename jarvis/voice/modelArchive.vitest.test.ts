/**
 * Установка модели: что остаётся на диске, когда распаковка не дошла до конца.
 *
 * Этот код ставит модели чужому человеку в первый час, и покрыт он не был
 * ничем. Замечание CodeRabbit (кусок 4, PR №43) описало ровно ту поломку,
 * которую отсюда не видно: распаковка шла прямо в папку модели, убитый
 * посреди записи процесс оставлял обрезанный файл, а проверка установленности
 * смотрит только на наличие файлов. Следующий запуск считал модель готовой,
 * загрузка в worker падала, и выбраться человек мог, только удалив папку
 * руками.
 */

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { installArchive } from './modelArchive';

const КОРЕНЬ = 'test-model';

/** Склад, куда «скачивается» архив достаточного размера. */
function стенд(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'jarvis-archive-'));
}

/** Ответ сервера с архивом нужного размера: меньше мегабайта отвергается. */
function ответСАрхивом(): typeof fetch {
  const размер = 1_200_000;
  return (async () =>
    new Response(new Uint8Array(размер), {
      status: 200,
      headers: { 'content-length': String(размер) },
    })) as unknown as typeof fetch;
}

describe('установка модели', () => {
  it('оборванная распаковка не оставляет папки модели', async () => {
    const installRoot = стенд();
    const modelRoot = path.join(installRoot, КОРЕНЬ);

    await expect(
      installArchive({
        url: 'https://example.invalid/model.tar.bz2',
        installRoot,
        rootDirName: КОРЕНЬ,
        expectedBytes: 1_200_000,
        isInstalled: async () => existsSync(modelRoot),
        fetchImpl: ответСАрхивом(),
        // Распаковка успела записать половину энкодера и умерла.
        extractImpl: async (_архив, куда) => {
          mkdirSync(path.join(куда, КОРЕНЬ), { recursive: true });
          writeFileSync(path.join(куда, КОРЕНЬ, 'encoder.onnx'), 'обрез');
          throw new Error('нет места на диске');
        },
      }),
    ).rejects.toThrow('нет места');

    // Главное: папки модели нет вовсе. Иначе следующий запуск принял бы
    // обрезанный файл за установленную модель.
    expect(existsSync(modelRoot)).toBe(false);
    // И перевалка за собой убрана.
    expect(existsSync(path.join(installRoot, `${КОРЕНЬ}.unpacking`))).toBe(false);
  });

  it('удавшаяся распаковка въезжает на место целиком', async () => {
    const installRoot = стенд();
    const modelRoot = path.join(installRoot, КОРЕНЬ);

    const куда = await installArchive({
      url: 'https://example.invalid/model.tar.bz2',
      installRoot,
      rootDirName: КОРЕНЬ,
      expectedBytes: 1_200_000,
      isInstalled: async () => existsSync(path.join(modelRoot, 'encoder.onnx')),
      fetchImpl: ответСАрхивом(),
      extractImpl: async (_архив, куда) => {
        mkdirSync(path.join(куда, КОРЕНЬ), { recursive: true });
        writeFileSync(path.join(куда, КОРЕНЬ, 'encoder.onnx'), 'целый');
      },
    });

    expect(куда).toBe(modelRoot);
    expect(readFileSync(path.join(modelRoot, 'encoder.onnx'), 'utf8')).toBe('целый');
  });

  it('архив без обещанной папки — это ошибка, а не тихий успех', async () => {
    const installRoot = стенд();

    await expect(
      installArchive({
        url: 'https://example.invalid/model.tar.bz2',
        installRoot,
        rootDirName: КОРЕНЬ,
        expectedBytes: 1_200_000,
        isInstalled: async () => false,
        fetchImpl: ответСАрхивом(),
        extractImpl: async (_архив, куда) => {
          mkdirSync(path.join(куда, 'совсем-другое'), { recursive: true });
        },
      }),
    ).rejects.toThrow(КОРЕНЬ);
  });
});
