/**
 * Окно, в котором видно, чем Джарвис занят.
 *
 * ## Зачем
 *
 * Замысел человека: одна команда — «сделай сайт по моей биографии в концепции
 * Бруно Симон» — и дальше работа на десятки минут, в которой агент сам роется
 * в архиве, лезет в гитхаб, лепит модели, качает текстуры, пишет физику. Без
 * окна такая работа непроглядна: единственным признаком жизни остаётся голос
 * раз в четверть минуты, а единственным способом понять, что происходит, —
 * читать `jarvis.log`, где дело утоплено в английском шуме подсистем.
 *
 * ## Почему это отдельное окно, а не индикатор
 *
 * Индикатор (statusOverlay) отвечает на один вопрос: слышит ли меня Джарвис.
 * Он крошечный, сквозной для мыши и всегда сверху — и таким должен остаться.
 * Рассказ о работе — другая вещь: его читают, в нём прокручивают назад, он
 * должен уметь не мешать. Поэтому обычное окно, которое человек ставит куда
 * хочет и закрывает, когда надоело.
 *
 * ## Что здесь нарочно сделано
 *
 * **Открывается не воруя фокус.** Человек в этот момент говорит или печатает
 * в другой программе; окно, забравшее клавиатуру, испортило бы и то и другое.
 *
 * **Прокрутка следует за низом, пока человек её не тронул.** Стоит ему
 * отлистать назад — лента перестаёт прыгать: он читает, а не догоняет.
 *
 * **Строки копятся и в закрытом окне.** Открыв его посреди работы, человек
 * видит, что было, а не пустоту.
 */

import { BrowserWindow, screen } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StoryLine } from '../../jarvis/observe/storyline';

export const LOG_WINDOW_CHANNELS = {
  line: 'jarvis-log:line',
  backlog: 'jarvis-log:backlog',
} as const;

const WIDTH = 520;
const HEIGHT = 620;
const MARGIN = 24;
/** Сколько строк помнить, пока окно закрыто. */
const BACKLOG_LIMIT = 500;

