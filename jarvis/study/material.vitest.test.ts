import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateMaterialBank, readMaterialSource, studyPrompt } from './generate';

const папки: string[] = [];
afterEach(() => {
  for (const папка of папки.splice(0)) rmSync(папка, { recursive: true, force: true });
});

/** Разбор документа так, как его раскладывает конвейер: свои свойства, ссылки под заголовком. */
function разбор(): string {
  const папка = mkdtempSync(path.join(tmpdir(), 'jarvis-material-'));
  папки.push(папка);
  const файл = path.join(папка, 'Перец — читаем вместе.md');
  const длинно = 'Совет решил запретить продажу. '.repeat(6);
  writeFileSync(
    файл,
    [
      '---',
      "курс: 'Коммерческое право'",
      'вид: материал для чтения',
      "источник: '[[peretz.pdf]]'",
      'добавлено: 2026-10-20',
      '---',
      '# Перец — читаем вместе',
      '',
      'Документ: [[peretz.pdf]] · [[Коммерческое право]]',
      '',
      '## Коротко',
      длинно,
      '## Сначала — вся история простыми словами',
      длинно,
      '## Часть 1. Полномочия совета',
      `> **הסמכות**\n>\n> *Полномочие*\n${длинно}`,
      '## Ключевые понятия',
      '| Оригинал | Перевод | Что значит |',
      '| --- | --- | --- |',
      '| סמכות | полномочие | право органа действовать |',
      '## Проверь себя',
      длинно,
      '## Шпаргалка',
      длинно,
      '## Пусто',
      'мало',
      '',
    ].join('\n'),
  );
  return файл;
}

describe('учёба по разбору документа', () => {
  it('разделы — содержательные «##», без краткого, самопроверки и шпаргалки; понятия — из таблицы', async () => {
    const src = await readMaterialSource(разбор());
    expect(src).toMatchObject({ kind: 'material', course: 'Коммерческое право', date: '2026-10-20', topic: 'Перец — читаем вместе', lecture: 'Перец — читаем вместе' });
    expect(src?.topics.map((t) => t.title)).toEqual(['Сначала — вся история простыми словами', 'Часть 1. Полномочия совета']);
    expect(src?.concepts).toEqual(['סמכות — полномочие — право органа действовать']);
  });

  it('задание модели — про материал, без меток времени; вопросы на языке документа с переводом', async () => {
    const src = await readMaterialSource(разбор());
    if (!src) throw new Error('нет разбора');
    const p = studyPrompt(src, 'he', 'ru');
    expect(p).toContain('учебный материал «Перец — читаем вместе»');
    expect(p).toContain('метку времени (at) не ставь');
    expect(p).not.toContain('Расшифровка:');
    expect(p).toContain('на иврите (так будет на экзамене)');
  });

  it('банк собирается и проходит ту же проверку качества, что у лекций', async () => {
    const вопрос = (section: number) => ({
      section,
      prompt: `מי מוסמך? (${section})`,
      promptRu: 'Кто уполномочен?',
      options: [
        { text: 'המועצה', ru: 'совет', why: 'Верно: по приказу', correct: true },
        { text: 'השר', ru: 'министр', why: 'Неверно: он дал полномочие', correct: false },
        { text: 'בית המשפט', ru: 'суд', why: 'Неверно: суд проверяет', correct: false },
        { text: 'העירייה', ru: 'мэрия', why: 'Неверно: её тут нет', correct: false },
      ],
      explanation: 'Полномочие дал приказ.',
      hint: 'приказ',
      answer: 'Совет.',
    });
    const bank = await generateMaterialBank(разбор(), {
      lectureLanguage: 'he',
      notes: 'ru',
      now: 1,
      summarize: async () => JSON.stringify({ questions: [вопрос(1), вопрос(5)], cards: [{ section: 2, front: 'סמכות (полномочие)', back: 'Право органа действовать.' }], tasks: [] }),
    });
    expect(bank).toMatchObject({ course: 'Коммерческое право', date: '2026-10-20', topic: 'Перец — читаем вместе' });
    expect(bank?.questions).toHaveLength(1);
    expect(bank?.questions[0]?.source).toEqual({ lecture: 'Перец — читаем вместе', at: undefined });
    expect(bank?.cards).toHaveLength(1);
    // Вопрос к разделу, которого нет, выброшен — и сказано почему.
    expect(bank?.warnings.some((w) => w.includes('нет раздела 5'))).toBe(true);
  });

  it('заметка без курса — не материал курса, заготавливать нечего', async () => {
    const папка = mkdtempSync(path.join(tmpdir(), 'jarvis-material-'));
    папки.push(папка);
    const файл = path.join(папка, 'x.md');
    writeFileSync(файл, '# X\n\n## Раздел\n' + 'текст '.repeat(40));
    expect(await readMaterialSource(файл)).toBeNull();
  });
});
