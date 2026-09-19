import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { makePlan, markStep } from './plan';
import { PlanStore } from './planStore';

const AT = 1_700_000_000_000;

function file(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-')), 'план.json');
}

describe('PlanStore', () => {
  it('доносит план от одного процесса до другого', () => {
    // Пишет агент внутри MCP-сервера, читает окно внутри приложения.
    const at = file();
    new PlanStore(at).write(makePlan('сделать сайт', ['архив', 'гитхаб'], AT));

    const read = new PlanStore(at).read();
    expect(read?.goal).toBe('сделать сайт');
    expect(read?.steps.map((step) => step.text)).toEqual(['архив', 'гитхаб']);
  });

  it('переживает отсутствие файла', () => {
    expect(new PlanStore(file()).read()).toBeNull();
  });

  it('переживает путь до несуществующей папки', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-'));
    const store = new PlanStore(path.join(dir, 'нет', 'такой', 'план.json'));
    store.write(makePlan('цель', ['шаг'], AT));

    expect(store.read()?.steps).toHaveLength(1);
  });

  it('считает битый файл отсутствием плана', () => {
    const at = file();
    writeFileSync(at, 'это не json', 'utf8');

    expect(new PlanStore(at).read()).toBeNull();
  });

  it('не доверяет содержимому файла на слово', () => {
    // Файл мог написать кто угодно: прошлая версия, рука человека, половина
    // прерванной записи. Окно не должно падать на шаге без состояния.
    const at = file();
    writeFileSync(
      at,
      JSON.stringify({
        goal: 'цель',
        steps: [
          { text: 'нормальный', state: 'сделано' },
          { text: 'без состояния' },
          { state: 'сделано' },
          'строка',
          null,
        ],
      }),
      'utf8',
    );

    const plan = new PlanStore(at).read();
    expect(plan?.steps.map((step) => step.text)).toEqual(['нормальный', 'без состояния']);
    expect(plan?.steps[1]?.state).toBe('ждёт');
  });

  it('не принимает за план что попало', () => {
    const at = file();
    writeFileSync(at, JSON.stringify({ что: 'то' }), 'utf8');

    expect(new PlanStore(at).read()).toBeNull();
  });

  it('сохраняет отметки шагов', () => {
    const at = file();
    const store = new PlanStore(at);
    store.write(markStep(makePlan('цель', ['шаг'], AT), 0, 'не вышло', AT, 'блендер молчит'));

    expect(store.read()?.steps[0]).toMatchObject({
      state: 'не вышло',
      note: 'блендер молчит',
    });
  });

  it('умеет забыть план', () => {
    const at = file();
    const store = new PlanStore(at);
    store.write(makePlan('цель', ['шаг'], AT));
    store.clear();

    expect(store.read()).toBeNull();
  });
});
