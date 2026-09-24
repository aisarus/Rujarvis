/**
 * The only thing Jarvis shows on screen.
 *
 * Someone working by voice cannot see a terminal, and an assistant that gives
 * no sign of what it is doing is indistinguishable from a broken one. This is
 * a small pill in the corner that answers one question at a glance: is it
 * asleep, listening, thinking, working, or talking.
 *
 * It is click-through on purpose. The point of this build is to need no hands,
 * so a window that has to be moved out of the way would be a defect.
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import type { VoiceStatus } from '../jarvis/voice/session';
import { currentLanguage, tr } from '../jarvis/locale/language';

export const STATUS_OVERLAY_CHANNEL = 'jarvis-overlay:status';

const WIDTH = 320;
const HEIGHT = 84;

/**
 * Насколько плашке позволено вырасти.
 *
 * Полный текст — это то, о чём просил человек, но плашка плавает поверх всего,
 * и фраза на пол-экрана закрыла бы саму работу. Двести восемьдесят точек — это
 * примерно восемь строк: длинная просьба помещается целиком, а экран остаётся
 * экраном.
 */
const MAX_HEIGHT = 280;
const MARGIN = 24;

function buildOverlayHtml(): string {
  return `<!doctype html>
<html lang="${currentLanguage()}">
<head><meta charset="utf-8"><title>Jarvis</title>
<style>
  /* Без height: 100% — ни у страницы, ни у плашки.
     Растянутая на окно плашка меряется в собственную высоту окна, и подгонка
     высоты превращается в круг: окно выросло — плашка «стала выше» — окно
     выросло ещё. См. подогнатьВысоту ниже. */
  html, body {
    margin: 0; padding: 0; background: #121216; overflow: hidden;
    font-family: "Segoe UI", system-ui, sans-serif; user-select: none;
  }
  #pill {
    display: flex; align-items: center; gap: 12px; min-height: 52px;
    box-sizing: border-box; padding: 14px 18px;
    /* The whole pill is the drag handle — there is nothing to click inside
       it, so every pixel may as well move it. */
    -webkit-app-region: drag; cursor: move;
    border: 1px solid rgba(255, 255, 255, 0.10);
    color: #f4f4f5;
    transition: opacity 220ms ease;
  }
  #pill.asleep { opacity: 0.45; }
  #dot {
    width: 12px; height: 12px; border-radius: 50%;
    background: #52525b; flex: none;
  }
  #dot.listening { background: #22c55e; animation: pulse 1.2s ease-in-out infinite; }
  #dot.transcribing { background: #38bdf8; animation: pulse 0.9s ease-in-out infinite; }
  #dot.thinking { background: #a78bfa; animation: pulse 0.9s ease-in-out infinite; }
  /* Разговор — жёлтый, как попросил человек. Работа — оранжевая: рядом, но
     различимо, и по подписи тем более. */
  #dot.chatting { background: #facc15; animation: pulse 1.4s ease-in-out infinite; }
  #dot.working { background: #f97316; animation: pulse 1.6s ease-in-out infinite; }
  #dot.speaking { background: #ec4899; animation: pulse 0.7s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  #text { min-width: 0; }
  /* Переносим, а не обрезаем.
     Человек сказал прямо: «вкладка что делаешь должна показывать полный, а не
     обрезанный текст». Раньше строка резалась дважды — на 34 знака в мосте и
     ещё раз многоточием здесь, — и понять, что именно Джарвис расслышал, было
     нельзя. Плашка теперь растёт под текст, а высоту окна подгоняет главный
     процесс. */
  #label {
    font-size: 15px; font-weight: 600; line-height: 1.25;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  #hint {
    font-size: 12px; color: #a1a1aa; margin-top: 3px;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
</style>
</head>
<body>
<div id="pill" class="asleep">
  <div id="dot"></div>
  <div id="text">
    <div id="label">${tr('Сплю', 'Asleep')}</div>
    <div id="hint">${tr('Скажите «Джарвис»', 'Say "Jarvis"')}</div>
  </div>
</div>
<script>
const { ipcRenderer } = require('electron');
const pill = document.getElementById('pill');
const dot = document.getElementById('dot');
const label = document.getElementById('label');
const hint = document.getElementById('hint');

// Последняя услышанная фраза держится на виду несколько секунд.
//
// Без этого человек не знает, что именно Джарвис расслышал и почему ничего не
// сделал: «спасибо» отброшено как вежливость, чужой разговор — как не к нему,
// собственная реплика — как эхо. Всё это уходило только в лог.
let noteUntil = 0;

// Высота окна — по содержимому.
//
// Плашка плавает поверх всего, и фиксированная высота означала обрезанный
// текст. Меряем после отрисовки и просим главный процесс подогнать окно;
// потолок ставит он же, чтобы длинная фраза не заняла пол-экрана.
//
// Мерить можно только то, что НЕ растянуто на окно. С height: 100% плашка
// отдавала высоту самого окна, к ней прибавлялись шестнадцать пикселей, окно
// вырастало — и следующий замер давал ещё больше. Круг упирался в потолок в
// 280 пикселей, и плашка стояла высокой при любом тексте (замер 23.09.2026).
let последняяВысота = 0;
function подогнатьВысоту() {
  requestAnimationFrame(() => {
    const нужно = Math.ceil(document.getElementById('pill').getBoundingClientRect().height) + 2;
    if (нужно === последняяВысота) return;
    последняяВысота = нужно;
    ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':height')}, нужно);
  });
}

ipcRenderer.on(${JSON.stringify(STATUS_OVERLAY_CHANNEL)}, (_event, status) => {
  dot.className = status.indicator;
  label.textContent = status.label;
  pill.classList.toggle('asleep', !status.awake && status.indicator === 'idle');

  if (status.note) {
    hint.textContent = status.note;
    noteUntil = Date.now() + 6000;
    подогнатьВысоту();
    return;
  }
  if (Date.now() < noteUntil) return;

  if (status.indicator === 'speaking' || status.indicator === 'working') {
    hint.textContent = ${JSON.stringify(tr('Говорите, чтобы перебить', 'Speak to interrupt'))};
  } else if (status.awake) {
    hint.textContent = ${JSON.stringify(tr('Слушаю без имени', 'Listening, no name needed'))};
  } else {
    hint.textContent = ${JSON.stringify(tr('Скажите «Джарвис»', 'Say "Jarvis"'))};
  }
  подогнатьВысоту();
});
</script>
</body>
</html>`;
}

