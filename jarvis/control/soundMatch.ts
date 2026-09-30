/**
 * Сравнение на слух, а не по буквам.
 *
 * Человек говорит по-русски, а окна и кнопки называются как придётся:
 * «Claude», «ChatGPT», «Code», «Settings». Распознавание к тому же слышит одно
 * слово по-разному. Живой журнал 30.09.2026: «переключись на клад», «на клуб»,
 * «на клод» — окно «Claude» открыто, нашлось только с «клод»; «переключись на
 * чат» — ChatGPT не нашёлся вовсе.
 *
 * Поэтому и сказанное, и написанное сводятся к одному звучанию:
 *
 * - латиница — в кириллицу по английскому произношению («Claude» → «клод»,
 *   «Edge» → «эдж», «ChatGPT» → «чатгпт»);
 * - безударные гласные сливаются, как их и слышит распознавание: «клод» и
 *   «клад» — одно;
 * - звонкие на конце оглушаются: «клод» и «клот»;
 * - дальше — по словам: целиком, началом слова («чат» → ChatGPT) или с
 *   допуском в одну-две буквы по длине.
 *
 * Не угадывает: две близкие цели — это вопрос, а не выбор (`pickBySound`).
 */

/** Латиница → кириллица по английскому произношению: сначала сочетания, потом буквы. */
const ЛАТИНИЦА: Array<[RegExp, string]> = [
  [/tion/gu, 'шн'],
  [/you/gu, 'ю'],
  [/sch/gu, 'ш'],
  [/tch/gu, 'ч'],
  [/dge/gu, 'дж'],
  [/ght/gu, 'т'],
  [/sh/gu, 'ш'],
  [/ch/gu, 'ч'],
  [/zh/gu, 'ж'],
  [/kh/gu, 'х'],
  [/ph/gu, 'ф'],
  [/th/gu, 'т'],
  [/ck/gu, 'к'],
  [/qu/gu, 'кв'],
  [/wh/gu, 'в'],
  [/oo/gu, 'у'],
  [/ee/gu, 'и'],
  [/ea/gu, 'и'],
  [/au/gu, 'о'],
  [/aw/gu, 'о'],
  [/ou/gu, 'ау'],
  [/ow/gu, 'оу'],
  [/ai/gu, 'эй'],
  [/ay/gu, 'эй'],
  [/ey/gu, 'эй'],
  [/oi/gu, 'ой'],
  [/oy/gu, 'ой'],
  [/ie/gu, 'и'],
  [/ui/gu, 'у'],
  [/gh/gu, 'г'],
  [/c(?=[eiy])/gu, 'с'],
  [/x/gu, 'кс'],
  [/j/gu, 'дж'],
  [/^y/gu, 'й'],
];

const БУКВЫ: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', k: 'к', l: 'л', m: 'м', n: 'н',
  o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', y: 'и', z: 'з',
};

const ГЛАСНЫЕ: Record<string, string> = { о: 'а', я: 'а', е: 'и', э: 'и', ы: 'и', ю: 'у', й: 'и' };
const ОГЛУШЕНИЕ: Record<string, string> = { б: 'п', в: 'ф', г: 'к', д: 'т', ж: 'ш', з: 'с' };

/** Слова, которые не часть названия: «переключись НА клод», «окно С ютубом». */
const СВЯЗКИ = new Set(['на', 'в', 'во', 'с', 'со', 'по', 'к', 'и', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'and']);

function словоЛатиницей(слово: string): string {
  let s = слово;
  for (const [от, в] of ЛАТИНИЦА) s = s.replace(от, в);
  // Немая «e» на конце после согласной: Claude, Code, Blade.
  // Перед ней может стоять и уже переведённая буква («dge» → «дж»), и ещё нет.
  s = s.replace(/(?<=[bcdfgklmnpqrstvzбвгджзклмнпрстфхцчшщ])e$/u, '');
  return [...s].map((c) => БУКВЫ[c] ?? c).join('');
}

