/**
 * Видно ли окно Электрона в списке окон на маке.
 *
 * Приёмка на macos-latest сказала странное: окно приёмки поднимается по
 * фразе («переключился на „Проба приёмки Rujarvis“»), а через несколько
 * случаев `windows()` отдаёт пустой список при живом окне на экране. Одно из
 * двух утверждений ложно, и рассуждением это не решить.
 *
 * Поэтому здесь не проверка, а замер, и запускается он под Электроном — иначе
 * окна Электрона взять неоткуда. Спрашиваются все три пути по отдельности:
 *
 *   1. System Events — кто вообще считается программой переднего плана
 *      (`background only`) и сколько окон у каждого;
 *   2. CGWindowList — список окон мимо Универсального доступа;
 *   3. сам драйвер — то, чем работает Джарвис.
 *
 * И всё это несколько раз подряд: если список то есть, то нет, это видно
 * только повтором.
 *
 *   pnpm jarvis:window-check
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { app, BrowserWindow } from 'electron';

import { DarwinDriver, WINDOW_LIST_SCRIPT } from '../../jarvis/desktop/darwinDriver';

const запустить = promisify(execFile);
const ждать = (мс: number): Promise<void> => new Promise((готово) => setTimeout(готово, мс));

const ИМЯ_ОКНА = 'Проба списка окон Rujarvis';

/** Кто такие процессы System Events: передний план или фон, и сколько окон. */
const КТО_ЕСТЬ_КТО = `
set out to ""
tell application "System Events"
  repeat with p in (every process)
    set nm to "?"
    try
      set nm to name of p
    end try
    set bg to "?"
    try
      set bg to (background only of p) as text
    end try
    set cnt to "ошибка"
    try
      set cnt to (count of windows of p) as text
    end try
    if cnt is not "0" then set out to out & nm & " фон=" & bg & " окон=" & cnt & linefeed
  end repeat
end tell
return out
`;

/** Окна мимо Универсального доступа. Замер 24.09.2026: 57–231 мс. */
const CG_СПИСОК = `
  ObjC.import('CoreGraphics');
  ObjC.import('Foundation');
  const ref = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  const data = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  JSON.stringify(data.map((w) => ({
    app: w.kCGWindowOwnerName,
    pid: w.kCGWindowOwnerPID,
    title: w.kCGWindowName === undefined ? null : w.kCGWindowName,
    layer: w.kCGWindowLayer,
  })));
`;

async function osascript(args: string[]): Promise<string> {
  const { stdout } = await запустить('osascript', args, { timeout: 30_000, maxBuffer: 16 << 20 });
  return stdout;
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error(`Замер имеет смысл только на macOS, а здесь ${process.platform}.`);
    app.exit(2);
    return;
  }

  const окно = new BrowserWindow({ title: ИМЯ_ОКНА, width: 360, height: 200, show: false });
  окно.setTitle(ИМЯ_ОКНА);
  окно.show();
  await ждать(1_500);

  console.log(`\nСвоё окно: «${окно.getTitle()}», видно=${окно.isVisible()}, pid=${process.pid}\n`);

  console.log('=== 1. Кто есть кто по System Events');
  console.log((await osascript(['-e', КТО_ЕСТЬ_КТО])).trimEnd() || '(пусто)');

  console.log('\n=== 2. CGWindowList');
  const cg = JSON.parse(await osascript(['-l', 'JavaScript', '-e', CG_СПИСОК])) as {
    app: string;
    pid: number;
    title: string | null;
    layer: number;
  }[];
  for (const строка of cg.slice(0, 20)) {
    console.log(`  ${строка.app} pid=${строка.pid} слой=${строка.layer} «${строка.title ?? '(заголовок скрыт)'}»`);
  }
  console.log(`  всего ${cg.length}, своих ${cg.filter((с) => с.pid === process.pid).length}`);

  console.log('\n=== 3. Сырой ответ списка окон драйвера');
  const сырой = await osascript(['-e', WINDOW_LIST_SCRIPT]);
  console.log(`  длина ответа ${сырой.length} знаков, строк ${сырой.split('\u001e').filter((s) => s.trim()).length}`);

  console.log('\n=== 4. Драйвер, три раза подряд');
  const driver = new DarwinDriver();
  for (let заход = 1; заход <= 3; заход += 1) {
    const начало = Date.now();
    try {
      const окна = await driver.windows();
      const своё = окна.find((о) => о.title === ИМЯ_ОКНА);
      console.log(
        `  заход ${заход}: окон ${окна.length} за ${Date.now() - начало} мс, своё ${своё ? 'НАЙДЕНО' : 'не найдено'}` +
          (окна.length ? ` — ${окна.map((о) => `${о.app}/«${о.title}»`).join(', ')}` : ''),
      );
    } catch (error) {
      console.log(`  заход ${заход}: ОТКАЗ — ${error instanceof Error ? error.message : String(error)}`);
    }
    await ждать(600);
  }

  console.log('\n=== 5. Поднять своё окно по заголовку');
  try {
    const впереди = await driver.focus(ИМЯ_ОКНА);
    console.log(`  вышло: впереди «${впереди.title}»`);
  } catch (error) {
    console.log(`  ОТКАЗ: ${error instanceof Error ? error.message : String(error)}`);
  }

  const итог = (await driver.windows().catch(() => [])).some((о) => о.title === ИМЯ_ОКНА);
  console.log(`\nИтог: окно Электрона ${итог ? 'видно' : 'НЕ ВИДНО'} драйверу.`);
  if (!окно.isDestroyed()) окно.destroy();
  app.exit(итог ? 0 : 1);
}

// Своё окно закрывается в конце, и Электрон на этом гасит приложение — замер
// должен пережить это сам.
app.on('window-all-closed', () => {});

void app.whenReady().then(main);
