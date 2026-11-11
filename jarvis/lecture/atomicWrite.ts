/**
 * Запись заметки целиком — через временный файл и переименование.
 *
 * `writeFile` сначала обрезает файл до нуля, потом пишет. Кончилось место,
 * выключили компьютер, упал Джарвис — и на месте конспекта пустой или
 * оборванный файл, а прежнего уже нет. Переименование же либо случилось, либо
 * нет: человек видит или старую заметку, или новую, но не половину.
 *
 * Временный файл лежит рядом (переименование через границу дисков не
 * атомарно) и начинается с точки: Obsidian такие не показывает.
 */

import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function временный(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
}

/** Obsidian, антивирус и проводник держат файл секунду — Windows отвечает отказом. */
function занят(error: unknown): boolean {
  const код = (error as NodeJS.ErrnoException).code;
  return код === 'EPERM' || код === 'EBUSY' || код === 'EACCES';
}

export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const черновик = временный(file);
  try {
    await writeFile(черновик, text, 'utf8');
    for (let попытка = 0; ; попытка += 1) {
      try {
        await rename(черновик, file);
        return;
      } catch (error) {
        if (попытка >= 4 || !занят(error)) throw error;
        await new Promise((r) => setTimeout(r, 200 * (попытка + 1)));
      }
    }
  } catch (error) {
    await rm(черновик, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function writeFileAtomicSync(file: string, text: string): void {
  const черновик = временный(file);
  try {
    writeFileSync(черновик, text, 'utf8');
    for (let попытка = 0; ; попытка += 1) {
      try {
        renameSync(черновик, file);
        return;
      } catch (error) {
        if (попытка >= 4 || !занят(error)) throw error;
      }
    }
  } catch (error) {
    try {
      rmSync(черновик, { force: true });
    } catch {
      // Черновик не убрался — он с точкой в имени и никому не мешает.
    }
    throw error;
  }
}
