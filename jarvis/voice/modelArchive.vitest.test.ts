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

import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertFreeSpace, installArchive } from './modelArchive';
import { VOICES } from './tts';

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

describe('скачанное — то самое', () => {
  const установка = (installRoot: string, extra: Partial<Parameters<typeof installArchive>[0]>): Promise<string> =>
    installArchive({
      url: 'https://example.invalid/model.tar.bz2',
      installRoot,
      rootDirName: КОРЕНЬ,
      expectedBytes: 1_200_000,
      isInstalled: async () => existsSync(path.join(installRoot, КОРЕНЬ, 'encoder.onnx')),
      fetchImpl: ответСАрхивом(),
      extractImpl: async (_архив, куда) => {
        mkdirSync(path.join(куда, КОРЕНЬ), { recursive: true });
        writeFileSync(path.join(куда, КОРЕНЬ, 'encoder.onnx'), 'модель');
      },
      ...extra,
    });

  // SHA-256 от 1 200 000 нулевых байт — того, что отдаёт поддельный сервер.
  const СУММА = createHash('sha256').update(new Uint8Array(1_200_000)).digest('hex');

  it('контрольная сумма сошлась — модель ставится', async () => {
    const installRoot = стенд();
    await установка(installRoot, { sha256: СУММА.toUpperCase() });
    expect(readFileSync(path.join(installRoot, КОРЕНЬ, 'encoder.onnx'), 'utf8')).toBe('модель');
  });

  it('не сошлась — до распаковки дело не доходит, архив стёрт, папки модели нет', async () => {
    const installRoot = стенд();
    let распаковано = false;
    await expect(
      установка(installRoot, {
        sha256: 'a'.repeat(64),
        extractImpl: async () => {
          распаковано = true;
        },
      }),
    ).rejects.toThrow(/контрольная сумма не сошлась|checksum mismatch/u);
    expect(распаковано).toBe(false);
    expect(existsSync(path.join(installRoot, КОРЕНЬ))).toBe(false);
    // Докачивать к подменённому нельзя: следующая попытка начнёт с нуля.
    expect(existsSync(path.join(installRoot, `${КОРЕНЬ}.tar.bz2.partial`))).toBe(false);
  });

  it('у голосов с объявленной суммой она вписана — 64 знака, и размер тот же, что у издателя', () => {
    const сСуммой = VOICES.filter((v) => v.sha256);
    expect(сСуммой.map((v) => v.id).sort()).toEqual(
      [
        'vits-piper-en_US-lessac-medium',
        'vits-piper-en_US-libritts_r-medium',
        'vits-piper-ru_RU-denis-medium',
        'vits-piper-ru_RU-dmitri-medium',
        'vits-piper-ru_RU-irina-medium',
        'vits-piper-ru_RU-ruslan-medium',
      ].sort(),
    );
    for (const голос of сСуммой) expect(голос.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('место на диске — до загрузки', () => {
  it('места мало — отказ сразу, с цифрами, и сервер не тронут', async () => {
    const installRoot = стенд();
    let запросов = 0;
    await expect(
      installArchive({
        url: 'https://example.invalid/model.tar.bz2',
        installRoot,
        rootDirName: КОРЕНЬ,
        expectedBytes: 1_931_372_882,
        isInstalled: async () => false,
        freeBytes: async () => 1024 ** 3,
        fetchImpl: (async () => {
          запросов += 1;
          return new Response(null, { status: 500 });
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Не хватает места на диске: нужно 3\.8 ГБ, свободно 1\.0 ГБ|Not enough disk space/u);
    expect(запросов).toBe(0);
  });

  it('узнать свободное место нечем — не гадаем и качаем', async () => {
    await expect(assertFreeSpace(стенд(), 10 ** 15, async () => null)).resolves.toBeUndefined();
    await expect(assertFreeSpace(стенд(), 1000, async () => 2000)).resolves.toBeUndefined();
    await expect(assertFreeSpace(стенд(), 3000, async () => 2000)).rejects.toThrow();
  });

  it('настоящий диск отвечает числом', async () => {
    // Проверка на этой машине: временная папка лежит на диске, где есть хоть сколько-то места.
    await expect(assertFreeSpace(стенд(), 1)).resolves.toBeUndefined();
  });
});
