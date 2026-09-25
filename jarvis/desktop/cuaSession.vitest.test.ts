import { describe, expect, it } from 'vitest';

import { windowsFromAnswer } from './cuaProtocol';

/**
 * Молчание драйвера окон нельзя выдавать за пустой экран.
 *
 * Драйвер сам заканчивает свою сессию — по простою или после собственной
 * ошибки — и дальше отвечает на ВСЁ одной фразой про `start_session`. Эта
 * фраза не разбиралась как список окон, и пустота уходила человеку бодрым
 * «Открытых окон нет».
 *
 * Поймано живым прогоном 25.09.2026: на экране стояли Блендер, Клод и
 * браузер, а Джарвис отвечал, что окон нет. Глаза и руки умирали молча — до
 * перезапуска приложения.
 */
describe('ответ драйвера окон', () => {
  const список = [
    '✅ Found 2 window(s) across 2 app(s); 2 on-screen.',
    '- electron.exe (pid 34032) "Jarvis" [window_id: 1050992]',
    '- blender.exe (pid 36432) "пустая - Blender 5.2.1 LTS" [window_id: 1903738]',
  ].join('\n');

  it('обычный список разбирается', () => {
    const окна = windowsFromAnswer(список);
    expect(окна).toHaveLength(2);
    expect(окна[1]).toMatchObject({ app: 'blender.exe', pid: 36432, windowId: 1903738 });
  });

  it('кончившаяся сессия — это отказ, а не пустой экран', () => {
    expect(() =>
      windowsFromAnswer('this session has ended; call start_session explicitly to reuse its label'),
    ).toThrow(/не списком/u);
  });

  it('в отказе видно, что именно сказал драйвер', () => {
    expect(() => windowsFromAnswer('Screen recording permission denied')).toThrow(
      /Screen recording permission denied/u,
    );
  });

  it('честный пустой экран остаётся пустым, без отказа', () => {
    // Заголовок есть — значит драйвер посчитал и правда ничего не нашёл.
    expect(windowsFromAnswer('✅ Found 0 window(s) across 0 app(s); 0 on-screen.')).toEqual([]);
  });

  it('служебные окна самого драйвера в список не идут', () => {
    const ответ = [
      '✅ Found 2 window(s) across 2 app(s); 2 on-screen.',
      '- cua-driver.exe (pid 1) "Cua.AgentCursorOverlay.default" [window_id: 1]',
      '- explorer.exe (pid 2) "Program Manager" [window_id: 2]',
    ].join('\n');
    expect(windowsFromAnswer(ответ)).toEqual([]);
  });
});
