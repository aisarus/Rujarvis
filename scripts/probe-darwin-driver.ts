/**
 * Драйвер рабочего стола macOS — на настоящем маке.
 *
 * Локального мака нет ни у кого из работающих над этим кодом, поэтому
 * единственная честная проверка — прогон на `macos-latest` в CI
 * (`.github/workflows/check-darwin-driver.yml`). Юнит-тесты проверяют разбор
 * и сборку скриптов; здесь проверяется то, что от них не зависит: даёт ли
 * macOS управлять окнами и делает ли драйвер то, о чём отчитывается.
 *
 * Главное здесь — весь путь на живом окне TextEdit: найти, свернуть, увидеть
 * свёрнутым в списке, развернуть, поднять. На Windows ломалась именно
 * середина: свёрнутое окно пропадало из списка, и «переключись на Edge» не
 * находило Edge ровно тогда, когда это нужнее всего.
 *
 * ## Почему TextEdit тут ни о чём не спрашивают
 *
 * Первый прогон (24.09.2026) умер на `tell application "TextEdit" to ...`:
 * «AppleEvent timed out (-1712)» через две минуты ожидания. Собственная
 * скриптовая надстройка программы отвечает, когда сама сочтёт нужным.
 * Поэтому программа запускается через `open`, а её содержимое читается через
 * System Events — тот же путь, которым ходит и сам драйвер, и он измерен.
 *
 *   pnpm jarvis:mac-check
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { DarwinDriver, type DarwinWindow } from '../jarvis/desktop/darwinDriver';

const запустить = promisify(execFile);

if (process.platform !== 'darwin') {
  console.error(`Эта проверка имеет смысл только на macOS, а здесь ${process.platform}.`);
  process.exit(2);
}

const driver = new DarwinDriver();
const провалы: string[] = [];
const рабочаяПапка = path.join(os.tmpdir(), 'rujarvis-mac-check');

/** Один шаг: что проверяли, сколько это стоило и что вышло. */
async function шаг<T>(имя: string, что: () => Promise<T>, обязателен = true): Promise<T | null> {
  const начало = Date.now();
  try {
    const итог = await что();
    console.log(`  вышло  ${имя} — ${Date.now() - начало} мс`);
    return итог;
  } catch (error) {
    const текст = error instanceof Error ? error.message : String(error);
    console.log(`  ОТКАЗ  ${имя} — ${Date.now() - начало} мс: ${текст}`);
    if (обязателен) провалы.push(`${имя}: ${текст}`);
    return null;
  }
}

function проверить(условие: boolean, имя: string): void {
  if (условие) {
    console.log(`  вышло  ${имя}`);
    return;
  }
  console.log(`  ОТКАЗ  ${имя}`);
  провалы.push(имя);
}

const подождать = (мс: number): Promise<void> => new Promise((готово) => setTimeout(готово, мс));

/** Размер PNG из его же заголовка: IHDR лежит с 16-го байта. */
function размерPng(файл: string): { width: number; height: number } {
  const данные = readFileSync(файл);
  return { width: данные.readUInt32BE(16), height: данные.readUInt32BE(20) };
}

/**
 * Что написано в окне TextEdit — глазами дерева доступности.
 *
 * Спрашивать саму программу нельзя (см. шапку), а System Events отвечает за
 * сотни миллисекунд и тем же путём, что и драйвер.
 */
const ТЕКСТ_ОКНА = `
tell application "System Events"
  set found to ""
  tell process "TextEdit"
    repeat with e in (entire contents of window 1)
      try
        if role of e is "AXTextArea" then
          set found to value of e
          exit repeat
        end if
      end try
    end repeat
  end tell
  if found is missing value then set found to ""
  return found
end tell
`;

async function текстОкна(): Promise<string> {
  const { stdout } = await запустить('osascript', ['-e', ТЕКСТ_ОКНА], { timeout: 20_000 });
  return stdout.replace(/\n$/u, '');
}

console.log('=== 1. Разрешение и экран');
const экран = await шаг('границы экрана', () => driver.screen());
if (экран) console.log(`         экран ${экран.width}×${экран.height}, начало (${экран.x}, ${экран.y})`);

console.log('\n=== 2. Мышь');
await шаг('перенести курсор в (120, 140)', () => driver.move(120, 140));
const где = await шаг('где курсор', () => driver.cursor());
if (где) {
  console.log(`         курсор в (${где.x}, ${где.y})`);
  проверить(Math.abs(где.x - 120) <= 1 && Math.abs(где.y - 140) <= 1, 'курсор оказался там, куда его перенесли');
}
await шаг('клик', () => driver.click({ x: 120, y: 140 }), false);
await шаг('колесо', () => driver.scroll(-3), false);

console.log('\n=== 3. Снимок экрана');
mkdirSync(рабочаяПапка, { recursive: true });
const файлСнимка = path.join(рабочаяПапка, 'shot.png');
const снимок = await шаг('снимок всего экрана', () => driver.screenshot(файлСнимка), false);
if (снимок) {
  const размер = размерPng(файлСнимка);
  console.log(`         png ${размер.width}×${размер.height}, драйвер сказал ${снимок.width}×${снимок.height}`);
  // Совпало — экран обычный; вдвое больше — Retina, и координаты клика живут
  // не в пикселях снимка. Пишем число, а не догадку.
  console.log(
    `         отношение пикселей снимка к координатам: ${(размер.width / Math.max(снимок.width, 1)).toFixed(2)}`,
  );
}

