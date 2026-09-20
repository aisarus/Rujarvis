import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileMemoryStorage, resolveJarvisHome } from './fileStorage';
import { JarvisMemory, type MemoryStorage, type MemorySnapshot } from './store';
import {
  WorldStateStore,
  selectWorldStateLines,
  type DesktopObserver,
} from '../context/worldState';

const temporaryDirs: string[] = [];

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jarvis-memory-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('JarvisMemory', () => {
  it('teaches an alias once and resolves it afterwards', async () => {
    const memory = new JarvisMemory();
    await memory.rememberProject({ name: 'aegis', path: 'D:\\Projects\\aegis', aliases: ['аегис'] });

    expect(memory.findProject('аегис')?.path).toBe('D:\\Projects\\aegis');
    expect(memory.knownProjects()).toHaveLength(1);
  });

  it('merges new aliases into a project it already knows', async () => {
    const memory = new JarvisMemory();
    await memory.rememberProject({ name: 'aegis', path: 'D:\\old', aliases: ['аегис'] });
    await memory.rememberProject({ name: 'Aegis', path: 'D:\\Projects\\aegis', aliases: ['эгида'] });

    const project = memory.findProject('aegis');
    expect(project?.path).toBe('D:\\Projects\\aegis');
    expect(project?.aliases?.sort()).toEqual(['аегис', 'эгида']);
    expect(memory.projects).toHaveLength(1);
  });

  it('resolves an application the user named their own way', async () => {
    const memory = new JarvisMemory();
    await memory.rememberApp({ spoken: 'спотифай', target: 'Spotify' });
    expect(memory.findApp('открой спотифай')?.target).toBe('Spotify');
    expect(memory.findApp('открой телеграм')).toBeUndefined();
  });

  it('keeps only the most recent tasks', async () => {
    const memory = new JarvisMemory({ taskHistoryLimit: 2 });
    for (const index of [1, 2, 3]) {
      await memory.recordTask({
        id: `t${index}`,
        utterance: `задача ${index}`,
        outcome: 'ок',
        ok: true,
        backend: 'claude-code',
      });
    }
    expect(memory.recentTasks).toHaveLength(2);
    expect(memory.lastTask()?.utterance).toBe('задача 3');
  });

  it('returns only the memory an utterance touches, bounded', async () => {
    const memory = new JarvisMemory();
    await memory.rememberProject({ name: 'aegis', path: 'D:\\Projects\\aegis', aliases: ['аегис'] });
    await memory.rememberProject({ name: 'rujarvis', path: 'D:\\Projects\\rujarvis' });
    await memory.rememberApp({ spoken: 'спотифай', target: 'Spotify' });

    const lines = memory.selectRelevant('посмотри в аегисе почему билд падает');
    expect(lines.some((line) => line.includes('D:\\Projects\\aegis'))).toBe(true);
    expect(lines.some((line) => line.includes('rujarvis'))).toBe(false);
    expect(lines.some((line) => line.includes('Spotify'))).toBe(false);
  });

  it('respects the line limit so memory never becomes a giant prompt', async () => {
    const memory = new JarvisMemory();
    for (let index = 0; index < 10; index += 1) {
      await memory.rememberProject({ name: `proj${index}`, path: `D:\\p${index}` });
    }
    const lines = memory.selectRelevant(
      'proj0 proj1 proj2 proj3 proj4 proj5 proj6 proj7 proj8 proj9',
      3,
    );
    expect(lines).toHaveLength(3);
  });

  it('survives a storage backend that fails on load and on save', async () => {
    const broken: MemoryStorage = {
      load: async () => {
        throw new Error('disk on fire');
      },
      save: async () => {
        throw new Error('disk still on fire');
      },
    };
    const memory = new JarvisMemory({ storage: broken });
    await memory.load();
    await expect(
      memory.rememberProject({ name: 'aegis', path: 'D:\\Projects\\aegis' }),
    ).resolves.toBeUndefined();
    expect(memory.findProject('aegis')).toBeDefined();
  });
});

describe('file-backed memory', () => {
  it('round-trips a snapshot through disk', async () => {
    const dir = await temporaryDir();
    const file = path.join(dir, 'memory.json');
    const storage = createFileMemoryStorage(file);

    const memory = new JarvisMemory({ storage });
    await memory.load();
    await memory.rememberProject({ name: 'aegis', path: 'D:\\Projects\\aegis', aliases: ['аегис'] });
    await memory.rememberPreference('browser', 'chrome');

    const reloaded = new JarvisMemory({ storage });
    await reloaded.load();
    expect(reloaded.findProject('аегис')?.path).toBe('D:\\Projects\\aegis');
    expect(reloaded.preferences.browser).toBe('chrome');
  });

  it('starts empty rather than failing when the file is corrupt', async () => {
    const dir = await temporaryDir();
    const file = path.join(dir, 'memory.json');
    await writeFile(file, '{ this is not json', 'utf-8');

    const memory = new JarvisMemory({ storage: createFileMemoryStorage(file) });
    await memory.load();
    expect(memory.projects).toHaveLength(0);
  });

  it('writes atomically so a crash cannot truncate the store', async () => {
    const dir = await temporaryDir();
    const file = path.join(dir, 'memory.json');
    const storage = createFileMemoryStorage(file);
    const snapshot: MemorySnapshot = {
      projects: [{ name: 'aegis', path: 'D:\\Projects\\aegis' }],
      apps: [],
      recentTasks: [],
      preferences: {},
    };
    await storage.save(snapshot);

    const raw = await readFile(file, 'utf-8');
    expect(JSON.parse(raw)).toEqual(snapshot);
  });

  it('places its home inside the shared Open Interpreter home', () => {
    expect(resolveJarvisHome({ INTERPRETER_HOME: '/custom/home' })).toBe(
      path.join('/custom/home', 'jarvis'),
    );
    expect(resolveJarvisHome({})).toBe(path.join(os.homedir(), '.openinterpreter', 'jarvis'));
  });
});

