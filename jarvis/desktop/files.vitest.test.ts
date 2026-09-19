import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatEntries,
  formatSize,
  moveIntoFolder,
  readFolder,
  readOutputTree,
  sectionFor,
  uniqueName,
} from './files';

describe('uniqueName', () => {
  it('оставляет имя, когда оно свободно', () => {
    expect(uniqueName('кот.png', new Set())).toBe('кот.png');
  });

  it('не затирает чужой файл с тем же именем', () => {
    // Вчерашний отчёт — это чья-то работа, а не мусор под замену.
    expect(uniqueName('отчёт.xlsx', new Set(['отчёт.xlsx']))).toBe('отчёт (2).xlsx');
  });

  it('ищет дальше, пока имя не освободится', () => {
    const taken = new Set(['а.png', 'а (2).png', 'а (3).png']);
    expect(uniqueName('а.png', taken)).toBe('а (4).png');
  });

  it('справляется с именем без расширения', () => {
    expect(uniqueName('README', new Set(['README']))).toBe('README (2)');
  });
});

describe('formatSize', () => {
  it('говорит про маленькие файлы в байтах', () => {
    expect(formatSize(512)).toBe('512 Б');
  });

  it('переходит на килобайты и мегабайты', () => {
    expect(formatSize(2048)).toBe('2 КБ');
    expect(formatSize(5 * 1024 * 1024)).toBe('5,0 МБ');
  });
});

describe('formatEntries', () => {
  const entry = (name: string, minutes: number) => ({
    name,
    size: 1024,
    modified: new Date(2026, 8, 19, 12, minutes),
    isFolder: false,
  });

  it('прямо говорит, что папка пуста', () => {
    // «Ничего не найдено» и «я не посмотрел» для модели должны различаться.
    expect(formatEntries([])).toBe('Папка пуста.');
  });

  it('обрезает длинный список и признаётся в этом', () => {
    const entries = Array.from({ length: 10 }, (_, index) => entry(`ф${index}.png`, index));
    const text = formatEntries(entries, 3);

    expect(text).toContain('ф0.png');
    expect(text).toContain('…и ещё 7');
    expect(text).not.toContain('ф9.png');
  });
});

const temporary: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-files-test-'));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  temporary.length = 0;
});

describe('readFolder', () => {
  it('показывает свежее первым — искать будут последнее', async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, 'старое.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 12));
    writeFileSync(path.join(dir, 'новое.txt'), 'y');

    const entries = await readFolder(dir);

    expect(entries.map((item) => item.name)).toEqual(['новое.txt', 'старое.txt']);
  });
});

describe('sectionFor', () => {
  it.each([
    ['закат.png', 'Images'],
    ['ролик.mp4', 'Video'],
    ['отчёт.xlsx', 'Docs'],
    ['договор.pdf', 'Docs'],
    ['установщик.exe', 'Apps'],
  ])('кладёт «%s» в раздел %s', (name, section) => {
    expect(sectionFor(name)).toBe(section);
  });

  it('незнакомое складывает в Files, а не бросает в корень', () => {
    // Корень — витрина: пусто в нём должно быть только по-настоящему.
    expect(sectionFor('дамп.bin')).toBe('Files');
    expect(sectionFor('README')).toBe('Files');
  });

  it('не зависит от регистра расширения', () => {
    expect(sectionFor('ФОТО.JPG')).toBe('Images');
  });
});

describe('moveIntoFolder', () => {
  it('переносит файл в раздел по его типу', async () => {
    const from = makeDir();
    const to = makeDir();
    const source = path.join(from, 'картинка.png');
    writeFileSync(source, 'данные');

    const moved = await moveIntoFolder(source, to);

    expect(moved).toBe(path.join(to, 'Images', 'картинка.png'));
    expect(await readFile(moved, 'utf8')).toBe('данные');
    expect(await readdir(from)).toEqual([]);
  });

  it('разводит картинку и ролик по разным разделам', async () => {
    const from = makeDir();
    const to = makeDir();
    writeFileSync(path.join(from, 'кадр.png'), 'a');
    writeFileSync(path.join(from, 'ролик.mp4'), 'b');

    const image = await moveIntoFolder(path.join(from, 'кадр.png'), to);
    const video = await moveIntoFolder(path.join(from, 'ролик.mp4'), to);

    expect(path.dirname(image).endsWith('Images')).toBe(true);
    expect(path.dirname(video).endsWith('Video')).toBe(true);
  });

  it('не затирает то, что уже лежит в разделе', async () => {
    const from = makeDir();
    const to = makeDir();
    mkdirSync(path.join(to, 'Images'), { recursive: true });
    writeFileSync(path.join(to, 'Images', 'картинка.png'), 'старое');
    writeFileSync(path.join(from, 'картинка.png'), 'новое');

    const moved = await moveIntoFolder(path.join(from, 'картинка.png'), to);

    expect(path.basename(moved)).toBe('картинка (2).png');
    expect(await readFile(path.join(to, 'Images', 'картинка.png'), 'utf8')).toBe('старое');
  });

  it('жалуется, когда переносить нечего', async () => {
    const to = makeDir();
    await expect(moveIntoFolder(path.join(to, 'нет-такого.png'), to)).rejects.toThrow();
  });
});

describe('readOutputTree', () => {
  it('показывает файлы по разделам, а не пять пустых папок', async () => {
    // Плоский список корня здесь бесполезен: в нём лежат только разделы.
    const from = makeDir();
    const to = makeDir();
    writeFileSync(path.join(from, 'кадр.png'), 'a');
    writeFileSync(path.join(from, 'ролик.mp4'), 'b');
    await moveIntoFolder(path.join(from, 'кадр.png'), to);
    await moveIntoFolder(path.join(from, 'ролик.mp4'), to);

    const tree = await readOutputTree(to);

    expect(tree).toContain('Images:');
    expect(tree).toContain('кадр.png');
    expect(tree).toContain('Video:');
    expect(tree).toContain('ролик.mp4');
    // Пустые разделы не занимают место в ответе.
    expect(tree).not.toContain('Apps:');
  });

  it('признаётся, что папка пуста, вместо списка разделов', async () => {
    expect(await readOutputTree(makeDir())).toBe('Папка пуста.');
  });

  it('показывает и то, что человек положил в корень руками', async () => {
    const to = makeDir();
    writeFileSync(path.join(to, 'заметка.txt'), 'x');

    expect(await readOutputTree(to)).toContain('заметка.txt');
  });
});
