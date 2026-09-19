import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forget, recall, remember } from './agentMemory';

describe('память агента между запусками', () => {
  let home: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.JARVIS_HOME;
    home = mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'));
    process.env.JARVIS_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = previous;
  });

  it('помнит записанное после перезапуска', () => {
    remember('кнопка Play в Riot', 'правый нижний угол, примерно (1720, 980)');
    // Чтение идёт с диска, а не из памяти процесса — это и есть проверка.
    expect(recall('Riot')[0]?.value).toContain('1720');
  });

  it('заменяет запись, а не плодит дубликаты', () => {
    remember('кнопка Play', 'слева');
    remember('кнопка Play', 'справа');
    const notes = recall('Play');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.value).toBe('справа');
  });

  it('отдаёт только то, что относится к делу', () => {
    remember('Riot', 'лаунчер лиги');
    remember('таблицы', 'сводный отчёт лежит в документах');
    expect(recall('Riot').map((n) => n.key)).toEqual(['Riot']);
  });

  it('без темы отдаёт всё, новое первым', () => {
    remember('первое', 'раз');
    remember('второе', 'два');
    expect(recall().map((n) => n.key)).toEqual(['второе', 'первое']);
  });

  it('забывает по просьбе и сообщает, было ли что забывать', () => {
    remember('лишнее', 'значение');
    expect(forget('лишнее')).toBe(true);
    expect(forget('лишнее')).toBe(false);
    expect(recall('лишнее')).toHaveLength(0);
  });
});
