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

/**
 * Отдельное слово фразы — не короче трёх букв и только с начала слова.
 *
 * Живой журнал 28.09.2026: распознаватель выдал кашу «нажми на селку им бар
 * билл», и слово «им» нашлось внутри «Имеет доступ к этому сайту» — Джарвис
 * кликнул по случайной надписи. Двухбуквенные слова фразы — почти всегда
 * предлоги и обрывки, а кусок внутри чужого слова — не название.
 */
const MIN_WORD_LENGTH = 3;

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
    const score = variant.word
      ? matchWordScore(name, variant.text, 100)
      : Math.max(matchScore(name, variant.text, 100), matchScore(id, variant.text, 88));
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
  /** Слово из фразы как сказано: совпадает только с началом слова в названии (см. MIN_WORD_LENGTH). */
  word?: boolean;
}

/** Слово фразы против названия: целое слово или его начало, а не кусок внутри. */
function matchWordScore(candidate: string, word: string, top: number): number {
  if (!candidate || !word) return 0;
  const words = candidate.split(' ');
  if (words.includes(word)) return top - 40;
  if (words.some((part) => part.startsWith(word))) return top - 45;
  return 0;
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
  const variants = new Map<string, Variant>();
  const add = (text: string, penalty: number, word = false): void => {
    const existing = variants.get(text);
    if (existing === undefined || penalty < existing.penalty) variants.set(text, { text, penalty, word });
  };

  add(wanted, 0);
  for (const item of synonymsOf(wanted)) add(item, 0);

  const words = wanted.split(' ');
  if (words.length > 1) {
    for (const word of words) {
      // Синонимы проверены заранее и ищутся как раньше («закрыть» → close в
      // CloseButton); слово как сказано — только целиком или с начала слова.
      for (const item of synonymsOf(word)) add(item, 10);
      if (word.length < MIN_WORD_LENGTH) continue;
      add(word, 10, true);
    }
  }

  return [...variants.values()];
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
