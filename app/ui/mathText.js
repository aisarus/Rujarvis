'use strict';
/*
 * Формулы окна учёбы — читаемым текстом.
 *
 * Конспект пишется в LaTeX (его рисует Obsidian), и те же `$…$` приходят в
 * вопросы и карточки. Окно показывает только текст (textContent), так что без
 * этого студент видел бы «$\dfrac{l}{f}$» вместо «l/f». Рисовать настоящие дроби
 * значило бы тянуть в окно KaTeX; ради вопроса, который должен просто читаться,
 * хватает значков Юникода.
 *
 * Трогается только то, что внутри `$…$`: остальной текст приходит и от
 * человека (названия курсов, пути), и обратный слеш в нём ничего не значит.
 * Границы формулы — как у Obsidian: открывающий `$` — не перед пробелом,
 * закрывающий — не после пробела и не перед цифрой, поэтому «$5 и $7» — деньги.
 */

const MATH_SYMBOLS = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '*', star: '⋆', circ: '∘', bullet: '•',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', sim: '~', simeq: '≃', cong: '≅', equiv: '≡', propto: '∝', ll: '≪', gg: '≫',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⇒', iff: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  infty: '∞', sum: 'Σ', prod: 'Π', int: '∫', oint: '∮', partial: '∂', nabla: '∇', prime: '′', degree: '°', ldots: '…', cdots: '…', dots: '…', vdots: '⋮',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', setminus: '∖',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', therefore: '∴', because: '∵',
  angle: '∠', perp: '⊥', parallel: '∥', triangle: '△', mid: '|', vert: '|', lvert: '|', rvert: '|', Vert: '‖', lVert: '‖', rVert: '‖',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']',
  quad: ' ', qquad: ' ', space: ' ', newline: ' ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'π', rho: 'ρ', varrho: 'ρ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
