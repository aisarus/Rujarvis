/**
 * Живая Крита: рисование в уже открытом документе, у человека на глазах.
 *
 * ## Зачем
 *
 * Человек хочет делать аниме агентом: персонажи с референсов, раскадровки,
 * сама анимация. Крита — лучшая свободная рисовалка, и у неё есть полный
 * питоновский API. Беда одна: **у Криты нет ключа командной строки «выполни
 * этот скрипт»**. Есть `--export`, `--export-sequence`, `--new-image`,
 * `--template` — запуска скрипта нет.
 *
 * Значит управлять ею можно только изнутри, надстройкой. Надстройка уже лежит
 * в ресурсах Криты (`pykrita/jarvis_live`), здесь — её сторона со стороны
 * Джарвиса.
 *
 * ## Как это устроено
 *
 * Ровно как живой блендер: ни сокетов, ни портов. Два файла в общей папке —
 * команда и ответ. Плагин четыре раза в секунду смотрит, не появилась ли
 * команда, исполняет её внутри открытого сеанса и кладёт ответ рядом.
 *
 * Папка переживает перезапуск Джарвиса, перезапуск Криты и любой порядок
 * запуска. И она читается глазами: видно, что именно ушло в исполнение.
 *
 * ## Чем это отличается от блендера
 *
 * Блендер умеет `--python`, поэтому слушатель ему передаётся при запуске.
 * Крита не умеет, поэтому слушатель должен быть установлен ЗАРАНЕЕ и включён
 * в настройках Криты. Отсюда `ensurePlugin`: надстройка кладётся на место
 * сама, а вот галочку в «Настройки → Модули Python» человек ставит руками —
 * один раз. Соврать здесь нельзя: без галочки Крита откроется и не ответит.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Сколько ждать ответа на одну команду. Рисование бывает долгим. */
const ANSWER_TIMEOUT_MS = 120_000;

/** Насколько свежей должна быть отметка жизни, чтобы считать сеанс живым. */
const ALIVE_WITHIN_MS = 5_000;

export interface LiveResult {
  ok: boolean;
  /** Что скрипт напечатал. */
  printed: string;
  error?: string;
}

/** Общая папка. Тот же путь вычисляет и надстройка внутри Криты. */
function liveDir(): string {
  const root =
    process.env.JARVIS_DATA_ROOT?.trim() ||
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'Rujarvis',
      'data',
    );
  const place = path.join(root, 'krita-live');
  mkdirSync(place, { recursive: true });
  return place;
}

function files(): { command: string; answer: string; alive: string } {
  const place = liveDir();
  return {
    command: path.join(place, 'команда.py'),
    answer: path.join(place, 'ответ.json'),
    alive: path.join(place, 'жив.txt'),
  };
}

/** Где Крита держит свои ресурсы, включая надстройки. */
export function resourcesDir(): string {
  return path.join(
    process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'krita',
  );
}

/** Установлена ли надстройка-слушатель. */
export function pluginInstalled(): boolean {
  const root = path.join(resourcesDir(), 'pykrita');
  return existsSync(path.join(root, 'jarvis_live.desktop')) &&
    existsSync(path.join(root, 'jarvis_live', '__init__.py'));
}

/** Отзывается ли живой сеанс прямо сейчас. */
export function isLive(): boolean {
  const { alive } = files();
  try {
    if (!existsSync(alive)) return false;
    return Date.now() - statSync(alive).mtimeMs <= ALIVE_WITHIN_MS;
  } catch {
    return false;
  }
}

/** Где лежит сама Крита. */
export function findKrita(): string | null {
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Krita (x64)', 'bin', 'krita.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Krita', 'bin', 'krita.exe'),
    path.join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Krita (x86)',
      'bin',
      'krita.exe',
    ),
  ];
  return candidates.find((file) => existsSync(file)) ?? null;
}

/**
 * Поднять Криту со слушателем.
 *
 * Через `cmd /c start` — иначе окно умирает вместе с тем, кто его запустил.
 * На блендере это уже проверено на живой машине: запущенный обычным способом,
 * он закрывался вместе с MCP-сервером.
 */
export function startLive(kritaExe: string, documentFile?: string): void {
  const { alive, answer, command } = files();
  for (const stale of [alive, answer, command]) {
    try {
      if (existsSync(stale)) rmSync(stale);
    } catch {
      // Остатки прошлого сеанса мешают, но не смертельно.
    }
  }

  const args = ['/c', 'start', '', kritaExe];
  if (documentFile) args.push(documentFile);

  const child = spawn('cmd.exe', args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/** Дождаться, пока слушатель отзовётся. */
export async function waitLive(timeoutMs = 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (isLive()) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/**
 * Исполнить скрипт в открытой Крите.
 *
 * Команда пишется через временный файл и переименование: слушатель заглядывает
 * четыре раза в секунду и не должен поймать файл на половине записи.
 */
export async function sendLive(code: string): Promise<LiveResult> {
  const { command, answer } = files();

  if (!isLive()) {
    return {
      ok: false,
      printed: '',
      error: pluginInstalled()
        ? 'живой Криты нет: подними её через krita_live_start'
        : 'надстройка-слушатель не установлена — вызови krita_live_start, он её положит',
    };
  }

  try {
    if (existsSync(answer)) rmSync(answer);
  } catch {
    // Старый ответ помешает распознать новый — но переживём.
  }

  writeFileSync(`${command}.tmp`, code, 'utf8');
  renameSync(`${command}.tmp`, command);

  const until = Date.now() + ANSWER_TIMEOUT_MS;
  while (Date.now() < until) {
    if (existsSync(answer)) {
      try {
        const parsed = JSON.parse(readFileSync(answer, 'utf8')) as Partial<LiveResult>;
        rmSync(answer);
        return {
          ok: parsed.ok === true,
          printed: typeof parsed.printed === 'string' ? parsed.printed : '',
          ...(parsed.error ? { error: String(parsed.error) } : {}),
        };
      } catch {
        // Ответ поймали на половине записи — подождём следующий круг.
      }
    }
    if (!isLive()) {
      return { ok: false, printed: '', error: 'Крита закрылась, не ответив' };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { ok: false, printed: '', error: 'Крита не ответила за две минуты' };
}

export { liveDir, ALIVE_WITHIN_MS };
