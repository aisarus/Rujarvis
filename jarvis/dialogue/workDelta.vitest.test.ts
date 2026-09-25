import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { WorkDelta } from './workDelta';
import type { Plan } from '../agent/plan';
import type { JarvisEvent } from '../memory/journal';

let dir: string;
let journalFile: string;
let planFile: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-delta-'));
  journalFile = path.join(dir, 'journal.json');
  planFile = path.join(dir, 'plan.json');
});

function writeJournal(...events: JarvisEvent[]): void {
  writeFileSync(journalFile, JSON.stringify(events), 'utf8');
}

function writePlan(plan: Plan): void {
  writeFileSync(planFile, JSON.stringify(plan), 'utf8');
}

function plan(steps: Plan['steps'], goal = 'собрать отчёт'): Plan {
  return { goal, steps, startedAt: 1000, updatedAt: 2000 };
}

const delta = (): WorkDelta => new WorkDelta({ journalFile, planFile });

describe('WorkDelta', () => {
  it('в начале разговора молчит: прошлого у него ещё нет', () => {
    writeJournal({ at: 10, kind: 'result', text: 'открыл Chrome' });
    expect(delta().since()).toEqual([]);
  });

  it('отдаёт то, что случилось после начала', () => {
    writeJournal({ at: 10, kind: 'result', text: 'открыл Chrome' });
    const d = delta();

    writeJournal(
      { at: 10, kind: 'result', text: 'открыл Chrome' },
      { at: 20, kind: 'result', text: 'сохранил отчёт.pdf' },
    );

    expect(d.since()).toEqual(['сохранил отчёт.pdf']);
  });

  it('дважды одно и то же не показывает', () => {
    const d = delta();
    writeJournal({ at: 20, kind: 'result', text: 'сохранил отчёт.pdf' });

    expect(d.since()).toEqual(['сохранил отчёт.pdf']);
    expect(d.since()).toEqual([]);
  });

  it('сбой называет сбоем: иначе он читается как сделанное', () => {
    const d = delta();
    writeJournal({ at: 20, kind: 'error', text: 'не смог открыть Krita' });

    expect(d.since()).toEqual(['сбой: не смог открыть Krita']);
  });

  it('читает журнал заново каждый раз', () => {
    // В журнал пишут два процесса — голосовой мост и MCP-сервер. Кэш в памяти
    // показал бы половину правды.
    const d = delta();
    writeJournal({ at: 20, kind: 'result', text: 'первое' });
    expect(d.since()).toEqual(['первое']);

    writeJournal(
      { at: 20, kind: 'result', text: 'первое' },
      { at: 30, kind: 'result', text: 'второе' },
    );
    expect(d.since()).toEqual(['второе']);
  });

  it('показывает смену состояния шага вместе с причиной', () => {
    writePlan(plan([{ text: 'найти данные', state: 'делаю' }]));
    const d = delta();

    writePlan(plan([{ text: 'найти данные', state: 'не вышло', note: 'сайт не отвечает' }]));

    expect(d.since()).toEqual(['шаг «найти данные» — не вышло: сайт не отвечает']);
  });

  it('новый план называет целиком', () => {
    const d = delta();
    writePlan(plan([{ text: 'найти данные', state: 'ждёт' }], 'посчитать расходы'));

    expect(d.since()).toEqual(['новый план: посчитать расходы', 'шаг «найти данные» — ждёт']);
  });

  it('неизменившийся шаг молчит', () => {
    writePlan(plan([{ text: 'найти данные', state: 'делаю' }]));
    const d = delta();
    writePlan(plan([{ text: 'найти данные', state: 'делаю' }]));

    expect(d.since()).toEqual([]);
  });

  it('держит потолок и говорит, сколько осталось за кадром', () => {
    const d = new WorkDelta({ journalFile, planFile, limit: 3 });
    writeJournal(
      ...Array.from({ length: 6 }, (_, i): JarvisEvent => ({
        at: 20 + i,
        kind: 'result',
        text: `шаг ${i}`,
      })),
    );

    const lines = d.since();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('…и ещё 3 раньше');
    // Остаются свежие: они нужнее старых.
    expect(lines.slice(1)).toEqual(['шаг 3', 'шаг 4', 'шаг 5']);
  });

  it('пустые и битые файлы — это не данные, а не падение', () => {
    writeFileSync(journalFile, 'не json', 'utf8');
    writeFileSync(planFile, '{', 'utf8');
    const d = delta();
    expect(d.since()).toEqual([]);
  });
});
