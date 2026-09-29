/**
 * Нажать в чужом окне по надписи — одним вызовом.
 *
 * Замер 29.09.2026: одно нажатие кнопки у агента — пять вызовов (список
 * окон → снимок → поиск → нажатие → снимок), по 5–8 секунд размышления
 * между ними, около полуминуты. Окно по заголовку и элемент по надписи
 * находятся без модели; ей остаётся один вызов.
 *
 * Здесь только выбор — чистые функции. Спросить окна и нажать делает сервер.
 */

import type { CuaElement, CuaWindow } from './cuaProtocol';

function норма(текст: string): string {
  return текст.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
}

export type ВыборОкна = { окно: CuaWindow } | { нет: true };

/**
 * Окно по части заголовка или имени программы. Точное совпадение — раньше
 * вхождения; из нескольких равных — первое в списке.
 */
export function pickWindow(windows: readonly CuaWindow[], wanted: string): ВыборОкна {
  const искомое = норма(wanted);
  if (!искомое) return { нет: true };
  const точное = windows.find((w) => норма(w.title) === искомое || норма(w.app) === искомое);
  if (точное) return { окно: точное };
  const вхождение = windows.find((w) => норма(w.title).includes(искомое) || норма(w.app).includes(искомое));
  return вхождение ? { окно: вхождение } : { нет: true };
}

export type ВыборЭлемента = { нажать: CuaElement } | { выбрать: CuaElement[] } | { нет: true };

/**
 * Элемент по надписи из найденных по вхождению. Точная надпись — нажать;
 * найден один — нажать; несколько без точного — не гадать, а вернуть список:
 * нажатая не та кнопка хуже лишнего вызова.
 */
export function pickElement(found: readonly CuaElement[], name: string): ВыборЭлемента {
  if (found.length === 0) return { нет: true };
  const искомое = норма(name);
  const точный = found.find((e) => норма(e.name) === искомое);
  if (точный) return { нажать: точный };
  if (found.length === 1) return { нажать: found[0] as CuaElement };
  return { выбрать: found.slice(0, 8) };
}
