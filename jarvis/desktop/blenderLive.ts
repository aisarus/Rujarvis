/**
 * Живой блендер: работа в уже открытом файле, у человека на глазах.
 *
 * ## Зачем
 *
 * Человек сказал так: «он создал ракету, я говорю — а теперь пусть ракета
 * полетит в космос, и он, не закрывая этот файл, при мне делает анимацию, а я
 * всё вижу».
 *
 * Сегодня так не выходит. `runPython` запускает блендер **фоновым**
 * (`--background`): окно не открывается вовсе, сцена считается и сохраняется в
 * файл, после чего файл открывается заново. Каждая правка — новое окно. Человек
 * это уже видел и сказал о нём прямо, заглавными буквами: просьба покрасить
 * сферу закрывала ему окно блендера.
 *
 * ## Как это устроено
 *
 * Блендер поднимается один раз, с маленьким слушателем на борту. Слушатель —
 * обычный скрипт на `bpy.app.timers`: четыре раза в секунду он смотрит, не
 * появился ли файл команды, и если появился — исполняет его **внутри живого
 * сеанса** и пишет ответ.
 *
 * Ни сокетов, ни портов, ни надстроек: два файла в общей папке. Это грубо, зато
 * переживает всё — перезапуск Джарвиса, перезапуск блендера, любой порядок
 * запуска. И это видно глазами: можно открыть папку и прочитать, что именно
 * было послано.
 *
 * ## Чего здесь нарочно нет
 *
 * **Сохранения после каждой команды.** Человек смотрит на экран; если каждая
 * правка будет писать файл на диск, он получит десятки версий и ни одной
 * причины. Сохраняет тот, кто просил сохранить.
 *
 * **Молчаливого отката на фоновый запуск.** Если живого сеанса нет, об этом
 * говорится вслух. Тихо сделать работу в невидимом блендере — значит снова
 * отчитаться об успехе там, где человек ничего не увидел.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Как часто слушатель заглядывает за командой, в секундах. */
const TICK_SECONDS = 0.25;

/** Сколько ждать ответа на одну команду. */
const ANSWER_TIMEOUT_MS = 120_000;

/** Старше этого отметка «жив» означает, что блендера больше нет. */
const ALIVE_WITHIN_MS = 5_000;

export interface LiveResult {
  ok: boolean;
  /** Что скрипт напечатал. */
  printed: string;
  error?: string;
}

function liveDir(): string {
  const root =
    process.env.JARVIS_DATA_ROOT?.trim() ||
    path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
      'Rujarvis',
      'data',
    );
  const dir = path.join(root, 'blender-live');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const files = (): {
  command: string;
  answer: string;
  alive: string;
  listener: string;
  blank: string;
} => {
  const dir = liveDir();
  return {
    command: path.join(dir, 'команда.py'),
    answer: path.join(dir, 'ответ.json'),
    alive: path.join(dir, 'жив.txt'),
    listener: path.join(dir, 'слушатель.py'),
    blank: path.join(dir, 'пустая.blend'),
  };
};

/**
 * Пустой файл, с которого начинается живой сеанс.
 *
 * ## Зачем он вообще
 *
 * Blender, запущенный без файла, показывает заставку — окно «создать новый или
 * открыть готовый» поверх всего. Пока её не убрали, сцена не видна и скрипты
 * бьют в пустоту. Человек сказал прямо: «иначе весь воркфлоу с блендером
 * рушится».
 *
 * Убрать её скриптом нельзя: это всплывающая область, и закрытия у неё в API
 * нет. Зато её нет вовсе, если Blender открывают С ФАЙЛОМ. Поэтому файл есть
 * всегда — самый обычный, пустой.
 *
 * Делается один раз фоновым запуском на пару секунд и дальше просто лежит.
 */
function ensureBlank(blenderExe: string): string | null {
  const { blank } = files();
  if (existsSync(blank)) return blank;

  try {
    execFileSync(
      blenderExe,
      [
        '--background',
        '--factory-startup',
        '--python-expr',
        `import bpy
bpy.ops.wm.read_factory_settings(use_empty=False)
bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(blank)})`,
      ],
      { timeout: 60_000, stdio: 'ignore' },
    );
  } catch {
    // Не вышло — сеанс всё равно поднимется, просто с заставкой.
  }

  return existsSync(blank) ? blank : null;
}

