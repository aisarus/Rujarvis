/**
 * Разбор ответов cua-driver.
 *
 * Драйвер отвечает не JSON-ом, а человеческим текстом: список окон строками
 * «- имя.exe (pid N) "Заголовок" [window_id: M]», дерево — отступами с
 * номерами в квадратных скобках. Здесь только разбор, без процессов и файлов,
 * поэтому всё это проверяется тестами без запуска драйвера.
 *
 * Два правила взяты не из головы, а из замеров 20.09.2026:
 *
 * 1. Элемент без номера нажать нечем. Драйвер печатает такие строки наравне с
 *    остальными, и если отдать их модели, она попробует нажать по несуществующему
 *    номеру.
 * 2. Полное дерево окна — 27 509 знаков, около 6 900 токенов, вдесятеро дороже
 *    снимка того же окна (1 078 токенов), который к тому же читается целиком.
 *    Поэтому большой ответ заворачивается, а не пересылается.
 */

/** Окно, по которому можно работать. */
export interface CuaWindow {
  app: string;
  pid: number;
  title: string;
  windowId: number;
}

/** Элемент, у которого есть номер — значит по нему можно нажать. */
export interface CuaElement {
  index: number;
  role: string;
  name: string;
}

/**
 * Окна, которые не нужны никогда.
 *
 * Наложение курсора драйвер рисует сам, «Program Manager» — это рабочий стол,
 * а хосты ввода и оболочки невидимы. Модель, которой их показать, тратит шаг
 * на выяснение, что это не то окно.
 */
const NOT_A_WINDOW = /cua-driver|AgentCursorOverlay|ShellExperienceHost|TextInputHost|Program Manager/i;

const WINDOW_LINE = /^- (\S+) \(pid (\d+)\) "([^"]*)" \[window_id: (\d+)\]/gm;

/**
 * Окна из ответа драйвера — или честный отказ.
 *
 * «Окон нет» и «я не понял ответ» — разные новости, и путать их нельзя.
 * Драйвер сам заканчивает свою сессию (по простою или после своей ошибки) и
 * дальше отвечает на всё одной фразой про `start_session`. Эта фраза не
 * разбиралась как список, пустота уходила человеку бодрым «Открытых окон
 * нет» — при живых Блендере, Клоде и браузере на экране. Поймано живым
 * прогоном 25.09.2026.
 *
 * Признак настоящего списка — заголовок «Found N window(s)»: он есть и когда
 * окон ноль.
 */
export function windowsFromAnswer(answer: string): CuaWindow[] {
  const окна = listedWindows(answer);
  if (окна.length === 0 && !/window\(s\)/iu.test(answer)) {
    throw new Error(`Драйвер окон ответил не списком: ${answer.trim().slice(0, 200)}`);
  }
  return окна;
}

export function listedWindows(answer: string): CuaWindow[] {
  const found: CuaWindow[] = [];
  for (const [, app, pid, title, windowId] of answer.matchAll(WINDOW_LINE)) {
    if (NOT_A_WINDOW.test(app) || NOT_A_WINDOW.test(title)) continue;
    found.push({ app, pid: Number(pid), title, windowId: Number(windowId) });
  }
  return found;
}

/**
 * Сколько элементов драйвер насчитал в окне.
 *
 * Нужно не ради числа, а ради проверки: дерево схлопывается до горстки
 * элементов, когда окно не отрисовано. Однажды такой ответ выглядел как
 * дешёвый режим и чуть не попал в отчёт замером.
 */
export function countedElements(answer: string): number | null {
  const found = /elements=(\d+)/.exec(answer);
  return found ? Number(found[1]) : null;
}

const NAMED_LINE = /- \[(\d+)\] (\w+) "([^"]+)"/g;

export function namedElements(tree: string): CuaElement[] {
  return [...tree.matchAll(NAMED_LINE)].map(([, index, role, name]) => ({
    index: Number(index),
    role,
    name,
  }));
}

/**
 * Найти элемент по имени.
 *
 * Точное совпадение важнее вхождения: в окне рядом живут кнопка «Terminal» и
 * кнопка «Run in terminal», и по запросу «Terminal» нужна первая. Драйверный
 * `query` этого различия не делает — он отдаёт обе.
 */
export function findElement(tree: string, wanted: string): CuaElement | null {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return null;
  const all = namedElements(tree);
  return (
    all.find((e) => e.name.toLowerCase() === needle) ??
    all.find((e) => e.name.toLowerCase().includes(needle)) ??
    null
  );
}

/**
 * Все элементы, чьё имя правда совпало, точное вперёд.
 *
 * Драйвер отдаёт находки вместе с предками по дереву — так видно, где элемент
 * живёт. Но предок не находка: живой прогон вернул шесть «находок» на имя,
 * которого в окне не было, и все шесть были предками. Модель, получив такой
 * список, нажмёт на предка и решит, что сделала дело.
 */
export function matchingElements(tree: string, wanted: string): CuaElement[] {
  const needle = wanted.trim().toLowerCase();
  if (!needle) return [];
  const hits = namedElements(tree).filter((e) => e.name.toLowerCase().includes(needle));
  const exact = hits.filter((e) => e.name.toLowerCase() === needle);
  return [...exact, ...hits.filter((e) => !exact.includes(e))];
}

/**
 * Предел, за которым ответ дороже снимка.
 *
 * Шесть тысяч знаков — это примерно полторы тысячи токенов: дороже снимка окна
 * и всё ещё дешевле полного дерева. Всё, что больше, значит «спросили слишком
 * широко» и должно вернуться советом сузить, а не стеной текста.
 */
export const READABLE_CHARS = 6_000;

export function tooBigToRead(answer: string): boolean {
  return answer.length > READABLE_CHARS;
}
