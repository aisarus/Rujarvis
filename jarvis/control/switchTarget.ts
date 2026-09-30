/**
 * «Переключись на …» — куда именно: вкладка внутри окна, другое окно или
 * вопрос.
 *
 * Порядок выбран по тому, что человек обычно имеет в виду:
 *
 * 1. Вкладка или раздел **внутри активного окна**, если звучит уверенно:
 *    в приложении Claude «переключись на код» — это переключатель Code, а не
 *    окно VS Code; в Параметрах «на звук» — раздел «Звук».
 * 2. **Окно** по звучанию заголовка: «клад», «клод» — Claude.
 * 3. Ничего уверенного — null: вызывающий пробует свои запасные пути
 *    (псевдонимы программ, вкладки браузера), а потом отдаёт фразу разговору,
 *    который видит список на экране и выберет или переспросит. «Не нашёл»
 *    человеку — последнее, а не первое.
 */

import type { UiElement } from './elements';
import { pickBySound } from './soundMatch';

export interface SwitchWindow {
  title: string;
  focused?: boolean;
  minimized?: boolean;
}

/** Что внутри окна считается «куда переключиться»: вкладки, разделы, пункты меню. */
const ВКЛАДКОПОДОБНЫЕ = new Set(['TabItem', 'RadioButton', 'ListItem', 'MenuItem', 'TreeItem']);

/**
 * Куда переключаться бессмысленно: свои окна Джарвиса (плашка, окно звука) и
 * невидимые служебные окна системы — живой снимок 30.09.2026 показывал их
 * среди настоящих.
 */
const СВОИ = new Set([
  'Jarvis', 'Jarvis audio', 'Program Manager', '',
  'NVIDIA GeForce Overlay', 'Интерфейс ввода Windows', 'Windows Input Experience',
]);

export type SwitchPlan =
  | { kind: 'element'; element: UiElement }
  | { kind: 'window'; title: string };

export function planSwitch(query: string, windows: readonly SwitchWindow[], elements: readonly UiElement[]): SwitchPlan | null {
  const вкладки = elements.filter((e) => e.enabled !== false && ВКЛАДКОПОДОБНЫЕ.has(e.type) && e.name.trim());
  const внутри = pickBySound(query, вкладки, (e) => e.name);
  if (внутри?.sure && внутри.score >= 0.9) return { kind: 'element', element: внутри.item };

  const окна = windows.filter((w) => !СВОИ.has(w.title.trim()));
  const окно = pickBySound(query, окна, (w) => w.title);
  if (окно?.sure) return { kind: 'window', title: окно.item.title };

  // Внутри окна — уверенно, но не так твёрдо, как в первом шаге: окна не
  // нашлось, значит, человек почти наверняка про вкладку здесь.
  if (внутри?.sure) return { kind: 'element', element: внутри.item };
  return null;
}

/**
 * Что сейчас на экране — коротким текстом для разговора: окна, активное
 * окно и то, что в нём можно нажать или открыть. Модель выбирает из этого
 * списка точное имя, а не сочиняет своё.
 */
export function describeScreen(activeTitle: string, windows: readonly SwitchWindow[], elements: readonly UiElement[], limit = 90): string {
  const окна = windows.filter((w) => !СВОИ.has(w.title.trim())).map((w) => `${w.title}${w.focused ? ' (активно)' : w.minimized ? ' (свёрнуто)' : ''}`);
  const группы = new Map<string, string[]>();
  for (const e of elements) {
    if (!e.name.trim() || e.enabled === false) continue;
    if (!/^(TabItem|RadioButton|ListItem|MenuItem|TreeItem|Button|Hyperlink|Edit|CheckBox|ComboBox|SplitButton|MenuBar)$/u.test(e.type)) continue;
    const имя = e.name.replace(/\s+/gu, ' ').trim().slice(0, 80);
    const список = группы.get(e.type) ?? [];
    if (!список.includes(имя)) список.push(имя);
    группы.set(e.type, список);
  }
  const порядок = ['TabItem', 'RadioButton', 'MenuItem', 'MenuBar', 'ListItem', 'TreeItem', 'Button', 'SplitButton', 'Hyperlink', 'CheckBox', 'ComboBox', 'Edit'];
  const строки: string[] = [`Окна: ${окна.join('; ') || 'нет'}`, `Активное окно: ${activeTitle || 'неизвестно'}`];
  let осталось = limit;
  for (const тип of порядок) {
    const имена = группы.get(тип);
    if (!имена || осталось <= 0) continue;
    const взято = имена.slice(0, осталось);
    осталось -= взято.length;
    строки.push(`${тип}: ${взято.join(' | ')}${имена.length > взято.length ? ` | …ещё ${имена.length - взято.length}` : ''}`);
  }
  return строки.join('\n');
}
