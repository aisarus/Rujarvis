import { describe, expect, it } from 'vitest';

import { PRIOR_DIGEST_CHARS, priorDigest, sectionPrompt } from './session';
import { claudeSummaryArgs } from './summarize';

const раздел = (n: number, текст: string) => `### Тема ${n} (${n}:00–${n}:05)\n${текст}`;

describe('расход токенов на конспект (04.11.2026: лекция съедала половину лимита подписки)', () => {
  it('запуск не тянет скиллы, настройки и инструменты', () => {
    const args = claudeSummaryArgs();
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', '', '--tools', '', '--disable-slash-commands', '--no-session-persistence', '--system-prompt']));
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });

  it('усилие задаётся только там, где его попросили', () => {
    expect(claudeSummaryArgs('sonnet')).not.toContain('--effort');
    expect(claudeSummaryArgs('sonnet', 'medium').slice(-2)).toEqual(['--effort', 'medium']);
  });

  it('последний раздел идёт целиком, из старых — только строки с числами, формулами и пометками', () => {
    const сводка = priorDigest([
      раздел(1, '- слова без цифр\n- дано: 250 работников\n- $F_1 = 28$\n- (⚠ на слух M, ширина l)'),
      раздел(2, '- только слова\n- и ещё слова'),
      раздел(3, '- последний: слова без цифр'),
    ]);
    expect(сводка).toContain('250 работников');
    expect(сводка).toContain('$F_1 = 28$');
    expect(сводка).toContain('⚠ на слух M');
    expect(сводка).not.toContain('слова без цифр\n- дано');
    expect(сводка).not.toContain('только слова');
    expect(сводка).toContain('- последний: слова без цифр');
    expect(сводка.indexOf('Тема 1')).toBeLessThan(сводка.indexOf('Тема 3'));
  });

  it('сводка не растёт с длиной лекции, и свежее важнее старого', () => {
    const разделы = Array.from({ length: 200 }, (_, n) => раздел(n, `- дано в разделе номер ${n}: ${'7 '.repeat(100)}`));
    const сводка = priorDigest(разделы);
    expect(сводка.length).toBeLessThanOrEqual(PRIOR_DIGEST_CHARS);
    expect(сводка).toContain('разделе номер 199');
    expect(сводка).toContain('разделе номер 198');
    expect(сводка).not.toContain('разделе номер 0:');
  });

  it('длинный последний раздел не обходит предел', () => {
    expect(priorDigest([раздел(1, 'x'.repeat(PRIOR_DIGEST_CHARS * 2))]).length).toBe(PRIOR_DIGEST_CHARS);
  });

  it('промпт раздела на длинной лекции ограничен', () => {
    const разделы = Array.from({ length: 200 }, (_, n) => раздел(n, `- дано ${n}: ${'7 '.repeat(100)}`));
    const без = sectionPrompt('кусок', 'Статистика', [], { lecture: 'he', notes: 'ru' }).length;
    expect(sectionPrompt('кусок', 'Статистика', разделы, { lecture: 'he', notes: 'ru' }).length).toBeLessThan(без + PRIOR_DIGEST_CHARS + 200);
  });
});
