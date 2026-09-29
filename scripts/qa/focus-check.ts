/**
 * «Переключись на …» — тем же драйвером, что у голосовых прямых команд.
 *
 * Живой журнал владельца 27.09.2026: «переключись на edge» — 511 и 671 мс
 * выполнения, при списке окон в 10 мс. Из них 250 мс драйвер спал всегда,
 * даже когда окно вышло вперёд сразу. И `Raise` звал `ShowWindow(h, 9)` —
 * SW_RESTORE — для любого окна: по документации Windows он возвращает к
 * обычному размеру и РАЗВЁРНУТОЕ окно, не только свёрнутое.
 *
 * Здесь — два своих окна (одно развёрнуто), переключения между ними и три
 * вопроса: развёрнутое осталось развёрнутым; поднятие быстрее 250 мс
 * (медиана); поднятое окно правда впереди.
 *
 * Выводит окна вперёд — поэтому гоняется в CI, а не на машине владельца.
 * Только Windows: SW_RESTORE и сон — в Windows-драйвере, мак поднимает окно
 * через AXRaise и размер не трогает; там выходит с кодом 2. Гасит только
 * свои окна, по pid, записанному при запуске.
 *
 * Три ответа: прошло, не прошло, нечем мерить.
 */
import { spawn } from 'node:child_process';

import { DesktopDriver, type DesktopWindow } from '../../jarvis/desktop/driver';

type Итог = { вид: 'прошло' | 'не прошло' | 'нечем мерить'; что: string };

const подождать = (мс: number): Promise<void> => new Promise((готово) => setTimeout(готово, мс));

// Заголовки латиницей: кириллица в командной строке PowerShell — лотерея.
const РАЗВЁРНУТОЕ = 'Jarvis focus probe ALPHA';
const ОБЫЧНОЕ = 'Jarvis focus probe BRAVO';

const ФОРМА = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$f = New-Object System.Windows.Forms.Form',
  '$f.Text = $env:PROBE_TITLE',
  "$f.StartPosition = 'Manual'",
  '$f.Location = New-Object System.Drawing.Point(120, 120)',
  '$f.Size = New-Object System.Drawing.Size(420, 300)',
  "if ($env:PROBE_MAX -eq '1') { $f.WindowState = 'Maximized' }",
  '[System.Windows.Forms.Application]::Run($f)',
].join('; ');

const свои: number[] = [];

const начало = Date.now();

function открыть(заголовок: string, развернуть: boolean): void {
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ФОРМА], {
    env: { ...process.env, PROBE_TITLE: заголовок, PROBE_MAX: развернуть ? '1' : '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (child.pid) свои.push(child.pid);
  // Окно пробы, пропавшее посреди проверки, — это улика, а не шум: пишем,
  // когда и с чем вышел его процесс.
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (текст: string) => console.log(`  [${заголовок}] stderr: ${текст.trim().slice(0, 300)}`));
  child.on('exit', (код, сигнал) =>
    console.log(`  [${заголовок}] процесс вышел через ${Date.now() - начало} мс: код ${код}, сигнал ${сигнал}`),
  );
}

function найти(окна: DesktopWindow[], заголовок: string): DesktopWindow | undefined {
  return окна.find((о) => о.title === заголовок);
}