console.log('\n=== 4. Живое окно TextEdit: найти, свернуть, увидеть, развернуть, поднять');
const файлДокумента = path.join(рабочаяПапка, 'rujarvis-check.txt');
writeFileSync(файлДокумента, '', 'utf8');
await шаг('запустить TextEdit', () => запустить('open', ['-a', 'TextEdit', файлДокумента], { timeout: 30_000 }));

/** Дождаться окна, а не поверить в него: программа поднимается не мгновенно. */
async function дождатьсяОкна(): Promise<DarwinWindow[]> {
  let окна: DarwinWindow[] = [];
  for (let попытка = 0; попытка < 12; попытка += 1) {
    окна = await driver.windows();
    if (окна.some((item) => item.app === 'TextEdit')) return окна;
    await подождать(1_000);
  }
  return окна;
}

const началоСписка = Date.now();
const окна = await дождатьсяОкна();
console.log(`  вышло  список окон — ${Date.now() - началоСписка} мс на последнюю попытку, окон ${окна.length}`);
for (const item of окна.slice(0, 8)) {
  console.log(
    `         ${item.focused ? '→' : ' '} ${item.app} «${item.title}» ${item.width}×${item.height}` +
      `${item.minimized ? ' (свёрнуто)' : ''}`,
  );
}
проверить(
  окна.some((item) => item.app === 'TextEdit'),
  'TextEdit есть в списке окон',
);
const pidTextEdit = окна.find((item) => item.app === 'TextEdit')?.pid;

const одинСписок = Date.now();
await driver.windows();
console.log(`         один список окон стоит ${Date.now() - одинСписок} мс`);

await шаг('поднять TextEdit', () => driver.focus('TextEdit'));
// «Сверни окно» приходит из таблицы команд как win+down; на маке это Cmd+M.
await шаг('свернуть окно (win+down → Cmd+M)', () => driver.key('win+down'));
await подождать(1_500);

const послеСворачивания = (await шаг('список окон при свёрнутом', () => driver.windows())) ?? [];
const свёрнутое = послеСворачивания.find((item) => item.app === 'TextEdit');
console.log(
  `         TextEdit: ${
    свёрнутое
      ? `«${свёрнутое.title}» ${свёрнутое.width}×${свёрнутое.height}, свёрнуто=${свёрнутое.minimized}`
      : 'нет в списке'
  }`,
);
проверить(свёрнутое !== undefined, 'свёрнутое окно ОСТАЛОСЬ в списке');
проверить(свёрнутое?.minimized === true, 'свёрнутое окно помечено свёрнутым');
проверить(Boolean(свёрнутое?.title), 'у свёрнутого окна читается заголовок');

const поднято = await шаг('развернуть и поднять свёрнутое окно', () => driver.focus('TextEdit'));
if (поднято) console.log(`         впереди «${поднято.title}»`);
await подождать(1_000);
const послеРазворота = (await шаг('список окон после разворота', () => driver.windows())) ?? [];
const развёрнутое = послеРазворота.find((item) => item.app === 'TextEdit');
проверить(развёрнутое?.minimized === false, 'окно развернулось обратно');
проверить(развёрнутое?.focused === true, 'окно действительно впереди');

console.log('\n=== 5. Печать и сочетания клавиш');
await шаг('напечатать кириллицу', () => driver.type('Привет, мир'));
await подождать(1_000);
const напечатано = (await шаг('прочитать текст окна', () => текстОкна())) ?? '';
console.log(`         в окне: «${напечатано}»`);
проверить(напечатано.includes('Привет, мир'), 'кириллица дошла до окна буква в букву');

// Выделить всё (ctrl+a из таблицы команд) и напечатать поверх: если Cmd+A не
// сработал, прежний текст останется на месте — это и будет видно.
await шаг('выделить всё (ctrl+a → Cmd+A)', () => driver.key('ctrl+a'));
await шаг('напечатать поверх выделения', () => driver.type('Замена'));
await подождать(1_000);
const послеЗамены = (await шаг('прочитать текст окна', () => текстОкна())) ?? '';
console.log(`         в окне: «${послеЗамены}»`);
проверить(послеЗамены === 'Замена', 'ctrl+a на маке выделил всё — текст заменён целиком');

console.log('\n=== 6. Элементы окна');
const элементы = await шаг('дерево доступности активного окна', () => driver.elements(), false);
if (элементы) {
  console.log(`         окно «${элементы.title}», элементов ${элементы.elements.length}`);
  for (const item of элементы.elements.slice(0, 8)) {
    console.log(`         ${item.type} «${item.name || item.id}» в (${item.x}, ${item.y})`);
  }
}

console.log('\n=== 7. Отказ найти окно');
try {
  await driver.focus('окна-с-таким-именем-нет-12345');
  проверить(false, 'несуществующее окно не должно находиться');
} catch (error) {
  const текст = error instanceof Error ? error.message : String(error);
  console.log(`         ${текст}`);
  проверить(текст.includes('На экране:'), 'отказ называет, что есть на экране');
}

// Гасим по своему pid, а не по маске: уборка по имени однажды снесла лишнее.
if (pidTextEdit) {
  try {
    process.kill(pidTextEdit);
  } catch {
    // Уже закрылся — и хорошо.
  }
}
rmSync(рабочаяПапка, { recursive: true, force: true });

console.log('\n=== Итог');
if (провалы.length === 0) {
  console.log('Всё, что проверялось, вышло.');
} else {
  console.log(`Провалов ${провалы.length}:`);
  for (const провал of провалы) console.log(`  — ${провал}`);
  process.exitCode = 1;
}
