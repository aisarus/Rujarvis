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
