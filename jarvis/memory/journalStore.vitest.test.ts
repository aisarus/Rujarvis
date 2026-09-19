import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { JournalStore } from './journalStore';

function file(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'jarvis-journal-')), 'journal.json');
}

describe('JournalStore', () => {
  it('помнит записанное', () => {
    const store = new JournalStore(file());
    store.record({ kind: 'launch', text: 'открыл Chrome' });

    expect(store.recent()).toHaveLength(1);
    expect(store.recent()[0].text).toBe('открыл Chrome');
  });

  it('проставляет время само', () => {
    const before = Date.now();
    const store = new JournalStore(file());
    store.record({ kind: 'launch', text: 'открыл Chrome' });

    expect(store.recent()[0].at).toBeGreaterThanOrEqual(before);
  });

  it('переживает перезапуск', () => {
    // Ради этого всё и пишется на диск: помощник, забывающий себя при
    // перезапуске, каждый раз начинает разговор заново.
    const where = file();
    new JournalStore(where).record({ kind: 'file', text: 'сделал закат.png' });

    expect(new JournalStore(where).recent()[0].text).toBe('сделал закат.png');
  });

  it('не растёт бесконечно', () => {
    const store = new JournalStore(file(), { limit: 5 });
    for (let index = 0; index < 20; index += 1) {
      store.record({ kind: 'launch', text: `действие ${index}` });
    }

    const kept = store.recent();
    expect(kept).toHaveLength(5);
    // Выбрасывается старое, а не новое.
    expect(kept.map((item) => item.text)).toContain('действие 19');
    expect(kept.map((item) => item.text)).not.toContain('действие 0');
  });

  it('переживает испорченный файл, а не падает вместе с приложением', () => {
    // Журнал — не та вещь, ради которой стоит не запуститься.
    const where = file();
    writeFileSync(where, 'это не json', 'utf8');

    const store = new JournalStore(where);
    expect(store.recent()).toEqual([]);
    store.record({ kind: 'note', text: 'работаю дальше' });
    expect(store.recent()).toHaveLength(1);
  });

  it('молчит, когда записи нет', () => {
    expect(new JournalStore(file()).recent()).toEqual([]);
  });

  it('отдаёт градиент, а не сырой журнал', () => {
    const store = new JournalStore(file());
    store.record({ kind: 'launch', text: 'открыл Chrome' });

    const lines = store.context();
    expect(lines[0]).toContain('открыл Chrome');
  });
});
