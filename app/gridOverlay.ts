/**
 * Окно с сеткой поверх экрана.
 *
 * Показывает пронумерованные клетки, чтобы точку можно было назвать голосом
 * там, где её нельзя назвать словом: в игре, на холсте, внутри картинки.
 *
 * ## Два решения, продиктованные Windows
 *
 * **Не прозрачное, а полупрозрачное.** Прозрачное окно без рамки на этой
 * машине не рисует ничего — это уже выяснено на индикаторе состояния, и второй
 * раз наступать на те же грабли незачем. Вместо прозрачности — обычное окно с
 * общей непрозрачностью: экран под ним виден приглушённо, номера читаются.
 *
 * **Сквозное для мыши.** `setIgnoreMouseEvents` обязателен: иначе окно, лежащее
 * поверх всего, будет само ловить клики, которые мы пытаемся отправить
 * приложению под ним.
 */

import { BrowserWindow, screen } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { gridLayout, physicalArea, type GridLayout } from '../jarvis/control/grid';

/** Сквозь окно должно быть видно, но номера должны читаться. */
const OPACITY = 0.45;

export interface GridOverlay {
  show(): GridLayout;
  hide(): void;
  layout(): GridLayout;
  visible(): boolean;
  dispose(): void;
}

export function createGridOverlay(): GridOverlay {
  const display = screen.getPrimaryDisplay();

  // Окно ставится в точках Electron, а клик уходит в физических пикселях
  // драйвера мыши. При масштабе 125% это 1536×864 против 1920×1080 — и
  // клетки, посчитанные в координатах окна, промахивались бы тем сильнее,
  // чем правее и ниже цель.
  const area = display.bounds;
  const grid = gridLayout(physicalArea(area, display.scaleFactor));

  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-grid-'));
  const page = path.join(dir, 'grid.html');
  writeFileSync(page, buildGridHtml(grid), 'utf8');

  let window: BrowserWindow | null = null;
  let shown = false;

  const open = (): BrowserWindow => {
    const created = new BrowserWindow({
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      show: false,
    });

    created.setAlwaysOnTop(true, 'screen-saver');
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    created.setOpacity(OPACITY);
    // Клик должен уходить в приложение под сеткой, а не в саму сетку.
    created.setIgnoreMouseEvents(true);
    void created.loadFile(page);
    return created;
  };

  return {
    show() {
      if (!window || window.isDestroyed()) window = open();
      window.showInactive();
      shown = true;
      return grid;
    },
    hide() {
      shown = false;
      if (window && !window.isDestroyed()) window.hide();
    },
    layout: () => grid,
    visible: () => shown,
    dispose() {
      shown = false;
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}

/**
 * Разметка сетки.
 *
 * Номер стоит в середине клетки и обведён тенью: поверх светлого фона белые
 * цифры иначе теряются, а угадывать номер — значит кликать наугад.
 */
function buildGridHtml(grid: GridLayout): string {
  const cells: string[] = [];
  for (let index = 1; index <= grid.cells; index += 1) {
    cells.push(`<div class="cell"><span>${index}</span></div>`);
  }

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<title>Сетка</title>
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    background: #000;
    user-select: none;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(${grid.columns}, 1fr);
    grid-template-rows: repeat(${grid.rows}, 1fr);
    width: 100vw;
    height: 100vh;
  }
  .cell {
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.35);
  }
  .cell span {
    font-family: "Segoe UI", system-ui, sans-serif;
    font-size: 30px;
    font-weight: 700;
    color: #ffffff;
    text-shadow: 0 0 6px #000, 0 0 2px #000;
  }
</style>
</head>
<body>
  <div class="grid">${cells.join('')}</div>
</body>
</html>
`;
}
