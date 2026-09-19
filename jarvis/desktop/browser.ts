/**
 * Браузер как инструмент, а не как картинка.
 *
 * Кликать по пикселям в браузере — худший из возможных способов: страница
 * прокручивается, вёрстка плывёт от размера окна, кнопка уезжает. Playwright
 * работает с самими элементами — по тексту, роли и селектору, — поэтому ему
 * всё равно, куда прокручено и какой масштаб.
 *
 * Профиль отдельный, а не основной. Chrome не отдаёт отладочный порт, когда
 * уже запущен с профилем по умолчанию, и заставлять человека закрывать свои
 * вкладки ради нашей задачи — плохая сделка. В своём профиле он один раз
 * войдёт куда нужно, и входы сохранятся.
 */

import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Browser, BrowserContext, Page } from 'playwright';

/**
 * Какой браузер вести.
 *
 * Edge по умолчанию, а не Chrome. Причина прикладная: Chrome отказался
 * пропускать регистрацию в отдельном профиле, а Edge пускает. Меняется
 * переменной окружения — но профиль у каждого движка свой, поэтому смена
 * браузера означает и новый вход.
 */
const CHANNEL = process.env.JARVIS_BROWSER_CHANNEL?.trim() || 'msedge';

export const PROFILE_DIR = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Rujarvis',
  `browser-profile-${CHANNEL}`,
);

let context: BrowserContext | null = null;
let browser: Browser | null = null;

/** Открывает браузер один раз и держит его между вызовами. */
async function ensureBrowser(): Promise<BrowserContext> {
  if (context) return context;

  const { chromium } = await import('playwright');
  try {
    context = await launch(chromium);
  } catch (error) {
    // Профиль занят другим окном — самая частая причина, и в сыром виде она
    // приезжает стеной логов Playwright, из которой ничего не понять.
    // Снимать чужой замок нельзя: два браузера на один профиль его портят.
    if (looksLikeProfileLock(error)) {
      throw new Error(
        `Профиль браузера занят: где-то уже открыто окно с ${PROFILE_DIR}. ` +
          'Закрой его и повтори.',
      );
    }
    throw error;
  }

  // Браузер — дочерний процесс, и без этого он переживает свой сервер,
  // продолжая держать профиль. Следующий запуск об это спотыкается.
  for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void context?.close().catch(() => {});
      context = null;
    });
  }

  return context;
}

type Chromium = Awaited<typeof import('playwright')>['chromium'];

function launch(chromium: Chromium): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: CHANNEL,
    headless: false,
    viewport: null,
    // Без этого Chrome отменяет скачивание молча, и файл, который человек
    // видел на экране, просто не появляется на диске.
    acceptDownloads: true,
    args: ['--start-maximized'],
  });
}

/**
 * Похоже ли это на занятый профиль.
 *
 * Chromium в таком случае завершается кодом 21, а Playwright сообщает, что
 * страница закрылась, — по самому тексту ошибки причину не угадать, поэтому
 * распознаём оба признака.
 */
function looksLikeProfileLock(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('exitCode=21') || message.includes('has been closed');
}

/** Текущая вкладка, или новая, если все закрыты. */
async function currentPage(): Promise<Page> {
  const ctx = await ensureBrowser();
  const pages = ctx.pages();
  const page = pages.length > 0 ? pages[pages.length - 1] : await ctx.newPage();
  return page as Page;
}

export async function openUrl(url: string): Promise<{ title: string; url: string }> {
  const page = await currentPage();
  // Схема есть — адрес уже полный. Проверять только http и https было
  // ошибкой: file:// превращался в https://file///… и не открывался.
  const target = /^[a-z][a-z0-9+.-]*:\/\//iu.test(url) ? url : `https://${url}`;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return { title: await page.title(), url: page.url() };
}

/**
 * Текст страницы, а не её снимок.
 *
 * Модели дешевле и точнее прочитать текст, чем разглядывать картинку: не надо
 * угадывать мелкий шрифт и не тратится место на пиксели.
 */
