import { describe, expect, it } from 'vitest';

import { readConfirmation } from './confirm';

describe('ответ на вопрос «да или нет»', () => {
  it('слышит согласие', () => {
    for (const answer of ['да', 'Да!', 'ага', 'давай', 'конечно', 'разрешаю', 'ок']) {
      expect(readConfirmation(answer), answer).toBe('yes');
    }
  });

  it('слышит отказ', () => {
    for (const answer of ['нет', 'Нет.', 'не надо', 'отмена', 'стоп', 'подожди']) {
      expect(readConfirmation(answer), answer).toBe('no');
    }
  });

  it('при сомнении не считает молчание согласием', () => {
    // Здесь ошибиться в сторону «да» — значит выполнить опасное действие,
    // которого человек не разрешал.
    for (const answer of ['сейчас посмотрю', 'а что там', '', 'хм', 'секунду']) {
      expect(readConfirmation(answer), answer).toBe('unclear');
    }
  });

  it('отказ побеждает в фразе, где есть и то и другое', () => {
    expect(readConfirmation('да не надо')).toBe('no');
    expect(readConfirmation('давай нет, отмена')).toBe('no');
  });
});

describe('согласие не выдумывается из неясного ответа', () => {
  /**
   * Замечания CodeRabbit (кусок 3, PR №42). Оба случая кончались тем, что
   * чувствительная работа начиналась, хотя человек её не разрешал.
   */
  it('многословный отказ находится не только в начале', () => {
    expect(readConfirmation('да, ни в коем случае')).toBe('no');
    expect(readConfirmation('ну да, не надо пока')).toBe('no');
    expect(readConfirmation('sure, do not')).toBe('no');
  });

  it('вопрос со словом «можно» согласием не считается', () => {
    expect(readConfirmation('можно сначала узнать подробнее?')).toBe('unclear');
    expect(readConfirmation('давай сначала посмотрим что там')).toBe('unclear');
    expect(readConfirmation('сделай сначала копию а потом спросим')).toBe('unclear');
  });

  it('но короткий ответ этими же словами — согласие', () => {
    expect(readConfirmation('можно')).toBe('yes');
    expect(readConfirmation('ну давай')).toBe('yes');
  });
});
