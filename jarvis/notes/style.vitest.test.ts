import { describe, expect, it } from 'vitest';

import { finalPrompt, sectionFromReply, sectionPrompt } from '../lecture/session';
import { normaliseSettings } from '../setup/settings';
import { conceptLines } from '../study/generate';
import { finalStyleRules, fromSummary, hasSummary, mermaidLooksValid, obsidianRules, sectionStyleRules, tidyNoteMarkdown } from './style';

describe('итог конспекта узнаётся', () => {
  it('выноской «Кратко» и прежним заголовком — на обоих языках', () => {
    expect(hasSummary('# Тема\n\n> [!abstract] Кратко\n> О лекции.\n\n## Конспект')).toBe(true);
    expect(hasSummary('> [!abstract]+ Summary\n> About.')).toBe(true);
    expect(hasSummary('## Кратко\nО лекции.')).toBe(true);
    // Слово «кратко» в тексте — ещё не итог.
    expect(hasSummary('## Конспект\n\n### Кратко о главном (00:00–05:00)\n- пункт')).toBe(false);
  });
});

describe('диаграммы, которые Obsidian покажет без ошибки', () => {
  const график = 'xychart-beta\n  title "Ломаная"\n  x-axis "Шоколад" [0, 50, 100]\n  y-axis "Сигареты" 0 --> 260\n  line [250, 200, 150]\n';

  it('график с числами проходит, со словами или неравными рядами — нет', () => {
    expect(mermaidLooksValid(график)).toBe(true);
    expect(mermaidLooksValid(график.replace('[250, 200, 150]', '[250, двести, 150]'))).toBe(false);
    expect(mermaidLooksValid(график.replace('[250, 200, 150]', '[250, 200]'))).toBe(false);
  });

  it('карта без скобок в подписях, схема — с подписями в кавычках', () => {
    expect(mermaidLooksValid('mindmap\n  root((Кривая))\n    Причины\n      специализация\n')).toBe(true);
    expect(mermaidLooksValid('mindmap\n  root((Кривая))\n    Причины (две)\n')).toBe(false);
    expect(mermaidLooksValid('flowchart LR\n  A["יתרון יחסי<br/>преимущество"] --> B["ниже (у Б)"]\n')).toBe(true);
    expect(mermaidLooksValid('flowchart LR\n  A[преимущество (Б)] --> B\n')).toBe(false);
  });

  it('незнакомый вид и HTML — нет', () => {
    expect(mermaidLooksValid('pie\n  "a": 1\n')).toBe(false);
    expect(mermaidLooksValid('flowchart LR\n  A["<script>x</script>"]\n')).toBe(false);
  });

  it('уборка: сломанная диаграмма уходит, рабочая остаётся, выноски не слипаются', () => {
    const ответ = [
      '### Наклон',
      '```mermaid\nmindmap\n  root((A))\n    ветка (сломана)\n```',
      '```mermaid\n' + график + '```',
      '> [!quote] Лектор, 23:50',
      '> אז השיפוע הוא העלות האלטרנטיבית השולית.',
      '> [!question]- Проверь себя: что такое наклон?',
      '> Предельная стоимость.',
    ].join('\n');
    const чисто = tidyNoteMarkdown(ответ);
    expect(чисто).not.toContain('ветка (сломана)');
    expect(чисто).toContain('xychart-beta');
    expect(чисто).toMatch(/השולית\.\n\n> \[!question\]-/u);
  });
});

