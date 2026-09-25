import { describe, expect, it } from 'vitest';

import { EchoGuard } from './echo';

const NOW = 1_000_000;

function guard(): EchoGuard {
  let clock = NOW;
  const instance = new EchoGuard({ now: () => clock });
  return Object.assign(instance, {
    advance(ms: number) {
      clock += ms;
    },
  }) as EchoGuard & { advance(ms: number): void };
}

describe('EchoGuard', () => {
  it('узнаёт собственную фразу, услышанную из колонок', () => {
    // Джарвис сказал «Открываю блендер», микрофон это услышал, и он выполнил
    // свою же реплику как команду. В журнале это видно чёрным по белому.
    const echo = guard();
    echo.spoke('Открываю блендер.');

    expect(echo.isOwnVoice('Открываю блендер')).toBe(true);
  });

  it('прощает распознавателю мелкие расхождения', () => {
    const echo = guard();
    echo.spoke('Закрыл Steam.');

    expect(echo.isOwnVoice('закрыл стим')).toBe(true);
  });

  it('узнаёт кусок собственной длинной фразы', () => {
    const echo = guard();
    echo.spoke('Файл «закат.png» — в папке «Джарвис» на рабочем столе, раздел Images.');

    expect(echo.isOwnVoice('в папке Джарвис на рабочем столе')).toBe(true);
  });

  it('не принимает команду человека за эхо', () => {
    const echo = guard();
    echo.spoke('Открываю блендер.');

    expect(echo.isOwnVoice('сделай в блендере красный шар')).toBe(false);
    expect(echo.isOwnVoice('закрой всё')).toBe(false);
  });

  it('забывает сказанное, когда оно давно отзвучало', () => {
    // Иначе человек, повторивший фразу Джарвиса через минуту, не будет услышан.
    const echo = guard() as EchoGuard & { advance(ms: number): void };
    echo.spoke('Открываю блендер.');
    echo.advance(20_000);

    expect(echo.isOwnVoice('Открываю блендер')).toBe(false);
  });

  it('молчит, пока ничего не говорил', () => {
    expect(guard().isOwnVoice('что угодно')).toBe(false);
  });

  it('помнит несколько последних реплик', () => {
    // Пока звучит вторая фраза, микрофон может донести хвост первой.
    const echo = guard();
    echo.spoke('Открываю блендер.');
    echo.spoke('Готово.');

    expect(echo.isOwnVoice('Открываю блендер')).toBe(true);
    expect(echo.isOwnVoice('готово')).toBe(true);
  });

  it('не глушит слова остановки — их говорят поверх речи нарочно', () => {
    const echo = guard();
    echo.spoke('Сейчас открою блендер и сделаю там шар, это займёт время.');

    // Человек перебивает — это должно доходить всегда.
    expect(echo.isOwnVoice('стоп')).toBe(false);
    expect(echo.isOwnVoice('тишина')).toBe(false);
    expect(echo.isOwnVoice('хватит')).toBe(false);
  });

  it('не считает эхом короткое слово, которого в реплике не было', () => {
    const echo = guard();
    echo.spoke('Открываю блендер.');

    expect(echo.isOwnVoice('да')).toBe(false);
  });
});
