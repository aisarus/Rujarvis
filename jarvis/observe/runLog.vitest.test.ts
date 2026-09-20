import { describe, expect, it } from 'vitest';

import { lineFor, runFileName, staleRuns, summarise } from './runLog';

const NEWLINE = String.fromCharCode(10);

describe('строка на событие', () => {
  it('пишет, кто и что', () => {
    expect(lineFor({ type: 'started', backend: 'claude-code' })).toBe('claude-code начал');
    expect(lineFor({ type: 'tool', backend: 'claude-code', name: 'blender_live' })).toBe(
      'claude-code инструмент blender_live',
    );
  });

  // Ради этой строки всё и затевалось. Она единственная объясняет, почему
  // работа свалилась дальше по цепочке, и до сих пор нигде не сохранялась.
  it('ошибку пишет целиком и помечает, был ли откат', () => {
    expect(
      lineFor({ type: 'error', backend: 'claude-code', message: 'process exited with 1', retryable: true }),
    ).toBe('claude-code ОШИБКА (откатится): process exited with 1');

    expect(
      lineFor({ type: 'error', backend: 'interpreter', message: 'нет ключа', retryable: false }),
    ).toBe('interpreter ОШИБКА: нет ключа');
  });

  it('длинный ответ не режет — журнал для разбора, а не для чтения вслух', () => {
    const long = 'я'.repeat(5_000);
    expect(lineFor({ type: 'assistant-text', backend: 'codex', text: long })).toContain(long);
  });

  it('итог показывает, чем кончилось', () => {
    const line = lineFor({
      type: 'completed',
      backend: 'claude-code',
      result: {
        ok: true, backend: 'claude-code', text: 'Готово', durationMs: 88_600,
        filesChanged: [], commands: [],
      },
    });
    expect(line).toContain('готово');
    expect(line).toContain('88.6');
  });

  it('у провала называет причину, а не только факт', () => {
    const line = lineFor({
      type: 'completed',
      backend: 'interpreter',
      result: {
        ok: false, backend: 'interpreter', text: '', durationMs: 1_000,
        filesChanged: [], commands: [], error: 'API Error: 401',
      },
    });
    expect(line).toContain('не вышло');
    expect(line).toContain('API Error: 401');
  });

  // Сторож: новый вид события обязан получить строку. Молчащий журнал хуже
  // отсутствующего — он создаёт впечатление, что записано всё.
  it('ни одно событие не остаётся без строки', () => {
    const every = [
      { type: 'started', backend: 'x' },
      { type: 'status', backend: 'x', text: 'т' },
      { type: 'assistant-text', backend: 'x', text: 'т' },
      { type: 'tool', backend: 'x', name: 'т' },
      { type: 'file-changed', backend: 'x', change: { path: 'п', kind: 'created' } },
      { type: 'command', backend: 'x', command: 'ls' },
      { type: 'error', backend: 'x', message: 'м', retryable: false },
      {
        type: 'completed',
        backend: 'x',
        result: { ok: true, backend: 'x', text: '', durationMs: 0, filesChanged: [], commands: [] },
      },
    ];
    for (const event of every) {
      expect(lineFor(event as never)).not.toBe('');
    }
  });
});

describe('имя файла прогона', () => {
  it('начинается со времени, чтобы сортировалось само', () => {
    const name = runFileName('Мультяшная ракета', new Date('2026-09-20T13:45:07'));
    expect(name).toMatch(/^2026-09-20-134507/u);
    expect(name.endsWith('.log')).toBe(true);
  });

  it('вычищает из названия всё, что ломает путь', () => {
    const name = runFileName('Открой C:\\Program Files/ и "сделай" <это>', new Date('2026-09-20T13:45:07'));
    expect(name).not.toMatch(/[\\/:"<>|?*]/u);
  });

  it('не отрастает без предела на длинной просьбе', () => {
    const name = runFileName('о'.repeat(500), new Date('2026-09-20T13:45:07'));
    expect(name.length).toBeLessThan(120);
  });

  it('у безымянной задачи всё равно есть имя', () => {
    expect(runFileName('   ', new Date('2026-09-20T13:45:07'))).toBe('2026-09-20-134507-без-названия.log');
  });
});

describe('что стирать', () => {
  const files = [
    '2026-09-18-100000-а.log',
    '2026-09-19-100000-б.log',
    '2026-09-20-100000-в.log',
    '2026-09-20-110000-г.log',
  ];

  it('оставляет свежие, отдаёт на стирание старые', () => {
    expect(staleRuns(files, 2)).toEqual(['2026-09-18-100000-а.log', '2026-09-19-100000-б.log']);
  });

  it('когда всё помещается — стирать нечего', () => {
    expect(staleRuns(files, 10)).toEqual([]);
  });

  // Утечка на 1115 брошенных папок случилась ровно потому, что никто не
  // стирал. Журнал пишется на каждую задачу, значит растёт быстрее всего.
  it('не путается в порядке, когда список пришёл вперемешку', () => {
    const mixed = [files[2], files[0], files[3], files[1]] as string[];
    expect(staleRuns(mixed, 1)).toEqual([
      '2026-09-18-100000-а.log',
      '2026-09-19-100000-б.log',
      '2026-09-20-100000-в.log',
    ]);
  });

  it('чужие файлы не трогает', () => {
    expect(staleRuns([...files, 'заметки.txt', 'план.json'], 0)).toEqual(files);
  });
});

describe('шапка прогона', () => {
  it('называет задачу, папку и порядок бэкендов', () => {
    const head = summarise({
      title: 'Мультяшная ракета',
      prompt: 'Открой блендер и сделай ракету',
      cwd: 'C:/Users/ariel/Desktop',
      capabilities: ['computer', 'files'],
      order: ['claude-code', 'codex'],
      rationale: 'Задача про экран',
      at: new Date('2026-09-20T13:45:07'),
    });
    expect(head).toContain('Мультяшная ракета');
    expect(head).toContain('claude-code → codex');
    expect(head).toContain('Задача про экран');
    expect(head).toContain('Открой блендер и сделай ракету');
    expect(head.endsWith(NEWLINE)).toBe(true);
  });
});