/** Одно слово → звучание. */
function звучание(слово: string): string {
  const латиница = /[a-z]/u.test(слово) ? словоЛатиницей(слово) : слово;
  let s = [...латиница.replace(/ё/gu, 'е').replace(/[ьъ]/gu, '')].map((c) => ГЛАСНЫЕ[c] ?? c).join('');
  const последняя = s.at(-1) ?? '';
  if (ОГЛУШЕНИЕ[последняя]) s = s.slice(0, -1) + ОГЛУШЕНИЕ[последняя];
  // Двойные — одной: «сеттингс», «ватсапп».
  return s.replace(/(.)\1+/gu, '$1');
}

/** Текст → звучание по словам, без связок и знаков. Цифры остаются. */
export function soundWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w && !СВЯЗКИ.has(w))
    .map(звучание)
    .filter(Boolean);
}

/** Расстояние Левенштейна; дальше `max` не считаем. */
function расстояние(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let строкаМин = i;
    for (let j = 1; j <= b.length; j += 1) {
      const v = Math.min((prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1), (prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1);
      cur.push(v);
      строкаМин = Math.min(строкаМин, v);
    }
    if (строкаМин > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

/** Сколько ошибок прощать слову такой длины: коротким — ни одной. */
function допуск(длина: number): number {
  return длина <= 3 ? 0 : длина <= 5 ? 1 : длина <= 8 ? 2 : 3;
}

function словоКСлову(сказано: string, написано: string): number {
  if (сказано === написано) return 1;
  // «чат» — начало «чатгпт»; «код» — начало «кодекс».
  if (сказано.length >= 3 && написано.startsWith(сказано)) return 0.92;
  // Сказали длиннее, чем написано: «клауди» про «Claude».
  if (написано.length >= 3 && сказано.startsWith(написано)) return 0.85;
  const d = расстояние(сказано, написано, допуск(Math.min(сказано.length, написано.length)));
  return d <= допуск(Math.min(сказано.length, написано.length)) ? 0.9 - 0.07 * d : 0;
}

/**
 * Насколько сказанное похоже на название, от 0 до 1. Каждое сказанное слово
 * ищет своё в названии; лишние слова названия чуть снижают счёт — из «Claude» и
 * «Claude Code — документация» по «клод» ближе первое.
 */
export function soundScore(query: string, label: string): number {
  const с = soundWords(query);
  const н = soundWords(label);
  if (с.length === 0 || н.length === 0) return 0;
  const слитноС = с.join('');
  const слитноН = н.join('');
  if (слитноС === слитноН) return 1;
  let сумма = 0;
  for (const слово of с) сумма += Math.max(...н.map((w) => словоКСлову(слово, w)));
  let счёт = сумма / с.length;
  // Разбитое распознаванием слово: «дит хаб» про GitHub.
  if (с.length > 1 || н.length > 1) {
    const d = расстояние(слитноС, слитноН, допуск(Math.min(слитноС.length, слитноН.length)));
    if (d <= допуск(Math.min(слитноС.length, слитноН.length))) счёт = Math.max(счёт, 0.88 - 0.1 * d);
  }
  const лишних = Math.max(0, н.length - с.length);
  return счёт * Math.max(0.8, 1 - 0.03 * лишних);
}

export interface SoundPick<T> {
  item: T;
  score: number;
  /** Уверенно ли: лучший заметно впереди второго. */
  sure: boolean;
  /** Близкие к лучшему — чтобы переспросить, а не угадать. */
  close: T[];
}

/**
 * Лучший по звучанию. Уверенно — если счёт не ниже 0.8 и второй отстаёт хотя
 * бы на 0.08 (или у второго то же название). Ничего похожего — null.
 */
export function pickBySound<T>(query: string, items: readonly T[], label: (item: T) => string, floor = 0.6): SoundPick<T> | null {
  const оценки = items
    .map((item) => ({ item, score: soundScore(query, label(item)) }))
    .filter((x) => x.score >= floor)
    .sort((a, b) => b.score - a.score);
  const лучший = оценки[0];
  if (!лучший) return null;
  const близкие = оценки.filter((x) => x.score >= лучший.score - 0.08 && label(x.item) !== label(лучший.item));
  return {
    item: лучший.item,
    score: лучший.score,
    sure: лучший.score >= 0.8 && близкие.length === 0,
    close: близкие.map((x) => x.item),
  };
}
