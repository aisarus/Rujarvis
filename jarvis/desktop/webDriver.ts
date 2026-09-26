/**
 * Кто водит вкладки на этой машине.
 *
 * Выбор между Chromium и Safari, его причины и умолчание — в
 * `browserChoice.ts`. Здесь только исполнение: один вид наружу, два пути под
 * ним, чтобы наверху — в инструментах, которые читает модель, — различия не
 * было.
 */

import * as chromium from './browser';
// Выбор движка и его описание живут в `browserChoice.ts`, без зависимостей:
// их спрашивает и промт агента, а тянуть туда браузер целиком незачем.
import { выбратьДвижок, type Движок } from './browserChoice';
import { safariListTabs, safariOpenTab, safariOpenUrl, safariReadPage } from './safari';

export { чемВодим, выбратьДвижок, type Движок } from './browserChoice';

/** Что умеют оба движка. Наверху различия быть не должно. */
export interface ВебДвижок {
  движок: Движок;
  openUrl(url: string): Promise<{ title: string; url: string }>;
  readPage(предел?: number): Promise<string>;
  listTabs(): Promise<Array<{ title: string; url: string; active: boolean }>>;
  openTab(url?: string): Promise<{ title: string; url: string }>;
}

/**
 * Читать страницу Safari деревом доступности, когда `do JavaScript` запрещён.
 *
 * Передаётся снаружи, чтобы этот модуль не тянул за собой драйвер рабочего
 * стола: он нужен только на маке и только в этой ветке.
 */
export type ЧтениеДеревом = () => Promise<string>;

export function вебДвижок(черезДерево?: ЧтениеДеревом, движок = выбратьДвижок()): ВебДвижок {
  if (движок === 'safari') {
    return {
      движок,
      openUrl: (url) => safariOpenUrl(url),
      readPage: (предел) => safariReadPage(предел, черезДерево),
      listTabs: () => safariListTabs(),
      openTab: (url) => safariOpenTab(url),
    };
  }
  return {
    движок,
    openUrl: (url) => chromium.openUrl(url),
    readPage: (предел) => chromium.readPage(предел),
    listTabs: () => chromium.listTabs(),
    openTab: (url) => chromium.openTab(url),
  };
}
