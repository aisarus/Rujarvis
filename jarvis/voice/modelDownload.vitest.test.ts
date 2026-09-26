/**
 * Загрузка модели по связи, которая рвётся и замирает.
 *
 * Для раздачи интернета с телефона. Раньше недокачанное стиралось и в начале, и
 * при любой ошибке, повтора не было, а замершая связь не ловилась вовсе.
 *
 * Сервер здесь поддельный, но ведёт себя как настоящий сервер релизов: на
 * `Range` отвечает 206 и `Content-Range` — так он ответил на живой замер
 * 26.09.2026. Байты у файла узнаваемые, и сверяется СОДЕРЖИМОЕ, а не только
 * размер: докачка, приклеившая кусок не туда, дала бы тот же размер.
 */

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { installArchive } from './modelArchive';

const КОРЕНЬ = 'test-model';
const РАЗМЕР = 1_200_000;

/** Файл с узнаваемым узором: у каждого места свой байт. */
const ФАЙЛ = Uint8Array.from({ length: РАЗМЕР }, (_, i) => (i * 7 + (i >> 11)) % 251);

type Ход = 'цело' | 'замереть' | 'без-range' | { оборвать: number };

/**
 * Сервер, который на каждый запрос делает следующий ход из плана.
 * Последний ход повторяется. В журнал пишется заголовок Range каждого запроса.
 */
