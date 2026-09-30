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
  /**
   * Программа окна — отдаёт маковский драйвер. На маке в заголовке окна нет
   * имени программы: у Chrome там только название страницы. Живой журнал
   * тестера 30.09.2026: «переключись на хром» не находило Chrome.
   */
  app?: string;
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

/** Окна, куда можно переключиться, — без своих и служебных. */
export function realWindows<T extends SwitchWindow>(windows: readonly T[]): T[] {
  // На маке своё окно без заголовка приходит программой «Electron».
  return windows.filter((w) => !СВОИ.has(w.title.trim()) || (!w.title.trim() && Boolean(w.app?.trim()) && w.app?.trim() !== 'Electron'));
}

/** Как окно звучит: заголовок и программа — на маке имя программы в заголовке не стоит. */
export function windowLabel(w: SwitchWindow): string {
  const app = w.app?.trim() ?? '';
  const title = w.title.trim();
  return app && !title.toLowerCase().includes(app.toLowerCase()) ? `${title} ${app}`.trim() : title;
}

export type SwitchPlan =
  | { kind: 'element'; element: UiElement }
  | { kind: 'window'; title: string };

export function planSwitch(query: string, windows: readonly SwitchWindow[], elements: readonly UiElement[]): SwitchPlan | null {
  const вкладки = elements.filter((e) => e.enabled !== false && ВКЛАДКОПОДОБНЫЕ.has(e.type) && e.name.trim());
  const внутри = pickBySound(query, вкладки, (e) => e.name);
  if (внутри?.sure && внутри.score >= 0.9) return { kind: 'element', element: внутри.item };

  // По заголовку и по программе — порознь: лишние слова заголовка («Новая
  // вкладка») разбавляли бы звучание программы. Программы — без повторов:
  // два окна Chrome не соперники друг другу.
  const окна = realWindows(windows);
  const поЗаголовку = pickBySound(query, окна, (w) => w.title);
  const программы = [...new Set(окна.map((w) => w.app?.trim() ?? '').filter(Boolean))];
  const поПрограмме = pickBySound(query, программы, (app) => app);
  const заголовок = поЗаголовку?.sure ? поЗаголовку : null;
  const программа = поПрограмме?.sure ? поПрограмме : null;
  if (заголовок && (!программа || заголовок.score >= программа.score)) {
    // Окно без заголовка ищется дальше по программе, а не пустой строкой.
    return { kind: 'window', title: заголовок.item.title.trim() || (заголовок.item.app ?? '') };
  }
  if (программа) return { kind: 'window', title: программа.item };

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
  const окна = realWindows(windows).map((w) => `${windowLabel(w)}${w.focused ? ' (активно)' : w.minimized ? ' (свёрнуто)' : ''}`);
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
