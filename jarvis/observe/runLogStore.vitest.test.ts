import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunLogStore } from './runLogStore';

let dir: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'runlog-test-'));
  clock = new Date('2026-09-20T13:45:07').getTime();
});

afterEach(() => {
  // Убираем за собой: утечка на 1115 брошенных папок начиналась так же.
  rmSync(dir, { recursive: true, force: true });
});

const runs = (keep = 50) => new RunLogStore(path.join(dir, 'runs'), keep, () => clock);

const only = (): string => {
  const files = readdirSync(path.join(dir, 'runs'));
  expect(files).toHaveLength(1);
  return readFileSync(path.join(dir, 'runs', files[0] as string), 'utf8');
};

const head = {
  title: 'Мультяшная ракета',
  prompt: 'Открой блендер и сделай ракету',
  cwd: 'C:/Users/user/Desktop',
  capabilities: ['computer'],
};

describe('запись прогона', () => {
  it('заводит папку, даже если её не было', () => {
    runs().begin(head);
    expect(readdirSync(path.join(dir, 'runs'))).toHaveLength(1);
  });

  it('пишет шапку, события и конец', () => {
    const log = runs();
    log.begin(head);
    log.saw({ type: 'started', backend: 'claude-code' });
    log.saw({ type: 'tool', backend: 'claude-code', name: 'blender_live' });
    log.end();

    const text = only();
    expect(text).toContain('Мультяшная ракета');
    expect(text).toContain('Открой блендер и сделай ракету');
    expect(text).toContain('claude-code начал');
    expect(text).toContain('claude-code инструмент blender_live');
    expect(text).toContain('--- конец ---');
  });

  // Ради этой строки журнал и заводился: она объясняет, почему работа ушла
  // дальше по цепочке и почему человек услышал ошибку от кого-то другого.
  it('сохраняет причину срыва вместе с пометкой об откате', () => {
    const log = runs();
    log.begin(head);
    log.saw({ type: 'error', backend: 'claude-code', message: 'process exited 1', retryable: true });
    log.saw({ type: 'status', backend: 'interpreter', text: 'Переключаюсь на Interpreter' });
    log.saw({ type: 'error', backend: 'interpreter', message: 'API Error: 401', retryable: false });
    log.end();

    const text = only();
    expect(text).toContain('claude-code ОШИБКА (откатится): process exited 1');
    expect(text).toContain('interpreter ОШИБКА: API Error: 401');
    // Порядок важен: первый срыв обязан стоять раньше последствия.
    expect(text.indexOf('process exited 1')).toBeLessThan(text.indexOf('401'));
  });

  it('отмеряет время от начала прогона', () => {
    const log = runs();
    log.begin(head);
    clock += 12_300;
    log.saw({ type: 'started', backend: 'codex' });
    log.end();
    expect(only()).toContain('12.3s  codex начал');
  });

  // Прогон, который завис или был убит, — как раз тот, ради которого журнал и
  // нужен. Собранный в памяти файл в таком случае не доехал бы.
  it('дописывает на ходу, а не в конце', () => {
    const log = runs();
    log.begin(head);
    log.saw({ type: 'started', backend: 'claude-code' });
    expect(only()).toContain('claude-code начал');
  });

  it('без начатого прогона молчит, а не падает', () => {
    const log = runs();
    expect(() => log.saw({ type: 'started', backend: 'codex' })).not.toThrow();
    expect(log.current()).toBeNull();
  });

  it('называет файл текущего прогона и забывает его в конце', () => {
    const log = runs();
    log.begin(head);
    expect(log.current()).toContain('Мультяшная-ракета.log');
    log.end();
    expect(log.current()).toBeNull();
  });
});

describe('уборка', () => {
  const old = (name: string) => {
    mkdirSync(path.join(dir, 'runs'), { recursive: true });
    writeFileSync(path.join(dir, 'runs', name), 'старое', 'utf8');
  };

  it('стирает лишние прогоны при начале нового', () => {
    old('2026-09-18-100000-а.log');
    old('2026-09-19-100000-б.log');
    old('2026-09-19-110000-в.log');

    runs(2).begin(head);

    const left = readdirSync(path.join(dir, 'runs')).sort();
    expect(left).toHaveLength(3);
    expect(left).not.toContain('2026-09-18-100000-а.log');
  });

  it('чужие файлы в папке не трогает', () => {
    old('заметки.txt');
    runs(0).begin(head);
    expect(readdirSync(path.join(dir, 'runs'))).toContain('заметки.txt');
  });
});
