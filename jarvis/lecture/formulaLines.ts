/**
 * Формулы старого конспекта — в LaTeX, и только они.
 *
 * Модель получает лишь строки, похожие на формулы, и менять может только их, так
 * что остальной текст заметки до неё физически не доходит. И в этих строках её
 * ответ не вставляется как есть: из него берутся только сами формулы, а всё вокруг
 * остаётся байтами исходной строки. Формула принимается, если в ней те же буквы и
 * числа в том же порядке и те же знаки действий, что и на её месте в исходной
 * строке. Не сошлось — строка остаётся как была: по конспекту учатся к экзамену, и
 * наведение порядка не должно исправить в нём ни одного числа.
 */

import { formulaRules } from '../notes/style';

export interface FormulaLine {
  /** Номер строки заметки, с нуля. */
  index: number;
  line: string;
}

const СИМВОЛЫ = /[√∑∫∞≈≠≤≥×÷±²³¹⁰⁴-⁹₀-₉α-ωΓΔΘΛΞΠΣΦΨΩ]/u;
const ОТНОШЕНИЕ = /[A-Za-z0-9)\]%]\s*[=<>]|[=<>]\s*[-−]?[A-Za-z0-9(]/u;
const АРИФМЕТИКА = /[A-Za-z0-9)]\s*[+*·^]\s*[A-Za-z0-9(]/u;
const ДРОБЬ = /(?<![\p{L}\p{N}])[A-Za-z0-9]{1,4}\s*\/\s*[A-Za-z0-9]{1,4}(?![\p{L}\p{N}])/u;
const МИНУС = /[A-Za-z0-9)]\s+[-−–]\s+[A-Za-z0-9(]/u;
const ИНДЕКС = /(?<![\p{L}\p{N}])[A-Za-z]_?\d{1,2}(?![\p{L}\p{N}])|[A-Za-z]_[A-Za-z0-9{]/u;
const ФУНКЦИЯ = /(?<![\p{L}\p{N}])[A-Za-z]\([A-Za-z0-9, ]+\)/u;
const БУКВА_В_РУССКОМ = /(?<![\p{L}\p{N}])[A-Za-z](?![\p{L}\p{N}'’])/u;
// В английском тексте «a» и «I» — обычные слова.
const БУКВА_В_ЛАТИНИЦЕ = /(?<![\p{L}\p{N}'’])[b-hj-zB-HJ-Z](?![\p{L}\p{N}'’])/u;

const ФУНКЦИИ = new Set(['log', 'ln', 'lg', 'sin', 'cos', 'tan', 'cot', 'arcsin', 'arccos', 'arctan', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'mod', 'det', 'gcd']);
const СЛОВА_КОДА = new Set(['if', 'in', 'or', 'is', 'as', 'do', 'for', 'int', 'str', 'len', 'and', 'not', 'def', 'try', 'del']);

/**
 * Код ли это в обратных кавычках. Старые конспекты пишут так и код (`total = 5`,
 * `print(x)`, `=SUM(B2:B10)`), и математику (`(a+b)³ = a³ + 3a²b`): первое должно
 * остаться кодом, второе — стать формулой.
 */
function похожеНаКод(т: string): boolean {
  if (/[_"'[\]{}:;#Ѐ-ӿ֐-׿]|==|!=|\+=/u.test(т)) return true;
  const слова = т.normalize('NFKC').match(/[A-Za-z]{2,}/gu) ?? [];
  return слова.some((с) => !ФУНКЦИИ.has(с) && (с.length > 3 || СЛОВА_КОДА.has(с)));
}

/** Что в строке не формула наверняка: разметка начала строки, ссылки, код, время, даты. */
function безОбвязки(строка: string): string {
  return строка
    .replace(/^[\s>]*(?:[-*+]\s+(?:\[[ x]\]\s+)?|\d+[.)]\s+)?/u, '')
    .replace(/!?\[\[[^\]]*\]\]/gu, ' ')
    .replace(/`([^`]*)`/gu, (_всё, внутри: string) => (похожеНаКод(внутри) ? ' ' : внутри))
    .replace(/\[![a-z]+\][+-]?/gu, ' ')
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:\s*[–-]\s*\d{1,2}:\d{2}(?::\d{2})?)?/gu, ' ')
    .replace(/\d{4}-\d{2}-\d{2}/gu, ' ');
}

export function looksLikeFormula(строка: string): boolean {
  const т = безОбвязки(строка);
  if ([СИМВОЛЫ, ОТНОШЕНИЕ, АРИФМЕТИКА, ДРОБЬ, МИНУС, ИНДЕКС, ФУНКЦИЯ].some((образец) => образец.test(т))) return true;
  return (/[Ѐ-ӿ֐-׿]/u.test(т) ? БУКВА_В_РУССКОМ : БУКВА_В_ЛАТИНИЦЕ).test(т);
}

/** Строки заметки, которые стоит показать модели. Уже с `$`, заголовки, свойства и блоки кода — нет. */
export function formulaCandidates(text: string): FormulaLine[] {
  const найдено: FormulaLine[] = [];
  let вСвойствах = /^---\r?\n/u.test(text);
  let вКоде = false;
  for (const [index, сырая] of text.split('\n').entries()) {
    const line = сырая.replace(/\r$/u, '');
    if (index === 0 && вСвойствах) continue;
    if (вСвойствах) {
      if (line === '---') вСвойствах = false;
      continue;
    }
    if (/^[\s>]*```/u.test(line)) {
      вКоде = !вКоде;
      continue;
    }
    if (вКоде || !line.trim() || /^#{1,6}\s/u.test(line) || line.includes('%%') || line.includes('$')) continue;
    if (looksLikeFormula(line)) найдено.push({ index, line });
  }
  return найдено;
}

const ГРЕЧЕСКИЕ: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  sum: 'Σ', prod: 'Π',
};
const ЗНАКИ: Record<string, string> = { le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', pm: '±', frac: '/', dfrac: '/', tfrac: '/', cfrac: '/', div: '/', lt: '<', gt: '>', cdot: '*', times: '*' };

/** Буквы и числа записи по порядку: LaTeX — только другая запись тех же букв. */
function буквыИЧисла(запись: string): string {
  return запись
    .normalize('NFKC')
    .replace(/∑/gu, 'Σ')
    .replace(/∏/gu, 'Π')
    .replace(/\\([A-Za-z]+)/gu, (_всё, имя: string) => ГРЕЧЕСКИЕ[имя] ?? (ФУНКЦИИ.has(имя) ? имя : ''))
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Сколько каких знаков действий: подмена плюса на минус не должна пройти. */
function знакиДействий(запись: string): string {
  const т = запись
    .normalize('NFKC')
    .replace(/\\([A-Za-z]+)/gu, (_всё, имя: string) => ЗНАКИ[имя] ?? '')
    .replace(/[÷⁄]/gu, '/')
    .replace(/[·×]/gu, '*')
    .replace(/[−–]/gu, '-');
  return ['+', '-', '*', '=', '<', '>', '≤', '≥', '≠', '≈', '±', '/'].map((знак) => [...т].filter((с) => с === знак).length).join(',');
}

function формулаНаМесте(место: string, формулы: readonly string[]): boolean {
  const запись = формулы.join(' ');
  if (!место.trim() || /[Ѐ-ӿ֐-׿]/u.test(запись)) return false;
  // Код в обратных кавычках — не формула, а непарная кавычка — не пойми что.
  if ([...место.matchAll(/`([^`]*)`/gu)].some((м) => похожеНаКод(м[1] ?? '')) || (место.match(/`/gu) ?? []).length % 2 !== 0) return false;
  return буквыИЧисла(место) === буквыИЧисла(запись) && знакиДействий(место) === знакиДействий(запись);
}

const В_ДОЛЛАРАХ = /\$\$([^$]+?)\$\$|\$((?:\\.|[^$\\])+?)\$/gu;

/**
 * Строка с формулами из ответа модели, собранная заново: всё вне формул — байты
 * исходной строки, в формулах — то, что написала модель. Ответ меняет что-то кроме
 * записи формул — null. Формул в ответе нет — исходная строка как есть.
 */
export function mergeFormulaLine(исходная: string, ответ: string): string | null {
  let стало = '';
  let позиция = 0;
  let копятся: string[] = [];
  let сырые: string[] = [];
  const закрыть = (место: string): boolean => {
    if (копятся.length === 0) {
      if (место.trim()) return false;
      стало += место;
      return true;
    }
    if (!формулаНаМесте(место, копятся)) return false;
    const начало = /^\s*/u.exec(место)?.[0] ?? '';
    const конец = /\s*$/u.exec(место)?.[0] ?? '';
    стало += `${начало}${сырые.join(' ')}${конец}`;
    копятся = [];
    сырые = [];
    return true;
  };
  const вне = (кусок: string): boolean => {
    const текст = кусок.trim();
    if (!текст) return true;
    // Знак доллара вне формулы — незакрытая формула: в исходной строке его не было.
    const где = исходная.indexOf(текст, позиция);
    if (где < 0 || текст.includes('$')) return false;
    if (!закрыть(исходная.slice(позиция, где))) return false;
    стало += текст;
    позиция = где + текст.length;
    return true;
  };
  let последний = 0;
  let формул = 0;
  for (const найдено of ответ.matchAll(В_ДОЛЛАРАХ)) {
    if (!вне(ответ.slice(последний, найдено.index))) return null;
    копятся.push(найдено[1] ?? найдено[2] ?? '');
    сырые.push(найдено[0]);
    формул += 1;
    последний = найдено.index + найдено[0].length;
  }
  if (формул === 0) return ответ.trim() === исходная.trim() ? исходная : null;
  if (!вне(ответ.slice(последний))) return null;
  if (!закрыть(исходная.slice(позиция))) return null;
  return стало;
}

export function formulaPrompt(строки: readonly FormulaLine[]): string {
  return [
    'Ниже — строки конспекта лекции, в которых, похоже, есть формулы. Переведи запись формул в LaTeX для Obsidian.',
    'Ответь только текстом: ничего не открывай, не читай и не сохраняй. Никаких пояснений до и после.',
    '',
    ...formulaRules('ru'),
    '',
    'Код программ — не формула: фрагменты на Python, формулы Excel и команды оставляй как есть. Математическую формулу в обратных кавычках записывай в LaTeX без кавычек.',
    'Меняй только запись формул. Ни слово, ни число, ни буква, ни знак действия не меняются и не переставляются; ничего не добавляй и не исправляй, даже если кажется ошибкой. Текст вне формул и разметка в начале строки («- », «> », «| ») — посимвольно как в исходной строке.',
    '',
    'Формат ответа: каждая строка — «номер| строка целиком». Строку без формул в ответ не включай. Если формул нет ни в одной — ответь одним словом НЕТ.',
    '',
    'Строки:',
    ...строки.map((с, i) => `${i + 1}| ${с.line}`),
  ].join('\n');
}

export interface FormulaResult {
  /** Заметка после замены строк. */
  text: string;
  /** Сколько строк получили формулы. */
  lines: number;
  /** Сколько строк из ответа модели не прошли проверку и остались как были. */
  rejected: number;
}

/**
 * Строк в одном вызове модели: на длинной лекции по математике их больше сотни, а
 * ответ такой длины мог бы не уложиться в срок вызова, и вся заметка осталась бы
 * необработанной.
 */
const СТРОК_В_ВЫЗОВЕ = 60;

export function formulaCalls(text: string): number {
  return Math.ceil(formulaCandidates(text).length / СТРОК_В_ВЫЗОВЕ);
}

/** Заметка с формулами в LaTeX. Вызов не вышел — ошибка, и ни одна пачка не применяется. */
export async function convertNoteFormulas(text: string, summarize: (prompt: string) => Promise<string>): Promise<FormulaResult> {
  const строки = formulaCandidates(text);
  let итог: FormulaResult = { text, lines: 0, rejected: 0 };
  for (let i = 0; i < строки.length; i += СТРОК_В_ВЫЗОВЕ) {
    const пачка = строки.slice(i, i + СТРОК_В_ВЫЗОВЕ);
    const часть = applyFormulaReply(итог.text, пачка, await summarize(formulaPrompt(пачка)));
    итог = { text: часть.text, lines: итог.lines + часть.lines, rejected: итог.rejected + часть.rejected };
  }
  return итог;
}

/** Ответ модели → строки заметки. Ответ не разобрать — ошибка, и заметка останется нетронутой. */
export function applyFormulaReply(text: string, строки: readonly FormulaLine[], ответ: string): FormulaResult {
  if (/^\s*(?:НЕТ|NONE|NO)\s*[.!]?\s*$/iu.test(ответ)) return { text, lines: 0, rejected: 0 };
  const ответы = new Map<number, string>();
  for (const сырая of ответ.split(/\r?\n/u)) {
    const найдено = /^\s*(\d+)\s*\|\s?(.*)$/u.exec(сырая);
    if (найдено) ответы.set(Number(найдено[1]), найдено[2] ?? '');
  }
  if (ответы.size === 0) throw new Error('ответ модели не разобран');
  const все = text.split('\n');
  let lines = 0;
  let rejected = 0;
  for (const [номер, новая] of ответы) {
    const строка = строки[номер - 1];
    const собранная = строка ? mergeFormulaLine(строка.line, новая) : null;
    if (!строка || собранная === null) {
      rejected += 1;
      continue;
    }
    if (собранная === строка.line) continue;
    const перевод = (все[строка.index] ?? '').endsWith('\r') ? '\r' : '';
    все[строка.index] = `${собранная}${перевод}`;
    lines += 1;
  }
  return { text: все.join('\n'), lines, rejected };
}
