import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from './courses';
import { findAbandonedLectures, recoverLecture } from './recover';
import { LectureSession } from './session';

async function временная(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'jarvis-recover-'));
}

/** Лекция, которую бросили посреди: настоящая сессия, звук и расшифровка, потом `abandon`. */
async function брошенная(папка: string, текст: string | null, when = new Date(2026, 9, 20, 10, 5)): Promise<LectureSession> {
  const сессия = new LectureSession(папка, '', { transcribe: async () => текст ?? '', summarize: async () => '' }, when);
  await сессия.start();
  сессия.addAudio(new Float32Array(16_000), 16_000);
  await new Promise((r) => setTimeout(r, 50));
  сессия.abandon();
  return сессия;
}

const модель = async (prompt: string): Promise<string> =>
  prompt.includes('[!abstract]') ? 'Предмет: Микроэкономика\nТема: Спрос\n\n## Кратко\nО спросе.' : '### Спрос\n- пункт';

describe('брошенная лекция', () => {
  it('узнаётся по заметке без свойств лекции, рядом с которой расшифровка и звук', async () => {
    const root = await временная();
    const курс = path.join(root, 'Микроэкономика');
    await mkdir(курс, { recursive: true });
    await writeFile(path.join(курс, 'Микроэкономика.md'), '# Микроэкономика\n', 'utf8');
    const вКурсе = await брошенная(курс, 'הביקוש יורד');
    const вКорне = await брошенная(root, 'מחיר', new Date(2026, 9, 21, 9, 0));
    // Своя заметка человека без расшифровки рядом — не лекция.
    await writeFile(path.join(курс, 'мои мысли.md'), '# мысли\n', 'utf8');
    // Законченная лекция — со свойствами.
    await writeFile(path.join(курс, '2026-10-13 — Цены.md'), "---\nкурс: 'Микроэкономика'\nдата: 2026-10-13\n---\n# Цены\n", 'utf8');
    await writeFile(path.join(курс, '2026-10-13 — Цены — расшифровка.md'), '**[00:00]** מחיר\n', 'utf8');
    await writeFile(path.join(курс, '2026-10-13 — Цены.wav'), Buffer.alloc(44));

    expect(findAbandonedLectures(root).sort()).toEqual([вКурсе.notesFile, вКорне.notesFile].sort());
    // Идущая лекция — тоже без свойств, но её не трогают.
    expect(findAbandonedLectures(root, new Set([вКорне.notesFile]))).toEqual([вКурсе.notesFile]);
  });

  it('дописывается по расшифровке и встаёт в свой курс со свойствами — больше не брошенная', async () => {
    const root = await временная();
    const курс = path.join(root, 'Микроэкономика');
    await mkdir(курс, { recursive: true });
    const сессия = await брошенная(курс, 'הביקוש יורד כשהמחיר עולה');
    const итог = await recoverLecture(сессия.notesFile, { root, languages: { lecture: 'he', notes: 'ru' }, summarize: модель });
    expect(итог).toMatchObject({ course: 'Микроэкономика', number: 1, summary: true });
    expect(path.basename(итог.notesFile)).toBe('2026-10-20 — Спрос.md');
    const заметка = await readFile(итог.notesFile, 'utf8');
    expect(parseFrontmatter(заметка)).toMatchObject({ course: 'Микроэкономика', number: 1, date: '2026-10-20', start: '10:05', topic: 'Спрос' });
    expect(заметка).toContain('## Кратко');
    expect(existsSync(итог.audioFile)).toBe(true);
    expect(findAbandonedLectures(root)).toEqual([]);
  });

  it('ничего не расслышано — раскладывается как есть, а не дописывается при каждом запуске', async () => {
    const root = await временная();
    const сессия = await брошенная(root, null);
    const итог = await recoverLecture(сессия.notesFile, { root, languages: { lecture: 'ru', notes: 'ru' }, summarize: модель });
    expect(итог).toMatchObject({ course: 'Без курса', sections: 0, summary: false });
    expect(parseFrontmatter(await readFile(итог.notesFile, 'utf8'))).toMatchObject({ course: 'Без курса', date: '2026-10-20' });
    expect(findAbandonedLectures(root)).toEqual([]);
  });
});
