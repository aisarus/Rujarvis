/**
 * Формулы старого конспекта — в LaTeX, и только они.
 *
 * Модель получает лишь строки, похожие на формулы, и менять может только их, так
 * что остальной текст заметки до неё физически не доходит. В этих строках её ответ
 * не вставляется как есть: из него берутся только сами формулы, всё вокруг остаётся
 * байтами исходной строки.
 *
 * Формула не «похожа» на исходный кусок, а доказывается равной ему. Оба разбираются
 * в один ряд знаков: числа целиком, с разделителями, буквы, действия на своих
 * местах, степени, индексы, скобки, дроби, — и ряды должны совпасть точно. Команда
 * LaTeX не из списка, незнакомый символ, слово, ссылка или код — отказ. Отказ стоит
 * дёшево: строка просто остаётся обычным текстом. Дорого обратное — неверное число,
 * красиво нарисованное: по конспекту учатся к экзамену, и более доверия вызывает
 * именно формула. На этой проверке держится и то, что размышления модели выключены
 * (`FORMULA_MODEL_ENV` в `tidy.ts`).
 */

import { formulaRules } from '../notes/style';

export interface FormulaLine {
  /** Номер строки заметки, с нуля. */
  index: number;
  line: string;
}

const ФУНКЦИИ = new Set(['log', 'ln', 'lg', 'sin', 'cos', 'tan', 'cot', 'arcsin', 'arccos', 'arctan', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'mod', 'det', 'gcd']);
const СЛОВА_КОДА = new Set(['if', 'in', 'or', 'is', 'as', 'do', 'for', 'int', 'str', 'len', 'and', 'not', 'def', 'try', 'del']);
/** Короткие слова, а не произведение букв: `x is 5` — не формула. */
const КОРОТКИЕ_СЛОВА = new Set(['is', 'if', 'in', 'on', 'at', 'to', 'of', 'or', 'as', 'an', 'by', 'we', 'it', 'be', 'no', 'so', 'up', 'do']);

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

/**
 * Строки заметки, которые стоит показать модели. Не показываются: свойства,
 * заголовки, строки с `$`, блоки кода (```, ~~~ и с отступом после пустой строки),
 * блоки формул `$$ … $$` и комментарии `%% … %%`, в том числе на несколько строк:
 * одинокая строка из блока формул выглядит как формула без `$`, и обёрнутая в них
 * сломала бы блок, а комментарий — личный текст, модели его показывать незачем.
 */
