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
import { jarvisHome } from '../setup/paths';

/**
 * Какой браузер вести.
 *
 * Edge по умолчанию, а не Chrome. Причина прикладная: Chrome отказался
 * пропускать регистрацию в отдельном профиле, а Edge пускает. Меняется
 * переменной окружения — но профиль у каждого движка свой, поэтому смена
 * браузера означает и новый вход.
 */
const CHANNEL = process.env.JARVIS_BROWSER_CHANNEL?.trim() || 'msedge';

/**
 * Чем пробовать, если названного браузера на машине нет.
 *
 * Edge стоит на каждой Windows и почти ни на одном маке — а канал Playwright
 * без установленного браузера не запускается вовсе: «Chromium distribution
 * 'msedge' is not found». На маке вкладки из-за этого не открывались совсем,
 * и человек видел стену логов Playwright вместо ответа.
 *
 * Поэтому порядок: сначала названный (его выбрал человек или он стоит по
 * умолчанию), потом остальные из семейства, и последним — chromium, который
 * Playwright носит с собой. Профиль у каждого движка свой: смена браузера
 * означает и новый вход, поэтому менять его молча на каждый запуск нельзя —
 * только когда прежний не завёлся.
 */
const ЗАПАСНЫЕ = ['msedge', 'chrome', 'chromium'];

/** Из чего выбирать на этой машине: названный первым, дальше — остальные. */
export function порядокКаналов(channel = CHANNEL, запасные = ЗАПАСНЫЕ): string[] {
  return [channel, ...запасные.filter((имя) => имя !== channel)];
}

/**
 * Похоже ли это на «такого браузера тут нет».
 *
 * Отличать обязательно: на отсутствие браузера пробуют следующий, а на всё
 * остальное — падают. Иначе занятый профиль или сломанный запуск тихо увели
 * бы человека в другой браузер с другим входом.
 */
export function браузераНет(error: unknown): boolean {
  const текст = error instanceof Error ? error.message : String(error);
  return (
    текст.includes('is not found') ||
    текст.includes('Failed to launch') ||
    текст.includes('executable doesn') ||
    текст.includes('No such file or directory')
  );
}

/**
 * Профиль браузера — внутри папки Джарвиса, какой бы она ни была.
 *
 * Собранный руками, путь получался виндовым на любой машине: на маке
 * LOCALAPPDATA не задан, и профиль ложился в ~/AppData/Local/Rujarvis —
 * рядом с домом, но не в нём. Снаружи папки Джарвиса его не видит ни
 * установщик, ни уборка, ни сам человек.
 */
export const PROFILE_DIR = path.join(jarvisHome(), `browser-profile-${CHANNEL}`);

let context: BrowserContext | null = null;
let browser: Browser | null = null;
/**
 * Идущий запуск. Ждать его, а не начинать второй.
 *
 * Клиент MCP зовёт инструменты параллельно, а `context` появлялся только
 * ПОСЛЕ ожидания: оба вызова проходили проверку и оба запускали браузер на
 * один профиль. Второй падал, и человек читал «Профиль браузера занят,
 * закрой его» — хотя чужого окна не было вовсе, мы сами себе и мешали.
 */
let запускается: Promise<BrowserContext> | null = null;

/** Открывает браузер один раз и держит его между вызовами. */
async function ensureBrowser(): Promise<BrowserContext> {
  if (context) return context;
  if (запускается) return запускается;
  запускается = поднять().finally(() => {
    запускается = null;
  });
  return запускается;
}

