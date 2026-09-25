import { describe, expect, it, vi } from 'vitest';

import { wheelTravel } from './wheelTravel';

/**
 * Поддельная страница.
 *
 * Кадр — просто строка: прибор про пиксели ничего не знает, сравнение приходит
 * рычагом. Поэтому проверять его можно без браузера и без единого пикселя,
 * ровно как задумано в Aegis.
 */
function fakePage(frames: Array<string | null>) {
  let at = 0;
  const pushes: Array<{ delta: number; pushes: number }> = [];
  return {
    pushes,
    tools: {
      push: async (options: { delta: number; pushes: number }) => {
        pushes.push(options);
      },
      shoot: async () => {
        const frame = frames[Math.min(at, frames.length - 1)] ?? null;
        at += 1;
        return frame;
      },
      same: (left: string, right: string) => left === right,
    },
  };
}

describe('wheelTravel', () => {
  it('едет, пока картинка меняется', async () => {
    const page = fakePage(['один', 'два', 'три', 'три']);
    const travel = await wheelTravel(page.tools);

    expect(travel?.shots).toEqual(['один', 'два', 'три']);
    expect(travel?.arrived).toBe(true);
  });

  it('различает «приехали» и «упёрлись в потолок»', async () => {
    // Это разные новости: во втором случае конца страницы мы не видели, и
    // молчать об этом нельзя.
    const endless = fakePage(
      Array.from({ length: 20 }, (_, index) => `кадр ${index}`),
    );
    const travel = await wheelTravel({ ...endless.tools, manyScreens: 4 });

    expect(travel?.shots).toHaveLength(4);
    expect(travel?.arrived).toBe(false);
  });

  it('на неподвижной странице отвечает «ехать некуда»', async () => {
    // Страница в один экран — это один кадр, а не проезд. Возвращать `null`
    // важнее, чем вернуть список из одного кадра: вызывающий тогда не станет
    // склеивать полосу из ничего.
    const still = fakePage(['один', 'один']);

    expect(await wheelTravel(still.tools)).toBeNull();
  });

  it('не отгоняет назад то, что не уехало', async () => {
    // Возврат — почти три секунды. В Aegis он стоял безусловно, и каждая
    // одноэкранная страница платила их за откат, которого не было.
    const rewind = vi.fn(async () => {});
    const still = fakePage(['один', 'один']);

    await wheelTravel({ ...still.tools, rewind });

    expect(rewind).not.toHaveBeenCalled();
  });

  it('отгоняет назад то, что уехало', async () => {
    const rewind = vi.fn(async () => {});
    const page = fakePage(['один', 'два', 'два']);

    await wheelTravel({ ...page.tools, rewind });

    expect(rewind).toHaveBeenCalledOnce();
  });

  it('переживает неудачный откат', async () => {
    // Снимки уже собраны — падение отката их не отменяет.
    const page = fakePage(['один', 'два', 'два']);
    const travel = await wheelTravel({
      ...page.tools,
      rewind: async () => {
        throw new Error('страница ушла');
      },
    });

    expect(travel?.shots).toHaveLength(2);
  });

  it('молчит, когда снять не удалось вовсе', async () => {
    const dead = fakePage([null]);

    expect(await wheelTravel(dead.tools)).toBeNull();
  });

  it('толкает не одним большим толчком, а несколькими', async () => {
    // Страницы с инерцией отвечают на один большой толчок рывком и промахом.
    const page = fakePage(['один', 'два', 'два']);
    await wheelTravel(page.tools);

    expect(page.pushes[0]?.pushes).toBeGreaterThan(1);
    expect(page.pushes[0]?.delta).toBeGreaterThan(0);
  });
});