export function formulaCandidates(text: string): FormulaLine[] {
  const найдено: FormulaLine[] = [];
  let вСвойствах = /^---\r?\n/u.test(text);
  let забор: string | null = null;
  let вКомментарии = false;
  let вБлокеФормул = false;
  let вОтступе = false;
  let пустаяПеред = true;
  for (const [index, сырая] of text.split('\n').entries()) {
    const line = сырая.replace(/\r$/u, '');
    if (index === 0 && вСвойствах) continue;
    if (вСвойствах) {
      if (line === '---') вСвойствах = false;
      continue;
    }
    const былаПустая = пустаяПеред;
    пустаяПеред = !line.trim();
    const содержимое = line.replace(/^[\s>]*/u, '');
    if (забор) {
      if (содержимое.startsWith(забор)) забор = null;
      continue;
    }
    if (/^(?:```|~~~)/u.test(содержимое)) {
      забор = содержимое.slice(0, 3);
      continue;
    }
    const комментариев = line.match(/%%/gu)?.length ?? 0;
    if (вКомментарии) {
      if (комментариев % 2 === 1) вКомментарии = false;
      continue;
    }
    if (комментариев % 2 === 1) {
      вКомментарии = true;
      continue;
    }
    if (комментариев > 0) continue;
    const блоковФормул = line.match(/\$\$/gu)?.length ?? 0;
    if (вБлокеФормул) {
      if (блоковФормул % 2 === 1) вБлокеФормул = false;
      continue;
    }
    if (блоковФормул % 2 === 1) {
      вБлокеФормул = true;
      continue;
    }
    if (/^(?: {4}|\t)/u.test(line)) {
      if (былаПустая || вОтступе) {
        вОтступе = true;
        continue;
      }
    } else if (line.trim()) {
      вОтступе = false;
    }
    if (!line.trim() || /^#{1,6}\s/u.test(line) || line.includes('$')) continue;
    if (looksLikeFormula(line)) найдено.push({ index, line });
  }
  return найдено;
}

// ——— Разбор в ряд знаков ———

/** Не удалось доказать: строка останется как была. */
class НеДоказано extends Error {}

/** Метки в ряду: группа степени или индекса и дробь, которой ещё не решили, нужны ли скобки. */
const ГРУППА = '⟦';
const КОНЕЦ_ГРУППЫ = '⟧';
const ДРОБЬ_ОТ = '⟪';
const ДРОБЬ_ДО = '⟫';

const ЗНАКИ: Record<string, string> = {
  '+': '+', '-': '-', '−': '-', '–': '-', '*': '*', '·': '*', '⋅': '*', '×': '*', '/': '/', '÷': '/', '⁄': '/',
  '=': '=', '<': '<', '>': '>', '≤': '≤', '≥': '≥', '≠': '≠', '≈': '≈', '±': '±',
  '(': '(', ')': ')', '[': '[', ']': ']', '!': '!', "'": "'", '′': "'", '|': '|', ',': ',', ';': ';', ':': ':', '.': '.',
  '√': '√', '∫': '∫', '∂': '∂', '∇': '∇', '∈': '∈', '∉': '∉', '∪': '∪', '∩': '∩', '⊂': '⊂', '⊆': '⊆', '∅': '∅', '∞': '∞',
  '°': '°', '…': '…', '→': '→', '←': '←', '↔': '↔', '⇒': '⇒', '⇔': '⇔', '≡': '≡', '∝': '∝', '∧': '∧', '∨': '∨', '¬': '¬', '∀': '∀', '∃': '∃',
  'Σ': 'Σ', '∑': 'Σ', 'Π': 'Π', '∏': 'Π', 'µ': 'μ', 'ℓ': 'ℓ',
};
const КОМАНДЫ_ЗНАКОВ: Record<string, string> = {
  times: '*', cdot: '*', div: '/', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', pm: '±', lt: '<', gt: '>',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', implies: '⇒', Leftrightarrow: '⇔', iff: '⇔',
  infty: '∞', sum: 'Σ', prod: 'Π', int: '∫', partial: '∂', nabla: '∇', in: '∈', notin: '∉', cup: '∪', cap: '∩', subset: '⊂', subseteq: '⊆', emptyset: '∅', varnothing: '∅',
  equiv: '≡', propto: '∝', land: '∧', wedge: '∧', lor: '∨', vee: '∨', neg: '¬', lnot: '¬', forall: '∀', exists: '∃', ldots: '…', dots: '…', cdots: '…',
  mid: '|', vert: '|', lvert: '|', rvert: '|', degree: '°', prime: "'", circ: '∘', ell: 'ℓ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
/** Только внешний вид: в значении формулы их нет. */
const КОМАНДЫ_ВИДА = new Set(['left', 'right', 'displaystyle', 'textstyle', 'quad', 'qquad', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr']);
const ОБЁРТКИ = new Set(['text', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'operatorname', 'boldsymbol']);
const ДРОБИ = new Set(['frac', 'dfrac', 'tfrac', 'cfrac']);
const АКЦЕНТЫ: Record<string, string> = { bar: 'bar', overline: 'bar', hat: 'hat', widehat: 'hat', tilde: 'tilde', widetilde: 'tilde', dot: 'dot', vec: 'vec' };
const МЕТКИ_АКЦЕНТОВ: Record<string, string> = { '̄': 'bar', '̅': 'bar', '̂': 'hat', '̃': 'tilde', '̇': 'dot', '⃗': 'vec' };
const ВЕРХНИЕ: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i' };
const НИЖНИЕ: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₒ': 'o', 'ₓ': 'x', 'ₕ': 'h', 'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₚ': 'p', 'ₛ': 's', 'ₜ': 't', 'ᵢ': 'i', 'ⱼ': 'j' };

const БУКВА = /^[A-Za-zα-ωΓΔΘΛΞΦΨΩ]$/u;
const ЦИФРА = /^\d$/u;

function скрипт(метка: string, внутри: readonly string[]): string[] {
  if (внутри.length === 0) throw new НеДоказано();
  if (метка === '^' && внутри.length === 1 && (внутри[0] === '∘' || внутри[0] === '°')) return ['°'];
  if (метка === '^' && внутри.length === 1 && внутри[0] === "'") return ["'"];
  return внутри.length === 1 ? [метка, внутри[0] as string] : [метка, ГРУППА, ...внутри, КОНЕЦ_ГРУППЫ];
}

/** Читатель символов, общий у обеих записей: число, буква с акцентом и индексом, надстрочные знаки. */
class Лента {
  i = 0;
  readonly символы: string[];

  constructor(текст: string) {
    // Только буквы: разложение трогало бы и знаки (≠ разложился бы на = и черту).
    this.символы = [...текст.replace(/\p{L}/gu, (буква) => (/[A-Za-zÀ-ɏͰ-Ͽ]/u.test(буква) ? буква.normalize('NFD') : буква))];
  }

  get c(): string | undefined {
    return this.символы[this.i];
  }

  /** Число целиком: разделитель внутри — часть числа, `{,}` — запись запятой в LaTeX. */
  число(сФигурной: boolean): string {
    let out = '';
    while (ЦИФРА.test(this.c ?? '')) out += this.символы[this.i++];
    for (;;) {
      const д = this.c;
      if ((д === '.' || д === ',') && ЦИФРА.test(this.символы[this.i + 1] ?? '')) {
        out += д;
        this.i += 1;
      } else if (сФигурной && д === '{' && this.символы[this.i + 1] === ',' && this.символы[this.i + 2] === '}' && ЦИФРА.test(this.символы[this.i + 3] ?? '')) {
        out += ',';
        this.i += 3;
      } else {
        return out;
      }
      while (ЦИФРА.test(this.c ?? '')) out += this.символы[this.i++];
    }
  }

  /** Буква; у неё бывает акцент (`x̄`) и индекс без черты (`L0` — то же, что `L_0`). */
  буква(): string[] {
    const б = this.символы[this.i++] as string;
    const акцент = МЕТКИ_АКЦЕНТОВ[this.c ?? ''];
    if (акцент) this.i += 1;
    if (!акцент && /^\p{M}$/u.test(this.c ?? '')) throw new НеДоказано();
    const знак = акцент ? `${акцент}:${б}` : б;
    if (!ЦИФРА.test(this.c ?? '')) return [знак];
    let индекс = '';
    while (ЦИФРА.test(this.c ?? '')) индекс += this.символы[this.i++];
    return [знак, '_', индекс];
  }

  /** Надстрочные и подстрочные знаки подряд: `xⁿ⁺¹`, `x₀`. */
  уступ(): string[] | null {
    const вверх = ВЕРХНИЕ[this.c ?? ''] !== undefined;
    const таблица = вверх ? ВЕРХНИЕ : НИЖНИЕ[this.c ?? ''] !== undefined ? НИЖНИЕ : null;
    if (!таблица) return null;
    let ascii = '';
    while (таблица[this.c ?? ''] !== undefined) ascii += таблица[this.символы[this.i++] as string];
    return скрипт(вверх ? '^' : '_', разобратьИсходное(ascii));
  }
}

/** Исходный кусок конспекта → ряд знаков. Незнакомый символ — отказ. */
function разобратьИсходное(текст: string): string[] {
  const л = new Лента(текст);
  const out: string[] = [];
  /** Что идёт за `^` или `_`: скобка, знак с числом или словом. */
  const аргумент = (): string[] => {
    const открыв = л.c;
    if (открыв === '(' || открыв === '{') {
      const закрыв = открыв === '(' ? ')' : '}';
      let глубина = 0;
      const от = л.i + 1;
      for (; л.i < л.символы.length; л.i += 1) {
        if (л.c === открыв) глубина += 1;
        if (л.c === закрыв && (глубина -= 1) === 0) break;
      }
      if (глубина !== 0) throw new НеДоказано();
      const внутри = л.символы.slice(от, л.i).join('');
      л.i += 1;
      return разобратьИсходное(внутри);
    }
    const знак = л.c === '-' || л.c === '−' || л.c === '+' ? [ЗНАКИ[л.символы[л.i++] as string] as string] : [];
    if (ЦИФРА.test(л.c ?? '')) return [...знак, л.число(false)];
    const слово: string[] = [];
    while (БУКВА.test(л.c ?? '')) слово.push(л.символы[л.i++] as string);
    if (слово.length === 0) throw new НеДоказано();
    return [...знак, ...слово];
  };
  while (л.c !== undefined) {
    const c = л.c;
    if (/\s/u.test(c)) {
      л.i += 1;
    } else if (ЦИФРА.test(c)) {
      out.push(л.число(false));
    } else if (БУКВА.test(c)) {
      out.push(...л.буква());
    } else if (c === '^' || c === '_') {
      л.i += 1;
      out.push(...скрипт(c, аргумент()));
    } else if (c === '{' || c === '}') {
      out.push(c);
      л.i += 1;
    } else {
      const уступ = л.уступ();
      if (уступ) {
        out.push(...уступ);
        continue;
      }
      const знак = ЗНАКИ[c];
      if (!знак || c === '%') {
        if (c !== '%') throw new НеДоказано();
        out.push('%');
      } else {
        out.push(знак);
      }
      л.i += 1;
    }
  }
  return out;
}

const ВТОРОЙ_СЛОЙ = new Set(['+', '-', '=', '<', '>', '≤', '≥', '≠', '≈', '±', ',', ';']);

/** Есть ли сложение или отношение вне скобок: такому верху дроби в строке нужны скобки. */
function естьСложениеСверху(ряд: readonly string[]): boolean {
  let глубина = 0;
  for (const з of ряд) {
    if (з === '(' || з === '[' || з === ГРУППА || з === ДРОБЬ_ОТ) глубина += 1;
    else if (з === ')' || з === ']' || з === КОНЕЦ_ГРУППЫ || з === ДРОБЬ_ДО) глубина -= 1;
    else if (глубина === 0 && ВТОРОЙ_СЛОЙ.has(з)) return true;
  }
  return false;
}

/** Один ли это множитель: `b`, `x^2`, `x_1`, `(a+b)`, `f(x)`, `√x`. Такому низу дроби скобки не нужны. */
function одинМножитель(ряд: readonly string[]): boolean {
  let и = 0;
  const простой = (): 'буква' | 'другое' | null => {
    const з = ряд[и];
    if (з === undefined) return null;
    if (з === '√') {
      и += 1;
      return простой() ? 'другое' : null;
    }
    if (з === '(') {
      let глубина = 0;
      for (; и < ряд.length; и += 1) {
        if (ряд[и] === '(') глубина += 1;
        if (ряд[и] === ')' && (глубина -= 1) === 0) break;
      }
      if (глубина !== 0) return null;
      и += 1;
      return 'другое';
    }
    if (ЦИФРА.test(з[0] ?? '')) {
      и += 1;
      return 'другое';
    }
    if (БУКВА.test(з) || /^\w+:./u.test(з)) {
      и += 1;
      return 'буква';
    }
    return null;
  };
  const уступы = (): void => {
    while (ряд[и] === '^' || ряд[и] === '_' || ряд[и] === "'") {
      if (ряд[и] === "'") {
        и += 1;
        continue;
      }
      и += 1;
      if (ряд[и] === ГРУППА) {
        let глубина = 0;
        for (; и < ряд.length; и += 1) {
          if (ряд[и] === ГРУППА) глубина += 1;
          if (ряд[и] === КОНЕЦ_ГРУППЫ && (глубина -= 1) === 0) break;
        }
      }
      и += 1;
    }
  };
  const вид = простой();
  if (!вид) return false;
  уступы();
  if (вид === 'буква' && ряд[и] === '(') {
    простой();
    уступы();
  }
  return и === ряд.length;
}

const МОЖНО_ПЕРЕД = new Set([undefined, '+', '-', '=', '<', '>', '≤', '≥', '≠', '≈', '±', ',', ';', ':', '(', '[', '{', '|', ГРУППА, '*', '→', '⇒', '⇔', '∈']);
const МОЖНО_ПОСЛЕ = new Set([undefined, '+', '-', '=', '<', '>', '≤', '≥', '≠', '≈', '±', ',', ';', ':', ')', ']', '}', '|', КОНЕЦ_ГРУППЫ, '*', '/', '→', '⇒', '⇔', '∈', '.']);

/** Дробь в строчной записи: скобки вокруг неё — только где без них значение было бы другим. */
function снятьМеткиДробей(ряд: readonly string[]): string[] {
  const out: string[] = [];
  for (let и = 0; и < ряд.length; и += 1) {
    if (ряд[и] !== ДРОБЬ_ОТ) {
      out.push(ряд[и] as string);
      continue;
    }
    let глубина = 0;
    let к = и;
    for (; к < ряд.length; к += 1) {
      if (ряд[к] === ДРОБЬ_ОТ) глубина += 1;
      if (ряд[к] === ДРОБЬ_ДО && (глубина -= 1) === 0) break;
    }
    const внутри = снятьМеткиДробей(ряд.slice(и + 1, к));
    const безСкобок = МОЖНО_ПЕРЕД.has(out[out.length - 1]) && МОЖНО_ПОСЛЕ.has(ряд[к + 1]);
    out.push(...(безСкобок ? внутри : ['(', ...внутри, ')']));
    и = к;
  }
  return out;
}

/** Формула LaTeX → тот же ряд знаков. Команда не из списка или странная запись — отказ. */
function разобратьФормулу(формула: string): string[] {
  const л = new Лента(формула);
  const аргумент = (): string[] => {
    while (/\s/u.test(л.c ?? '')) л.i += 1;
    const c = л.c;
    if (c === undefined) throw new НеДоказано();
    if (c === '{') {
      л.i += 1;
      return ряд(true);
    }
    if (c === '\\') {
      л.i += 1;
      return команда();
    }
    // Без скобок LaTeX берёт ровно один символ: `10^23` — это 10² и 3, а не 10²³.
    л.i += 1;
    if (ЦИФРА.test(c) || БУКВА.test(c)) return [c];
    const знак = ЗНАКИ[c];
    if (!знак) throw new НеДоказано();
    return [знак];
  };
  const команда = (): string[] => {
    const c = л.c;
    if (c === undefined) throw new НеДоказано();
    if (!/[A-Za-z]/u.test(c)) {
      л.i += 1;
      if (c === ',' || c === ';' || c === ':' || c === '!' || c === ' ') return [];
      if (c === '%') return ['%'];
      if (c === '{' || c === '}') return [c];
      throw new НеДоказано();
    }
    let имя = '';
    while (/[A-Za-z]/u.test(л.c ?? '')) имя += л.символы[л.i++];
    if (ДРОБИ.has(имя)) {
      const верх = аргумент();
      const низ = аргумент();
      const сверху = естьСложениеСверху(верх) ? ['(', ...верх, ')'] : верх;
      const снизу = одинМножитель(снятьМеткиДробей(низ)) ? низ : ['(', ...низ, ')'];
      return [ДРОБЬ_ОТ, ...сверху, '/', ...снизу, ДРОБЬ_ДО];
    }
    if (имя === 'sqrt') {
      if (л.c === '[') throw new НеДоказано();
      const под = аргумент();
      return ['√', ...(одинМножитель(снятьМеткиДробей(под)) ? под : ['(', ...под, ')'])];
    }
    if (ОБЁРТКИ.has(имя)) return аргумент();
    if (АКЦЕНТЫ[имя]) {
      const под = аргумент();
      if (под.length !== 1 || !БУКВА.test(под[0] as string)) throw new НеДоказано();
      return [`${АКЦЕНТЫ[имя]}:${под[0]}`];
    }
    if (КОМАНДЫ_ВИДА.has(имя)) {
      if (л.c === '.') throw new НеДоказано();
      return [];
    }
    if (ФУНКЦИИ.has(имя)) return [...имя];
    const знак = КОМАНДЫ_ЗНАКОВ[имя];
    if (!знак) throw new НеДоказано();
    return [знак];
  };
  const ряд = (доСкобки: boolean): string[] => {
    const out: string[] = [];
    while (л.c !== undefined) {
      const c = л.c;
      if (/\s/u.test(c) || c === '~') {
        л.i += 1;
      } else if (c === '}') {
        if (!доСкобки) throw new НеДоказано();
        л.i += 1;
        return out;
      } else if (c === '{') {
        л.i += 1;
        out.push(...ряд(true));
      } else if (c === '\\') {
        л.i += 1;
        out.push(...команда());
      } else if (c === '^' || c === '_') {
        л.i += 1;
        out.push(...скрипт(c, аргумент()));
      } else if (ЦИФРА.test(c)) {
        out.push(л.число(true));
      } else if (БУКВА.test(c)) {
        out.push(...л.буква());
      } else {
        const уступ = л.уступ();
        if (уступ) {
          out.push(...уступ);
          continue;
        }
        const знак = ЗНАКИ[c];
        // Голый % в LaTeX — комментарий до конца формулы, остальное незнакомо.
        if (!знак) throw new НеДоказано();
        out.push(знак);
        л.i += 1;
      }
    }
    if (доСкобки) throw new НеДоказано();
    return out;
  };
  return снятьМеткиДробей(ряд(false));
}

/** Слова в формуле не живут: `Total cost`, `x is 5`. Сокращения и имена функций — можно. */
function естьСлова(кусок: string): boolean {
  return (кусок.match(/[A-Za-z]{2,}/gu) ?? []).some((с) => {
    if (ФУНКЦИИ.has(с)) return false;
    if (с.length === 2) return КОРОТКИЕ_СЛОВА.has(с);
    return !(с === с.toUpperCase() && с.length <= 5);
  });
}

/** Доказать, что формулы на этом месте строки — та же запись, что в исходном куске. */
function формулаНаМесте(место: string, формулы: readonly string[], вТаблице: boolean): boolean {
  if (!место.trim()) return false;
  if ((место.match(/`/gu) ?? []).length % 2 !== 0) return false;
  if ([...место.matchAll(/`([^`]*)`/gu)].some((м) => похожеНаКод(м[1] ?? ''))) return false;
  const кусок = место.replace(/`/gu, '');
  if (естьСлова(кусок)) return false;
  // В строке таблицы «|» — граница столбца, и в формуле его быть не может.
  if (вТаблице && (кусок.includes('|') || формулы.some((ф) => ф.includes('|')))) return false;
  try {
    const а = разобратьИсходное(кусок);
    const б = формулы.flatMap((ф) => разобратьФормулу(ф));
    return а.length > 0 && а.length === б.length && а.every((з, и) => з === б[и]);
  } catch (error) {
    if (error instanceof НеДоказано) return false;
    throw error;
  }
}

