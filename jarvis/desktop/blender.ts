/**
 * Blender через его собственный Python.
 *
 * Официального коннектора Blender в каталоге нет — проверено поиском. Зато у
 * самого Blender есть полный Python API (`bpy`), и это не обходной путь, а
 * штатный: в нём написан весь интерфейс программы. Всё, что делает мышь,
 * делается скриптом, и только скрипт можно повторить и проверить.
 *
 * Запуск фоновый (`--background`): окно не открывается, сцена считается и
 * сохраняется. Для показа человеку файл потом открывается обычным способом.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Куда Blender ставится на Windows. Версии меняются, поэтому ищем. */
const SEARCH_ROOTS = [
  'C:\\Program Files\\Blender Foundation',
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Blender'),
];

let cachedPath: string | null = null;

export function findBlender(): string | null {
  if (cachedPath) return cachedPath;

  const explicit = process.env.JARVIS_BLENDER?.trim();
  if (explicit && existsSync(explicit)) {
    cachedPath = explicit;
    return cachedPath;
  }

  for (const root of SEARCH_ROOTS) {
    if (!root || !existsSync(root)) continue;
    // Версии лежат папками рядом: «Blender 5.2», «Blender 4.2».
    for (const entry of readdirSync(root)) {
      const candidate = path.join(root, entry, 'blender.exe');
      if (existsSync(candidate)) {
        cachedPath = candidate;
        return cachedPath;
      }
    }
  }
  return null;
}

export interface BlenderResult {
  ok: boolean;
  output: string;
}

/**
 * Выполняет Python в Blender и возвращает то, что скрипт напечатал.
 *
 * Скрипт пишется во временный файл, а не передаётся строкой: код с кавычками
 * и переносами не переживает путь через командную строку — ровно та ошибка,
 * из-за которой в этом проекте уже один инструмент молча ничего не делал.
 */
export async function runPython(code: string, blendFile?: string): Promise<BlenderResult> {
  const blender = findBlender();
  if (!blender) {
    return { ok: false, output: 'Blender не найден. Укажите путь в JARVIS_BLENDER.' };
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-blender-'));
  const script = path.join(dir, 'task.py');
  writeFileSync(script, code, 'utf8');

  const args: string[] = ['--background'];
  if (blendFile) args.push(blendFile);
  args.push('--python', script, '--python-exit-code', '1');

  try {
    const { stdout, stderr } = await run(blender, args, {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    return { ok: true, output: trimNoise(stdout + stderr) };
  } catch (error) {
    const detail = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: trimNoise(`${detail.stdout ?? ''}${detail.stderr ?? ''}` || detail.message || 'Неизвестная ошибка'),
    };
  }
}

/**
 * Blender печатает баннер и служебные строки, которые модели не нужны и
 * только съедают место.
 */
function trimNoise(output: string): string {
  return output
    .split(/\r?\n/u)
    .filter((line) => !/^(Blender \d|Read prefs:|Read blend:|found bundled|Warning: |Info: Deleted)/u.test(line))
    .join('\n')
    .trim();
}

/**
 * Открывает файл в окне Blender и **не ждёт** его закрытия.
 *
 * Ожидание здесь было бы ошибкой на часы: `run` возвращается, когда программа
 * завершилась, а человек смотрит на неё ровно столько, сколько захочет.
 * Процесс отвязывается и живёт сам.
 *
 * Зачем вообще открывать: фоновый запуск ничего не показывает, и человек, для
 * которого делали сцену, её не видит. Сделанное в программе должно быть видно
 * в этой программе.
 */
export function openInBlender(blendFile: string): void {
  const blender = findBlender();
  if (!blender) throw new Error('Blender не найден');

  // Через `start`, а не напрямую.
  //
  // `detached: true` на Windows не спасает: дочерний процесс остаётся в том же
  // объекте задания, и когда Claude Code гасит MCP-сервер после задачи, Blender
  // умирает вместе с ним. В журнале это выглядело как «окно было открыто» из
  // ответа агента и пустой экран у человека — он справедливо сказал, что я вру.
  //
  // `cmd /c start` передаёт запуск оболочке, и получившийся процесс не связан
  // с нами ничем. Тот же приём уже используется для запуска программ голосом.
  const child = spawn('cmd.exe', ['/c', 'start', '', blender, blendFile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