function сервер(план: Ход[], журнал: string[]): typeof fetch {
  let номер = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const ход = план[Math.min(номер, план.length - 1)] as Ход;
    номер++;
    const заголовки = new Headers(init?.headers);
    const range = заголовки.get('range') ?? '';
    журнал.push(range);

    const сигнал = init?.signal;
    if (сигнал?.aborted) throw сигнал.reason ?? new Error('отменено');

    const с = ход === 'без-range' ? 0 : Number(/bytes=(\d+)-/u.exec(range)?.[1] ?? 0);
    if (с >= РАЗМЕР) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${РАЗМЕР}` } });
    }
    const кусок = ФАЙЛ.subarray(с);
    const частично = с > 0;
    const headers: Record<string, string> = { 'content-length': String(кусок.length) };
    if (частично) headers['content-range'] = `bytes ${с}-${РАЗМЕР - 1}/${РАЗМЕР}`;

    const отдать = typeof ход === 'object' ? ход.оборвать : ход === 'замереть' ? 1_000 : кусок.length;
    // Выдача ПО ЗАПРОСУ читателя, а не вся сразу. Ошибка потока выбрасывает
    // ещё не прочитанные куски — так велят правила потоков, — и первая версия
    // этого сервера, ронявшая поток сразу после выдачи, не донесла до файла ни
    // байта. Настоящий обрыв случается ПОСЛЕ того, как байты прочитаны.
    let i = 0;
    const тело = new ReadableStream<Uint8Array>({
      start(controller) {
        сигнал?.addEventListener('abort', () => controller.error(сигнал.reason ?? new Error('отменено')));
      },
      pull(controller) {
        const предел = Math.min(отдать, кусок.length);
        if (i < предел) {
          const до = Math.min(предел, i + 65_536);
          controller.enqueue(кусок.slice(i, до));
          i = до;
          return;
        }
        if (ход === 'замереть') return new Promise<void>(() => undefined); // тишина без ошибки
        if (typeof ход === 'object') controller.error(new Error('обрыв связи'));
        else controller.close();
        return;
      },
    });
    return new Response(тело, { status: частично ? 206 : 200, headers });
  }) as unknown as typeof fetch;
}

function стенд(): { installRoot: string; архив: string } {
  const installRoot = mkdtempSync(path.join(os.tmpdir(), 'jarvis-download-'));
  return { installRoot, архив: path.join(installRoot, `${КОРЕНЬ}.tar.bz2.partial`) };
}

/** Установка, которая при распаковке сверяет скачанное байт в байт. */
function поставить(installRoot: string, fetchImpl: typeof fetch, ещё: Partial<Parameters<typeof installArchive>[0]> = {}) {
  let скачано: Uint8Array | null = null;
  const итог = installArchive({
    url: 'https://example.invalid/model.tar.bz2',
    installRoot,
    rootDirName: КОРЕНЬ,
    expectedBytes: РАЗМЕР,
    isInstalled: async () => existsSync(path.join(installRoot, КОРЕНЬ, 'ok')),
    fetchImpl,
    retryDelayMs: () => 1,
    // Щедро: короткий срок нужен только тесту на замирание, он просит свой.
    // При 200 мс для всех медленный Windows-раннер CI (антивирус проверяет
    // каждую запись во временный файл) ловил ложное «замирание» между кусками:
    // обрыв «на 400 000» случался на 65 536, и тест падал на 9dcaa6f.
    stallMs: 10_000,
    extractImpl: async (архив, куда) => {
      скачано = new Uint8Array(readFileSync(архив));
      const { mkdirSync } = await import('node:fs');
      mkdirSync(path.join(куда, КОРЕНЬ), { recursive: true });
      writeFileSync(path.join(куда, КОРЕНЬ, 'ok'), '');
    },
    ...ещё,
  });
  return { итог, скачано: () => скачано };
}

function тотЖеФайл(данные: Uint8Array | null): boolean {
  return данные !== null && данные.length === ФАЙЛ.length && Buffer.compare(Buffer.from(данные), Buffer.from(ФАЙЛ)) === 0;
}

describe('загрузка модели по плохой связи', () => {
  it('оборвалась на середине — докачивает с места обрыва, а не с нуля', async () => {
    const { installRoot } = стенд();
    const журнал: string[] = [];
    const { итог, скачано } = поставить(installRoot, сервер([{ оборвать: 400_000 }, 'цело'], журнал));

    await итог;
    expect(журнал).toEqual(['', 'bytes=400000-']);
    expect(тотЖеФайл(скачано())).toBe(true);
  });

  it('замершая связь ловится сроком и загрузка продолжается', async () => {
    // Мобильная связь чаще замирает, чем рвётся: байты не идут, ошибки нет.
    // Без срока полоска прогресса стояла бы вечно.
    const { installRoot } = стенд();
    const журнал: string[] = [];
    const { итог, скачано } = поставить(installRoot, сервер(['замереть', 'цело'], журнал), { stallMs: 1_000 });

    await итог;
    expect(журнал).toEqual(['', 'bytes=1000-']);
    expect(тотЖеФайл(скачано())).toBe(true);
  });

  it('сервер не услышал Range — пишет заново, а не приклеивает', async () => {
    const { installRoot } = стенд();
    const журнал: string[] = [];
    const { итог, скачано } = поставить(installRoot, сервер([{ оборвать: 300_000 }, 'без-range'], журнал));

    await итог;
    // Приклей он весь файл к трёмстам тысячам — размер вышел бы 1,5 МБ.
    expect(тотЖеФайл(скачано())).toBe(true);
  });

  it('недокачанное с прошлого раза продолжается — хоть после перезапуска', async () => {
    const { installRoot, архив } = стенд();
    writeFileSync(архив, ФАЙЛ.subarray(0, 500_000));
    const журнал: string[] = [];
    const { итог, скачано } = поставить(installRoot, сервер(['цело'], журнал));

    await итог;
    expect(журнал).toEqual(['bytes=500000-']);
    expect(тотЖеФайл(скачано())).toBe(true);
  });

  it('чужое недокачанное больше файла — начинает с нуля', async () => {
    const { installRoot, архив } = стенд();
    writeFileSync(архив, new Uint8Array(2_000_000));
    const журнал: string[] = [];
    const { итог, скачано } = поставить(installRoot, сервер(['цело'], журнал));

    await итог;
    expect(журнал[0]).toBe('bytes=2000000-');
    expect(журнал.at(-1)).toBe('');
    expect(тотЖеФайл(скачано())).toBe(true);
  });

  it('сдаётся после провалов без продвижения — и скачанное сохраняет', async () => {
    const { installRoot, архив } = стенд();
    const журнал: string[] = [];
    const { итог } = поставить(installRoot, сервер([{ оборвать: 100_000 }, { оборвать: 0 }], журнал));

    await expect(итог).rejects.toThrow(/сохранено|kept/u);
    // Одна попытка с продвижением и четыре без: на пятом провале подряд — стоп.
    expect(журнал).toHaveLength(5);
    // Скачанное лежит: следующее нажатие продолжит с него, а не с нуля.
    expect(statSync(архив).size).toBe(100_000);
  });

  it('пока загрузка продвигается, повторам нет предела', async () => {
    // Большую модель по раздаче может рвать много раз. Если каждый раз что-то
    // докачивается, бросать её было бы глупо.
    const { installRoot } = стенд();
    const журнал: string[] = [];
    const план: Ход[] = Array.from({ length: 11 }, () => ({ оборвать: 100_000 }) as Ход);
    план.push('цело');
    const { итог, скачано } = поставить(installRoot, сервер(план, журнал));

    await итог;
    expect(журнал).toHaveLength(12);
    expect(тотЖеФайл(скачано())).toBe(true);
  });

  it('отмену человека не повторяет', async () => {
    const { installRoot } = стенд();
    const журнал: string[] = [];
    const отмена = new AbortController();
    const { итог } = поставить(installRoot, сервер(['замереть'], журнал), {
      signal: отмена.signal,
      stallMs: 60_000,
    });
    setTimeout(() => отмена.abort(new Error('отменено человеком')), 30);

    await expect(итог).rejects.toThrow();
    expect(журнал).toHaveLength(1);
  });

  it('испорченный архив стирается, чтобы следующая попытка не докачивала порчу', async () => {
    const { installRoot, архив } = стенд();
    const журнал: string[] = [];
    const { итог } = поставить(installRoot, сервер(['цело'], журнал), {
      extractImpl: async () => {
        throw new Error('bzip2: испорченные данные');
      },
    });

    await expect(итог).rejects.toThrow('испорченные');
    expect(existsSync(архив)).toBe(false);
  });

  it('целая установка убирает архив за собой', async () => {
    const { installRoot, архив } = стенд();
    const { итог } = поставить(installRoot, сервер(['цело'], []));

    await итог;
    expect(existsSync(архив)).toBe(false);
  });
});
