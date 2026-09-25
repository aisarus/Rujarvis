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
export function открытьВкладкуScript(url: string): string {
  return `
tell application "Safari"
  activate
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
export function перейтиScript(url: string): string {
  return `
tell application "Safari"
  activate
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