const MATH_FRACTIONS = new Set(['frac', 'dfrac', 'tfrac', 'cfrac']);
const MATH_WRAPPERS = new Set(['text', 'textbf', 'textit', 'textrm', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathbb', 'mathcal', 'operatorname', 'boldsymbol', 'bm', 'mbox', 'hbox']);
const MATH_ACCENTS = { bar: '̄', overline: '̅', hat: '̂', widehat: '̂', tilde: '̃', widetilde: '̃', vec: '⃗', dot: '̇', ddot: '̈' };
const MATH_DROPPED = new Set(['left', 'right', 'displaystyle', 'textstyle', 'limits', 'nolimits', 'big', 'Big', 'bigg', 'Bigg', 'bigl', 'bigr', 'Bigl', 'Bigr', 'biggl', 'biggr', 'Biggl', 'Biggr']);
const MATH_SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ' };
const MATH_SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };

// Дробь — метками: нужны ли ей внешние скобки, видно только по соседям.
const FRAC_OPEN = '';
const FRAC_CLOSE = '';
const SAFE_AFTER = /^\s*(?:$|[+\-−=<>≤≥≠≈×·÷,;:)\]}|⟩→⇒⇔∈])/u;
const SAFE_BEFORE = /(?:^|[+\-−=<>≤≥≠≈×·÷,;:(\[{|⟨→⇒⇔∈])\s*$/u;

function mathScript(text, table, mark) {
  const compact = text.replace(/\s+/gu, '');
  if (!compact) return '';
  if (mark === '^' && (compact === '∘' || compact === '°')) return '°';
  if (mark === '^' && compact === '′') return '′';
  const chars = [...compact];
  if (chars.every((c) => table[c])) return chars.map((c) => table[c]).join('');
  return chars.length === 1 ? `${mark}${compact}` : `${mark}(${compact})`;
}

function mathAtom(text) {
  return /^[\p{L}\p{N}\p{M}.,′_^]+(?:\([^()]*\))?$/u.test(text) || /^\([^()]*\)$/u.test(text);
}

/** Разбор формулы: чтение идёт одним проходом, `at` — общая позиция. */
function mathParse(src) {
  let at = 0;

  function group() {
    // После «{»: до парной «}».
    let out = '';
    while (at < src.length && src[at] !== '}') out += step();
    at += 1;
    return out;
  }

  /** Один аргумент команды: {группа}, \команда или один знак. */
  function argument() {
    while (src[at] === ' ') at += 1;
    if (at >= src.length) return '';
    return step();
  }

  function command() {
    const match = /^[A-Za-z]+/u.exec(src.slice(at));
    if (!match) {
      const sign = src[at] ?? '';
      at += 1;
      if (sign === ',' || sign === ';' || sign === ':' || sign === ' ' || sign === '\\') return ' ';
      if (sign === '!') return '';
      if (sign === '|') return '‖';
      return sign;
    }
    const name = match[0];
    at += name.length;
    if (MATH_FRACTIONS.has(name)) {
      const top = argument();
      const bottom = argument();
      const part = (p) => (mathAtom(p) ? p : `(${p})`);
      return `${FRAC_OPEN}${part(top)}/${part(bottom)}${FRAC_CLOSE}`;
    }
    if (name === 'sqrt') {
      let degree = '';
      if (src[at] === '[') {
        const end = src.indexOf(']', at);
        if (end > at) {
          degree = mathScript(mathParse(src.slice(at + 1, end)), MATH_SUP, '^');
          at = end + 1;
        }
      }
      const body = argument();
      return `${degree}√${mathAtom(body) ? body : `(${body})`}`;
    }
    if (MATH_WRAPPERS.has(name)) return argument();
    if (MATH_ACCENTS[name]) return [...argument()].map((c) => `${c}${MATH_ACCENTS[name]}`).join('');
    if (MATH_DROPPED.has(name)) {
      // «\right.» — пустая скобка: её и не видно.
      if ((name === 'left' || name === 'right') && src[at] === '.') at += 1;
      return '';
    }
    if (name === 'begin' || name === 'end') {
      if (src[at] === '{') {
        at += 1;
        group();
      }
      return ' ';
    }
    return MATH_SYMBOLS[name] ?? name;
  }

  function step() {
    const c = src[at];
    if (c === '\\') {
      at += 1;
      return command();
    }
    if (c === '{') {
      at += 1;
      return group();
    }
    if (c === '^' || c === '_') {
      at += 1;
      return mathScript(argument(), c === '^' ? MATH_SUP : MATH_SUB, c);
    }
    at += 1;
    return c === '~' || c === '&' ? ' ' : c;
  }

  let out = '';
  while (at < src.length) out += step();
  return out;
}

function mathParens(text) {
  // С самой глубокой дроби: внутри неё меток уже нет, и соседи видны как есть.
  const inner = new RegExp(`${FRAC_OPEN}([^${FRAC_OPEN}${FRAC_CLOSE}]*)${FRAC_CLOSE}`, 'u');
  let out = text;
  for (let found = inner.exec(out); found; found = inner.exec(out)) {
    const before = out.slice(0, found.index).replaceAll(FRAC_OPEN, '').replaceAll(FRAC_CLOSE, '');
    const after = out.slice(found.index + found[0].length);
    const safe = SAFE_BEFORE.test(before) && SAFE_AFTER.test(after);
    out = `${out.slice(0, found.index)}${safe ? found[1] : `(${found[1]})`}${after}`;
  }
  return out;
}

function mathToText(latex) {
  return mathParens(mathParse(latex)).replace(/\s+/gu, ' ').trim();
}

// В ивритском вопросе формула не должна разворачиваться: изолируем её слева направо.
const FORMULA = /\\\$|\$\$([\s\S]+?)\$\$|\$(?![\s,.;:!?)])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/gu;

function readableMath(text) {
  if (typeof text !== 'string' || !text.includes('$')) return text;
  return text.replace(FORMULA, (all, block, inline) => {
    if (all === '\\$') return '$';
    try {
      return `⁦${mathToText(block ?? inline)}⁩`;
    } catch (_) {
      return all;
    }
  });
}