export async function readPage(maxChars = 8_000): Promise<string> {
  const page = await currentPage();
  // Через локаторы, а не evaluate с document: код внутри evaluate исполняется
  // в браузере, но проверяется как код Node, и типы DOM там недоступны.
  const main = page.locator('main, article, [role="main"]').first();
  const source = (await main.count()) > 0 ? main : page.locator('body');
  const text = await source.innerText({ timeout: 10_000 });
  const clean = text.replace(/\n{3,}/gu, '\n\n').trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}\n…(обрезано)` : clean;
}

/** Ссылки и кнопки, по которым можно кликнуть — с тем текстом, что видит человек. */
export async function listControls(limit = 40): Promise<string[]> {
  const page = await currentPage();
  const items = page.locator('a:visible, button:visible, [role="button"]:visible');
  const count = Math.min(await items.count(), limit * 3);

  const seen = new Set<string>();
  const out: string[] = [];
  for (let index = 0; index < count && out.length < limit; index += 1) {
    const label = ((await items.nth(index).innerText().catch(() => '')) || '').trim();
    if (!label || label.length > 80 || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

export async function clickText(text: string): Promise<string> {
  const page = await currentPage();
  // Сначала точное совпадение по видимому тексту, потом частичное — так
  // «Войти» не срабатывает на «Войти через Google», пока есть точная кнопка.
  const exact = page.getByText(text, { exact: true }).first();
  const target = (await exact.count()) > 0 ? exact : page.getByText(text).first();
  await target.click({ timeout: 10_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  return page.url();
}

export async function fillField(label: string, value: string): Promise<void> {
  const page = await currentPage();
  const byLabel = page.getByLabel(label).first();
  const target =
    (await byLabel.count()) > 0 ? byLabel : page.getByPlaceholder(label).first();
  await target.fill(value, { timeout: 10_000 });
}

export async function pressKey(key: string): Promise<void> {
  const page = await currentPage();
  await page.keyboard.press(key);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

/**
 * Нажимает кнопку скачивания и забирает файл.
 *
 * Без этого браузер был односторонним: он мог сделать картинку на сайте, но не
 * мог принести её на диск, — а картинка, которую нельзя принести, для человека
 * не существует. Файл сначала попадает во временное место; раскладывать его по
 * разделам — дело вызывающего.
 */
export async function downloadVia(
  label: string,
  timeoutMs = 180_000,
): Promise<{ path: string; name: string }> {
  const page = await currentPage();

  // Подписка ставится до клика: событие приходит быстрее, чем успевает
  // вернуться сам клик, и подписка после него опаздывает.
  const waiting = page.waitForEvent('download', { timeout: timeoutMs });
  await clickText(label);
  const download = await waiting;

  const name = download.suggestedFilename() || `файл-${Date.now()}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-download-'));
  const file = path.join(dir, name);
  await download.saveAs(file);

  const failure = await download.failure();
  if (failure) throw new Error(`Скачивание не удалось: ${failure}`);

  return { path: file, name };
}

/**
 * Ждёт, пока на странице появится нужный текст.
 *
 * Генерация картинки или ролика занимает десятки секунд, и всё это время
 * страница выглядит законченной. Без ожидания агент читает её слишком рано и
 * докладывает о пустоте как о результате.
 */
export async function waitForText(text: string, timeoutMs = 180_000): Promise<boolean> {
  const page = await currentPage();
  try {
    await page.getByText(text).first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function screenshot(file: string): Promise<string> {
  const page = await currentPage();
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/** Снимок в память, без файла: для сравнения кадров при проезде страницы. */
export async function shoot(): Promise<Buffer> {
  const page = await currentPage();
  return page.screenshot({ fullPage: false });
}

/**
 * Выполнить скрипт на странице и вернуть, что он отдал.
 *
 * Скрипт приходит СТРОКОЙ, а не функцией, и это не небрежность. Приборы
 * проезда (`pageRider`) отдают именно текст: так их правила проверяются тестом
 * без всякого браузера, а выполнять умеет только тот, у кого страница есть.
 */
export async function evaluate(script: string): Promise<unknown> {
  const page = await currentPage();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return page.evaluate(script);
}

/**
 * Настоящее колесо мыши.
 *
 * Не `scrollTo` и не `scrollLeft`. Замер Aegis на странице с перехватом
 * колеса: `el.scrollLeft = 1500` двигает на **0 пикселей**, настоящее колесо —
 * на **1800**. Так устроен весь жанр горизонтальных новелл, и сайты вроде
 * Бруно Симон в том числе: скриптом такая страница неподвижна, и снять с неё
 * можно только заставку.
 */
export async function wheel(dx: number, dy: number): Promise<void> {
  const page = await currentPage();
  await page.mouse.wheel(dx, dy);
}

/**
 * Нажатие по координатам.
 *
 * Нужно там, где надписи нет в разметке: у Бруно Симон «CLICK TO START»
 * нарисовано на холсте, и по тексту его не найти — зато видно на снимке.
 */
export async function clickAt(x: number, y: number): Promise<void> {
  const page = await currentPage();
  await page.mouse.click(x, y);
}

/** Навести курсор: будит то, что реагирует на мышь, ничего не нажимая. */
export async function hover(x: number, y: number): Promise<void> {
  const page = await currentPage();
  await page.mouse.move(x, y);
}

/** Размер видимой части страницы — для расчёта проезда. */
export async function viewport(): Promise<{ width: number; height: number }> {
  const page = await currentPage();
  const size = page.viewportSize();
  return size ?? { width: 1280, height: 720 };
}

export async function listTabs(): Promise<Array<{ title: string; url: string }>> {
  const ctx = await ensureBrowser();
  return Promise.all(ctx.pages().map(async (page) => ({ title: await page.title(), url: page.url() })));
}

export async function dispose(): Promise<void> {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = null;
  browser = null;
}
