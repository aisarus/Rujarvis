/**
 * Кто водит вкладки на этой машине.
 *
 * Два движка, и выбор между ними — не вкусовщина, а разные возможности.
 *
 * **Chromium через Playwright** (Edge, Chrome, своя сборка) точен: локаторы,
 * `evaluate`, настоящее колесо, нажатие по координатам. Но профиль у него
 * СВОЙ: вкладки открываются в чистом браузере, где человек никуда не вошёл.
 * «Включи сериал» в таком окне упирается в форму входа, и пока человек не
 * войдёт в этом профиле, так и будет.
 *
 * **Safari** — тот самый браузер, в котором человек уже сидит: его вкладки,
 * его входы, его подписки. Точности меньше: `do JavaScript` выключен по
 * умолчанию, локаторов нет. Зато у Safari НАСТОЯЩЕЕ дерево доступности — в
 * отличие от Chromium, которому его надо просить, — и наш маковский драйвер
 * читает его без всяких разрешений сверх уже выданных.
 *
 * ## Кого берём по умолчанию
 *
 * На маке — Safari. Причина одна и прикладная: человек просит «включи
 * сериал», «посмотри мою почту», «найди в моих заказах», и всё это про его
 * входы. Браузер, в котором он не вошёл, отвечает на такие просьбы формой
 * входа, а не делом.
 *
 * На Windows — Chromium: Edge стоит всегда, а Safari там нет.
 *
 * Переопределяется `JARVIS_BROWSER=safari|chromium`. Это не тонкая настройка,
 * а выход: человек, которому нужна точность важнее входов, должен иметь
 * возможность сказать это словами один раз, а не бороться каждый день.
 */

import * as chromium from './browser';
import {
  safariListTabs,
  safariOpenTab,
  safariOpenUrl,
  safariReadPage,
  safariДоступен,
} from './safari';

export type Движок = 'safari' | 'chromium';

/**
 * Какой движок взять.
 *
 * Вынесено отдельной функцией и проверяется числами: выбор влияет на то, куда
 * уйдут входы человека, и ошибиться в нём молча нельзя.
 */
export function выбратьДвижок(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Движок {
  const сказано = env.JARVIS_BROWSER?.trim().toLowerCase();
  if (сказано === 'safari') {
    // Просьба человека сильнее платформы — но обещать Safari там, где его нет,
    // нельзя: на Windows это молчаливый отказ вместо работы.
    return safariДоступен(platform) ? 'safari' : 'chromium';
  }
  if (сказано === 'chromium') return 'chromium';
  return safariДоступен(platform) ? 'safari' : 'chromium';
}

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

/**
 * Чем именно водим — в описание инструмента и в журнал.
 *
 * Модель должна знать, с чем имеет дело: в Safari нет локаторов и нажатия идут
 * через дерево доступности, а в своём Chromium человек не вошёл ни на один
 * сайт. Промолчать значит дать ей строить план на неверных допущениях.
 */
export function чемВодим(движок: Движок): string {
  return движок === 'safari'
    ? 'Safari — браузер человека: его вкладки и его входы. Нажатия и ввод идут ' +
        'инструментами окна (window_find, window_press, window_write), а не локаторами.'
    : 'Chromium в отдельном профиле: входы в нём свои и сохраняются между ' +
        'запусками, окна человека не трогаются.';
}
