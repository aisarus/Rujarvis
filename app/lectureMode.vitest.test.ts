import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const папка = vi.hoisted(() => ({ путь: '' }));

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }));
// Настоящий obsidian.json владельца указывает на его заметки: проверка туда не пишет.
vi.mock('../jarvis/lecture/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jarvis/lecture/vault')>()),
  lectureFolder: () => ({ folder: папка.путь, vault: null }),
}));

const { finishLecture, lectureActive, startLecture } = await import('./lectureMode');

afterEach(async () => {
  await finishLecture();
  if (папка.путь) await rm(папка.путь, { recursive: true, force: true });
});

describe('режим лекции в мосте', () => {
  it('«закончи» не держит мост: лекция кончается сразу, итог приходит потом', async () => {
    папка.путь = await mkdtemp(path.join(tmpdir(), 'jarvis-lecture-mode-'));
    const options = { home: папка.путь, outputDir: папка.путь, lectureLanguage: 'ru', notesLanguage: 'ru' as const, mainEndpoint: () => null };

    // Модели для лекций нет — об этом сказано, а не молча хуже.
    expect(await startLecture('Физика', options)).toMatch(/lecture-model/u);
    expect(lectureActive()).toBe(true);
    expect(await startLecture('Физика', options)).toMatch(/уже пишется|Already/u);

    const итог = finishLecture();
    expect(итог).not.toBeNull();
    // Следующая фраза — уже разговор, а не лекция.
    expect(lectureActive()).toBe(false);
    // Прошлая ещё дописывается и держит порт своего сервера — новая ждёт.
    expect(await startLecture('Химия', options)).toMatch(/дописываю|Still finishing/u);
    expect(lectureActive()).toBe(false);

    expect(await итог).toMatch(/разделов — 0|0 sections/u);
    expect((await readdir(папка.путь)).filter((f) => f.endsWith('.md'))).toHaveLength(2);
    expect(await startLecture('Химия', options)).not.toMatch(/дописываю|Still finishing/u);
    expect(lectureActive()).toBe(true);
  });

  it('«закончи», когда конспекта нет, — не ошибка и не ожидание', () => {
    expect(finishLecture()).toBeNull();
  });
});
