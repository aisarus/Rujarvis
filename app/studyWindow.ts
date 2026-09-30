/**
 * Окно учёбы: «Сегодня», курсы по темам, квиз, карточки, экзамен, задачи.
 *
 * Страница (`ui/study.html`) видит только узкий мост (`studyPreload.ts`), а
 * всё, что знает про диск и модель, — здесь и в `StudyService`. Конспект окно
 * не показывает: читать его — в Obsidian, окно открывает заметку там.
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { BrowserWindow, ipcMain, shell } from 'electron';

import { obsidianOpenUrl } from '../jarvis/lecture/vault';
import type { StudyService } from '../jarvis/study/service';
import { APP_ROOT } from './root';

export const STUDY_CHANNEL = 'jarvis-study';

export interface StudyWindowDeps {
  service(): StudyService;
  preparing(): string[];
  prepare(notesFile: string): void;
  language(): 'ru' | 'en';
  /** Не показывать окно — для проверки без экрана и без фокуса. */
  hidden?: boolean;
}

let window: BrowserWindow | null = null;
let deps: StudyWindowDeps | null = null;
let registered = false;

function служба(): StudyService {
  if (!deps) throw new Error('окно учёбы не настроено');
  return deps.service();
}

/** Окно открыто — пусть перечитает то, что показывает (заготовка закончилась). */
export function sendStudyUpdate(): void {
  if (window && !window.isDestroyed()) window.webContents.send(`${STUDY_CHANNEL}:changed`, deps?.preparing() ?? []);
}

/** Ответ окну: данные или понятная ошибка, а не упавший вызов. */
function обработать(канал: string, fn: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`${STUDY_CHANNEL}:${канал}`, async (event, ...args: unknown[]) => {
    if (!window || event.sender !== window.webContents) throw new Error('чужое окно');
    try {
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      console.error(`[jarvis:study] ${канал}: ${error instanceof Error ? error.message : String(error)}`);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function строка(v: unknown): string {
  if (typeof v !== 'string') throw new Error('ожидалась строка');
  return v;
}

function число(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('ожидалось число');
  return v;
}

function зарегистрировать(): void {
  if (registered) return;
  registered = true;
  обработать('today', () => ({ today: служба().today(), preparing: deps?.preparing() ?? [] }));
  обработать('course', (name) => служба().course(строка(name)));
  обработать('quizStart', (scope) => {
    const s = (scope ?? {}) as { course?: unknown; lecture?: unknown; topic?: unknown };
    return служба().startQuiz({
      course: строка(s.course),
      lecture: typeof s.lecture === 'string' ? s.lecture : undefined,
      topic: typeof s.topic === 'string' ? s.topic : undefined,
    });
  });
  обработать('quizAnswer', (id, index, chosen) => служба().answerQuiz(строка(id), число(index), число(chosen)));
  обработать('openAnswer', (id, index, text) => служба().checkOpen(строка(id), число(index), строка(text)));
  обработать('examStart', (course, count, minutes) => служба().startExam(строка(course), число(count), число(minutes)));
  обработать('examAnswer', (id, index, chosen) => служба().answerExam(строка(id), число(index), число(chosen)));
  обработать('examSubmit', (id) => служба().submitExam(строка(id)));
  обработать('cards', (course) => служба().dueCards(typeof course === 'string' && course ? course : undefined));
  обработать('cardReview', (course, id, verdict) => {
    const v = строка(verdict);
    if (v !== 'again' && v !== 'know') throw new Error('неизвестный ответ карточки');
    служба().reviewCard(строка(course), строка(id), v);
  });
  обработать('tasks', (course, lecture) => служба().tasks(строка(course), typeof lecture === 'string' && lecture ? lecture : undefined));
  обработать('taskMark', (course, id, solved) => служба().markTask(строка(course), строка(id), Boolean(solved)));
  обработать('prepare', (notesFile) => deps?.prepare(строка(notesFile)));
  // Заметка открывается в Obsidian, звук — адресом файла для проигрывателя
  // окна. Пути приходят из банков лекций, не со страницы, — но проверяем, что
  // это заметка и звук, а не что угодно.
  обработать('openNote', async (file) => {
    const f = строка(file);
    if (!f.endsWith('.md')) throw new Error('это не заметка');
    await shell.openExternal(obsidianOpenUrl(f));
  });
  обработать('audioUrl', (file) => {
    const f = строка(file);
    if (!/\.(wav|mp3|m4a|ogg|opus|webm)$/iu.test(f)) throw new Error('это не звук');
    return pathToFileURL(f).href;
  });
}

/** Окно учёбы — для проверки, что страница поднялась. */
export function studyWindowForCheck(): BrowserWindow | null {
  return window;
}

export function openStudyWindow(options: StudyWindowDeps): void {
  deps = options;
  зарегистрировать();
  if (window && !window.isDestroyed()) {
    if (!options.hidden) {
      window.show();
      window.focus();
    }
    sendStudyUpdate();
    return;
  }
  window = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 540,
    title: options.language() === 'en' ? 'Study' : 'Учёба',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(APP_ROOT, 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist', 'app', 'studyPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (!options.hidden) window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = null;
  });
  void window.loadFile(path.join(APP_ROOT, 'app', 'ui', 'study.html'), { query: { lang: options.language() } });
}
