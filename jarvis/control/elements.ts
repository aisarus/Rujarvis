/**
 * Клик по названию, а не по пикселям.
 *
 * Windows отдаёт дерево доступности — то самое, которым пользуются экранные
 * читалки. В нём у каждой кнопки есть имя и координаты, поэтому «кликни
 * закрыть» не требует ни снимка экрана, ни похода к модели: спросили окно,
 * нашли кнопку, кликнули. Полминуты превращаются в десятые доли секунды.
 *
 * ## Что выяснилось на этой машине
 *
 * Языки перемешаны. Заголовок окна и системные кнопки приходят по-русски
 * («Свернуть», «Закрыть»), меню приложения — по-английски («File», «Edit»), а
 * Блокнот целиком на иврите («סגור כרטיסיה»). Зато `AutomationId` у него
 * английский и стабильный: `CloseButton`, `AddButton`.
 *
 * Отсюда правило: искать по имени, по идентификатору и по смыслу — небольшой
 * словарь соответствий закрывает то, что не закрывают первые два.
 *
 * ## Отказ лучше промаха
 *
 * Не нашли — возвращаем ничего, и задача уходит агенту, который посмотрит на
 * экран. Клик «примерно туда» хуже отсутствия клика: он срабатывает, человек
 * его не ждал, и последствия замечают не сразу.
 */

/** Элемент окна, как его отдаёт драйвер. */
export interface UiElement {
  name: string;
  /** Английский и стабильный даже там, где имя переведено. */
  id: string;
  type: string;
  enabled: boolean;
  /** Центр элемента — туда и кликаем. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Что человек говорит и что написано на кнопке.
 *
 * Только то, что встречается постоянно: подтверждения, отказы, файловые
 * операции, навигация. Словарь намеренно маленький — он не заменяет понимание,
 * а лишь перекидывает мост через язык интерфейса.
 */
const SYNONYMS: Record<string, string[]> = {
  'закрыть': ['close', 'закрыть', 'סגור'],
  'сохранить': ['save', 'сохранить', 'שמור'],
  'открыть': ['open', 'открыть', 'פתח'],
  'отмена': ['cancel', 'отмена', 'ביטול'],
  'ок': ['ok', 'ок', 'אישור'],
  'да': ['yes', 'да', 'כן'],
  'нет': ['no', 'нет', 'לא'],
  'удалить': ['delete', 'remove', 'удалить'],
  'назад': ['back', 'назад'],
  'далее': ['next', 'далее', 'продолжить'],
  'войти': ['sign in', 'log in', 'login', 'войти'],
  'выйти': ['sign out', 'log out', 'logout', 'выйти'],
  'отправить': ['send', 'submit', 'отправить'],
  'поиск': ['search', 'find', 'поиск', 'найти'],
  'файл': ['file', 'файл'],
  'правка': ['edit', 'правка'],
  'вид': ['view', 'вид'],
  'справка': ['help', 'справка'],
  'настройки': ['settings', 'options', 'preferences', 'настройки'],
  'добавить': ['add', 'new', 'добавить'],
  'свернуть': ['minimize', 'свернуть'],
  'развернуть': ['maximize', 'restore', 'развернуть'],
  'печать': ['print', 'печать'],
  'копировать': ['copy', 'копировать'],
  'вставить': ['paste', 'вставить'],
};

/** Типы, по которым вообще имеет смысл кликать. */
const INTERACTIVE = new Set([
  'Button', 'MenuItem', 'TabItem', 'CheckBox', 'RadioButton', 'Hyperlink',
  'ListItem', 'ComboBox', 'Edit', 'SplitButton', 'TreeItem', 'Custom',
]);

/** Ниже этого совпадение слишком случайно, чтобы по нему кликать. */
const MIN_SCORE = 40;

/** Одна буква совпадает с чем угодно; запрос короче этого не рассматриваем. */
const MIN_QUERY_LENGTH = 2;

export function chooseElement(query: string, elements: readonly UiElement[]): UiElement | null {
  const wanted = normalise(query);
  if (wanted.length < MIN_QUERY_LENGTH) return null;

  const variants = expand(wanted);

  let best: UiElement | null = null;
  let bestScore = 0;

  for (const element of elements) {
    // По выключенной кнопке кликать нечего, и выбрать её вместо живой — хуже,
    // чем не найти ничего.
    if (!element.enabled) continue;

    const score = scoreElement(element, variants);
    if (score > bestScore) {
      best = element;
      bestScore = score;
    }
  }

  return bestScore >= MIN_SCORE ? best : null;
}

function scoreElement(element: UiElement, variants: readonly Variant[]): number {
  const name = normalise(element.name);
  const id = normalise(element.id);

  let best = 0;
  for (const variant of variants) {
    const score = Math.max(
      matchScore(name, variant.text, 100),
      matchScore(id, variant.text, 88),
    );
    if (score > 0) best = Math.max(best, score - variant.penalty);
  }
  if (best === 0) return 0;

  // Кнопка предпочтительнее панели во весь экран: панель «содержит» нужное
  // слово ровно потому, что содержит всё окно.
  if (INTERACTIVE.has(element.type)) best += 15;
  if (element.width > 900 && element.height > 600) best -= 30;

  return best;
}

function matchScore(candidate: string, wanted: string, top: number): number {
  if (!candidate || !wanted) return 0;
  if (candidate === wanted) return top;
  if (candidate.startsWith(wanted)) return top - 25;
  if (candidate.includes(wanted)) return top - 40;
  // Обратное вхождение: человек сказал длиннее, чем написано на кнопке.
  if (wanted.includes(candidate) && candidate.length >= 3) return top - 45;
  return 0;
}

interface Variant {
  text: string;
  /** Насколько это совпадение слабее точного: по части фразы — слабее. */
  penalty: number;
}

/**
 * Само слово плюс то, как оно могло быть написано на другом языке.
 *
 * Разбирается и вся фраза, и каждое слово по отдельности: «закрыть вкладку»
 * не найдётся целиком нигде, а «закрыть» превращается в `close` и попадает в
 * `CloseButton`. Совпадение по отдельному слову считается слабее — иначе
 * длинная фраза цеплялась бы за первое попавшееся слово.
 */
function expand(wanted: string): Variant[] {
  const variants = new Map<string, number>();
  const add = (text: string, penalty: number): void => {
    const existing = variants.get(text);
    if (existing === undefined || penalty < existing) variants.set(text, penalty);
  };

  add(wanted, 0);
  for (const item of synonymsOf(wanted)) add(item, 0);

  const words = wanted.split(' ');
  if (words.length > 1) {
    for (const word of words) {
      if (word.length < MIN_QUERY_LENGTH) continue;
      add(word, 10);
      for (const item of synonymsOf(word)) add(item, 10);
    }
  }

  return [...variants].map(([text, penalty]) => ({ text, penalty }));
}

function synonymsOf(wanted: string): string[] {
  const out: string[] = [];
  for (const [word, group] of Object.entries(SYNONYMS)) {
    if (word === wanted || group.includes(wanted)) {
      out.push(word, ...group);
    }
  }
  return out;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
