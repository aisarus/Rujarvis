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
    const width = Math.min(1100, Math.round(work.width * 0.8));
    const height = Math.min(820, Math.round(work.height * 0.85));

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

function buildHelpHtml(groups: readonly CatalogueGroup[]): string {
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
  <p class="hint">${tr('Скажите «убери список», чтобы закрыть. Всё остальное можно говорить прямо сейчас.', 'Say "hide the list" to close it. Everything else works right now.')}</p>
  <div class="columns">${sections}</div>
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
