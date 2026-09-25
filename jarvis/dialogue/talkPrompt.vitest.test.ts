import { describe, expect, it } from 'vitest';

import { buildTalkOpening, buildTalkTurn } from './talkPrompt';

describe('buildTalkOpening', () => {
  it('называет все пять рычагов: неназванным разговор не воспользуется', () => {
    const запрос = buildTalkOpening({ said: 'привет' });
    for (const рычаг of ['start_work', 'add_note', 'stop_work', 'add_step', 'work_now']) {
      expect(запрос).toContain(рычаг);
    }
  });

  it('кладёт фразу человека последней', () => {
    const запрос = buildTalkOpening({ said: 'как там дела' });
    expect(запрос.trimEnd().endsWith('Человек сказал: как там дела')).toBe(true);
  });

  it('показывает работу, когда она есть', () => {
    const запрос = buildTalkOpening({
      said: 'ну что там',
      work: ['Цель: собрать отчёт', '— найти данные (делаю)'],
    });
    expect(запрос).toContain('Работа сейчас:');
    expect(запрос).toContain('Цель: собрать отчёт');
  });

  it('честно говорит, что работы нет', () => {
    // Молчание про работу читается как «работа идёт, но я о ней не знаю».
    expect(buildTalkOpening({ said: 'привет' })).toContain('Работы сейчас нет.');
  });

  it('передаёт характер, который человек правит сам', () => {
    const запрос = buildTalkOpening({ said: 'привет', instructions: 'Не называй меня сэром.' });
    expect(запрос).toContain('Не называй меня сэром.');
  });

  it('пустые строки состояния не превращаются в пустые разделы', () => {
    const запрос = buildTalkOpening({ said: 'привет', work: ['  '], recent: [''] });
    expect(запрос).toContain('Работы сейчас нет.');
    expect(запрос).not.toContain('Недавно:');
  });
});

describe('buildTalkTurn', () => {
  it('без новостей отдаёт одну фразу', () => {
    expect(buildTalkTurn('а почему')).toBe('Человек сказал: а почему');
  });

  it('с новостями кладёт их перед фразой', () => {
    const запрос = buildTalkTurn('что случилось', ['сбой: не смог открыть Krita']);
    expect(запрос).toContain('С прошлого раза:');
    expect(запрос).toContain('сбой: не смог открыть Krita');
    expect(запрос.trimEnd().endsWith('Человек сказал: что случилось')).toBe(true);
  });

  it('правила второй раз не повторяет', () => {
    // Они уже прочитаны первым ходом и помнятся сессией. Повтор — это
    // оплаченные заново секунды ожидания человека.
    expect(buildTalkTurn('ага', ['что-то случилось'])).not.toContain('start_work');
  });
});
