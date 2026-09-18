/**
 * File-backed memory storage.
 *
 * Lives beside the Workstation's own state in the shared Open Interpreter home
 * (`INTERPRETER_HOME`, otherwise `~/.openinterpreter`), so Jarvis memory
 * travels with the rest of the user's configuration.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EMPTY_SNAPSHOT, type MemorySnapshot, type MemoryStorage } from './store';

export function resolveJarvisHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.INTERPRETER_HOME?.trim();
  return path.join(home && home.length > 0 ? home : path.join(os.homedir(), '.openinterpreter'), 'jarvis');
}

export function createFileMemoryStorage(
  filePath = path.join(resolveJarvisHome(), 'memory.json'),
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