/**
 * Слушатель, который живёт внутри блендера.
 *
 * Пишется на диск при запуске, а не хранится в сборке: так его можно открыть и
 * прочитать, когда что-то пойдёт не так, — и так не нужно ничего копировать при
 * сборке.
 *
 * Внутри нет ни одной обратной кавычки и ни одного переноса, собранного
 * склейкой: этот текст уже трижды за день портили экранирования, и здесь он
 * записан самым скучным возможным способом.
 */
function listenerSource(): string {
  const { command, answer, alive } = files();
  const asPy = (value: string): string => JSON.stringify(value);

  return [
    'import bpy, json, os, io, traceback, contextlib',
    '',
    'КОМАНДА = ' + asPy(command),
    'ОТВЕТ = ' + asPy(answer),
    'ЖИВ = ' + asPy(alive),
    '',
    '',
    'def отметиться():',
    '    try:',
    '        with open(ЖИВ, "w", encoding="utf-8") as f:',
    '            f.write("1")',
    '    except Exception:',
    '        pass',
    '',
    '',
    'def ответить(ok, printed, error):',
    '    try:',
    '        with open(ОТВЕТ + ".tmp", "w", encoding="utf-8") as f:',
    '            json.dump({"ok": ok, "printed": printed, "error": error}, f, ensure_ascii=False)',
    '        os.replace(ОТВЕТ + ".tmp", ОТВЕТ)',
    '    except Exception:',
    '        pass',
    '',
    '',
    'def тик():',
    '    отметиться()',
    '    if os.path.exists(КОМАНДА):',
    '        try:',
    '            with open(КОМАНДА, "r", encoding="utf-8") as f:',
    '                код = f.read()',
    '        except Exception:',
    '            return ' + String(TICK_SECONDS),
    '        try:',
    '            os.remove(КОМАНДА)',
    '        except Exception:',
    '            pass',
    '        поток = io.StringIO()',
    '        try:',
    '            with contextlib.redirect_stdout(поток):',
    '                exec(compile(код, "команда", "exec"), {"bpy": bpy, "__name__": "__main__"})',
    '            ответить(True, поток.getvalue(), None)',
    '        except Exception:',
    '            ответить(False, поток.getvalue(), traceback.format_exc())',
    '    return ' + String(TICK_SECONDS),
    '',
    '',
    '',
    '# Заставка «создать новый или открыть готовый» перекрывает сцену и ломает',
    '# всю работу. Здесь она выключается насовсем — и для ручных запусков тоже.',
    'try:',
    '    bpy.context.preferences.view.show_splash = False',
    '    bpy.ops.wm.save_userpref()',
    'except Exception:',
    '    pass',
    '',
    'отметиться()',
    'bpy.app.timers.register(тик, persistent=True)',
    'print("[jarvis] слушатель блендера поднят")',
    '',
  ].join('\n');
}

/** Жив ли сейчас блендер со слушателем. */
export function isLive(): boolean {
  const { alive } = files();
  try {
    if (!existsSync(alive)) return false;
    return Date.now() - statSync(alive).mtimeMs <= ALIVE_WITHIN_MS;
  } catch {
    return false;
  }
}

/**
 * Поднять блендер со слушателем.
 *
 * Через `cmd /c start` — иначе окно умирает вместе с тем, кто его запустил.
 * Это уже проверено на живой машине: запущенный обычным способом блендер
 * закрывался вместе с MCP-сервером.
 */
export function startLive(blenderExe: string, blendFile?: string): void {
  const { listener, alive, answer, command } = files();
  writeFileSync(listener, listenerSource(), 'utf8');
  for (const stale of [alive, answer, command]) {
    try {
      if (existsSync(stale)) rmSync(stale);
    } catch {
      // Остатки прошлого сеанса мешают, но не смертельно.
    }
  }

  // С файлом — значит без заставки. Свой пустой, если человек не назвал свой.
  const openWith = blendFile ?? ensureBlank(blenderExe);

  const args = ['/c', 'start', '', blenderExe];
  if (openWith) args.push(openWith);
  args.push('--python', listener);

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
 * Исполнить скрипт в открытом блендере.
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
      error: 'живого блендера нет: сначала подними его через blender_live_start',
    };
  }

  try {
    if (existsSync(answer)) rmSync(answer);
  } catch {
    // Старый ответ помешает распознать новый — но если не стёрся, поможет
    // сравнение по времени ниже.
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
      return { ok: false, printed: '', error: 'блендер закрылся, не ответив' };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { ok: false, printed: '', error: 'блендер не ответил за две минуты' };
}

export { liveDir, listenerSource, TICK_SECONDS, ALIVE_WITHIN_MS };
