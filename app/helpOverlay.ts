/**
 * Окно со списком команд.
 *
 * Команд около восьмидесяти, и человек, который о них не знает, ими не
 * пользуется: для управления голосом незнание команды неотличимо от её
 * отсутствия. Сказал «что ты умеешь» — увидел всё и закрыл.
 *
 * Список строится из таблицы команд, а не пишется здесь: написанный отдельно,
 * он разойдётся с кодом на первой же правке и начнёт обещать несуществующее.
 *
 * Окно, в отличие от сетки, обычное: его читают, а не прицеливаются сквозь
 * него. Поэтому оно непрозрачное, с прокруткой и не перехватывает мышь только
 * потому, что человеку может понадобиться пролистать.
 */

import { BrowserWindow, screen } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandCatalogue, type CatalogueGroup } from '../jarvis/control/catalogue';
import { currentLanguage, tr } from '../jarvis/locale/language';

export interface HelpOverlay {
  show(): void;
  hide(): void;
  visible(): boolean;
  dispose(): void;
}

export function createHelpOverlay(): HelpOverlay {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-help-'));
  const page = path.join(dir, 'help.html');
  writeFileSync(page, buildHelpHtml(commandCatalogue()), 'utf8');

  let window: BrowserWindow | null = null;
  let shown = false;

  const open = (): BrowserWindow => {
    const work = screen.getPrimaryDisplay().workArea;
    /**
     * Окно под список, а не список под окно.
     *
     * Потолки 1100×820 были взяты на глаз, и список в них не помещался.
     * Замер 25.09.2026, список из 71 команды, высота содержимого в лучшем
     * (трёхколоночном) раскладе против высоты окна:
     *
     *   80%/85%, потолок 1100×820  →  1100×734   надо 853, есть 736
     *   90%/90%                    →  1382×778   надо 805, есть 780
     *   92%/92%                    →  1413×795   надо 798, есть 798  ← влезло
     *   96%/94%                    →  1475×812   надо 814, есть 814
     *
     * Потолки остались, но такие, чтобы на обычном экране они не срабатывали
     * и окно не разъезжалось во всю ширину сверхширокого монитора.
     */
    const width = Math.min(1600, Math.round(work.width * 0.92));
    const height = Math.min(1000, Math.round(work.height * 0.92));

    const created = new BrowserWindow({
      width,
      height,
      x: work.x + Math.round((work.width - width) / 2),
      y: work.y + Math.round((work.height - height) / 2),
      frame: false,
      backgroundColor: '#12141a',
      resizable: false,
      skipTaskbar: true,
      // Не забирает фокус: человек говорит, а не печатает, и отобранный
      // фокус выбил бы его из программы, в которой он работал.
      focusable: false,
      alwaysOnTop: true,
      show: false,
    });

    created.setAlwaysOnTop(true, 'screen-saver');
    void created.loadFile(page);
    return created;
  };

  return {
    show() {
      if (!window || window.isDestroyed()) window = open();
      window.showInactive();
      shown = true;
    },
    hide() {
      shown = false;
      if (window && !window.isDestroyed()) window.hide();
    },
    visible: () => shown,
    dispose() {
      shown = false;
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}

/** Что дал замер одной раскладки: высота списка и вылезла ли таблица. */
export interface Проба {
  высота: number;
  вылезает: boolean;
}

/**
 * Сколько колонок брать.
 *
 * «Больше колонок — ниже список» неверно: фраза команды не переносится, и в
 * узкой колонке таблица вылезает за край, а описание переносится на две-три
 * строки — список становится ВЫШЕ. Поэтому раскладки перебираются, а не
 * считаются, и годится та, где список ниже всего и ни одна таблица не шире
 * своей колонки. При равной высоте берём меньшее число колонок: на 1413×795
 * три и четыре дают одинаковые 798.
 *
 * Если не годится ни одна — остаются три: столько же, сколько было до
 * подбора, и с тремя список хотя бы читается.
 *
 * Функция уезжает в страницу исходником (`toString`) и потому не знает
 * ничего снаружи себя. Проверяется она числами того самого замера, а не
 * поиском слова «columnCount» в тексте страницы: поиск слова не краснеет,
 * когда проверка ширины перевёрнута, а это и есть поломка.
 */
export function выбратьКолонки(проба: (n: number) => Проба): number {
  let выбрано = 3;
  let лучшая = Infinity;
  for (let n = 2; n <= 5; n += 1) {
    const итог = проба(n);
    if (итог.вылезает) continue;
    if (итог.высота < лучшая) {
      лучшая = итог.высота;
      выбрано = n;
    }
  }
  return выбрано;
}

export function buildHelpHtml(groups: readonly CatalogueGroup[]): string {
  const sections = groups
    .map((group) => {
      const rows = group.items
        .map(
          (item) =>
            `<tr><td class="say">«${escapeHtml(item.say)}»</td><td class="does">${escapeHtml(item.does)}</td></tr>`,
        )
        .join('');
      return `<section><h2>${escapeHtml(group.title)}</h2><table>${rows}</table></section>`;
    })
    .join('');

  return `<!doctype html>
<html lang="${currentLanguage()}">
<head>
<meta charset="utf-8" />
<title>${tr('Что умеет Джарвис', 'What Jarvis can do')}</title>
<style>
  :root { color-scheme: dark; }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: #12141a;
    color: #e8eaf0;
    font-family: "Segoe UI", system-ui, sans-serif;
    user-select: none;
  }
  body { overflow-y: auto; padding: 22px 26px 30px; box-sizing: border-box; }
  h1 { margin: 0 0 4px; font-size: 21px; font-weight: 700; }
  .hint { margin: 0 0 18px; font-size: 13px; color: #8b93a7; }
  .columns { column-count: 3; column-gap: 26px; }
  section { break-inside: avoid; margin-bottom: 18px; }
  h2 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #6f9df2;
  }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; font-size: 13px; line-height: 1.45; }
  .say { color: #ffffff; white-space: nowrap; padding-right: 10px; }
  .does { color: #9aa3b8; }
</style>
</head>
<body>
  <h1>${tr('Что умеет Джарвис', 'What Jarvis can do')}</h1>
  <p class="hint">${tr('Скажите «убери список», чтобы закрыть. Всё остальное можно говорить прямо сейчас.', 'Say "hide the list" to close it. Everything else works right now.')}<span id="ниже" hidden> ${tr('Список длиннее окна: остальное — прокруткой колеса.', 'The list is longer than the window: scroll the rest with the wheel.')}</span></p>
  <div class="columns">${sections}</div>
<script>
/*
 * Число колонок подбирается замером, а не задаётся на глаз.
 *
 * «Больше колонок — ниже список» неверно: фраза команды не переносится
 * (nowrap), поэтому в узкой колонке таблица вылезает за её край, а описание
 * начинает переноситься на две-три строки — и список становится ВЫШЕ. Замер
 * 25.09.2026, окно 1100×734, высота содержимого:
 *
 *   1 колонка  2072      4 колонки 1095 (одна таблица шире колонки)
 *   2 колонки  1117      5 колонок 1012 (семь таблиц шире)
 *   3 колонки   853      6 колонок 1012 (восемь, и ширина вылезла)
 *
 * Поэтому берём ту раскладку, в которой список ниже всего и ни одна таблица
 * не шире своей колонки. Раскладка зависит от ширины окна: на 1413×795 и три,
 * и четыре колонки дают 798 — выбирается меньшее число.
 */
(function () {
  var columns = document.querySelector('.columns');
  var tables = Array.prototype.slice.call(document.querySelectorAll('table'));
  function вылезает() {
    for (var i = 0; i < tables.length; i += 1) {
      var своя = tables[i].parentElement.getBoundingClientRect().width;
      if (tables[i].getBoundingClientRect().width > своя + 1) return true;
    }
    return false;
  }
  // Правило ниже — та же функция, что проверена тестом числами замера.
  var выбратьКолонки = ${выбратьКолонки.toString()};
  var выбрано = выбратьКолонки(function (n) {
    columns.style.columnCount = String(n);
    void columns.offsetHeight;
    return { высота: document.body.scrollHeight, вылезает: вылезает() };
  });
  columns.style.columnCount = String(выбрано);
  /*
   * На маленьком экране список не влезает и в лучшей раскладке: замер
   * 25.09.2026 на 1366×728 — 823 точки против 672. Молча спрятанный хвост —
   * это «команды нет»: человек не знает ни что он есть, ни чем его достать.
   */
  if (document.body.scrollHeight > document.body.clientHeight + 1) {
    document.getElementById('ниже').hidden = false;
  }
})();
</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}