export interface StatusOverlay {
  update(status: VoiceStatus): void;
  /** Короткая строка о том, что услышано и что с этим стало. */
  note(status: VoiceStatus, text: string): void;
  dispose(): void;
}

interface SavedPosition {
  x: number;
  y: number;
}

function positionFile(): string {
  return path.join(app.getPath('userData'), 'jarvis-overlay-position.json');
}

/** Where the user last dragged it, if that place still exists. */
function readSavedPosition(): SavedPosition | null {
  try {
    const file = positionFile();
    if (!existsSync(file)) return null;
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<SavedPosition>;
    if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return null;

    // A monitor that has since been unplugged would put the pill off-screen,
    // where it cannot be dragged back.
    const visible = screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      return (
        saved.x! + WIDTH > area.x &&
        saved.x! < area.x + area.width &&
        saved.y! + HEIGHT > area.y &&
        saved.y! < area.y + area.height
      );
    });
    return visible ? { x: saved.x, y: saved.y } : null;
  } catch {
    return null;
  }
}

function savePosition(position: SavedPosition): void {
  try {
    writeFileSync(positionFile(), JSON.stringify(position), 'utf8');
  } catch {
    // Losing the position is not worth reporting to someone working by voice.
  }
}

export function createStatusOverlay(): StatusOverlay {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-overlay-'));
  const pagePath = path.join(dir, 'overlay.html');
  writeFileSync(pagePath, buildOverlayHtml(), 'utf8');

  let window = openWindow(pagePath);

  /**
   * Пересоздание после падения.
   *
   * Окно индикатора действительно падает: в логе `render-process-gone` с
   * кодом доступа к чужой памяти, вместе со службой захвата видео. Без
   * пересоздания человек навсегда теряет единственный признак того, что
   * Джарвис его слышит, — а сам Джарвис при этом продолжает работать.
   */
  const revive = (): void => {
    console.log('[jarvis] окно индикатора упало, поднимаю заново');
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch {
      // Уже мертво — и хорошо.
    }
    window = openWindow(pagePath);
    window.webContents.once('render-process-gone', revive);
  };
  window.webContents.once('render-process-gone', revive);

  /**
   * Отправка в окно.
   *
   * `isDestroyed` тут недостаточно: объект окна жив, а его кадр уже мёртв, и
   * `send` бросает «Render frame was disposed». Раз в секунду, бесконечно —
   * ровно это и залило лог ошибками.
   */
  const send = (payload: unknown): void => {
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(STATUS_OVERLAY_CHANNEL, payload);
    } catch {
      // Кадр исчез между проверкой и отправкой. Индикатор поднимется сам.
    }
  };

  return {
    note(status, text) {
      send({ ...status, note: text });
    },
    update(status) {
      send(status);
    },
    dispose() {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

function openWindow(pagePath: string): BrowserWindow {
  const work = screen.getPrimaryDisplay().workArea;
  const saved = readSavedPosition();
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: saved?.x ?? work.x + work.width - WIDTH - MARGIN,
    y: saved?.y ?? work.y + work.height - HEIGHT - MARGIN,
    frame: false,
    // Not transparent. A transparent frameless window on Windows renders
    // nothing at all here — the window exists, reports itself visible, and
    // paints no pixels. A solid pill that is actually on screen beats a
    // prettier one that is not.
    transparent: false,
    backgroundColor: '#121216',
    // Изменяемое — вынужденно.
    //
    // При `resizable: false` Windows отдаёт странице меньше, чем просили:
    // замер 25.09.2026 при масштабе 125%, просили высоту 134 точки — страница
    // получила 128, и нижние четыре точки плашки оказались срезаны ровно
    // тогда, когда текст перестал помещаться в строку, то есть когда высота и
    // нужна. Со `resizable: true` окно получает ровно запрошенное. Тянуть
    // плашку человеку не за что: вся она — ручка перетаскивания, а её размер
    // главный процесс задаёт заново на каждое обновление.
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  // Высота — по содержимому, а не по константе.
  //
  // Окно просит ровно столько, сколько занял текст. Ширина не меняется: её
  // человек привык видеть, и прыгающая по горизонтали плашка раздражает
  // сильнее обрезанного текста.
  const onHeight = (event: Electron.IpcMainEvent, height: unknown): void => {
    if (event.sender !== window.webContents) return;
    if (typeof height !== 'number' || !Number.isFinite(height)) return;
    if (window.isDestroyed()) return;
    const нужно = Math.max(HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)));
    const было = window.getBounds();
    if (было.height === нужно) return;

    // Ширина задаётся ЧИСЛОМ, а не берётся из прошлых границ.
    //
    // `setBounds({ ...window.getBounds(), height })` выглядит безобидно и
    // течёт: при масштабе экрана 125% круговорот «прочитал границы — вернул
    // их обратно» теряет около пяти процентов ширины на каждом вызове.
    //
    // Замер 23.09.2026, то же окно, шесть обновлений подряд:
    //   из getBounds  269 → 255 → 242 → 229 → 215 → 202 → 189
    //   явной шириной 269 → 307 → 307 → 307 → 307 → 307 → 307
    //
    // А обновление приходит на КАЖДУЮ услышанную фразу. За вечер плашка
    // ужималась с 320 до тридцати с небольшим пикселей: оставалась узкая
    // полоска с точкой состояния, текст в неё не помещался вовсе, и со
    // стороны это выглядело как «Джарвис не запустился».
    //
    // Растём вниз от той же верхней кромки: плашка стоит внизу экрана, и рост
    // вверх выталкивал бы её за край.
    window.setBounds({ x: было.x, y: было.y, width: WIDTH, height: нужно });
  };
  ipcMain.on(`${STATUS_OVERLAY_CHANNEL}:height`, onHeight);
  window.once('closed', () => {
    ipcMain.removeListener(`${STATUS_OVERLAY_CHANNEL}:height`, onHeight);
  });

  // Above full-screen apps too, otherwise the one moment the user most needs
  // to see "работаю" is the moment it is hidden behind a maximised window.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Mouse events are needed for dragging; the window still never takes
  // focus, so moving it does not interrupt whatever the user was typing in.

  window.on('moved', () => {
    const [x, y] = window.getPosition();
    savePosition({ x, y });
  });

  void window.loadFile(pagePath).then(() => {
    if (!window.isDestroyed()) window.showInactive();
  });

  return window;
}
