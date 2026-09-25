import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { StandingInstructions } from './standingInstructions';

function file(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'jarvis-instructions-')), 'характер.md');
}

describe('StandingInstructions', () => {
  it('молчит, пока файла нет', () => {
    expect(new StandingInstructions(file()).read()).toBe('');
  });

  it('создаёт образец, который человеку понятно править', () => {
    const where = file();
    new StandingInstructions(where).ensure();

    const content = readFileSync(where, 'utf8');
    expect(content).toContain('Мои указания');
    expect(content.length).toBeGreaterThan(100);
  });

  it('отдаёт написанное человеком', () => {
    const where = file();
    writeFileSync(where, '## Мои указания\n\nОтвечай коротко. Не извиняйся.\n', 'utf8');

    expect(new StandingInstructions(where).read()).toBe('Отвечай коротко. Не извиняйся.');
  });

  it('не тащит в промпт пояснения к самому файлу', () => {
    // Иначе модель читает «правьте свободно» как указание себе.
    const where = file();
    const instructions = new StandingInstructions(where);
    instructions.ensure();

    const text = instructions.read();
    expect(text).not.toContain('Правьте свободно');
    expect(text).not.toContain('Характер и постоянные указания');
  });

  it('видит правку без перезапуска', async () => {
    // Ради этого всё и сделано файлом: человек правит характер и сразу
    // проверяет, не пересобирая ничего.
    const where = file();
    writeFileSync(where, '## Мои указания\n\nПервое.\n', 'utf8');
    const instructions = new StandingInstructions(where);
    expect(instructions.read()).toBe('Первое.');

    await new Promise((resolve) => setTimeout(resolve, 12));
    writeFileSync(where, '## Мои указания\n\nВторое.\n', 'utf8');

    expect(instructions.read()).toBe('Второе.');
  });

  it('не перечитывает нетронутый файл', () => {
    const where = file();
    writeFileSync(where, '## Мои указания\n\nОдно.\n', 'utf8');
    const instructions = new StandingInstructions(where);

    expect(instructions.read()).toBe('Одно.');
    expect(instructions.read()).toBe('Одно.');
  });

  it('переживает файл без заголовка', () => {
    const where = file();
    writeFileSync(where, 'Просто текст без разметки.', 'utf8');

    expect(new StandingInstructions(where).read()).toBe('Просто текст без разметки.');
  });
});
