/**
 * File-backed memory storage.
 *
 * Lives in Jarvis's data folder (`jarvis/setup/paths.ts`), next to the
 * journal and the settings: everything the assistant knows about the user is
 * in one place the user can open.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { jarvisPaths } from '../setup/paths';
import { EMPTY_SNAPSHOT, type MemorySnapshot, type MemoryStorage } from './store';

export function createFileMemoryStorage(
  filePath = path.join(jarvisPaths().data, 'memory.json'),
): MemoryStorage {
  /**
   * Записи выстраиваются в очередь.
   *
   * Своё имя черновика решает половину беды, но не всю: на Windows два
   * переименования в один и тот же файл дают EPERM — второе падает, потому
   * что первое держит цель. А отказ записи молча терял псевдоним, которому
   * человек только что научил Джарвиса. Очередь дешевле любых разбирательств:
   * сохранений тут единицы в минуту.
   */
  let очередь: Promise<void> = Promise.resolve();

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf-8');
      } catch (error) {
        // «Файла ещё нет» — это пустая память, и она в порядке. Всё
        // остальное — отказ, и молчать о нём нельзя: пустой снимок поверх
        // занятого файла унесёт все проекты и псевдонимы, которым человек
        // учил Джарвиса.
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...EMPTY_SNAPSHOT };
        throw error;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        // Битый файл откладываем в сторону, а не теряем.
        const копия = `${filePath}.broken-${Date.now()}`;
        try {
          await rename(filePath, копия);
          console.error(`[jarvis] память не разобралась, отложена в ${копия}`);
        } catch {
          console.error(`[jarvis] память не разобралась и не отложилась: ${filePath}`);
        }
        void error;
        return { ...EMPTY_SNAPSHOT };
      }

      if (!parsed || typeof parsed !== 'object') return { ...EMPTY_SNAPSHOT };
      const снимок = { ...EMPTY_SNAPSHOT, ...(parsed as MemorySnapshot) };
      // Руками правленный файл не должен ронять работу с проектами.
      снимок.projects = Array.isArray(снимок.projects)
        ? снимок.projects.filter(
            (проект) =>
              Boolean(проект) && typeof проект.name === 'string' && typeof проект.path === 'string',
          )
        : [];
      return снимок;
    },

    async save(snapshot) {
      const моя = очередь.then(() => записать(snapshot));
      // Хвост не должен обрываться на неудаче: упавшая запись не повод
      // перестать сохранять дальше.
      очередь = моя.catch(() => undefined);
      return моя;
    },
  };

  async function записать(snapshot: MemorySnapshot): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    // Сначала во временный файл, потом переименование: обрыв посреди записи
    // не должен оставить обрезанный файл, унося с собой все псевдонимы, к
    // которым человек приучил Джарвиса.
    //
    // Имя черновика своё на каждую запись: с общим два сохранения подряд без
    // `await` писали в ОДИН файл.
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf-8');
    await rename(temporary, filePath);
  }
}