describe('виды конспекта', () => {
  const иврит = { notes: 'ru' as const, foreign: 'иврите' };

  it('«Разбор»: цитата лектора, «проверь себя», шпаргалка', () => {
    expect(sectionStyleRules('razbor', иврит).join('\n')).toMatch(/\[!quote\][\s\S]*\[!question\]- Проверь себя/u);
    expect(finalStyleRules('razbor', иврит).join('\n')).toMatch(/\[!abstract\] Кратко[\s\S]*На иврите[\s\S]*## Шпаргалка/u);
  });

  it('«Сначала проверь себя»: вопросы, что я умею, карта, ловушки', () => {
    expect(sectionStyleRules('questions', иврит).join('\n')).toMatch(/2–4 свёрнутые выноски «> \[!question\]-/u);
    expect(finalStyleRules('questions', иврит).join('\n')).toMatch(/- \[ \][\s\S]*mindmap[\s\S]*## Понятия[\s\S]*## Ловушки/u);
  });

  it('«Язык лекции рядом»: фразы с переводом, словарь, вопросы на языке экзамена', () => {
    const раздел = sectionStyleRules('bilingual', иврит).join('\n');
    expect(раздел).toMatch(/\[!quote\] мм:сс/u);
    expect(раздел).toMatch(/\| На иврите \| По-русски \|/u);
    expect(finalStyleRules('bilingual', иврит).join('\n')).toMatch(/flowchart LR[\s\S]*с вопросом на иврите/u);
  });

  it('лекция на языке конспекта — без перевода и без правила про направление письма', () => {
    expect(obsidianRules({ notes: 'ru', foreign: null }).join('\n')).not.toMatch(/перевод/u);
    expect(obsidianRules(иврит).join('\n')).toMatch(/перевод — следующим абзацем/u);
    expect(sectionStyleRules('bilingual', { notes: 'ru', foreign: null }).join('\n')).toMatch(/\| Термин \| Значение \|/u);
  });

  it('промпты берут вид из языков; по умолчанию — «Разбор»', () => {
    expect(sectionPrompt('[00:00] кусок', 'Физика', [], { lecture: 'he', notes: 'ru', style: 'questions' })).toMatch(/\[!question\]- Вопрос\?/u);
    expect(sectionPrompt('[00:00] кусок', 'Физика', [], { lecture: 'he', notes: 'ru' })).toMatch(/Проверь себя/u);
    expect(finalPrompt('[00:00] текст', '', { lecture: 'en', notes: 'en', style: 'bilingual' })).toMatch(/## How the lecturer said it/u);
    // Минуты записи — только для подписи слов лектора.
    expect(sectionPrompt('кусок', '', [])).toMatch(/Метки «\[мм:сс\]»/u);
  });
});

describe('слова модели вне заметки', () => {
  // Живая проверка 20.10.2026: модель полезла в хранилище и начала раздел
  // словами «Доступа к хранилищу Obsidian сейчас нет — вставьте раздел сами».
  it('до заголовка раздела и до выноски итога — отрезаются', () => {
    const раздел = sectionFromReply('Доступа к хранилищу нет — вставьте сами.\n\n### Наклон\n- пункт', 2);
    expect(раздел).toBe('### Наклон\n- пункт');
    expect(fromSummary('Вот итог:\n\n> [!abstract] Кратко\n> О лекции.')).toBe('> [!abstract] Кратко\n> О лекции.');
    expect(fromSummary('## Кратко\nО лекции.')).toBe('## Кратко\nО лекции.');
  });

  it('промпты просят только текст и не упоминают, куда он ляжет', () => {
    for (const промпт of [sectionPrompt('к', '', []), finalPrompt('т', ''), sectionPrompt('c', '', [], { lecture: 'en', notes: 'en' })]) {
      expect(промпт).not.toMatch(/живёт в Obsidian|live in Obsidian/u);
      expect(промпт).toMatch(/ничего не открывай|open, read or save nothing/u);
    }
  });
});

describe('понятия из итога — списком и таблицей', () => {
  it('таблица: без шапки и черты, ячейки через тире', () => {
    const блок = '\n| Понятие | На иврите | Коротко |\n| --- | --- | --- |\n| Наклон | שיפוע | предельная стоимость |\n| Специализация | התמחות | вторая причина |\n';
    expect(conceptLines(блок)).toEqual(['Наклон — שיפוע — предельная стоимость', 'Специализация — התמחות — вторая причина']);
  });

  it('список — как раньше', () => {
    expect(conceptLines('- наклон — предельная стоимость\n* излом — смена работника\n')).toEqual(['наклон — предельная стоимость', 'излом — смена работника']);
  });
});

describe('настройки оформления', () => {
  it('по умолчанию — «Кольцо», как в системе, «Разбор»; чужие значения — к умолчанию', () => {
    expect(normaliseSettings({})).toMatchObject({ look: 'ring', theme: 'system', notesStyle: 'razbor' });
    expect(normaliseSettings({ look: 'tetrad', theme: 'dark', notesStyle: 'bilingual' })).toMatchObject({ look: 'tetrad', theme: 'dark', notesStyle: 'bilingual' });
    expect(normaliseSettings({ look: 'neon', theme: 'sepia', notesStyle: 'essay' })).toMatchObject({ look: 'ring', theme: 'system', notesStyle: 'razbor' });
  });
});