export function buildLogWindowHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Джарвис — что делаю</title>
<style>
  html, body {
    margin: 0; padding: 0; height: 100%; background: #0f0f12; overflow: hidden;
    font-family: "Segoe UI", system-ui, sans-serif; color: #e4e4e7;
  }
  #head {
    display: flex; align-items: baseline; gap: 10px;
    padding: 12px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  #title { font-size: 14px; font-weight: 600; }
  #count { font-size: 12px; color: #71717a; }
  #feed {
    height: calc(100% - 44px); overflow-y: auto; padding: 8px 0 16px;
    scrollbar-width: thin; scrollbar-color: #3f3f46 transparent;
  }
  .row {
    display: grid; grid-template-columns: 58px 1fr; gap: 10px;
    padding: 4px 16px; font-size: 13px; line-height: 1.45;
  }
  .time { color: #52525b; font-variant-numeric: tabular-nums; font-size: 12px; }
  .what { min-width: 0; }
  .text { font-weight: 500; }
  .detail {
    color: #a1a1aa; margin-left: 6px; font-weight: 400;
    word-break: break-word;
  }
  .row.task {
    margin-top: 14px; padding-top: 12px;
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .row.task .text { color: #fafafa; font-size: 14px; font-weight: 700; }
  .row.start .text, .row.done .text { color: #4ade80; }
  .row.error .text { color: #f87171; }
  .row.error .detail { color: #fca5a5; }
  .row.said .text { color: #c4b5fd; font-weight: 400; }
  .row.plan .text { color: #fde047; font-weight: 700; }
  .row.plan .detail { color: #fef3c7; }
  .row.note .text { color: #f0abfc; }
  .row.note .detail { color: #f5d0fe; }
  .row.file .text { color: #7dd3fc; }
  .row.command .text { color: #fbbf24; }
  .row.command .detail { font-family: Consolas, "Cascadia Mono", monospace; }
  #empty { padding: 28px 16px; color: #52525b; font-size: 13px; }
</style>
</head>
<body>
<div id="head"><div id="title">Что делаю</div><div id="count"></div></div>
<div id="feed"><div id="empty">Пока ничего не делаю.</div></div>
<script>
const { ipcRenderer } = require('electron');
const CH = ${JSON.stringify(LOG_WINDOW_CHANNELS)};
const feed = document.getElementById('feed');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
let shown = 0;

// Прокрутка следует за низом, пока человек её не тронул. Стоит ему отлистать
// назад - лента перестаёт прыгать: он читает, а не догоняет.
let follow = true;
feed.addEventListener('scroll', function () {
  const bottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop;
  follow = bottom < 40;
});

function clock(at) {
  const d = new Date(at);
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function add(line) {
  if (empty && empty.parentNode) empty.remove();

  const row = document.createElement('div');
  row.className = 'row ' + line.kind;

  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = clock(line.at);

  const what = document.createElement('div');
  what.className = 'what';

  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = line.text;
  what.appendChild(text);

  if (line.detail) {
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = line.detail;
    what.appendChild(detail);
  }

  row.appendChild(time);
  row.appendChild(what);
  feed.appendChild(row);

  shown += 1;
  count.textContent = shown + ' шагов';

  // Старое убираем, иначе часовая работа съест память окна.
  while (feed.childElementCount > 1200) feed.removeChild(feed.firstElementChild);
  if (follow) feed.scrollTop = feed.scrollHeight;
}

ipcRenderer.on(CH.line, function (_event, line) { add(line); });
ipcRenderer.on(CH.backlog, function (_event, lines) {
  for (const line of lines) add(line);
});
</script>
</body>
</html>`;
}

export interface LogWindow {
  /** Добавляет строку: в окно, если оно открыто, и в память в любом случае. */
  append(line: StoryLine): void;
  open(): void;
  close(): void;
  /** Открывает, если закрыто, и наоборот. Возвращает новое состояние. */
  toggle(): boolean;
  isOpen(): boolean;
  dispose(): void;
}

export function createLogWindow(): LogWindow {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-log-'));
  const pagePath = path.join(dir, 'log.html');
  writeFileSync(pagePath, buildLogWindowHtml(), 'utf8');

  const backlog: StoryLine[] = [];
  let window: BrowserWindow | null = null;

  const send = (channel: string, payload: unknown): void => {
    try {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(channel, payload);
    } catch {
      // Кадр исчез между проверкой и отправкой. Строка не стоит падения.
    }
  };

  const open = (): void => {
    if (window && !window.isDestroyed()) {
      // Уже открыто — поднять, но не забирать клавиатуру: человек мог в этот
      // момент печатать в другой программе.
      window.showInactive();
      return;
    }

    const work = screen.getPrimaryDisplay().workArea;
    window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      x: work.x + work.width - WIDTH - MARGIN,
      y: work.y + MARGIN,
      title: 'Джарвис — что делаю',
      backgroundColor: '#0f0f12',
      show: false,
      // Не «всегда сверху»: это окно читают подолгу, и отнимать им место у
      // того, над чем человек работает, значит заставить его это окно закрыть.
      alwaysOnTop: false,
      skipTaskbar: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });

    const current = window;
    current.on('closed', () => {
      if (window === current) window = null;
    });

    void current.loadFile(pagePath).then(() => {
      if (current.isDestroyed()) return;
      current.showInactive();
      // То, что было до открытия: человек, открывший окно посреди работы,
      // должен увидеть её, а не пустоту.
      if (backlog.length > 0) {
        try {
          current.webContents.send(LOG_WINDOW_CHANNELS.backlog, backlog);
        } catch {
          // Окно закрыли за те миллисекунды, что грузилась страница.
        }
      }
    });
  };

  const close = (): void => {
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
  };

  return {
    append(line) {
      backlog.push(line);
      if (backlog.length > BACKLOG_LIMIT) backlog.splice(0, backlog.length - BACKLOG_LIMIT);
      send(LOG_WINDOW_CHANNELS.line, line);
    },
    open,
    close,
    toggle() {
      if (window && !window.isDestroyed()) {
        close();
        return false;
      }
      open();
      return true;
    },
    isOpen() {
      return window !== null && !window.isDestroyed();
    },
    dispose: close,
  };
}
