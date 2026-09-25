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
      await mkdir(path.dirname(filePath), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that silently loses every project alias the user taught Jarvis.
      // Своё имя на каждую запись: два сохранения подряд без `await` писали в
      // ОДИН файл, и второе переименование падало с ENOENT — либо на место
      // памяти въезжала перемешанная половина.
      const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf-8');
      await rename(temporary, filePath);
    },
  };
}
