import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isSectionName,
  tidyRoot,
  командаПоказа,
  formatEntries,
  formatSize,
  moveIntoFolder,
  readFolder,
  readOutputTree,
  safeFolderName,
  sectionDir,
  sectionFor,
  sectionName,
  tidyOutput,
  uniqueName,
} from './files';
import { setLanguage } from '../locale/language';

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
    ['закат.png', 'images'],
    ['ролик.mp4', 'video'],
    ['отчёт.xlsx', 'tables'],
    ['договор.pdf', 'docs'],
    ['доклад.pptx', 'slides'],
    ['песня.mp3', 'audio'],
    ['скрипт.py', 'code'],
    ['архив.zip', 'archives'],
    ['установщик.exe', 'apps'],
  ])('кладёт «%s» в раздел %s', (name, section) => {
    expect(sectionFor(name)).toBe(section);
  });

  it('незнакомое складывает в «Разное», а не бросает в корень', () => {
    // Корень — витрина: пусто в нём должно быть только по-настоящему.
    expect(sectionFor('дамп.bin')).toBe('other');
    expect(sectionFor('README')).toBe('other');
  });

  it('не зависит от регистра расширения', () => {
    expect(sectionFor('ФОТО.JPG')).toBe('images');
  });

  it('называет разделы на языке человека', () => {
    expect(sectionName('images', 'ru')).toBe('Картинки');
    expect(sectionName('images', 'en')).toBe('Images');
  });
});

describe('sectionDir', () => {
  afterEach(() => setLanguage('ru'));

  it('после смены языка остаётся в разделе, который уже есть', () => {
    // «Картинки» и «Images» рядом — хуже любой из них.
    const to = makeDir();
    mkdirSync(path.join(to, 'Картинки'));
    setLanguage('en');

    expect(sectionDir(to, 'images')).toBe(path.join(to, 'Картинки'));
    expect(sectionDir(to, 'video')).toBe(path.join(to, 'Video'));
  });
});

describe('safeFolderName', () => {
  it('вычищает то, что Windows не примет в имени папки', () => {
    expect(safeFolderName('Отчёт: март/апрель?')).toBe('Отчёт март апрель');
  });

  it('пустое и точки — не подпапка', () => {
    expect(safeFolderName('  ')).toBeUndefined();
    expect(safeFolderName('..')).toBeUndefined();
    expect(safeFolderName(undefined)).toBeUndefined();
  });

  it('обходит зарезервированные имена', () => {
    expect(safeFolderName('CON')).toBe('CON_');
  });
});

