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

import { BrowserWindow, ipcMain, nativeImage, screen } from 'electron';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import type { Look } from '../jarvis/setup/settings';
import type { VoiceStatus } from '../jarvis/voice/session';
import { currentLanguage, tr } from '../jarvis/locale/language';
import { currentLook, LOOK_CHANNEL, looksCssUrl, windowBackground } from './look';
import { APP_ROOT, APP_USER_MODEL_ID } from './root';

export const STATUS_OVERLAY_CHANNEL = 'jarvis-overlay:status';

/**
 * Откуда конспект берёт звук: микрофон — лекция в аудитории; звук компьютера —
 * лекция в Zoom, голос лектора приходит из колонок.
 */
export type LectureSource = 'mic' | 'system';

export function isLectureSource(value: unknown): value is LectureSource {
  return value === 'mic' || value === 'system';
}

/** Состояние конспекта, как его показывает кнопка. */
export type LectureButtonState = 'off' | 'starting' | 'on' | 'finishing' | 'importing';

/**
 * Что показать под кнопками, пока идёт лекция: курс, в который она пишется,
 * список курсов для выбора и предупреждение, если лектора плохо слышно.
 */
export interface LectureInfo {
  /** Курс, выбранный человеком или угаданный; null — решит модель по содержанию. */
  course: string | null;
  courses: string[];
  /** Строка под кнопками, пока она верна: «лектора слышно плохо…», «расшифровываю файл…». */
  line?: string;
}

/** Подписи — при сборке страницы: язык читается из настроек позже загрузки модуля. */
function lectureButtonLabels(): Record<LectureButtonState, string> {
  return {
    off: tr('● Конспект', '● Lecture notes'),
    starting: tr('Начинаю…', 'Starting…'),
    on: tr('■ Закончить конспект', '■ Stop lecture notes'),
    finishing: tr('Дописываю итог…', 'Writing the summary…'),
    importing: tr('Конспектирую файл…', 'Notes from a file…'),
  };
}

/** Те же состояния короче — для уменьшенной плашки в одну строку. */
function compactButtonLabels(): Record<LectureButtonState, string> {
  return {
    off: tr('● Запись', '● Record'),
    starting: tr('Начинаю…', 'Starting…'),
    on: tr('■ Стоп', '■ Stop'),
    finishing: tr('Дописываю…', 'Finishing…'),
    importing: tr('Файл…', 'File…'),
  };
}

/** Галочки кнопки размера — рисунком: «▾» в шрифте плашки выходил точкой (снимок 21.10.2026). */
const CHEVRON = {
  down: '<svg viewBox="0 0 12 12" width="1em" height="1em"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 12 12" width="1em" height="1em"><path d="M2.5 7.5 6 4l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** Размер плашки: обычная или уменьшенная (запись и конспект). */
export type OverlaySize = 'full' | 'compact';

export function isOverlaySize(value: unknown): value is OverlaySize {
  return value === 'full' || value === 'compact';
}

const WIDTH = 320;
const HEIGHT = 84;

/**
 * Крупный режим: вдвое больше и контрастнее.
 *
 * Плашка 320×84 со шрифтом 15 пикселей — единственный способ увидеть
 * состояние, и для слабого зрения он не работает вовсе. В крупном режиме
 * шрифт 26, подпись 18, ширина 560: с метра видно, слушает Джарвис или нет.
 *
 * Отдельным режимом, а не «сделаем всем покрупнее»: тому, кто видит хорошо,
 * плашка на полэкрана мешает работать.
 */
const BIG_WIDTH = 560;
const BIG_HEIGHT = 120;

/**
 * Насколько плашке позволено вырасти.
 *
 * Полный текст — это то, о чём просил человек, но плашка плавает поверх всего,
 * и фраза на пол-экрана закрыла бы саму работу. Двести восемьдесят точек — это
 * примерно восемь строк: длинная просьба помещается целиком, а экран остаётся
 * экраном. Плюс ряд кнопок под плашкой: его потолок не должен срезать.
 */
const MAX_HEIGHT = 340;

interface Размер {
  width: number;
  height: number;
}

/**
 * Уменьшенная — одна строка: знак, запись, конспект и кнопки размера. Ширина
 * — по самым длинным подписям рядом («Дописываю…» и «Конспект ↗»), замер
 * 21.10.2026: 304 и 454 точки; уже — и кнопка обрезается многоточием.
 */
const COMPACT_WIDTH = 310;
const COMPACT_HEIGHT = 44;
const BIG_COMPACT_WIDTH = 460;
const BIG_COMPACT_HEIGHT = 70;

const размер = (крупно: boolean, вид: OverlaySize = 'full'): Размер =>
  вид === 'compact'
    ? крупно
      ? { width: BIG_COMPACT_WIDTH, height: BIG_COMPACT_HEIGHT }
      : { width: COMPACT_WIDTH, height: COMPACT_HEIGHT }
    : крупно
      ? { width: BIG_WIDTH, height: BIG_HEIGHT }
      : { width: WIDTH, height: HEIGHT };
const MARGIN = 24;

/**
 * Где встать обычной или уменьшенной плашке: там, где её оставили, но целиком
 * на экране. Уменьшенную могли поставить у правого края — обычная шире и
 * ушла бы за него. Не двигали — в правый нижний угол.
 */
export function fitOnScreen(
  saved: { x: number; y: number } | null,
  size: { width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
): Electron.Rectangle {
  const x = saved?.x ?? area.x + area.width - size.width - MARGIN;
  const y = saved?.y ?? area.y + area.height - size.height - MARGIN;
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - size.width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - size.height)),
    width: size.width,
    height: size.height,
  };
}