async function main(): Promise<void> {
  console.log('');
  console.log('«Переключись на …»: размер окна, время, что впереди');
  if (process.platform !== 'win32') {
    console.log('НЕЧЕМ МЕРИТЬ: проверка Windows-драйвера; мак поднимает окно через AXRaise');
    process.exit(2);
  }

  const драйвер = new DesktopDriver();
  const итоги: Array<{ имя: string; итог: Итог }> = [];
  const шаг = async (имя: string, делать: () => Promise<Итог>): Promise<void> => {
    console.log(`  шаг «${имя}» — с ${Date.now() - начало} мс`);
    try {
      итоги.push({ имя, итог: await делать() });
    } catch (беда) {
      итоги.push({ имя, итог: { вид: 'не прошло', что: (беда instanceof Error ? беда.message : String(беда)).slice(0, 240) } });
    }
  };

  try {
    await драйвер.warm();
    открыть(РАЗВЁРНУТОЕ, true);
    открыть(ОБЫЧНОЕ, false);

    let до: DesktopWindow | undefined;
    for (let i = 0; i < 50 && !(до && найти(await драйвер.windows(), ОБЫЧНОЕ)); i += 1) {
      до = найти(await драйвер.windows(), РАЗВЁРНУТОЕ);
      await подождать(400);
    }
    const обычное = найти(await драйвер.windows(), ОБЫЧНОЕ);
    if (!до || !обычное) {
      итоги.push({ имя: 'окна пробы', итог: { вид: 'нечем мерить', что: 'не появились за 20 с' } });
    } else {
      console.log(`  развёрнутое до переключений: ${до.width}x${до.height} в (${до.x}, ${до.y})`);

      await шаг('развёрнутое окно после «переключись» осталось развёрнутым', async () => {
        if (до.width <= 420) return { вид: 'нечем мерить', что: `окно не развернулось при запуске: ${до.width}x${до.height}` };
        await драйвер.focus(ОБЫЧНОЕ);
        await драйвер.focus(РАЗВЁРНУТОЕ);
        const после = найти(await драйвер.windows(), РАЗВЁРНУТОЕ);
        if (!после) return { вид: 'не прошло', что: 'окно пропало из списка' };
        const было = `${до.width}x${до.height}`;
        const стало = `${после.width}x${после.height}`;
        return после.width === до.width && после.height === до.height
          ? { вид: 'прошло', что: `${было} → ${стало}` }
          : { вид: 'не прошло', что: `${было} → ${стало}: SW_RESTORE вернул развёрнутое к обычному размеру` };
      });

      await шаг('поднятие окна быстрее 250 мс (медиана из шести)', async () => {
        const замеры: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          const куда = i % 2 === 0 ? ОБЫЧНОЕ : РАЗВЁРНУТОЕ;
          const начало = performance.now();
          await драйвер.focus(куда);
          замеры.push(Math.round(performance.now() - начало));
        }
        const медиана = [...замеры].sort((a, b) => a - b)[Math.floor(замеры.length / 2)] ?? 0;
        const что = `медиана ${медиана} мс; все: ${замеры.join(', ')}`;
        return медиана < 250 ? { вид: 'прошло', что } : { вид: 'не прошло', что };
      });

      await шаг('поднятое окно правда впереди', async () => {
        await драйвер.focus(ОБЫЧНОЕ);
        const окно = найти(await драйвер.windows(), ОБЫЧНОЕ);
        return окно?.focused
          ? { вид: 'прошло', что: ОБЫЧНОЕ }
          : { вид: 'не прошло', что: 'драйвер сказал «поднял», а впереди другое' };
      });

      // Живой журнал 29.09.2026: агент открыл поиск Windows, и «переключись на
      // Edge» дважды кончилось «впереди «Поиск»».
      await шаг('«переключись» при открытом меню «Пуск»', async () => {
        await драйвер.focus(ОБЫЧНОЕ);
        await драйвер.key('win');
        await подождать(1200);
        const впереди = (await драйвер.windows()).find((о) => о.focused);
        if (!впереди || впереди.title.trim() === ОБЫЧНОЕ) {
          return { вид: 'нечем мерить', что: `меню «Пуск» не вышло вперёд: впереди «${впереди?.title ?? 'ничего'}»` };
        }
        await драйвер.focus(РАЗВЁРНУТОЕ);
        const окно = найти(await драйвер.windows(), РАЗВЁРНУТОЕ);
        return окно?.focused
          ? { вид: 'прошло', что: `впереди было «${впереди.title}», поднялось ${РАЗВЁРНУТОЕ}` }
          : { вид: 'не прошло', что: `впереди осталось не то, а было «${впереди.title}»` };
      });

      // «Сверни Edge» — живой журнал 28.09.2026: ушло агенту на 44 с.
      await шаг('«сверни <название>» сворачивает названное окно, «переключись» его возвращает', async () => {
        await драйвер.focus(ОБЫЧНОЕ);
        const свёрнуто = await драйвер.minimize(ОБЫЧНОЕ);
        const после = найти(await драйвер.windows(), ОБЫЧНОЕ);
        if (!после) return { вид: 'не прошло', что: 'свёрнутое окно пропало из списка окон' };
        if (!после.minimized) return { вид: 'не прошло', что: `драйвер сказал «свернул ${свёрнуто.title}», а окно не свёрнуто` };
        await драйвер.focus(ОБЫЧНОЕ);
        const вернулось = найти(await драйвер.windows(), ОБЫЧНОЕ);
        return вернулось && !вернулось.minimized
          ? { вид: 'прошло', что: `свернул «${свёрнуто.title}» и вернул` }
          : { вид: 'не прошло', что: 'после «переключись» окно осталось свёрнутым' };
      });
    }
  } finally {
    for (const pid of свои) {
      try {
        process.kill(pid);
      } catch {
        // Уже вышло — и хорошо.
      }
    }
    драйвер.dispose();
  }

  let неПрошло = 0;
  let нечем = 0;
  for (const { имя: название, итог } of итоги) {
    if (итог.вид === 'не прошло') неПрошло++;
    if (итог.вид === 'нечем мерить') нечем++;
    const метка = итог.вид === 'прошло' ? 'прошло      ' : итог.вид === 'не прошло' ? 'НЕ ПРОШЛО   ' : 'нечем мерить';
    console.log(`  ${метка} ${название} — ${итог.что}`);
  }
  console.log(`Всего ${итоги.length}: не прошло ${неПрошло}, нечем мерить ${нечем}`);
  process.exitCode = неПрошло > 0 ? 1 : нечем > 0 ? 2 : 0;
}

void main();