async function поднять(): Promise<BrowserContext> {
  const { chromium } = await import('playwright');
  const пробовали: string[] = [];
  let последняя: unknown = null;

  for (const канал of порядокКаналов()) {
    try {
      context = await launch(chromium, канал);
      if (канал !== CHANNEL) {
        // Молчать нельзя: профиль у каждого движка свой, и человек должен
        // понимать, почему его вход не подхватился.
        console.log(`[jarvis] ${CHANNEL} не нашёлся, веду ${канал}`);
      }
      break;
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
      // Нет такого браузера — пробуем следующий. Любая другая беда своя, и
      // прятать её за перебором значит врать про причину.
      if (!браузераНет(error)) throw error;
      пробовали.push(канал);
      последняя = error;
    }
  }

  if (!context) {
    const причина = последняя instanceof Error ? последняя.message : String(последняя);
    throw new Error(
      `Не нашёл ни одного браузера (пробовал: ${пробовали.join(', ')}). ` +
        'Поставьте Chrome или Edge, либо выполните «pnpm exec playwright install chromium». ' +
        `Последняя ошибка: ${причина}`,
    );
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

function launch(chromium: Chromium, канал: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    // `chromium` — не канал, а та сборка, которую Playwright носит с собой:
    // каналом её просить нельзя, поле остаётся пустым.
    channel: канал === 'chromium' ? undefined : канал,
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

/**
 * Какая вкладка сейчас рабочая.
 *
 * Раньше рабочей считалась последняя открытая, и этого хватало, пока вкладка
 * была одна. С несколькими так нельзя: переключились на первую — а читать и
 * нажимать всё равно продолжали в последней. Поэтому рабочая вкладка
 * запоминается отдельно, а «последняя» остаётся запасным ответом.
 */
let активная: Page | null = null;

/** Текущая вкладка, или новая, если все закрыты. */
async function currentPage(): Promise<Page> {
  const ctx = await ensureBrowser();
  if (активная && !активная.isClosed()) return активная;

  const pages = ctx.pages();
  const page = pages.length > 0 ? pages[pages.length - 1] : await ctx.newPage();
  активная = page as Page;
  return активная;
}

/**
 * Найти вкладку по номеру или по куску заголовка либо адреса.
 *
 * Номер — потому что список вкладок человек и модель видят по номерам. Кусок
 * текста — потому что вслух говорят «переключись на википедию», а не «на
 * вкладку два».
 */
async function найтиВкладку(target: string): Promise<{ page: Page; index: number } | null> {
  const ctx = await ensureBrowser();
  const pages = ctx.pages() as Page[];

  const номер = Number(target.trim());
  if (Number.isInteger(номер) && номер >= 1 && номер <= pages.length) {
    return { page: pages[номер - 1] as Page, index: номер };
  }

  const искомое = target.trim().toLowerCase();
  if (!искомое) return null;
  for (const [i, page] of pages.entries()) {
    const заголовок = (await page.title().catch(() => '')).toLowerCase();
    if (заголовок.includes(искомое) || page.url().toLowerCase().includes(искомое)) {
      return { page, index: i + 1 };
    }
  }
  return null;
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
  // Обработчик вешается СРАЗУ.
  //
  // Если клик бросит (кнопку не нашли), до `await waiting` дело не дойдёт, а
  // ожидание отклонится по сроку — через три минуты, без обработчика. В Node
  // 22 это гасит процесс: MCP-сервер падал спустя три минуты после неудачной
  // загрузки, и связать одно с другим было нечем.
  waiting.catch(() => undefined);
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
  } catch (error) {
    // `false` — только по сроку. Всё остальное пробрасываем.
    //
    // Раньше сюда сваливались и закрытый браузер, и упавшая страница, и
    // неверный локатор: агент читал «не дождался за отведённое время» и ждал
    // дальше, а настоящая причина терялась.
    const текст = error instanceof Error ? error.message : String(error);
    if (/timeout|exceeded/iu.test(текст)) return false;
    throw error;
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
  // Спрашиваем саму страницу, а не Playwright.
  //
  // Контекст открыт с `viewport: null` (окно во весь экран), и
  // `page.viewportSize()` при этом всегда `null` — возвращалась заглушка
  // 1280×720. От неё берётся шаг проезда и считается «доехали»: на
  // развёрнутом окне кадры перекрывались, на узком между ними пропадали
  // куски страницы, а отметка о конце была неверной.
  try {
    const свой = (await page.evaluate(
      '[window.innerWidth, window.innerHeight]',
    )) as [number, number];
    if (Number.isFinite(свой[0]) && свой[0] > 0 && Number.isFinite(свой[1]) && свой[1] > 0) {
      return { width: Math.round(свой[0]), height: Math.round(свой[1]) };
    }
  } catch {
    // Страница могла закрыться прямо сейчас — тогда спросим Playwright.
  }
  const size = page.viewportSize();
  return size ?? { width: 1280, height: 720 };
}

export async function listTabs(): Promise<Array<{ title: string; url: string; active: boolean }>> {
  const ctx = await ensureBrowser();
  return Promise.all(
    ctx.pages().map(async (page) => ({
      title: await page.title().catch(() => ''),
      url: page.url(),
      active: page === активная,
    })),
  );
}

/** Новая вкладка рядом с нынешними — и она сразу становится рабочей. */
export async function openTab(url?: string): Promise<{ title: string; url: string }> {
  const ctx = await ensureBrowser();
  const page = (await ctx.newPage()) as Page;
  активная = page;
  if (url) {
    const target = /^[a-z][a-z0-9+.-]*:\/\//iu.test(url) ? url : `https://${url}`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  await page.bringToFront().catch(() => undefined);
  return { title: await page.title().catch(() => ''), url: page.url() };
}

/**
 * Переключиться на вкладку.
 *
 * Выводит её вперёд И делает рабочей. Одного `bringToFront` мало: человек
 * увидел бы нужную вкладку, а чтение и нажатия продолжали бы уходить в
 * прежнюю — молча и мимо.
 */
export async function switchTab(target: string): Promise<{ title: string; url: string }> {
  const найдено = await найтиВкладку(target);
  if (!найдено) throw new Error(`Нет вкладки «${target}»`);
  активная = найдено.page;
  await найдено.page.bringToFront().catch(() => undefined);
  return { title: await найдено.page.title().catch(() => ''), url: найдено.page.url() };
}

/** Закрыть вкладку. Последнюю не закрываем: браузер без вкладок бесполезен. */
export async function closeTab(target: string): Promise<{ title: string; url: string }> {
  const ctx = await ensureBrowser();
  if (ctx.pages().length <= 1) throw new Error('Это последняя вкладка — закрывать нечего');

  const найдено = await найтиВкладку(target);
  if (!найдено) throw new Error(`Нет вкладки «${target}»`);

  const заголовок = await найдено.page.title().catch(() => '');
  const адрес = найдено.page.url();
  await найдено.page.close();
  if (активная === найдено.page) активная = null;
  return { title: заголовок, url: адрес };
}

export async function dispose(): Promise<void> {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = null;
  browser = null;
}
