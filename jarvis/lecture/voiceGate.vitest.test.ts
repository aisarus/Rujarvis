import { describe, expect, it } from 'vitest';

import { lectureHeardForJarvis } from './voiceGate';

describe('голос во время лекции', () => {
  it('«Джарвис» → «Слушаю» → «закончи конспект» заканчивает конспект (живой прогон 29.09.2026)', () => {
    expect(lectureHeardForJarvis('Джарвис', false)).toBe(true);
    expect(lectureHeardForJarvis('закончи конспект', true)).toBe(true);
    // Не разбуженный — фраза без имени остаётся звуком аудитории.
    expect(lectureHeardForJarvis('закончи конспект', false)).toBe(false);
  });

  it('команда с именем проходит сразу; стоп и тишина — всегда', () => {
    expect(lectureHeardForJarvis('Джарвис, закончи конспект', false)).toBe(true);
    expect(lectureHeardForJarvis('стоп', false)).toBe(true);
    expect(lectureHeardForJarvis('тишина', false)).toBe(true);
    expect(lectureHeardForJarvis('Джарвис, стоп', false)).toBe(true);
  });

  it('каша из аудитории с «именем» внутри в разговор не уходит', () => {
    // Русский слух на 24 секундах иврита; похожее на имя нашлось в каше.
    expect(
      lectureHeardForJarvis('Джарвис дайморд который очень много читает это сифер в еврейте англит церфе или в каком-то', false),
    ).toBe(false);
    expect(lectureHeardForJarvis('У нас есть в курсе два до сих пор Джарвис', false)).toBe(false);
    // Разговор во время лекции не ведётся — только команды.
    expect(lectureHeardForJarvis('Джарвис, расскажи анекдот', false)).toBe(false);
    expect(lectureHeardForJarvis('расскажи анекдот', true)).toBe(false);
  });

  it('на заданный вопрос короткое «да» и «нет» проходят; без вопроса — нет (ревью 29.09.2026)', () => {
    expect(lectureHeardForJarvis('Джарвис, да', false, true)).toBe(true);
    expect(lectureHeardForJarvis('нет', false, true)).toBe(true);
    expect(lectureHeardForJarvis('Джарвис, да', false, false)).toBe(false);
    // Длинная фраза из аудитории с «да» внутри — не ответ.
    expect(lectureHeardForJarvis('да это было в восемнадцатом веке во Франции', false, true)).toBe(false);
  });

  it('пустое — не к нему', () => {
    expect(lectureHeardForJarvis('', true)).toBe(false);
    expect(lectureHeardForJarvis('   ', false)).toBe(false);
  });
});
