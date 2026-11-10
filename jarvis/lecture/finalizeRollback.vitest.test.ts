/**
 * Раскладка лекции по курсу: переезд трёх файлов — всё или ничего.
 * Отдельным файлом: переименование подменяется, и другим проверкам это мешало бы.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const отказ = vi.hoisted(() => ({ накуда: null as RegExp | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const настоящий = await importOriginal<typeof import('node:fs/promises')>();
  const rename: typeof настоящий.rename = async (от, куда) => {
    if (отказ.накуда?.test(String(куда))) throw Object.assign(new Error('EXDEV: файл держит другая программа'), { code: 'EXDEV' });
    return настоящий.rename(от, куда);
  };
  return { ...настоящий, rename, default: { ...настоящий, rename } };
});

const { finalizeLecture } = await import('./finalize');
const { findAbandonedLectures } = await import('./recover');
const { parseFrontmatter } = await import('./courses');

const папки: string[] = [];
afterEach(async () => {
  отказ.накуда = null;
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

describe('сбой переименования при раскладке', () => {
  it('лекция не остаётся наполовину разложенной: файлы на прежних местах, заметка не тронута, повтор раскладывает', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'jarvis-rollback-'));
    папки.push(root);
    const база = path.join(root, '2026-10-20 1005 Лекция');
    const заметка = '# Лекция\n\nРасшифровка: [[2026-10-20 1005 Лекция — расшифровка]] · звук: 2026-10-20 1005 Лекция.wav\n\n## Конспект\n\n### Спрос (00:00–05:00)\n- пункт\n';
    const расшифровка = '# Расшифровка — Лекция\n\nКонспект: [[2026-10-20 1005 Лекция]]\n\n**[00:00]** слова\n';
    await writeFile(`${база}.md`, заметка, 'utf8');
    await writeFile(`${база} — расшифровка.md`, расшифровка, 'utf8');
    await writeFile(`${база}.wav`, Buffer.alloc(100));
    const input = {
      root,
      notesFile: `${база}.md`,
      transcriptFile: `${база} — расшифровка.md`,
      audioFile: `${база}.wav`,
      notes: 'ru' as const,
      when: new Date(2026, 9, 20, 10, 5),
      durationSec: 300,
      course: 'Микроэкономика',
      topic: 'Спрос',
    };

    // Звук и расшифровка переехали, а заметку не пустили.
    отказ.накуда = /Спрос\.md$/u;
    await expect(finalizeLecture(input)).rejects.toThrow(/EXDEV/u);

    expect((await readdir(root)).sort()).toEqual(['2026-10-20 1005 Лекция — расшифровка.md', '2026-10-20 1005 Лекция.md', '2026-10-20 1005 Лекция.wav', 'Микроэкономика'].sort());
    expect(await readdir(path.join(root, 'Микроэкономика'))).toEqual([]);
    // Ни свойств, ни ссылок на имена, которых нет.
    expect(await readFile(`${база}.md`, 'utf8')).toBe(заметка);
    expect(await readFile(`${база} — расшифровка.md`, 'utf8')).toBe(расшифровка);
    // Свойств нет — значит, следующий запуск найдёт её как брошенную и разложит.
    expect(findAbandonedLectures(root)).toEqual([`${база}.md`]);

    отказ.накуда = null;
    const место = await finalizeLecture(input);
    expect(path.relative(root, место.notesFile)).toBe(path.join('Микроэкономика', '2026-10-20 — Спрос.md'));
    expect(existsSync(место.audioFile) && existsSync(место.transcriptFile)).toBe(true);
    const текст = await readFile(место.notesFile, 'utf8');
    expect(parseFrontmatter(текст)).toMatchObject({ course: 'Микроэкономика', number: 1, topic: 'Спрос' });
    expect(текст).toContain('![[2026-10-20 — Спрос.wav]]');
    expect(await readFile(место.transcriptFile, 'utf8')).toContain('Конспект: [[2026-10-20 — Спрос]]');
    expect(await readdir(root)).toEqual(['Микроэкономика']);
  });
});