function placeOverlay(saved: { x: number; y: number } | null, size: Размер): Electron.Rectangle {
  const area = saved ? screen.getDisplayMatching({ ...saved, ...size }).workArea : screen.getPrimaryDisplay().workArea;
  return fitOnScreen(saved, size, area);
}

export function buildOverlayHtml(look: Look = currentLook()): string {
  return `<!doctype html>
<html lang="${currentLanguage()}" data-look="${look}">
<head><meta charset="utf-8"><title>${tr('Джарвис', 'Jarvis')}</title>
<link rel="stylesheet" href="${looksCssUrl()}">
<style>
  /* Цвета и шрифты — из looks.css, вид — атрибут data-look: его меняют в
     настройках, и плашка перекрашивается сразу.

     Без height: 100% — ни у страницы, ни у плашки.
     Растянутая на окно плашка меряется в собственную высоту окна, и подгонка
     высоты превращается в круг: окно выросло — плашка «стала выше» — окно
     выросло ещё. См. подогнатьВысоту ниже. */
  html, body {
    margin: 0; padding: 0; overflow: hidden; user-select: none;
    /* Запасные значения — на случай, если таблица видов не прочиталась:
       плашка — единственный признак «я слышу», и без стиля она обязана
       остаться читаемой. */
    background: var(--surface, #172042); color: var(--text, #eef1ff);
    font-family: var(--font-ui, "Segoe UI", system-ui, sans-serif);
  }
  /* Клетка тетради — и на плашке, но без красных полей. */
  [data-look="tetrad"] body.paper { --margin-at: -10px; background-size: auto, 16px 16px, 16px 16px, auto; }
  #pill {
    position: relative;
    display: flex; align-items: center; gap: 12px; min-height: 52px;
    box-sizing: border-box; padding: 13px 16px 12px;
    /* The whole pill is the drag handle — there is nothing to click inside
       it, so every pixel may as well move it. */
    -webkit-app-region: drag; cursor: move;
    transition: opacity 220ms ease;
  }
  #pill.asleep { opacity: 0.55; }
  /* Знак состояния. Цвет — у вида свой, смысл один: зелёный слушает,
     голубой распознаёт, сиреневый думает, жёлтый разговаривает, оранжевый
     работает, розовый говорит. Разговор и работа рядом по цвету — различимы
     ещё и подписью. */
  /* Цвет состояния — у всей плашки (data-state): им же в виде «Маркер»
     подчёркнута подпись. */
  #pill { --c: var(--st-idle); }
  #pill[data-state="listening"] { --c: var(--st-listen); }
  #pill[data-state="transcribing"] { --c: var(--st-trans); }
  #pill[data-state="thinking"] { --c: var(--st-think); }
  #pill[data-state="chatting"] { --c: var(--st-chat); }
  #pill[data-state="working"] { --c: var(--st-work); }
  #pill[data-state="speaking"] { --c: var(--st-speak); }
  #dot { width: 12px; height: 12px; border-radius: 50%; background: var(--c); flex: none;
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 22%, transparent); display: flex; align-items: center; justify-content: center; gap: 2px; }
  #dot b { display: none; }
  #dot.idle { box-shadow: none; }
  #dot.listening { animation: pulse 1.2s ease-in-out infinite; }
  #dot.transcribing { animation: pulse 0.9s ease-in-out infinite; }
  #dot.thinking { animation: pulse 0.9s ease-in-out infinite; }
  #dot.chatting { animation: pulse 1.4s ease-in-out infinite; }
  #dot.working { animation: pulse 1.6s ease-in-out infinite; }
  #dot.speaking { animation: pulse 0.7s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  @keyframes spin { to { transform: rotate(360deg); } }
  #text { min-width: 0; }
  /* Переносим, а не обрезаем.
     Человек сказал прямо: «вкладка что делаешь должна показывать полный, а не
     обрезанный текст». Раньше строка резалась дважды — на 34 знака в мосте и
     ещё раз многоточием здесь, — и понять, что именно Джарвис расслышал, было
     нельзя. Плашка теперь растёт под текст, а высоту окна подгоняет главный
     процесс. */
  #label {
    font-size: 15px; font-weight: 600; line-height: 1.3;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  #hint {
    font-size: 12.5px; color: var(--muted); margin-top: 2px;
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  /* Крупный режим. Контраст тоже выше: серый по тёмному читается плохо. */
  body.big #pill { min-height: 88px; padding: 20px 26px; }
  body.big #label { font-size: 26px; line-height: 1.3; }
  body.big #hint { font-size: 18px; color: var(--text-2); margin-top: 6px; }
  body.big #dot { width: 18px; height: 18px; }
  /* Кнопки под плашкой. В аудитории вслух не покомандуешь — живой прогон
     29.09.2026: «нужны физические кнопки под плашкой». Окно по-прежнему не
     берёт фокус, так что нажатие не сбивает то, что человек печатает;
     кнопки вынуты из области перетаскивания, иначе нажатие тащило бы окно.
     Ряд переносится, а не сжимает кнопку: «Закончить конспект» рядом с
     длинным курсом разваливался на три строки (снимок 20.10.2026). */
  #bar {
    display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 11px;
    -webkit-app-region: drag;
  }
  #bar button, #row button {
    -webkit-app-region: no-drag; cursor: pointer;
    font: 500 12.5px var(--font-ui);
    color: var(--text); background: var(--surface-2);
    border: 1.5px solid var(--line); border-radius: var(--radius-btn);
    padding: 4px 11px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  }
  #bar button:hover, #row button:hover { border-color: var(--line-2); }
  #bar button.on, #row button.on { background: var(--bad); border-color: var(--bad); color: var(--surface); font-weight: 600; }
  #bar button:disabled, #row button:disabled { opacity: 0.55; cursor: default; }
  #bar button.drop { border-color: var(--accent); background: var(--accent-soft); }
  body.big #bar button, body.big #row button { font-size: 20px; padding: 10px 18px; }
  #sources { display: none; flex-wrap: wrap; gap: 6px; padding: 0 12px 11px; }
  #sources.open { display: flex; }
  #sources button, #courses button {
    cursor: pointer; font: 500 12px var(--font-ui);
    color: var(--text); background: var(--surface); border: 1.5px solid var(--line);
    border-radius: var(--radius-btn); padding: 4px 10px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #sources button:hover, #courses button:hover { border-color: var(--line-2); }
  body.big #sources button { font-size: 18px; padding: 8px 14px; }
  #courses { display: none; flex-wrap: wrap; gap: 6px; padding: 0 12px 11px; }
  #courses.open { display: flex; }
  #courses button.chosen { border-color: var(--accent); color: var(--accent); }
  body.big #courses button { font-size: 18px; padding: 8px 14px; }
  #info {
    display: none; padding: 0 16px 11px; font-size: 12.5px; color: var(--warn);
    white-space: pre-wrap; overflow-wrap: anywhere;
  }
  #info.on { display: block; }
  body.big #info { font-size: 18px; }

  /* Обычная, уменьшенная и свёрнутая в панель задач. Плашка стоит поверх
     всего, и в лекции с кнопками она закрывала чужие окна — убрать её было
     нечем (тестер 21.10.2026: «нажать "свернуть", и чтобы он превратился в
     иконку внизу»; владелец — размеры на выбор, а свернуть — в панель задач,
     28.10.2026). Кнопки — в углу и вне области перетаскивания, иначе
     нажатие тащило бы окно. */
  #text { padding-right: 44px; }
  #corner { position: absolute; top: 5px; right: 6px; display: flex; gap: 2px; -webkit-app-region: no-drag; }
  #corner button {
    display: flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; cursor: pointer;
    border: 0; border-radius: 6px; background: transparent; color: var(--muted);
    font: 700 14px/1 var(--font-ui);
  }
  #corner button:hover { background: var(--surface-2); color: var(--text); }
  body.big #text { padding-right: 70px; }
  body.big #corner button { width: 32px; height: 32px; font-size: 22px; }
  /* Уменьшенная: знак состояния, запись и готовый конспект — одной строкой.
     Что услышано, не показывается: строка прыгала бы по высоте от каждой
     фразы. Подпись состояния — во всплывающей подсказке. */
  #row { display: none; gap: 6px; align-items: center; min-width: 0; }
  body.compact #text, body.compact #bar, body.compact #courses { display: none !important; }
  body.compact #row { display: flex; }
  body.compact #pill { gap: 8px; padding: 8px 6px 8px 12px; min-height: 0; }
  body.compact #row button { padding: 4px 9px; }
  body.compact #corner { position: static; margin-left: auto; }
  body.big.compact #pill { padding: 12px 10px 12px 18px; }
  body.big.compact #row button { padding: 9px 14px; }

  /* ——— Тетрадь: подсказки от руки ——— */
  [data-look="tetrad"] #hint { font: 600 17px/1.1 var(--font-hand); color: var(--text-2); margin-top: 3px; }
  [data-look="tetrad"] #info { font: 600 17px/1.15 var(--font-hand); }
  [data-look="tetrad"] body.big #hint { font-size: 26px; }

  /* ——— Маркер: состояние — мазком маркера под подписью ——— */
  [data-look="marker"] #dot { width: 10px; height: 10px; border-radius: 3px; box-shadow: none; }
  [data-look="marker"] #pill:not([data-state="idle"]) #label span {
    background: var(--c); color: #1c1e22; border-radius: 3px 8px 4px 9px / 8px 4px 9px 4px;
    padding: 0 .22em; margin: 0 -.1em; -webkit-box-decoration-break: clone; box-decoration-break: clone;
  }
  [data-look="marker"] #label { line-height: 1.5; }
  [data-look="marker"] #bar button.on, [data-look="marker"] #row button.on { background: var(--m-pink); border-color: var(--m-pink); color: #1c1e22; }

  /* ——— Кольцо: знак — кольцо из значка ——— */
  [data-look="ring"] #dot { width: 18px; height: 18px; background: none; border: 3px solid var(--c); box-shadow: none; }
  [data-look="ring"] #dot.idle { border-width: 2px; opacity: 0.8; }
  [data-look="ring"] #dot.listening { box-shadow: 0 0 0 4px color-mix(in srgb, var(--c) 22%, transparent); }
  [data-look="ring"] #dot.working, [data-look="ring"] #dot.thinking, [data-look="ring"] #dot.transcribing {
    border-color: color-mix(in srgb, var(--c) 25%, transparent); border-top-color: var(--c); border-right-color: var(--c);
    animation: spin 1.1s linear infinite;
  }
  [data-look="ring"] #dot.speaking b { display: block; width: 2.5px; height: 7px; border-radius: 2px; background: var(--c); }
  [data-look="ring"] #dot.speaking b:nth-child(2) { height: 11px; }
  [data-look="ring"] #label { font-weight: 500; }
  [data-look="ring"] #bar button, [data-look="ring"] #row button, [data-look="ring"] #sources button, [data-look="ring"] #courses button { border-color: transparent; }
  [data-look="ring"] body.big #dot { width: 26px; height: 26px; }
</style>
</head>
<body class="paper">
<div id="pill" class="asleep" data-state="idle">
  <div id="dot" class="idle"><b></b><b></b><b></b></div>
  <div id="text">
    <div id="label"><span id="labelText">${tr('Сплю', 'Asleep')}</span></div>
    <div id="hint">${tr('Скажите «Джарвис»', 'Say "Jarvis"')}</div>
  </div>
  <div id="row">
    <button id="rec" type="button">${compactButtonLabels().off}</button>
    <button id="open" type="button" title="${tr('Открыть конспект — идущей лекции или последний готовый', 'Open the notes — of the lecture in progress or the latest finished one')}">${tr('Конспект ↗', 'Notes ↗')}</button>
  </div>
  <div id="corner">
    <button id="smaller" type="button" title="${tr('Уменьшить: только запись и конспект', 'Smaller: only recording and notes')}">${CHEVRON.down}</button>
    <button id="mini" type="button" title="${process.platform === 'darwin' ? tr('Свернуть в Dock', 'Minimize to the Dock') : tr('Свернуть в панель задач', 'Minimize to the taskbar')}">–</button>
  </div>
</div>
<div id="bar">
  <button id="lecture" type="button">${lectureButtonLabels().off}</button>
  <button id="course" type="button" style="display:none"></button>
  <button id="file" type="button" title="${tr('Запись лекции или учебный документ (PDF, Word, PowerPoint, фото). Можно перетащить файл сюда', 'A lecture recording or a study document (PDF, Word, PowerPoint, photo). You can drop a file here')}">${tr('Из файла…', 'From a file…')}</button>
  <button id="study" type="button">${tr('Учёба', 'Study')}</button>
</div>
<div id="sources">
  <button id="source-mic" type="button">${tr('В аудитории (микрофон)', 'In the room (microphone)')}</button>
  <button id="source-system" type="button">${tr('Zoom (звук компьютера)', 'Zoom (computer sound)')}</button>
</div>
<div id="courses"></div>
<div id="info"></div>
<script>
const { ipcRenderer } = require('electron');
const pill = document.getElementById('pill');
const lectureButton = document.getElementById('lecture');
const courseButton = document.getElementById('course');
const fileButton = document.getElementById('file');
const coursesBox = document.getElementById('courses');
const info = document.getElementById('info');
const recButton = document.getElementById('rec');
const openButton = document.getElementById('open');
const smallerButton = document.getElementById('smaller');
const lectureLabels = ${JSON.stringify(lectureButtonLabels())};
const CHEVRON = ${JSON.stringify(CHEVRON)};
const compactLabels = ${JSON.stringify(compactButtonLabels())};
const WORDS = ${JSON.stringify({
    course: tr('Курс: ', 'Course: '),
    guess: tr('угадаю по лекции', 'guess from the lecture'),
    guessItem: tr('Угадать по лекции', 'Guess from the lecture'),
    open: tr('Конспект ↗', 'Notes ↗'),
    noNotes: tr('Конспектов нет', 'No notes yet'),
    smaller: tr('Уменьшить: только запись и конспект', 'Smaller: only recording and notes'),
    bigger: tr('Развернуть', 'Expand'),
  })};
const sourcesBox = document.getElementById('sources');
let конспектИдёт = false;
// Начать — сначала выбрать, откуда звук: в аудитории лектора слышит микрофон,
// в Zoom — он звучит из колонок. Закончить — сразу. Так и на уменьшенной.
function нажатьКонспект() {
  if (конспектИдёт) {
    ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':lecture')});
    return;
  }
  sourcesBox.classList.toggle('open');
  подогнатьВысоту();
}
lectureButton.addEventListener('click', нажатьКонспект);
recButton.addEventListener('click', нажатьКонспект);
// Нечего открыть — говорит сама кнопка: строка «услышал…» на уменьшенной
// не видна.
openButton.addEventListener('click', async () => {
  const открыт = await ipcRenderer.invoke(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':open')});
  if (открыт) return;
  openButton.textContent = WORDS.noNotes;
  setTimeout(() => { openButton.textContent = WORDS.open; }, 3000);
});
for (const [id, источник] of [['source-mic', 'mic'], ['source-system', 'system']]) {
  document.getElementById(id).addEventListener('click', () => {
    sourcesBox.classList.remove('open');
    подогнатьВысоту();
    ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':lecture')}, источник);
  });
}
courseButton.addEventListener('click', () => {
  coursesBox.classList.toggle('open');
  подогнатьВысоту();
});
fileButton.addEventListener('click', () => {
  ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':file')}, null);
});
document.getElementById('study').addEventListener('click', () => {
  ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':study')});
});
// Размер: «▾» уменьшает, «▴» возвращает обычную, «–» сворачивает в панель
// задач — обратно плашку возвращает щелчок по её кнопке там.
let вид = 'full';
const SIZE = ${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':size')};
smallerButton.addEventListener('click', (e) => {
  e.stopPropagation();
  ipcRenderer.send(SIZE, вид === 'compact' ? 'full' : 'compact');
});
document.getElementById('mini').addEventListener('click', (e) => {
  e.stopPropagation();
  ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':minimize')});
});
// Файл можно бросить на кнопку: плашка — ручка перетаскивания окна, и файл,
// брошенный на неё, до страницы не доходит, а кнопки из неё вынуты.
for (const цель of [fileButton, lectureButton]) {
  цель.addEventListener('dragover', (e) => { e.preventDefault(); fileButton.classList.add('drop'); });
  цель.addEventListener('dragleave', () => fileButton.classList.remove('drop'));
  цель.addEventListener('drop', (e) => {
    e.preventDefault();
    fileButton.classList.remove('drop');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const путь = require('electron').webUtils.getPathForFile(f);
    if (путь) ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':file')}, путь);
  });
}
function showLecture(state) {
  const now = state === 'on' || state === 'finishing' || state === 'starting' || state === 'importing' ? state : 'off';
  for (const [кнопка, подписи] of [[lectureButton, lectureLabels], [recButton, compactLabels]]) {
    кнопка.textContent = подписи[now];
    кнопка.classList.toggle('on', now === 'on');
    кнопка.disabled = now === 'finishing' || now === 'starting' || now === 'importing';
  }
  courseButton.style.display = now === 'on' ? '' : 'none';
  fileButton.style.display = now === 'off' ? '' : 'none';
  if (now !== 'on') coursesBox.classList.remove('open');
  конспектИдёт = now !== 'off';
  if (конспектИдёт) sourcesBox.classList.remove('open');
}
let последнийСписок = '';
function showLectureInfo(li) {
  const курс = li && li.course;
  courseButton.textContent = WORDS.course + (курс || WORDS.guess) + ' ▾';
  const список = JSON.stringify(li ? [li.course, li.courses] : null);
  if (список !== последнийСписок) {
    последнийСписок = список;
    coursesBox.textContent = '';
    const пункты = (li ? li.courses : []).map((имя) => [имя, имя]).concat([[WORDS.guessItem, '']]);
    for (const [подпись, значение] of пункты) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = подпись;
      b.classList.toggle('chosen', (курс || '') === значение);
      b.addEventListener('click', () => {
        coursesBox.classList.remove('open');
        ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':course')}, значение);
        подогнатьВысоту();
      });
      coursesBox.appendChild(b);
    }
  }
  const строка = li && li.line ? li.line : '';
  info.textContent = строка;
  info.classList.toggle('on', Boolean(строка));
}
const dot = document.getElementById('dot');
const label = document.getElementById('labelText');
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
    const нужно = Math.ceil(
      pill.getBoundingClientRect().height +
      document.getElementById('bar').getBoundingClientRect().height +
      sourcesBox.getBoundingClientRect().height +
      coursesBox.getBoundingClientRect().height +
      info.getBoundingClientRect().height,
    ) + 2;
    if (нужно === последняяВысота) return;
    последняяВысота = нужно;
    ipcRenderer.send(${JSON.stringify(STATUS_OVERLAY_CHANNEL + ':height')}, нужно);
  });
}

// Кнопки под плашкой видны сразу, а не с первой услышанной фразы.
подогнатьВысоту();

// Вид меняют в настройках — плашка перекрашивается сразу, не дожидаясь фразы.
function видПлашки(look) {
  if (['tetrad', 'marker', 'ring'].includes(look) && document.documentElement.dataset.look !== look) {
    document.documentElement.dataset.look = look;
    подогнатьВысоту();
  }
}
ipcRenderer.on(${JSON.stringify(LOOK_CHANNEL)}, (_event, look) => видПлашки(look));

ipcRenderer.on(${JSON.stringify(STATUS_OVERLAY_CHANNEL)}, (_event, status) => {
  // Крупный режим переключается на ходу: его меняют голосом.
  document.body.classList.toggle('big', Boolean(status.big));
  const былВид = вид;
  вид = status.size === 'compact' ? 'compact' : 'full';
  document.body.classList.toggle('compact', вид === 'compact');
  smallerButton.innerHTML = вид === 'compact' ? CHEVRON.up : CHEVRON.down;
  smallerButton.title = вид === 'compact' ? WORDS.bigger : WORDS.smaller;
  // Подписи состояния на уменьшенной нет — она в подсказке.
  pill.title = вид === 'compact' ? status.label : '';
  // Размер сменили — высоту меряем заново: прошлый замер был в другом виде.
  if (былВид !== вид) последняяВысота = 0;
  видПлашки(status.look);
  showLecture(status.lecture);
  showLectureInfo(status.lectureInfo);
  dot.className = status.indicator;
  pill.dataset.state = status.indicator;
  label.textContent = status.label;
  pill.classList.toggle('asleep', !status.awake && status.indicator === 'idle');

  if (status.note) {
    hint.textContent = status.note;
    noteUntil = Date.now() + 6000;
    подогнатьВысоту();
    return;
  }
  if (Date.now() < noteUntil) return;

  // Своя подсказка — у варианта «только конспекты»: «скажите «Джарвис»» там
  // было бы неправдой, голоса нет.
  if (status.hint) {
    hint.textContent = status.hint;
  } else if (status.indicator === 'speaking' || status.indicator === 'working') {
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

/** Состояние для плашки; `hint` — своя строка под подписью вместо подсказки про голос. */
export type OverlayStatus = VoiceStatus & { hint?: string };

export interface StatusOverlay {
  update(status: OverlayStatus): void;
  /** Короткая строка о том, что услышано и что с этим стало. */
  note(status: OverlayStatus, text: string): void;
  /**
   * Включить крупный режим.
   *
   * Функцией снаружи, а не чтением настроек изнутри: режим меняют голосом на
   * ходу, и плашка должна перестроиться сразу, не дожидаясь перезапуска.
   */
  setBig(big: boolean): void;
  /** Что показывать на кнопке конспекта. */
  setLecture(state: LectureButtonState): void;
  /** Курс лекции, список курсов и строка под кнопками; null — убрать. */
  setLectureInfo(info: LectureInfo | null): void;
  dispose(): void;
}

export interface StatusOverlayOptions {
  /** Нажата кнопка конспекта: начать (с выбранным источником звука) или закончить (без него). */
  onLectureButton?: (source?: LectureSource) => void;
  /** Выбран курс из списка; пусто — угадать по содержанию. */
  onCourse?: (course: string) => void;
  /** Файл для конспекта: брошен на кнопку (путь) или нажата «Из файла…» (null). */
  onFile?: (file: string | null) => void;
  /** Кнопка «Учёба». */
  onStudy?: () => void;
  /** «Конспект ↗» на уменьшенной плашке; false — открывать нечего. */
  onOpenNotes?: () => boolean;
}

interface SavedPosition {
  x: number;
  y: number;
}

function positionFile(): string {
  return path.join(app.getPath('userData'), 'jarvis-overlay-position.json');
}

function readSaved(): Record<string, unknown> {
  try {
    const file = positionFile();
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Размер плашки помнится между запусками: уменьшили — значит, мешала.
 * Свёрнутость — нет: только что запущенный Джарвис показывает себя, иначе
 * его не отличить от незапустившегося.
 */
function readSavedSize(): OverlaySize {
  const saved = readSaved();
  return isOverlaySize(saved.size) ? saved.size : 'full';
}

function saveSize(size: OverlaySize): void {
  try {
    writeFileSync(positionFile(), JSON.stringify({ ...readSaved(), size }), 'utf8');
  } catch {
    // Не запомнилось — при следующем запуске плашка будет обычной, и только.
  }
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
    writeFileSync(positionFile(), JSON.stringify({ ...readSaved(), ...position }), 'utf8');
  } catch {
    // Losing the position is not worth reporting to someone working by voice.
  }
}

export function createStatusOverlay(options: StatusOverlayOptions = {}): StatusOverlay {
  let крупно = false;
  let вид = readSavedSize();
  let лекция: LectureButtonState = 'off';
  let сведения: LectureInfo | null = null;
  // Последнее состояние, чтобы перерисовать кнопку, не дожидаясь новой фразы.
  let последнее: Record<string, unknown> | null = null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-overlay-'));
  const pagePath = path.join(dir, 'overlay.html');
  writeFileSync(pagePath, buildOverlayHtml(), 'utf8');

  let window = openWindow(pagePath, () => размер(крупно, вид));

  /**
   * Пересоздание после падения.
   *
   * Окно индикатора действительно падает: в логе `render-process-gone` с
   * кодом доступа к чужой памяти, вместе со службой захвата видео. Без
   * пересоздания человек навсегда теряет единственный признак того, что
   * Джарвис его слышит, — а сам Джарвис при этом продолжает работать.
   */
  // Сколько раз подряд падало и когда пробовать снова.
  //
  // Без задержки и предела `revive` поднимал окно мгновенно, новый кадр падал
  // с той же причиной — и так по кругу, пока машина не начинала тормозить
  // вся. Задержка растёт, попыток шесть, после чего Джарвис работает без
  // индикатора и прямо об этом говорит: молча остаться без единственного
  // признака «я слышу» хуже, чем знать, что его нет.
  const ПОПЫТОК = 6;
  let падений = 0;
  let ожидание: ReturnType<typeof setTimeout> | null = null;
  let похоронено = false;

  const поднять = (): void => {
    ожидание = null;
    window = openWindow(pagePath, () => размер(крупно, вид));
    window.webContents.once('render-process-gone', revive);
  };

  function revive(): void {
    if (похоронено) return;
    падений += 1;
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch {
      // Уже мертво — и хорошо.
    }
    if (падений > ПОПЫТОК) {
      console.error(
        `[jarvis] окно индикатора упало ${падений} раз подряд — больше не поднимаю. ` +
          'Джарвис работает, но показывать, что он слышит, нечем.',
      );
      return;
    }
    // 0.5 с, 1, 2, 4, 8, 16 — падающий по одной причине кадр перестаёт
    // жечь машину, а разовое падение человек и не заметит.
    const через = 500 * 2 ** (падений - 1);
    console.log(`[jarvis] окно индикатора упало, поднимаю заново через ${через} мс (попытка ${падений} из ${ПОПЫТОК})`);
    ожидание = setTimeout(поднять, через);
    ожидание.unref?.();
  }

  window.webContents.once('render-process-gone', revive);

  /**
   * Отправка в окно.
   *
   * `isDestroyed` тут недостаточно: объект окна жив, а его кадр уже мёртв, и
   * `send` бросает «Render frame was disposed». Раз в секунду, бесконечно —
   * ровно это и залило лог ошибками.
   */
  const send = (payload: Record<string, unknown>): void => {
    последнее = payload;
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(STATUS_OVERLAY_CHANNEL, {
        ...payload,
        lecture: лекция,
        lectureInfo: сведения,
        look: currentLook(),
        size: вид,
      });
    } catch {
      // Кадр исчез между проверкой и отправкой. Индикатор поднимется сам.
    }
  };

  // Кнопка — только из своего окна: чужая страница не может начать запись.
  const onLecture = (event: Electron.IpcMainEvent, source: unknown): void => {
    if (window.isDestroyed() || event.sender !== window.webContents) return;
    options.onLectureButton?.(isLectureSource(source) ? source : undefined);
  };
  ipcMain.on(`${STATUS_OVERLAY_CHANNEL}:lecture`, onLecture);
  // Курс — только из списка, который плашке и показали.
  const onCourse = (event: Electron.IpcMainEvent, course: unknown): void => {
    if (window.isDestroyed() || event.sender !== window.webContents || typeof course !== 'string') return;
    if (course && !сведения?.courses.includes(course)) return;
    options.onCourse?.(course);
  };
  ipcMain.on(`${STATUS_OVERLAY_CHANNEL}:course`, onCourse);
  const onFile = (event: Electron.IpcMainEvent, file: unknown): void => {
    if (window.isDestroyed() || event.sender !== window.webContents) return;
    options.onFile?.(typeof file === 'string' && file ? file : null);
  };
  ipcMain.on(`${STATUS_OVERLAY_CHANNEL}:file`, onFile);
  const onStudy = (event: Electron.IpcMainEvent): void => {
    if (window.isDestroyed() || event.sender !== window.webContents) return;
    options.onStudy?.();
  };
  ipcMain.on(`${STATUS_OVERLAY_CHANNEL}:study`, onStudy);

  // Обычная и уменьшенная — туда, где плашку оставили. Размер — числом, как и
  // везде здесь: getBounds при масштабе 125% течёт (см. onHeight).
  const сменитьВид = (новый: OverlaySize): void => {
    if (вид === новый || window.isDestroyed()) return;
    вид = новый;
    saveSize(вид);
    window.setBounds(placeOverlay(readSavedPosition(), размер(крупно, новый)));
    if (последнее) send({ ...последнее, note: undefined });
  };
  const onSize = (event: Electron.IpcMainEvent, size: unknown): void => {
    if (window.isDestroyed() || event.sender !== window.webContents) return;
    if (isOverlaySize(size)) сменитьВид(size);
  };
  ipcMain.on(`${STATUS_OVERLAY_CHANNEL}:size`, onSize);

  // Идёт запись — на кнопке свёрнутой плашки красная точка: что микрофон
  // пишет, видно и тогда, когда самой плашки на экране нет. Кнопка есть только
  // у свёрнутой, поэтому точку ставим и при сворачивании.
  const отметитьЗапись = (): void => {
    if (process.platform !== 'win32' || window.isDestroyed()) return;
    const пишет = лекция === 'on';
    window.setOverlayIcon(пишет ? точкаЗаписи() : null, пишет ? tr('Идёт запись лекции', 'Recording a lecture') : '');
  };
  const onMinimize = (event: Electron.IpcMainEvent): void => {
    if (window.isDestroyed() || event.sender !== window.webContents) return;
    свернуть(window);
    отметитьЗапись();
  };
  ipcMain.on(`${STATUS_OVERLAY_CHANNEL}:minimize`, onMinimize);
  const onOpen = (event: Electron.IpcMainInvokeEvent): boolean => {
    if (window.isDestroyed() || event.sender !== window.webContents) return false;
    return options.onOpenNotes?.() ?? false;
  };
  ipcMain.handle(`${STATUS_OVERLAY_CHANNEL}:open`, onOpen);

  return {
    note(status, text) {
      send({ ...status, note: text, big: крупно });
    },
    update(status) {
      send({ ...status, big: крупно });
    },
    setLecture(state) {
      if (лекция === state) return;
      лекция = state;
      if (!window.isDestroyed() && window.isMinimized()) отметитьЗапись();
      // Без заметки: иначе прошлая строка «услышал…» всплыла бы заново.
      if (последнее) send({ ...последнее, note: undefined });
    },
    setLectureInfo(info) {
      if (JSON.stringify(info) === JSON.stringify(сведения)) return;
      сведения = info;
      if (последнее) send({ ...последнее, note: undefined });
    },
    setBig(big) {
      if (крупно === big) return;
      крупно = big;
      // Ширину задаём числом, а не из `getBounds`.
      //
      // При масштабе 125% `setBounds` из `getBounds` терял проценты за вызов:
      // замерено 269 → 255 → 242 → 229 → 215 → 202 → 189, и плашка усыхала в
      // полоску. Здесь та же ловушка, и обходится она так же.
      //
      // Свёрнутой размер не задаём: она его потеряет, а развёрнутая подгонит
      // себя сама (openWindow, «restore»).
      if (!window.isDestroyed() && !window.isMinimized()) {
        const было = window.getBounds();
        window.setBounds({ x: было.x, y: было.y, ...размер(big, вид) });
      }
    },
    dispose() {
      // Отложенный подъём тоже надо отменить: иначе окно всплывёт уже после
      // того, как его закрыли, и переживёт выключение самого Джарвиса.
      похоронено = true;
      ipcMain.removeListener(`${STATUS_OVERLAY_CHANNEL}:lecture`, onLecture);
      ipcMain.removeListener(`${STATUS_OVERLAY_CHANNEL}:course`, onCourse);
      ipcMain.removeListener(`${STATUS_OVERLAY_CHANNEL}:file`, onFile);
      ipcMain.removeListener(`${STATUS_OVERLAY_CHANNEL}:study`, onStudy);
      ipcMain.removeListener(`${STATUS_OVERLAY_CHANNEL}:size`, onSize);
      ipcMain.removeListener(`${STATUS_OVERLAY_CHANNEL}:minimize`, onMinimize);
      ipcMain.removeHandler(`${STATUS_OVERLAY_CHANNEL}:open`);
      if (ожидание) {
        clearTimeout(ожидание);
        ожидание = null;
      }
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

/**
 * Свернуть плашку в панель задач (владелец, 28.10.2026).
 *
 * Плашка — окно без фокуса и без кнопки в панели задач: так щелчок по ней не
 * отнимает клавиатуру у программы, где человек печатает. Свёрнутой она на
 * время становится обычным окном — с кнопкой и фокусом, чтобы щелчок по
 * кнопке разворачивал её, как любое окно. Развернули — снова плашка
 * (openWindow, «restore»).
 */
function свернуть(window: BrowserWindow): void {
  window.setFocusable(true);
  window.setMinimizable(true);
  window.setSkipTaskbar(false);
  window.minimize();
}

/**
 * Красная точка поверх кнопки свёрнутой плашки, пока идёт запись.
 *
 * Рисуется по точкам, а не файлом: 16×16 в порядке BGRA с яркостью,
 * умноженной на прозрачность, — так Electron принимает картинку из памяти.
 */
function точкаЗаписи(): Electron.NativeImage {
  const n = 16;
  const точки = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      // Мягкий край в одну точку: ступенчатый круг на 16 точках виден.
      const a = Math.max(0, Math.min(1, n / 2 - 0.5 - Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2)));
      const i = (y * n + x) * 4;
      точки[i] = Math.round(0x3d * a);
      точки[i + 1] = Math.round(0x2f * a);
      точки[i + 2] = Math.round(0xcf * a);
      точки[i + 3] = Math.round(0xff * a);
    }
  }
  return nativeImage.createFromBitmap(точки, { width: n, height: n });
}

function openWindow(pagePath: string, размерРежима: () => Размер): BrowserWindow {
  const место = placeOverlay(readSavedPosition(), размерРежима());
  const window = new BrowserWindow({
    width: место.width,
    height: место.height,
    x: место.x,
    y: место.y,
    frame: false,
    // Not transparent. A transparent frameless window on Windows renders
    // nothing at all here — the window exists, reports itself visible, and
    // paints no pixels. A solid pill that is actually on screen beats a
    // prettier one that is not.
    transparent: false,
    backgroundColor: windowBackground(),
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
    // Значок — для кнопки свёрнутой плашки в панели задач.
    icon: path.join(APP_ROOT, 'resources', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  // Кнопка свёрнутой плашки подписана «Rujarvis», а не «Electron»: ярлык
  // установщика с окнами не связан, и без этого Windows берёт имя у
  // electron.exe (замер 28.10.2026).
  if (process.platform === 'win32') {
    window.setAppDetails({
      appId: APP_USER_MODEL_ID,
      appIconPath: path.join(APP_ROOT, 'resources', 'icon.ico'),
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}" "${path.join(APP_ROOT, 'dist', 'app', 'main.cjs')}"`,
      relaunchDisplayName: 'Rujarvis',
    });
  }

  // Высота — по содержимому, а не по константе.
  //
  // Окно просит ровно столько, сколько занял текст. Ширина не меняется: её
  // человек привык видеть, и прыгающая по горизонтали плашка раздражает
  // сильнее обрезанного текста.
  let запрошено = 0;
  const подогнать = (): void => {
    // Свёрнутое окно заданный размер теряет (замер 28.10.2026: высота,
    // заданная свёрнутой, не дожила до разворота) — подгоним, когда развернут.
    if (window.isDestroyed() || window.isMinimized()) return;
    // Размер берём у ТЕКУЩЕГО режима, а не у обычного.
    //
    // Здесь стояло `HEIGHT`/`WIDTH` числами, и это стирало крупный режим:
    // `setBig(true)` растягивал окно до 560, а первая же услышанная фраза
    // присылала высоту и возвращала ширину к 320. Шрифт оставался крупным,
    // окно — узким, и текст срезался ровно у того человека, ради которого
    // режим и сделан. Поймано приёмкой: «окно не выросло: 322 → 322».
    const режим = размерРежима();
    const нужно = Math.max(режим.height, Math.min(MAX_HEIGHT, Math.round(запрошено)));
    const было = window.getBounds();
    if (было.height === нужно && было.width === режим.width) return;

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
    // Нижний край — на экране: плашка стоит внизу, и выросшее окно уводило
    // кнопки под край экрана (ревью 29.09.2026). Не помещается — поднимаем.
    const экран = screen.getDisplayMatching(было).workArea;
    const y = Math.max(экран.y, Math.min(было.y, экран.y + экран.height - нужно));
    window.setBounds({ x: было.x, y, width: режим.width, height: нужно });
  };
  const onHeight = (event: Electron.IpcMainEvent, height: unknown): void => {
    if (event.sender !== window.webContents) return;
    if (typeof height !== 'number' || !Number.isFinite(height)) return;
    запрошено = height;
    подогнать();
  };
  ipcMain.on(`${STATUS_OVERLAY_CHANNEL}:height`, onHeight);

  // Развернули щелчком по кнопке в панели задач — снова плашка: без фокуса и
  // без кнопки, и в размере, который ей задали, пока была свёрнута.
  window.on('restore', () => {
    window.setFocusable(false);
    window.setMinimizable(false);
    window.setSkipTaskbar(true);
    подогнать();
  });
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
    // Место свёрнутого окна — не место плашки.
    if (window.isMinimized()) return;
    const [x, y] = window.getPosition();
    savePosition({ x, y });
  });

  void window.loadFile(pagePath).then(() => {
    if (!window.isDestroyed()) window.showInactive();
  });

  return window;
}
