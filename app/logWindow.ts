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

import type { StoryLine } from '../jarvis/observe/storyline';
import { currentLanguage, tr } from '../jarvis/locale/language';

export const LOG_WINDOW_CHANNELS = {
  line: 'jarvis-log:line',
  backlog: 'jarvis-log:backlog',
} as const;

const WIDTH = 520;
const HEIGHT = 620;
const MARGIN = 24;
/** Сколько строк помнить, пока окно закрыто. */
const BACKLOG_LIMIT = 500;

export interface СловаШагов {
  one: string;
  few: string;
  many: string;
}

/** Счётчик шагов на двух языках. Русский склоняется, английский — нет. */
export const СЛОВА_ШАГОВ: Record<'ru' | 'en', СловаШагов> = {
  ru: { one: ' шаг', few: ' шага', many: ' шагов' },
  en: { one: ' step', few: ' steps', many: ' steps' },
};

/**
 * Подпись счётчика.
 *
 * Эта функция уезжает в страницу окна исходником (`toString`), поэтому она
 * ничего не знает снаружи себя: ни импортов, ни констант модуля.
 */
export function подписьШагов(n: number, слова: СловаШагов): string {
  const сотня = n % 100;
  const единица = n % 10;
  if (сотня >= 11 && сотня <= 14) return n + слова.many;
  if (единица === 1) return n + слова.one;
  if (единица >= 2 && единица <= 4) return n + слова.few;
  return n + слова.many;
}

/**
 * Догонять ли низ ленты.
 *
 * Правило одно: человек у самого низа — лента прыгает за новой строкой;
 * человек отлистал назад — лента стоит, он читает, а не догоняет. Запас в
 * 40 пикселей — на дробную прокрутку и на масштаб экрана: ровного нуля
 * scrollTop не даёт никогда.
 *
 * Функция уезжает в страницу исходником (`toString`), поэтому не знает
 * ничего снаружи себя. Проверяется она числами, а не поиском слова
 * «follow» в тексте страницы: поиск слова не краснеет, когда знак
 * сравнения перевёрнут, а это и есть настоящая поломка.
 */
export function следуетЗаНизом(scrollHeight: number, clientHeight: number, scrollTop: number): boolean {
  return scrollHeight - clientHeight - scrollTop < 40;
}

export function buildLogWindowHtml(): string {
  return `<!doctype html>
<html lang="${currentLanguage()}">
<head><meta charset="utf-8"><title>${tr('Джарвис — что делаю', 'Jarvis — what I am doing')}</title>
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
<div id="head"><div id="title">${tr('Что делаю', 'What I am doing')}</div><div id="count"></div></div>
<div id="feed"><div id="empty">${tr('Пока ничего не делаю.', 'Nothing going on yet.')}</div></div>
<script>
const feed = document.getElementById('feed');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
let shown = 0;

// Прокрутка следует за низом, пока человек её не тронул. Стоит ему отлистать
// назад - лента перестаёт прыгать: он читает, а не догоняет.
// Правило ниже — та же функция, что проверена тестом числами.
const следуетЗаНизом = ${следуетЗаНизом.toString()};
let follow = true;
feed.addEventListener('scroll', function () {
  follow = следуетЗаНизом(feed.scrollHeight, feed.clientHeight, feed.scrollTop);
});

function clock(at) {
  const d = new Date(at);
  const pad = function (n) { return String(n).padStart(2, '0'); };
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// Счётчик читают, а «1 шагов» читается как ошибка в самой программе.
//
// Правило ниже — та же функция, что проверена тестом: она переносится в
// страницу исходником, а не переписывается заново. Переписанное правило
// разойдётся с проверенным на первой же правке.
const СЛОВА = ${JSON.stringify(СЛОВА_ШАГОВ[currentLanguage()])};
const подписьШагов = ${подписьШагов.toString()};

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
  count.textContent = подписьШагов(shown, СЛОВА);

  // Старое убираем, иначе часовая работа съест память окна.
  while (feed.childElementCount > 1200) feed.removeChild(feed.firstElementChild);
  if (follow) feed.scrollTop = feed.scrollHeight;
}

// Строки приходят через мост из preload: у самой страницы доступа к Node нет.
window.jarvisLog.onLine(function (line) { add(line); });
window.jarvisLog.onBacklog(function (lines) {
  for (const line of lines) add(line);
});
</script>
</body>
</html>`;
}

/**
 * Мост между главным процессом и страницей журнала.
 *
 * В окно льётся вывод агента, а агент читает веб-страницы: однажды туда
 * приедет чужой текст. Пока он выводится через textContent, и выполнить его
 * нельзя — но окно жило с nodeIntegration, и одна будущая правка на innerHTML
 * превратила бы чужую строку в выполнение кода с правами хозяина машины.
 * Теперь страница не умеет require вовсе, а этот preload отдаёт ей ровно две
 * вещи: подписку на строку и подписку на предысторию.
 */
export function buildLogWindowPreload(): string {
  return `const { contextBridge, ipcRenderer } = require('electron');
const CH = ${JSON.stringify(LOG_WINDOW_CHANNELS)};

contextBridge.exposeInMainWorld('jarvisLog', {
  onLine: (handle) => ipcRenderer.on(CH.line, (_event, line) => handle(line)),
  onBacklog: (handle) => ipcRenderer.on(CH.backlog, (_event, lines) => handle(lines)),
});
`;
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
  const preloadPath = path.join(dir, 'preload.js');
  writeFileSync(preloadPath, buildLogWindowPreload(), 'utf8');

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
      title: tr('Джарвис — что делаю', 'Jarvis — what I am doing'),
      backgroundColor: '#0f0f12',
      show: false,
      // Не «всегда сверху»: это окно читают подолгу, и отнимать им место у
      // того, над чем человек работает, значит заставить его это окно закрыть.
      alwaysOnTop: false,
      skipTaskbar: false,
      // Окно журнала показывает чужой текст, поэтому прав у него нет: Node
      // отключён, мир страницы отделён от мира preload, песочница включена.
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
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
