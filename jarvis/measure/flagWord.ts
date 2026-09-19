/**
 * «false» — это слово, а не ложь.
 *
 * Перенесено из Aegis (`operator/src/flag-word.js`) вместе с историей, потому
 * что история и есть объяснение.
 *
 * ## Беда, пойманная на живом прогоне
 *
 * Голова попросила снять чужую страницу на десктопе и написала честно:
 * `mobile: "false"`. Рычаг сделал `Boolean("false")` — а это **истина**,
 * непустая строка, — и открыл страницу в мобильной ширине. Модель сказала
 * одно, дом сделал другое, и никто не заметил: снимок вышел непустой, ворота
 * его пропустили, в журнале всё «ok».
 *
 * Хуже всего, что беда молчаливая. Отказ виден, а подмена десктопа мобилкой
 * выглядит как обычная работа — и весь разбор идёт по не той раскладке.
 *
 * ## Где это нужно Джарвису
 *
 * Там, где он читает **текст** модели, а не типизированный аргумент. Инструменты
 * MCP описаны через `zod` и приезжают уже разобранными — им это не нужно.
 * А вот разбор ответа маршрутизатора (`applyModelNormalization`,
 * `mergeRouterCapabilities`) читает именно текст, и там слово «нет» обязано
 * значить нет.
 */

const FALSE_WORDS = new Set([
  'false',
  '0',
  'no',
  'нет',
  'off',
  'выкл',
  'выключено',
  'null',
  'undefined',
  'ложь',
  '',
]);

const TRUE_WORDS = new Set([
  'true',
  '1',
  'yes',
  'да',
  'on',
  'вкл',
  'включено',
  'истина',
]);

/**
 * Признак из ответа модели.
 *
 * `fallback` — что считать, когда не сказано ничего. Неизвестное слово тоже
 * уходит в умолчание: «может быть» — это не «да».
 */
export function flagWord(value: unknown, fallback = false): boolean {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;

  const word = String(value).trim().toLowerCase();
  if (FALSE_WORDS.has(word)) return false;
  if (TRUE_WORDS.has(word)) return true;
  return fallback;
}

export { FALSE_WORDS, TRUE_WORDS };
