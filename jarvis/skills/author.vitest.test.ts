import { describe, expect, it } from 'vitest';

import { buildSkillFile, isSelfAuthored, isValidSkillName, skillPath } from './author';

describe('isValidSkillName', () => {
  it('принимает обычное имя', () => {
    expect(isValidSkillName('excel-automation')).toBe(true);
    expect(isValidSkillName('obs')).toBe(true);
  });

  it('отвергает всё, чем можно уйти из папки навыков', () => {
    // Запись по произвольному пути — это запись куда угодно на диске.
    expect(isValidSkillName('../../windows/system32')).toBe(false);
    expect(isValidSkillName('a/b')).toBe(false);
    expect(isValidSkillName('a\\b')).toBe(false);
    expect(isValidSkillName('..')).toBe(false);
  });

  it('отвергает пустое и слишком длинное', () => {
    expect(isValidSkillName('')).toBe(false);
    expect(isValidSkillName('   ')).toBe(false);
    expect(isValidSkillName('a'.repeat(80))).toBe(false);
  });

  it('отвергает пробелы и заглавные — имя попадёт в путь', () => {
    expect(isValidSkillName('моя штука')).toBe(false);
    expect(isValidSkillName('Excel')).toBe(false);
  });
});

describe('skillPath', () => {
  it('кладёт навык в свою папку', () => {
    const path = skillPath('C:\\root', 'excel-automation');
    expect(path).toContain('excel-automation');
    expect(path.endsWith('SKILL.md')).toBe(true);
  });

  it('не даёт выйти за пределы папки навыков', () => {
    expect(() => skillPath('C:\\root', '../evil')).toThrow();
  });
});

describe('buildSkillFile', () => {
  const file = buildSkillFile({
    name: 'obs-recording',
    description: 'Запись экрана через OBS.',
    body: '# Запись\n\nЗапускать с --startrecording.',
  });

  it('начинается с заголовка, который читает Клод', () => {
    expect(file.startsWith('---\n')).toBe(true);
    expect(file).toContain('name: obs-recording');
    expect(file).toContain('description: Запись экрана через OBS.');
  });

  it('сохраняет тело как есть', () => {
    expect(file).toContain('Запускать с --startrecording.');
  });

  it('помечает себя как написанный Джарвисом', () => {
    // Иначе он однажды перезапишет навык, написанный человеком, и тот не
    // поймёт, куда делась его работа.
    expect(isSelfAuthored(file)).toBe(true);
  });

  it('заканчивается переводом строки', () => {
    expect(file.endsWith('\n')).toBe(true);
  });

  it('не ломает заголовок многострочным описанием', () => {
    // Перенос строки внутри description разрушил бы YAML целиком.
    const tricky = buildSkillFile({
      name: 'x',
      description: 'первая строка\nвторая строка',
      body: 'тело',
    });
    const header = tricky.split('---')[1] ?? '';
    const lines = header.split('\n').filter((line) => line.startsWith('description:'));
    expect(lines).toHaveLength(1);
    // Обе половины остались, но живут на одной строке.
    expect(lines[0]).toBe('description: первая строка вторая строка');
  });
});

describe('isSelfAuthored', () => {
  it('узнаёт чужой навык', () => {
    const handwritten = '---\nname: excel\ndescription: таблицы\n---\n\n# Excel\n';
    expect(isSelfAuthored(handwritten)).toBe(false);
  });

  it('не падает на пустом файле', () => {
    expect(isSelfAuthored('')).toBe(false);
  });
});

describe('заголовок навыка остаётся читаемым YAML', () => {
  /**
   * Замечания CodeRabbit (кусок 3, PR №42). Оба случая ломали навык молча:
   * записался — а прочитаться на следующем запуске уже не может.
   */
  it('двоеточие в описании не рвёт заголовок', () => {
    const файл = buildSkillFile({ name: 'проба', description: 'a: b', body: 'текст' });
    expect(файл).toContain('description: "a: b"');
    // И он по-прежнему свой: метку внутри заголовка видно.
    expect(isSelfAuthored(файл)).toBe(true);
  });

  it('три чёрточки в описании не обрывают заголовок', () => {
    const файл = buildSkillFile({ name: 'проба', description: 'a --- b', body: 'текст' });
    // Раньше разбор резал по любому вхождению «---», метка оставалась за
    // границей, навык переставал считаться своим, и повторная запись в него
    // отклонялась.
    expect(isSelfAuthored(файл)).toBe(true);
  });

  it('чужой навык своим не считается', () => {
    const чужой = ['---', 'name: чужой', 'description: не наш', '---', '', 'текст'].join('\n');
    expect(isSelfAuthored(чужой)).toBe(false);
  });
});