describe('moveIntoFolder', () => {
  it('переносит файл в раздел по его типу', async () => {
    const from = makeDir();
    const to = makeDir();
    const source = path.join(from, 'картинка.png');
    writeFileSync(source, 'данные');

    const moved = await moveIntoFolder(source, to);

    expect(moved).toBe(path.join(to, 'Картинки', 'картинка.png'));
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

    expect(path.dirname(image).endsWith('Картинки')).toBe(true);
    expect(path.dirname(video).endsWith('Видео')).toBe(true);
  });

  it('не затирает то, что уже лежит в разделе', async () => {
    const from = makeDir();
    const to = makeDir();
    mkdirSync(path.join(to, 'Картинки'), { recursive: true });
    writeFileSync(path.join(to, 'Картинки', 'картинка.png'), 'старое');
    writeFileSync(path.join(from, 'картинка.png'), 'новое');

    const moved = await moveIntoFolder(path.join(from, 'картинка.png'), to);

    expect(path.basename(moved)).toBe('картинка (2).png');
    expect(await readFile(path.join(to, 'Картинки', 'картинка.png'), 'utf8')).toBe('старое');
  });

  it('кладёт файлы одной задачи в подпапку внутри раздела', async () => {
    const from = makeDir();
    const to = makeDir();
    writeFileSync(path.join(from, 'кадр.png'), 'a');

    const moved = await moveIntoFolder(path.join(from, 'кадр.png'), to, 'Логотип: кафе');

    expect(moved).toBe(path.join(to, 'Картинки', 'Логотип кафе', 'кадр.png'));
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

    expect(tree).toContain('Картинки:');
    expect(tree).toContain('кадр.png');
    expect(tree).toContain('Видео:');
    expect(tree).toContain('ролик.mp4');
    // Пустые разделы не занимают место в ответе.
    expect(tree).not.toContain('Программы:');
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

describe('tidyOutput', () => {
  it('раскладывает по разделам файлы, которые агент бросил в корень', async () => {
    const to = makeDir();
    const file = path.join(to, 'отчёт.pdf');
    writeFileSync(file, 'x');

    const moves = await tidyOutput(to, [file]);

    expect(moves.get(file)).toBe(path.join(to, 'Документы', 'отчёт.pdf'));
    expect(await readdir(to)).toEqual(['Документы']);
  });

  it('папку агента уносит целиком в раздел большинства её файлов', async () => {
    const to = makeDir();
    const folder = path.join(to, 'Кафе');
    mkdirSync(folder);
    const files = ['1.png', '2.png', 'заметки.txt'].map((name) => path.join(folder, name));
    for (const file of files) writeFileSync(file, 'x');

    const moves = await tidyOutput(to, files);

    expect(moves.get(files[0])).toBe(path.join(to, 'Картинки', 'Кафе', '1.png'));
    expect(await readFile(path.join(to, 'Картинки', 'Кафе', 'заметки.txt'), 'utf8')).toBe('x');
  });

  it('не трогает то, что человек положил сам, и то, что уже в разделе', async () => {
    const to = makeDir();
    const mine = path.join(to, 'моё.txt');
    writeFileSync(mine, 'x');
    mkdirSync(path.join(to, 'Картинки'));
    const sorted = path.join(to, 'Картинки', 'кадр.png');
    writeFileSync(sorted, 'x');

    const moves = await tidyOutput(to, [sorted, path.join(os.tmpdir(), 'чужое.png')]);

    expect(moves.size).toBe(0);
    expect((await readdir(to)).sort()).toEqual(['Картинки', 'моё.txt']);
  });
});

/**
 * Показ файла в проводнике.
 *
 * Пробел в пути ломал это молча, и ломал на самом частом случае: тема задачи с
 * пробелом («Картинки\Логотип кафе») — это норма, а не край. Node сам берёт в
 * кавычки любой аргумент с пробелом, и проводник получал `"/select,C:\…"`
 * целиком в кавычках. Замерено 25.09.2026: открывались «Документы» вместо
 * нужной папки, а инструмент отвечал «Показал».
 */
describe('чем показать файл', () => {
  // Пути — через String.raw.
  //
  // В обычных кавычках `\п` это не «слэш и п», а просто «п»: неизвестное
  // экранирование JS съедает молча. Проверка пути Windows оставалась без
  // единого обратного слэша — «C:ппапка с пробеламифайл с пробелом.txt» — и
  // доказывала не то, ради чего написана.
  it('Windows: кавычки вокруг пути, а не вокруг всего аргумента', () => {
    const путь = String.raw`C:\п\папка с пробелами\файл с пробелом.txt`;
    const команда = командаПоказа(путь, false, 'win32');
    expect(путь).toContain(String.fromCharCode(92));
    expect(команда.file).toBe('explorer.exe');
    expect(команда.args).toEqual([`/select,"${путь}"`]);
    // Без этого Windows переупакует строку и всё сломается заново.
    expect(команда.verbatim).toBe(true);
  });

  it('Windows: папку открываем, а не выделяем в ней саму себя', () => {
    const путь = String.raw`C:\п\моя папка`;
    const команда = командаПоказа(путь, true, 'win32');
    expect(команда.args).toEqual([`"${путь}"`]);
  });

  it('macOS: файл показывается в Finder ключом -R, а не открывается', () => {
    expect(командаПоказа('/п/файл с пробелом.txt', false, 'darwin')).toEqual({
      file: 'open',
      args: ['-R', '/п/файл с пробелом.txt'],
      verbatim: false,
    });
  });

  it('macOS: папка открывается как есть', () => {
    expect(командаПоказа('/п/папка', true, 'darwin').args).toEqual(['/п/папка']);
  });

  it('Linux: показать файл нечем — открываем папку, где он лежит', () => {
    const команда = командаПоказа('/п/папка/файл.txt', false, 'linux');
    expect(команда.file).toBe('xdg-open');
    expect(команда.args).toEqual(['/п/папка']);
  });
});

/**
 * Папки прежней раскладки нельзя утаскивать в разделы.
 *
 * До разделов на языке человека их было пять: Images, Video, Docs, Files,
 * Apps. «Docs» и «Files» не совпали ни с одним нынешним именем, и уборка
 * считала их обычной папкой задачи: стоило агенту записать файл внутрь — и
 * вся папка уезжала в «Документы\Docs» вместе с работой за месяц. На папке
 * человека 25.09.2026 оба набора разделов лежат рядом, так что случай не
 * выдуманный.
 */
describe('имена разделов', () => {
  it('нынешние узнаются на обоих языках', () => {
    for (const имя of ['Картинки', 'Images', 'Документы', 'Documents', 'Разное', 'Other']) {
      expect(isSectionName(имя), имя).toBe(true);
    }
  });

  it('прежние узнаются тоже — иначе уборка их унесёт', () => {
    for (const имя of ['Docs', 'Files', 'Images', 'Video', 'Apps']) {
      expect(isSectionName(имя), имя).toBe(true);
    }
  });

  it('папка задачи разделом не считается', () => {
    for (const имя of ['Логотип кафе', 'Мультяшная ракета', 'docsx']) {
      expect(isSectionName(имя), имя).toBe(false);
    }
  });
});

/**
 * Разбор корня по просьбе.
 *
 * Уборка после задачи трогает только то, что агент в этой задаче писал, — и
 * это правильно. Но накопившееся так и лежит: на папке человека 25.09.2026 в
 * корне нашлось восемь файлов. Разбор по просьбе закрывает это, не нарушая
 * обещания «положенное вами остаётся на месте»: он делается, только когда
 * попросили.
 */
describe('разбор корня по просьбе', () => {
  it('файлы уезжают в разделы, папки остаются нетронутыми', async () => {
    const дом = mkdtempSync(path.join(os.tmpdir(), 'jarvis-tidy-'));
    writeFileSync(path.join(дом, 'снимок.png'), 'x');
    writeFileSync(path.join(дом, 'заметка.md'), 'x');
    writeFileSync(path.join(дом, 'песня.mp3'), 'x');
    mkdirSync(path.join(дом, 'Логотип кафе'));
    writeFileSync(path.join(дом, 'Логотип кафе', 'внутри.png'), 'x');
    mkdirSync(path.join(дом, 'Docs'));

    const { moves, failures } = await tidyRoot(дом);

    expect(failures).toEqual([]);
    expect(moves.size).toBe(3);
    const корень = (await readdir(дом)).sort();
    // Папки на месте: и задача, и старый раздел.
    expect(корень).toContain('Логотип кафе');
    expect(корень).toContain('Docs');
    // Ни одного файла в корне не осталось.
    for (const имя of ['снимок.png', 'заметка.md', 'песня.mp3']) {
      expect(корень).not.toContain(имя);
    }
    // И каждый лёг в свой раздел.
    expect(await readdir(path.join(дом, 'Картинки'))).toEqual(['снимок.png']);
    expect(await readdir(path.join(дом, 'Аудио'))).toEqual(['песня.mp3']);
  });

  it('пропавшей папки не пугаемся, чужой ошибке не молчим', async () => {
    // Пропажа — не беда: папку могли убрать руками между вызовами.
    const нет = path.join(os.tmpdir(), `jarvis-tidy-нет-${Date.now()}`);
    const { moves } = await tidyRoot(нет);
    expect(moves.size).toBe(0);

    // А вот «не папка» — беда, и молчать о ней нельзя: раньше `.catch(() =>
    // [])` превращал любую ошибку чтения в «разбирать нечего», и человек
    // слышал это там, где на самом деле не смогли даже заглянуть.
    const файл = path.join(mkdtempSync(path.join(os.tmpdir(), 'jarvis-tidy-')), 'это-файл.txt');
    writeFileSync(файл, 'x');
    await expect(tidyRoot(файл)).rejects.toThrow();
  });

  it('споткнулись на одном — остальные перенесены и названы', async () => {
    const дом = mkdtempSync(path.join(os.tmpdir(), 'jarvis-tidy-'));
    writeFileSync(path.join(дом, 'заметка.txt'), 'x');
    writeFileSync(path.join(дом, 'снимок.png'), 'x');

    // Отказ подаём через шов переноса: в настоящей файловой системе его не
    // подстроить — занятое имя перенос обходит сам, раздел-файл уезжает
    // раньше блокируемого, а открытый файл Windows переносить всё равно даёт.
    const { moves, failures } = await tidyRoot(дом, async (source, куда) => {
      if (source.endsWith('.png')) throw new Error('раздел занят чем-то чужим');
      return moveIntoFolder(source, куда);
    });

    // Раньше исключение уносило с собой весь список, и найти уже
    // перенесённое было негде.
    expect(moves.size).toBe(1);
    expect([...moves.keys()][0]).toContain('заметка.txt');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.file).toContain('снимок.png');
    expect(failures[0]?.why).toContain('раздел занят');
  });

  it('служебные файлы и пояснение к папке остаются на месте', async () => {
    const дом = mkdtempSync(path.join(os.tmpdir(), 'jarvis-tidy-'));
    // desktop.ini — настройки самой папки, а не файл человека.
    writeFileSync(path.join(дом, 'desktop.ini'), 'x');
    writeFileSync(path.join(дом, 'Thumbs.db'), 'x');
    // Пояснение, уехавшее в «Документы», больше ничего не объясняет.
    writeFileSync(path.join(дом, 'о папке.txt'), 'x');
    writeFileSync(path.join(дом, 'обычный.png'), 'x');

    const { moves } = await tidyRoot(дом);

    expect(moves.size).toBe(1);
    const корень = await readdir(дом);
    expect(корень).toContain('desktop.ini');
    expect(корень).toContain('Thumbs.db');
    expect(корень).toContain('о папке.txt');
    expect(корень).not.toContain('обычный.png');
  });

  it('в пустом корне ничего не делает', async () => {
    const дом = mkdtempSync(path.join(os.tmpdir(), 'jarvis-tidy-'));
    mkdirSync(path.join(дом, 'Картинки'));
    const { moves, failures } = await tidyRoot(дом);
    expect(moves.size).toBe(0);
    expect(failures).toEqual([]);
  });
});
