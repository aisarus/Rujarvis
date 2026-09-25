/**
 * Кто на странице на самом деле едет.
 *
 * Перенесено из Aegis (`operator/src/page-rider.js`) вместе с объяснением.
 *
 * ## Беда, которая стоила двух прогонов
 *
 * Съёмка звала `window.scrollTo` и считала дело сделанным. На чужих страницах
 * это неверно трижды:
 *
 *   1. Едет не окно, а вложенный элемент. Замер: `documentElement.scrollWidth`
 *      986 при экране 986 — документ стоит, вбок везёт внутренний контейнер.
 *   2. Едет не туда. Горизонтальную новеллу вертикальный проезд не открывает
 *      вовсе: едешь вниз, ничего не меняется, снимаешь заставку.
 *   3. Не едет никто: страница ловит колесо и двигает содержимое трансформом.
 *      Это чинится настоящим колесом (`wheelTravel`), а не отсюда.
 *
 * ## Здесь лечится первое и второе
 *
 * Ездока не угадываем по числам, а находим **толчком**: толкаем кандидата на
 * десять пикселей и смотрим, сдвинулся ли он. Элемент с огромным `scrollWidth`,
 * который не двигается (например, `body` под обрезающим `html`), так
 * отсеивается сам — а по числам он выглядел лучшим.
 *
 * ## Почему текст, а не действие
 *
 * Модуль отдаёт **текст скрипта**, а не выполняет его: выполнять умеет только
 * тот, у кого есть страница, а правило должно проверяться без браузера. Ровно
 * поэтому у этого файла есть тест, а у съёмки — нет.
 */

export type Axis = 'вбок' | 'вниз';

/** Имя, под которым найденный ездок живёт в окне страницы. */
export function riderSlot(axis: Axis): string {
  return `__jarvisРидер${axis === 'вбок' ? 'Бок' : 'Низ'}`;
}

/**
 * Скрипт поиска ездока.
 *
 * Возвращает ПОЛНЫЙ проезд по оси (видимая часть + запас) или 0, если ехать
 * некому.
 *
 * `threshold` — сколько пикселей запаса считать содержимым, а не отступом.
 */
export function findRider(axis: Axis, threshold = 40): string {
  const sideways = axis === 'вбок';
  const size = sideways ? 'scrollWidth' : 'scrollHeight';
  const visible = sideways ? 'clientWidth' : 'clientHeight';
  const offset = sideways ? 'scrollLeft' : 'scrollTop';
  const slot = riderSlot(axis);

  return `(() => {
    const кандидаты = [];
    const все = [document.scrollingElement || document.documentElement, document.body, ...document.querySelectorAll('*')];
    for (const el of все) {
      if (!el) continue;
      const запас = (el.${size} || 0) - (el.${visible} || 0);
      if (запас > ${threshold}) кандидаты.push([запас, el]);
    }
    кандидаты.sort((a, b) => b[0] - a[0]);
    for (const [запас, el] of кандидаты) {
      const было = el.${offset};
      el.${offset} = было + 10;
      const поехал = el.${offset} !== было;
      el.${offset} = было;
      if (поехал) { window.${slot} = el; return (el.${visible} || 0) + запас; }
    }
    window.${slot} = null;
    return 0;
  })()`;
}

/** Скрипт проезда: двигаем НАЙДЕННОГО ездока, а не окно. */
export function rideTo(axis: Axis, to: number): string {
  const sideways = axis === 'вбок';
  const offset = sideways ? 'scrollLeft' : 'scrollTop';
  const fallback = sideways ? `window.scrollTo(${to}, 0)` : `window.scrollTo(0, ${to})`;
  const slot = riderSlot(axis);

  return `(() => { const е = window.${slot}; if (е) { е.${offset} = ${to}; } else { ${fallback}; } })()`;
}

/**
 * Какая ось у страницы длиннее.
 *
 * Не «сколько пикселей», а «куда ехать». Горизонтальную новеллу вертикальный
 * проезд не открывает вовсе, и выбрать ось надо ДО съёмки, а не после.
 */
export function longerAxis(sideways: number, down: number): Axis | null {
  const bySide = Number.isFinite(sideways) ? sideways : 0;
  const byDown = Number.isFinite(down) ? down : 0;
  if (bySide <= 0 && byDown <= 0) return null;
  return bySide > byDown ? 'вбок' : 'вниз';
}
