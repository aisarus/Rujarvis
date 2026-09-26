/**
 * Safari: браузер человека, а не наш.
 *
 * ## Почему отдельно от `browser.ts`
 *
 * Вкладками Джарвис водит через Playwright, а тот ведёт Chromium — Edge,
 * Chrome или свою сборку. Safari так не взять: это WebKit, и своего профиля
 * Playwright в нём не поднимет. А на маке у многих только он.
 *
 * Разница не только техническая, и вторая важнее. Playwright поднимает СВОЙ
 * профиль: вкладки открываются в чистом браузере, где человек никуда не
 * вошёл. «Включи сериал» в таком окне упирается в форму входа. Safari — тот
 * самый браузер, в котором человек уже сидит: его вкладки, его входы, его
 * подписки.
 *
 * ## Чем водим
 *
 * Навигация и вкладки — AppleScript: Safari умеет `open location`, знает свои
 * окна и вкладки и отдаёт их имена и адреса. Нажатия и ввод — тем же
 * драйвером рабочего стола, что и всё остальное на маке: Safari, в отличие от
 * Chromium, держит настоящее дерево доступности и отдаёт его без просьб.
 *
 * ## Чего Safari не даёт без спроса
 *
 * `do JavaScript` в нём выключен по умолчанию и включается человеком в
 * «Разработка → Разрешить JavaScript из Apple Events». Поэтому текст страницы
 * читается сначала так, а при отказе — через дерево доступности, которое
 * разрешения не требует. Врать про причину нельзя: «страница пустая» и
 * «Safari не пустил» — разные беды, и чинят их по-разному.
 *
 * Имена переменных в AppleScript — только латиница: кириллица в них даёт
 * «syntax error: Expected expression but found unknown token». Русские строки
 * в кавычках живут нормально.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { appleScriptArgs } from './darwinDriver';
import { readShowWork } from './showWork';

const запустить = promisify(execFile);

/** Как обратиться к Safari. `null` — эта машина не мак, и говорить не о чем. */
export function safariДоступен(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

/** Строку в кавычки для AppleScript. */
export function вКавычки(текст: string): string {
  const БС = String.fromCharCode(92);
  return `"${текст.split(БС).join(BSx2()).split('"').join(`${БС}"`)}"`;
}

function BSx2(): string {
  const БС = String.fromCharCode(92);
  return БС + БС;
}

/** Открыть адрес новой вкладкой в текущем окне и вывести её вперёд. */
export function открытьВкладкуScript(url: string, вперёд = true): string {
  return `
tell application "Safari"
  ${вперёд ? 'activate' : '-- в фоне: человек просил не лезть на экран'}
  if (count of windows) is 0 then
    make new document with properties {URL:${вКавычки(url)}}
  else
    tell window 1
      set newTab to make new tab with properties {URL:${вКавычки(url)}}
      set current tab to newTab
    end tell
  end if
  delay 0.4
  return (name of current tab of window 1) & "${РАЗДЕЛИТЕЛЬ}" & (URL of current tab of window 1)
end tell
`;
}

/** Перейти по адресу в ТЕКУЩЕЙ вкладке, не плодя новых. */
export function перейтиScript(url: string, вперёд = true): string {
  return `
tell application "Safari"
  ${вперёд ? 'activate' : '-- в фоне: человек просил не лезть на экран'}
  if (count of windows) is 0 then
    make new document with properties {URL:${вКавычки(url)}}
  else
    set URL of current tab of window 1 to ${вКавычки(url)}
  end if
  delay 0.4
  return (name of current tab of window 1) & "${РАЗДЕЛИТЕЛЬ}" & (URL of current tab of window 1)
end tell
`;
}

/**
 * Разделитель полей в ответе.
 *
 * Управляющий символ, а не запятая: заголовки страниц полны и запятых, и
 * кавычек, и разбор по ним рассыпается на первом же сериале с двоеточием в
 * названии. Тот же приём, что в `darwinDriver.ts`.
 */
export const РАЗДЕЛИТЕЛЬ = String.fromCharCode(31);
export const РАЗДЕЛИТЕЛЬ_СТРОК = String.fromCharCode(30);

/** Все вкладки всех окон: заголовок, адрес и та ли это, что открыта сейчас. */
export const ВКЛАДКИ_SCRIPT = `
set fieldSep to character id 31
set rowSep to character id 30
set out to ""
tell application "Safari"
  repeat with w in windows
    set activeTab to ""
    try
      set activeTab to name of current tab of w
    end try
    repeat with t in tabs of w
      set isActive to "0"
      if (name of t) is activeTab then set isActive to "1"
      set out to out & (name of t) & fieldSep & (URL of t) & fieldSep & isActive & rowSep
    end repeat
  end repeat
end tell
return out
`;

export interface SafariВкладка {
  title: string;
  url: string;
  active: boolean;
}

export function разобратьВкладки(вывод: string): SafariВкладка[] {
  return вывод
    .split(РАЗДЕЛИТЕЛЬ_СТРОК)
    .map((строка) => строка.trim())
    .filter(Boolean)
    .map((строка) => {
      const [title = '', url = '', active = '0'] = строка.split(РАЗДЕЛИТЕЛЬ);
      return { title, url, active: active === '1' };
    });
}

export function разобратьПереход(вывод: string): { title: string; url: string } {
  const [title = '', url = ''] = вывод.trim().split(РАЗДЕЛИТЕЛЬ);
  return { title, url };
}

/**
 * Текст страницы через `do JavaScript`.
 *
 * Работает только если человек включил «Разрешить JavaScript из Apple
 * Events». Отказ здесь — не пустая страница, и различать это обязательно.
 */
export function текстСтраницыScript(предел: number): string {
  return `
tell application "Safari"
  set pageText to do JavaScript "document.body ? document.body.innerText.slice(0, ${предел}) : ''" in current tab of window 1
  return pageText
end tell
`;
}

/** Похоже ли это на «Safari не пустил», а не на «страница пустая». */
export function javaScriptЗапрещён(беда: unknown): boolean {
  const текст = беда instanceof Error ? беда.message : String(беда);
  return (
    текст.includes('Apple Events') ||
    текст.includes('not allowed') ||
    текст.includes('-1743') ||
    текст.includes('JavaScript') ||
    текст.includes('errAEEventNotPermitted')
  );
}

/** Что сказать человеку, когда Safari не пустил скрипт к странице. */
export const КАК_РАЗРЕШИТЬ_JS =
  'Safari не пускает к тексту страницы. Включите один раз: Safari → Настройки → ' +
  'Дополнения → «Показывать меню "Разработка"», затем Разработка → ' +
  '«Разрешить JavaScript из Apple Events».';

/**
 * Живая часть: тот же вид, что у `browser.ts`, но через Safari.
 *
 * Названия и порядок полей совпадают нарочно — наверху, в инструментах,
 * которые читает модель, различия быть не должно: она не обязана знать, чем
 * именно водят вкладки на этой машине.
 */


/** Сколько ждать ответа от Safari. Он бывает занят своим окном входа. */
const ОТВЕТ_МС = 20_000;

async function осаскрипт(скрипт: string): Promise<string> {
  try {
    const { stdout } = await запустить('osascript', appleScriptArgs(скрипт), {
      timeout: ОТВЕТ_МС,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (беда) {
    // Причина — в stderr, а не в сообщении.
    //
    // `execFile` кладёт в message саму команду, и для AppleScript это
    // пятнадцать строк скрипта без единого слова о том, что не понравилось.
    // Настоящий ответ osascript — «Not authorized to send Apple Events»,
    // «Safari got an error: …» — лежит в stderr, и без него отладка сводится
    // к гаданию. Поймано первым же живым прогоном Safari 26.09.2026: замер
    // упал, напечатал весь скрипт и ни слова о причине.
    const свод = беда as { stderr?: string; code?: unknown; signal?: unknown; killed?: boolean };
    const причина = свод.stderr?.trim();
    if (причина) throw new Error(причина);
    // Пустой stderr — не «без причины».
    //
    // Так выглядит убитый по тайм-ауту osascript: Safari не ответил вовсе.
    // Первый прогон на раннере GitHub дал именно это, и по сообщению
    // «Command failed» отличить тайм-аут от отказа было нельзя. Разница
    // важна: на тайм-аут говорят «нечем мерить», на отказ — «не работает».
    if (свод.killed === true || свод.signal) {
      throw new Error(
        `Safari не ответил за ${Math.round(ОТВЕТ_МС / 1000)} с (${String(свод.signal ?? 'убит по тайм-ауту')}). ` +
          'Он либо не запущен и не поднимается, либо система не пускает к нему Apple Events.',
      );
    }
    throw беда;
  }
}

/** Открыть адрес в текущей вкладке Safari и вывести его вперёд. */
export async function safariOpenUrl(url: string): Promise<{ title: string; url: string }> {
  return разобратьПереход(await осаскрипт(перейтиScript(url, readShowWork())));
}

/** Новая вкладка, она же рабочая. */
export async function safariOpenTab(url?: string): Promise<{ title: string; url: string }> {
  return разобратьПереход(await осаскрипт(открытьВкладкуScript(url ?? 'about:blank', readShowWork())));
}

export async function safariListTabs(): Promise<SafariВкладка[]> {
  return разобратьВкладки(await осаскрипт(ВКЛАДКИ_SCRIPT));
}

/**
 * Текст страницы: сначала скриптом, при запрете — через дерево доступности.
 *
 * `do JavaScript` в Safari выключен по умолчанию. Запрет и пустая страница —
 * разные беды: первую человек чинит одной галкой, вторую не чинит никак.
 * Поэтому запрет не выдаётся за пустоту, а называется своими словами.
 */
export async function safariReadPage(
  предел = 8_000,
  черезДерево?: () => Promise<string>,
): Promise<string> {
  try {
    const текст = (await осаскрипт(текстСтраницыScript(предел))).trim();
    if (текст) return текст;
  } catch (беда) {
    if (!javaScriptЗапрещён(беда)) throw беда;
    if (!черезДерево) throw new Error(КАК_РАЗРЕШИТЬ_JS);
  }
  if (!черезДерево) return '';
  // Дерево доступности разрешения на Apple Events к странице не требует, и у
  // Safari оно настоящее — в отличие от Chromium, которому его надо просить.
  return черезДерево();
}
