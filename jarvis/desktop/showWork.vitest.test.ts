import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readShowWork, showWorkFile, writeShowWork } from './showWork';
import { открытьВкладкуScript, перейтиScript } from './safari';

/**
 * Режим работы — правило для рук, а не совет модели.
 *
 * «Работай в фоне» доезжало только до промта: браузер выводил окно вперёд
 * всегда, и человек, сказавший «работай тихо», получал вкладку под руки.
 * MCP-сервер — отдельный процесс, а режим переключается посреди работы,
 * поэтому он лежит в файле: переменной окружения у запущенного процесса уже не
 * поменять.
 */
function свежийФайл(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'rujarvis-rezhim-')), 'show-work.json');
}

describe('readShowWork', () => {
  it('нет файла — значит на виду', () => {
    // Человек просил показывать по умолчанию. Молчаливый уход в фон он
    // воспримет как поломку, а не как настройку.
    expect(readShowWork(path.join(свежийФайл(), 'нет-такого'))).toBe(true);
  });

  it('битый или пустой файл — тоже на виду', () => {
    for (const мусор of ['', '{', 'null', '[]', '"фон"']) {
      const файл = свежийФайл();
      writeFileSync(файл, мусор, 'utf8');
      expect(readShowWork(файл), `на «${мусор}»`).toBe(true);
    }
  });

  it('читает записанное в обе стороны', () => {
    const файл = свежийФайл();
    expect(writeShowWork(false, файл)).toBe(true);
    expect(readShowWork(файл)).toBe(false);
    expect(writeShowWork(true, файл)).toBe(true);
    expect(readShowWork(файл)).toBe(true);
  });

  it('в фон уходит только по прямому false', () => {
    // Любое другое значение — на виду: ошибиться в сторону «показал лишнее»
    // дешевле, чем в сторону «работал молча, и человек решил, что сломалось».
    const файл = свежийФайл();
    for (const значение of ['0', 'нет', 'null', '1']) {
      writeFileSync(файл, JSON.stringify({ showWork: значение }), 'utf8');
      expect(readShowWork(файл), `на ${значение}`).toBe(true);
    }
    writeFileSync(файл, JSON.stringify({ showWork: false }), 'utf8');
    expect(readShowWork(файл)).toBe(false);
  });
});

describe('showWorkFile', () => {
  it('лежит в папке данных, а не где попало', () => {
    expect(showWorkFile({})).toContain('show-work.json');
  });

  it('переносится переменной, как и всё общее', () => {
    expect(showWorkFile({ JARVIS_SHOW_WORK_FILE: '/x/rezhim.json' })).toBe('/x/rezhim.json');
  });
});

describe('Safari в фоне не лезет на экран', () => {
  it('на виду выводит браузер вперёд', () => {
    expect(открытьВкладкуScript('https://ya.ru', true)).toContain('activate');
    expect(перейтиScript('https://ya.ru', true)).toContain('activate');
  });

  it('в фоне не выводит: человек просил не лезть', () => {
    // `activate` у Safari забирает передний план у того, в чём человек
    // печатает. Это и есть то, от чего он отказался словами.
    expect(открытьВкладкуScript('https://ya.ru', false)).not.toContain('activate');
    expect(перейтиScript('https://ya.ru', false)).not.toContain('activate');
  });

  it('и в фоне скрипт остаётся целым, а не обрезанным', () => {
    // Вместо activate — комментарий AppleScript, а не пустое место: пустая
    // строка внутри tell-блока его не ломает, но читать такой скрипт нельзя.
    const скрипт = открытьВкладкуScript('https://ya.ru', false);
    expect(скрипт).toContain('tell application "Safari"');
    expect(скрипт).toContain('end tell');
    expect(скрипт).toContain('--');
  });
});
