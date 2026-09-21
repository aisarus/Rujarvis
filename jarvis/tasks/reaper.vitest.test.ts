import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { forgetChild, reapAll, trackChild, trackedChildren } from './reaper';

/**
 * Живой процесс, который сам не кончится: цель для проверки.
 *
 * Через `node`, а не `cmd /c pause`: со `stdio: 'ignore'` у `pause` вход — это
 * сразу конец файла, и она умирает раньше, чем до неё доберутся. Первый заход
 * так и вышел: taskkill честно отвечал «процесса нет», и виноват был тест.
 */
function долгоживущий(): { pid: number; жив: () => boolean } {
  const ребёнок = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  let живой = true;
  ребёнок.on('exit', () => { живой = false; });
  return { pid: ребёнок.pid!, жив: () => живой };
}

afterEach(async () => { await reapAll(); });

describe('reaper', () => {
  it('убивает настоящий процесс, а не отчитывается', async () => {
    // Весь смысл прибора в том, что он работает, когда вежливая просьба не
    // доходит. Проверять его на выдуманном объекте бессмысленно.
    const жертва = долгоживущий();
    trackChild(жертва.pid);

    const итог = await reapAll();

    expect(итог.killed).toContain(жертва.pid);
    await new Promise((готово) => setTimeout(готово, 300));
    expect(жертва.жив()).toBe(false);
  });

  it('после уборки реестр пуст', async () => {
    trackChild(долгоживущий().pid);
    await reapAll();
    expect(trackedChildren()).toEqual([]);
  });

  it('забытый процесс не трогается', async () => {
    const выживший = долгоживущий();
    trackChild(выживший.pid);
    forgetChild(выживший.pid);

    const итог = await reapAll();

    expect(итог.killed).not.toContain(выживший.pid);
    expect(выживший.жив()).toBe(true);
    // Убираем сами: он не под присмотром, но и висеть ему незачем.
    trackChild(выживший.pid);
  });

  it('не берёт в реестр то, чего не бывает', () => {
    trackChild(undefined);
    trackChild(0);
    trackChild(-1);
    trackChild(1.5);
    expect(trackedChildren()).toEqual([]);
  });

  it('уборка на пустом реестре не падает', async () => {
    await expect(reapAll()).resolves.toEqual({ killed: [], failed: [] });
  });

  it('один мёртвый не мешает убить живого', async () => {
    // taskkill с несколькими /PID падает целиком, если один уже мёртв. Поэтому
    // цели бьются по одной — иначе выжившие остались бы жить.
    const мёртвый = долгоживущий();
    await new Promise<void>((готово) => {
      const т = spawn('taskkill', ['/F', '/PID', String(мёртвый.pid)], { windowsHide: true, stdio: 'ignore' });
      т.on('exit', () => готово());
      т.on('error', () => готово());
    });
    const живой = долгоживущий();

    trackChild(мёртвый.pid);
    trackChild(живой.pid);
    const итог = await reapAll();

    expect(итог.killed).toContain(живой.pid);
    await new Promise((готово) => setTimeout(готово, 300));
    expect(живой.жив()).toBe(false);
  });
});
