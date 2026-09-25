/**
 * Предел считает молчание, а не работу.
 *
 * Был потолок по общему времени, и он убивал именно долгую работу: прогон
 * «сделать 3D-модель по 2D-видео» оборвался ровно на 1200.1 секунде посреди
 * правки файла, при живом потоке событий. Человек услышал «превысил
 * отведённое время» и не получил ничего.
 *
 * Проверяется настоящим процессом, а не подделкой: теряться тут может именно
 * на стыке потока вывода и таймера.
 */

import { describe, expect, it } from 'vitest';

import { CliProcess } from './process';

/** Node, который шумит заданное число раз с заданным промежутком. */
function шумящий(разів: number, черезМс: number): string[] {
  return [
    '-e',
    `let n=0;const t=setInterval(()=>{console.log('{"тик":'+n+'}');if(++n>=${разів})` +
      `{clearInterval(t);setTimeout(()=>process.exit(0),50);}},${черезМс});`,
  ];
}

describe('долгая работа не считается зависанием', () => {
  it('процесс, который шумит, переживает предел молчания', async () => {
    const строки: string[] = [];
    const процесс = new CliProcess({
      command: process.execPath,
      // Восемь тиков по 80 мс — 640 мс работы при пределе молчания в 300.
      args: шумящий(8, 80),
      idleTimeoutMs: 300,
      onStdoutLine: (line) => { строки.push(line); },
    });

    const итог = await процесс.wait();
    expect(итог.timedOut).toBe(false);
    expect(строки.length).toBeGreaterThanOrEqual(8);
  }, 20_000);

  it('молчащий процесс обрывается', async () => {
    const процесс = new CliProcess({
      command: process.execPath,
      // Один тик, потом молчание на пять секунд.
      args: ['-e', 'console.log("{}");setTimeout(()=>process.exit(0),5000);'],
      idleTimeoutMs: 300,
      onStdoutLine: () => {},
    });

    const итог = await процесс.wait();
    expect(итог.timedOut).toBe(true);
  }, 20_000);

  // Потолок остаётся: от зацикливания, которое исправно шумит, молчание не
  // спасает, и что-то обязано остановить его.
  it('потолок по общему времени всё равно срабатывает', async () => {
    const процесс = new CliProcess({
      command: process.execPath,
      args: шумящий(1000, 50),
      timeoutMs: 400,
      idleTimeoutMs: 10_000,
      onStdoutLine: () => {},
    });

    const итог = await процесс.wait();
    expect(итог.timedOut).toBe(true);
  }, 20_000);
});
