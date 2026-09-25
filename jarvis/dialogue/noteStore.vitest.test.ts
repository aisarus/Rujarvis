import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { NoteStore } from './noteStore';

function store(): NoteStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'));
  return new NoteStore(path.join(dir, 'notes.json'));
}

describe('NoteStore', () => {
  it('переживает путь до несуществующей папки', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'));
    const deep = new NoteStore(path.join(dir, 'нет', 'такой', 'папки', 'notes.json'));
    deep.add('крышу синей');

    expect(deep.peek().map((note) => note.text)).toEqual(['крышу синей']);
  });

  it('доносит правку от одного процесса до другого', () => {
    // Мост кладёт, агент забирает — и это два разных процесса, у которых общий
    // только этот файл.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'));
    const file = path.join(dir, 'notes.json');
    new NoteStore(file).add('крышу сделай синей');

    expect(new NoteStore(file).take().map((note) => note.text)).toEqual([
      'крышу сделай синей',
    ]);
  });

  it('очищает ящик, отдав его', () => {
    const box = store();
    box.add('крышу синей');

    expect(box.take()).toHaveLength(1);
    expect(box.take()).toHaveLength(0);
  });

  it('не кладёт одно и то же дважды', () => {
    const box = store();
    box.add('крышу синей');
    box.add('крышу синей');

    expect(box.peek()).toHaveLength(1);
  });

  it('считает битый файл пустым ящиком', () => {
    // Из-за испорченного файла помощник падать не должен: молчание здесь
    // безопаснее исключения посреди работы.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'));
    const file = path.join(dir, 'notes.json');
    writeFileSync(file, 'это не json', 'utf8');

    expect(new NoteStore(file).peek()).toEqual([]);
  });

  it('не принимает за правки чужое содержимое файла', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-notes-'));
    const file = path.join(dir, 'notes.json');
    writeFileSync(file, JSON.stringify([{ нет: 'полей' }, 'строка', null]), 'utf8');

    expect(new NoteStore(file).peek()).toEqual([]);
  });

  it('не хранит пустое', () => {
    const box = store();
    box.add('   ');

    expect(box.peek()).toEqual([]);
  });
});

describe('забрать одну заметку', () => {
  // Решение «поправка или отдельная задача» принимается в фоне и приходит
  // через несколько секунд. За это время агент мог забрать ящик.
  it('убирает названную и оставляет остальные', () => {
    const box = store();
    box.add('шрифт крупнее');
    box.add('найди картинки');

    expect(box.drop('найди картинки')).toBe(true);
    expect(box.peek().map((n) => n.text)).toEqual(['шрифт крупнее']);
  });

  // Тот самый гонок: агент успел прочитать ящик раньше, чем пришло решение.
  // Заводить вторую задачу теперь нельзя — работа по ней уже идёт.
  it('говорит «нет», когда заметку уже забрали', () => {
    const box = store();
    box.add('найди картинки');
    box.take();

    expect(box.drop('найди картинки')).toBe(false);
  });

  it('не спотыкается о пробелы по краям', () => {
    const box = store();
    box.add('найди картинки');
    expect(box.drop('  найди картинки  ')).toBe(true);
    expect(box.peek()).toEqual([]);
  });
});