describe('WorldStateStore', () => {
  it('tracks the foreground window and pushes the old one into history', () => {
    const store = new WorldStateStore();
    store.setActiveWindow({ title: 'Aegis — Visual Studio Code', app: 'Code' });
    store.setActiveWindow({ title: 'GitHub — Chrome', app: 'chrome.exe' });

    const state = store.snapshot();
    expect(state.activeWindow?.app).toBe('chrome.exe');
    expect(state.foregroundApp).toBe('chrome.exe');
    expect(state.recentWindows[0]?.title).toBe('Aegis — Visual Studio Code');
  });

  it('keeps a stale picture when the desktop query fails', async () => {
    const observer: DesktopObserver = {
      activeWindow: async () => {
        throw new Error('no window server');
      },
    };
    const store = new WorldStateStore({ observer });
    store.setActiveWindow({ title: 'Notepad', app: 'notepad.exe' });

    await expect(store.refresh()).resolves.toBeTruthy();
    expect(store.snapshot().activeWindow?.title).toBe('Notepad');
  });

  it('reads the desktop when the observer works', async () => {
    const observer: DesktopObserver = {
      activeWindow: async () => ({ title: 'Telegram', app: 'Telegram.exe' }),
      currentBrowserTab: async () => ({ title: 'GitHub', url: 'https://github.com/aisarus' }),
    };
    const state = await new WorldStateStore({ observer }).refresh();
    expect(state.activeWindow?.title).toBe('Telegram');
    expect(state.currentBrowserTab?.url).toBe('https://github.com/aisarus');
  });

  it('bounds recent files and processes', () => {
    const store = new WorldStateStore({ historyLimit: 2 });
    store.noteFile('a');
    store.noteFile('b');
    store.noteFile('c');
    expect(store.snapshot().recentFiles).toEqual(['c', 'b']);

    store.noteProcess({ pid: 1, command: 'pnpm build', startedAt: 0 });
    store.noteProcess({ pid: 2, command: 'pnpm test', startedAt: 0 });
    store.forgetProcess(1);
    expect(store.snapshot().spawnedProcesses.map((entry) => entry.pid)).toEqual([2]);
  });
});

describe('selectWorldStateLines', () => {
  it('gives a referential utterance what it needs to resolve «это»', () => {
    const store = new WorldStateStore();
    store.setActiveWindow({ title: 'Блокнот — заметки.txt', app: 'notepad.exe' });
    store.noteUtterance('открой заметки');
    store.noteResult({ text: 'Открыл заметки.txt', ok: true, backend: 'interpreter' });
    // Вторая реплика — та самая, в которой есть «это». Предыдущей она делает
    // первую: до неё никакой предыстории и не было.
    store.noteUtterance('закрой это');

    const lines = selectWorldStateLines(store.snapshot(), { needsWorldState: true });
    expect(lines.some((line) => line.includes('Блокнот'))).toBe(true);
    expect(lines.some((line) => line.includes('открой заметки'))).toBe(true);
    // Нынешняя реплика предысторией не притворяется: она и так в самой просьбе.
    expect(lines.some((line) => line.includes('закрой это'))).toBe(false);
  });

  it('stays quiet for a fully specified request', () => {
    const store = new WorldStateStore();
    store.setActiveWindow({ title: 'Блокнот', app: 'notepad.exe' });
    store.noteUtterance('открой заметки');

    const lines = selectWorldStateLines(store.snapshot(), { needsWorldState: false });
    expect(lines.some((line) => line.includes('Предыдущая реплика'))).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('never exceeds the requested line budget', () => {
    const store = new WorldStateStore();
    store.setActiveWindow({ title: 'A', app: 'a.exe' });
    store.setActiveWindow({ title: 'B', app: 'b.exe' });
    store.setBrowserTab({ title: 'GitHub', url: 'https://github.com' });
    store.setProject('aegis', 'D:\\Projects\\aegis');
    store.noteUtterance('что там');
    store.noteResult({ text: 'многострочный\nответ', ok: true, backend: 'codex' });
    store.noteFile('a.ts');

    expect(selectWorldStateLines(store.snapshot(), { needsWorldState: true, limit: 3 })).toHaveLength(3);
  });

  it('shows only the first line of a long previous result', () => {
    const store = new WorldStateStore();
    store.noteResult({
      text: 'Нашёл проблему в конфиге.\nПодробности:\nмного текста',
      ok: true,
      backend: 'claude-code',
    });
    const lines = selectWorldStateLines(store.snapshot(), { needsWorldState: true });
    const resultLine = lines.find((line) => line.startsWith('Предыдущий результат'));
    expect(resultLine).toContain('Нашёл проблему в конфиге.');
    expect(resultLine).not.toContain('много текста');
  });
});
