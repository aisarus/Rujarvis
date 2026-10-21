import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normaliseSettings } from '../setup/settings';
import { renderFrontmatter } from './courses';
import { moveLecture } from './finalize';
import { deleteRecording, deleteRecordings, expiredRecordings, listRecordings, recordingOf, summarizeRecordings } from './recordings';

const ДЕНЬ = 24 * 60 * 60 * 1000;

/** Лекция, как её оставляет `finalizeLecture`: заметка со свойствами, расшифровка, звук. */
async function лекция(
  root: string,
  курс: string,
  база: string,
  { речь = true, расшифровка = true, звук = 1000, notes = 'ru' as 'ru' | 'en' } = {},
): Promise<string> {
  const папка = path.join(root, курс);
  await mkdir(папка, { recursive: true });
  const заметка = path.join(папка, `${база}.md`);
  const подпись = notes === 'en' ? 'Transcript' : 'Расшифровка';
  const суффикс = notes === 'en' ? 'transcript' : 'расшифровка';
  await writeFile(
    заметка,
    `${renderFrontmatter({ course: курс, number: 1, date: '2026-10-13' }, notes)}# Тема\n\n${подпись}: [[${база} — ${суффикс}]] · [[${курс}]]\n\n![[${база}.wav]]\n\n## Конспект\n`,
    'utf8',
  );
  if (расшифровка) {
    await writeFile(path.join(папка, `${база} — ${суффикс}.md`), `# ${подпись}\n\n${речь ? '**[00:00]** Сегодня о спросе.\n' : ''}`, 'utf8');
  }
  await writeFile(path.join(папка, `${база}.wav`), Buffer.alloc(звук));
  return заметка;
}

async function временная(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'jarvis-recordings-'));
}

describe('записи лекций на диске', () => {
  it('запись — только звук рядом с заметкой лекции Джарвиса; без расшифровки или без речи — нужен', async () => {
    const root = await временная();
    await лекция(root, 'Микроэкономика', '2026-10-13 — Спрос', { звук: 3000 });
    await лекция(root, 'Микроэкономика', '2026-10-20 — Тишина', { речь: false, звук: 2000 });
    await лекция(root, 'Без курса', '2026-10-14', { расшифровка: false, звук: 500 });
    // Чужой звук в хранилище и во «Входящих» — не записи лекций.
    await writeFile(path.join(root, 'Микроэкономика', 'подкаст.wav'), Buffer.alloc(100));
    await mkdir(path.join(root, 'Входящие'));
    await writeFile(path.join(root, 'Входящие', 'лекция.wav'), Buffer.alloc(100));
    // Идущая лекция: заметка ещё без свойств.
    await writeFile(path.join(root, 'Микроэкономика', '2026-10-21 1005 Лекция.md'), '# Лекция\n', 'utf8');
    await writeFile(path.join(root, 'Микроэкономика', '2026-10-21 1005 Лекция.wav'), Buffer.alloc(100));

    const записи = listRecordings(root);
    expect(записи.map((r) => [r.course, r.lecture, r.bytes, r.keep]).sort()).toEqual(
      [
        ['Без курса', '2026-10-14', 500, 'no-transcript'],
        ['Микроэкономика', '2026-10-13 — Спрос', 3000, undefined],
        ['Микроэкономика', '2026-10-20 — Тишина', 2000, 'empty-transcript'],
      ].sort(),
    );
    expect(summarizeRecordings(записи)).toEqual({ count: 3, bytes: 5500, deletable: 1, deletableBytes: 3000 });
  });

  it('удалённый звук: файла нет, в заметке вместо проигрывателя — строка, что звук удалён', async () => {
    const root = await временная();
    const заметка = await лекция(root, 'Микроэкономика', '2026-10-13 — Спрос');
    const запись = recordingOf(заметка)!;
    await deleteRecording(запись, new Date(2026, 9, 21));
    expect(existsSync(запись.audioFile)).toBe(false);
    const текст = await readFile(заметка, 'utf8');
    expect(текст).not.toContain('![[');
    expect(текст).toContain('*Звук лекции удалён 21.10.2026, чтобы не занимать место: конспект и расшифровка остались.*');
    expect(recordingOf(заметка)).toBeNull();
    // Перенос в другой курс не возвращает проигрыватель, который вёл бы в никуда.
    const итог = await moveLecture(root, заметка, 'Макроэкономика', 'ru');
    expect(await readFile(итог.notesFile, 'utf8')).not.toContain('![[');
  });

  it('у английского конспекта и строка английская', async () => {
    const root = await временная();
    const заметка = await лекция(root, 'Statistics', '2026-10-13 — Variables', { notes: 'en' });
    await deleteRecording(recordingOf(заметка)!, new Date(2026, 9, 21));
    expect(await readFile(заметка, 'utf8')).toContain('*Lecture audio deleted on 2026-10-21 to save disk space; the notes and transcript remain.*');
  });

  it('нужный звук не удаляется ни по одному, ни скопом', async () => {
    const root = await временная();
    const тишина = await лекция(root, 'Микро', '2026-10-20 — Тишина', { речь: false });
    await лекция(root, 'Микро', '2026-10-13 — Спрос', { звук: 700 });
    await expect(deleteRecording(recordingOf(тишина)!)).rejects.toThrow(/нужен/u);
    expect(await deleteRecordings(listRecordings(root))).toEqual({ deleted: 1, bytes: 700, kept: 1, failed: 0 });
    expect(listRecordings(root).map((r) => r.lecture)).toEqual(['2026-10-20 — Тишина']);
  });

  it('в настройках по умолчанию — удалять через неделю; «хранить» — только явным выбором', () => {
    expect(normaliseSettings({}).recordingsKeep).toBe('week');
    expect(normaliseSettings({ recordingsKeep: 'forever' }).recordingsKeep).toBe('forever');
    expect(normaliseSettings({ recordingsKeep: 'month' }).recordingsKeep).toBe('week');
  });

  it('сам через неделю — только записи старше семи дней и с расшифровкой', async () => {
    const root = await временная();
    const сейчас = Date.now();
    const старая = await лекция(root, 'Микро', 'старая');
    const свежая = await лекция(root, 'Микро', 'свежая');
    const стараяБезРечи = await лекция(root, 'Микро', 'старая без речи', { речь: false });
    for (const [заметка, дней] of [[старая, 8], [свежая, 6], [стараяБезРечи, 30]] as const) {
      const когда = new Date(сейчас - дней * ДЕНЬ);
      await utimes(заметка.replace(/\.md$/u, '.wav'), когда, когда);
    }
    expect(expiredRecordings(listRecordings(root), сейчас).map((r) => r.lecture)).toEqual(['старая']);
  });
});
