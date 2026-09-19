import { describe, expect, it } from 'vitest';

import { describeArtifacts } from './artifacts';

const OUTPUT = 'C:\\Users\\ariel\\Desktop\\Джарвис';
const WORKSPACE = 'C:\\Users\\ariel\\AppData\\Local\\Rujarvis\\src';

describe('describeArtifacts', () => {
  it('называет файл и папку, когда результат лёг в папку ассистента', () => {
    const report = describeArtifacts([{ path: `${OUTPUT}\\закат.png`, action: 'created' }], {
      outputDir: OUTPUT,
    });

    expect(report?.spoken).toContain('закат.png');
    expect(report?.spoken).toContain('Джарвис');
    expect(report?.paths).toEqual([`${OUTPUT}\\закат.png`]);
  });

  it('называет раздел, в котором лежит файл', () => {
    // «В папке Джарвис» мало, когда внутри пять разделов.
    const report = describeArtifacts(
      [{ path: `${OUTPUT}\\Images\\закат.png`, action: 'created' }],
      { outputDir: OUTPUT },
    );

    expect(report?.spoken).toContain('раздел Images');
  });

  it('не выдумывает раздел для файла в корне папки', () => {
    const report = describeArtifacts([{ path: `${OUTPUT}\\закат.png`, action: 'created' }], {
      outputDir: OUTPUT,
    });

    expect(report?.spoken).not.toContain('раздел');
  });

  it('называет полный путь, когда файл лёг мимо папки ассистента', () => {
    const report = describeArtifacts(
      [{ path: 'C:\\Users\\ariel\\Pictures\\кот.png', action: 'created' }],
      { outputDir: OUTPUT },
    );

    // Человек не найдёт файл, которого не назвали: тут важен весь путь.
    expect(report?.spoken).toContain('C:\\Users\\ariel\\Pictures\\кот.png');
  });

  it('молчит про правку исходников — это работа, а не подарок человеку', () => {
    const report = describeArtifacts(
      [
        { path: `${WORKSPACE}\\jarvis\\core.ts`, action: 'modified' },
        { path: `${WORKSPACE}\\jarvis\\new.ts`, action: 'created' },
      ],
      { outputDir: OUTPUT, workspace: WORKSPACE },
    );

    expect(report).toBeNull();
  });

  it('молчит про временные файлы', () => {
    const report = describeArtifacts(
      [{ path: 'C:\\Users\\ariel\\AppData\\Local\\Temp\\jarvis-x\\task.py', action: 'created' }],
      { outputDir: OUTPUT },
    );

    expect(report).toBeNull();
  });

  it('не объявляет удаление находкой', () => {
    const report = describeArtifacts([{ path: `${OUTPUT}\\старое.png`, action: 'deleted' }], {
      outputDir: OUTPUT,
    });

    expect(report).toBeNull();
  });

  it('перечисляет несколько файлов, но не зачитывает бесконечный список', () => {
    const changes = ['а.png', 'б.png', 'в.png', 'г.png', 'д.png'].map((name) => ({
      path: `${OUTPUT}\\${name}`,
      action: 'created' as const,
    }));

    const report = describeArtifacts(changes, { outputDir: OUTPUT });

    expect(report?.paths).toHaveLength(5);
    expect(report?.spoken).toContain('а.png');
    expect(report?.spoken).toContain('ещё 2');
    expect(report?.spoken).not.toContain('д.png');
  });

  it('считает папку своей независимо от регистра и вида слешей', () => {
    const report = describeArtifacts(
      [{ path: 'c:/users/ariel/desktop/Джарвис/отчёт.xlsx', action: 'created' }],
      { outputDir: OUTPUT },
    );

    expect(report?.spoken).toContain('Джарвис');
    expect(report?.spoken).not.toContain('c:/users');
  });

  it('не повторяет один и тот же файл дважды', () => {
    const report = describeArtifacts(
      [
        { path: `${OUTPUT}\\счёт.xlsx`, action: 'created' },
        { path: `${OUTPUT}\\счёт.xlsx`, action: 'modified' },
      ],
      { outputDir: OUTPUT },
    );

    expect(report?.paths).toHaveLength(1);
  });
});
