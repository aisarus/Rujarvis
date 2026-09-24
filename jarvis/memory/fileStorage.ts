/**
 * File-backed memory storage.
 *
 * Lives in Jarvis's data folder (`jarvis/setup/paths.ts`), next to the
 * journal and the settings: everything the assistant knows about the user is
 * in one place the user can open.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { jarvisPaths } from '../setup/paths';
import { EMPTY_SNAPSHOT, type MemorySnapshot, type MemoryStorage } from './store';

export function createFileMemoryStorage(
  filePath = path.join(jarvisPaths().data, 'memory.json'),
): MemoryStorage {
  return {
    async load() {
      try {
        const raw = await readFile(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return { ...EMPTY_SNAPSHOT };
        return { ...EMPTY_SNAPSHOT, ...(parsed as MemorySnapshot) };
      } catch {
        return null;
      }
    },

    async save(snapshot) {
      await mkdir(path.dirname(filePath), { recursive: true });
      // Write-then-rename: a crash mid-write must not leave a truncated file
      // that silently loses every project alias the user taught Jarvis.
      const temporary = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf-8');
      await rename(temporary, filePath);
    },
  };
}