/** Куски строки, внутри которых формул быть не может: ссылки, адреса, код, заголовок выноски. */
function запретныеКуски(строка: string): Array<[number, number]> {
  const куски: Array<[number, number]> = [];
  for (const образец of [/!?\[\[[^\]]*\]\]/gu, /!?\[[^\]]*\]\([^)]*\)/gu, /https?:\/\/\S+/gu, /\[![a-z]+\][+-]?/gu]) {
    for (const м of строка.matchAll(образец)) куски.push([м.index, м.index + м[0].length]);
  }
  for (const м of строка.matchAll(/`([^`]*)`/gu)) if (похожеНаКод(м[1] ?? '')) куски.push([м.index, м.index + м[0].length]);
  return куски;
}

const В_ДОЛЛАРАХ = /\$\$([^$]+?)\$\$|\$((?:\\.|[^$\\])+?)\$/gu;

/**
 * Строка с формулами из ответа модели, собранная заново: всё вне формул — байты
 * исходной строки, в формулах — то, что написала модель и что доказано равным.
 * Не доказано — null. Формул в ответе нет — исходная строка как есть.
 */
export function mergeFormulaLine(исходная: string, ответ: string): string | null {
  const вТаблице = /^[\s>]*\|/u.test(исходная);
  const запретные = запретныеКуски(исходная);
  let стало = '';
  let позиция = 0;
  let копятся: string[] = [];
  let сырые: string[] = [];
  const закрыть = (конец: number): boolean => {
    const место = исходная.slice(позиция, конец);
    if (копятся.length === 0) {
      if (место.trim()) return false;
      стало += место;
      return true;
    }
    const от = позиция + (место.length - место.trimStart().length);
    const до = конец - (место.length - место.trimEnd().length);
    if (запретные.some(([а, б]) => от < б && а < до)) return false;
    if (!формулаНаМесте(место, копятся, вТаблице)) return false;
    // Цифра сразу за закрывающим `$` Obsidian не даст нарисовать формулу.
    if (!/\s$/u.test(место) && ЦИФРА.test(исходная[конец] ?? '')) return false;
    стало += `${/^\s*/u.exec(место)?.[0] ?? ''}${сырые.join(' ')}${/\s*$/u.exec(место)?.[0] ?? ''}`;
    копятся = [];
    сырые = [];
    return true;
  };
  const вне = (кусок: string): boolean => {
    const текст = кусок.trim();
    if (!текст) return true;
    // Знак доллара вне формулы — незакрытая формула: в исходной строке его не было.
    if (текст.includes('$')) return false;
    // Кусок может встретиться и раньше: точка конца предложения — и внутри числа 437.5.
    // Подходит то место, для которого формула перед ним доказана.
    for (let где = исходная.indexOf(текст, позиция); где >= 0; где = исходная.indexOf(текст, где + 1)) {
      if (!закрыть(где)) continue;
      стало += текст;
      позиция = где + текст.length;
      return true;
    }
    return false;
  };
  let последний = 0;
  let формул = 0;
  for (const найдено of ответ.matchAll(В_ДОЛЛАРАХ)) {
    if (!вне(ответ.slice(последний, найдено.index))) return null;
    // С пробелом у знака доллара Obsidian формулу не рисует, и строка покажет доллары.
    if (найдено[2] !== undefined && найдено[2] !== найдено[2].trim()) return null;
    копятся.push(найдено[1] ?? найдено[2] ?? '');
    сырые.push(найдено[0]);
    формул += 1;
    последний = найдено.index + найдено[0].length;
  }
  if (формул === 0) return ответ.trim() === исходная.trim() ? исходная : null;
  if (!вне(ответ.slice(последний))) return null;
  if (!закрыть(исходная.length)) return null;
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
    'Меняй только запись формул. Ни слово, ни число, ни буква, ни знак действия, ни скобка не меняются и не переставляются; ничего не добавляй и не исправляй, даже если кажется ошибкой: умножения, которого нет, не добавляй (2x остаётся 2x). Текст вне формул и разметка в начале строки («- », «> », «| ») — посимвольно как в исходной строке.',
    'Только простой LaTeX: \\dfrac, ^, _, \\cdot, \\times, \\le, \\ge, \\ne, \\approx, \\pm, \\sqrt, \\%, греческие буквы. Дробь пиши через \\dfrac, только если в строке она записана через косую черту; запятая в числе — {,}. Слова внутрь $…$ не бери.',
    '',
    'Формат ответа: ровно по одной строке на каждый номер, ни один номер не пропускай. Есть формулы — «номер| строка целиком». Нет — только «номер|».',
    '',
    'Строки:',
    ...строки.map((с, i) => `${i + 1}| ${с.line}`),
  ].join('\n');
}

export interface FormulaChange {
  /** Номер строки заметки, с нуля, когда её меняли. */
  index: number;
  before: string;
  after: string;
}

export interface FormulaResult {
  /** Заметка после замены строк. */
  text: string;
  /** Сколько строк получили формулы. */
  lines: number;
  /** Строк, которые модель изменила, а проверка не смогла доказать равенство: остались как были. */
  rejected: number;
  /** На сколько строк модель не ответила: ответ оборвался или строки пропущены. */
  missing: number;
  changes: FormulaChange[];
  /** Что именно не принято: человеку должно быть видно, какие строки остались текстом. */
  refused: Array<{ line: string; reply: string }>;
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

/** Запись пошла, пока шла работа: прекращаем, ничего не применяя. */
export class FormulaStopped extends Error {}

/**
 * Заметка с формулами в LaTeX. Вызов не вышел — ошибка, и ни одна пачка не
 * применяется. `busy` спрашивается перед каждым вызовом модели.
 */
export async function convertNoteFormulas(
  text: string,
  summarize: (prompt: string) => Promise<string>,
  busy?: () => string | null,
): Promise<FormulaResult> {
  const строки = formulaCandidates(text);
  let итог: FormulaResult = { text, lines: 0, rejected: 0, missing: 0, changes: [], refused: [] };
  for (let i = 0; i < строки.length; i += СТРОК_В_ВЫЗОВЕ) {
    const занято = busy?.();
    if (занято) throw new FormulaStopped(занято);
    const пачка = строки.slice(i, i + СТРОК_В_ВЫЗОВЕ);
    const часть = applyFormulaReply(итог.text, пачка, await summarize(formulaPrompt(пачка)));
    итог = {
      text: часть.text,
      lines: итог.lines + часть.lines,
      rejected: итог.rejected + часть.rejected,
      missing: итог.missing + часть.missing,
      changes: [...итог.changes, ...часть.changes],
      refused: [...итог.refused, ...часть.refused],
    };
  }
  return итог;
}

/** Ответ модели → строки заметки. Ответ не разобрать — ошибка, и заметка останется нетронутой. */
export function applyFormulaReply(text: string, строки: readonly FormulaLine[], ответ: string): FormulaResult {
  const ответы = new Map<number, string>();
  for (const сырая of ответ.split(/\r?\n/u)) {
    const найдено = /^\s*(\d+)\s*\|\s?(.*)$/u.exec(сырая);
    if (найдено) ответы.set(Number(найдено[1]), найдено[2] ?? '');
  }
  if (ответы.size === 0) throw new Error('ответ модели не разобран');
  const все = text.split('\n');
  const changes: FormulaChange[] = [];
  const refused: FormulaResult['refused'] = [];
  let rejected = 0;
  let отвечено = 0;
  for (const [номер, новая] of ответы) {
    const строка = строки[номер - 1];
    if (!строка) {
      rejected += 1;
      refused.push({ line: '', reply: новая });
      continue;
    }
    отвечено += 1;
    if (!новая.trim()) continue;
    const собранная = mergeFormulaLine(строка.line, новая);
    if (собранная === null) {
      rejected += 1;
      refused.push({ line: строка.line, reply: новая });
      continue;
    }
    if (собранная === строка.line) continue;
    const перевод = (все[строка.index] ?? '').endsWith('\r') ? '\r' : '';
    все[строка.index] = `${собранная}${перевод}`;
    changes.push({ index: строка.index, before: строка.line, after: собранная });
  }
  return { text: все.join('\n'), lines: changes.length, rejected, missing: строки.length - отвечено, changes, refused };
}
