import { describe, expect, it } from 'vitest';

import { buildHelpHtml } from './helpOverlay';
import { commandCatalogue } from '../jarvis/control/catalogue';

/**
 * Список команд, который не влезает в окно.
 *
 * Замер 24.09.2026 на экране 1536×864: окно справки выходит 1051×712, а сам
 * список в три колонки занимает 910 точек — пятая часть команд остаётся ниже
 * сгиба. Прокрутить её нечем: окно нарочно не берёт фокус, потому что человек
 * в этот момент говорит, а не печатает, — остаётся только колёсико мыши, о
 * котором окно нигде не говорит. При этом само окно обещает обратное:
 * «сказал — увидел всё».
 *
 * Поэтому колонки подбираются под окно уже на странице.
 */
describe('buildHelpHtml', () => {
  const html = buildHelpHtml(commandCatalogue());

  it('доезжает до конца, а не обрывается на середине', () => {
    // Одна обратная кавычка внутри шаблонной строки рвёт страницу пополам.
    expect(html).toContain('</script>');
    expect(html).toContain('</html>');
  });

  it('подбирает число колонок замером, а не задаёт его числом', () => {
    expect(html).toContain('columnCount');
    expect(html).toContain('scrollHeight');
    // Перебор, а не рост: больше колонок не значит ниже список.
    expect(html).toContain('n <= 5');
  });

  it('отбрасывает раскладки, где таблица шире своей колонки', () => {
    // Фраза команды не переносится: в узкой колонке таблица вылезает за край,
    // описание начинает переноситься, и список становится выше, а не ниже.
    expect(html).toContain('вылезает');
    expect(html).toContain('getBoundingClientRect');
  });

  it('вставляет команды как текст, а не как разметку', () => {
    expect(html).not.toContain('innerHTML');
  });

  it('показывает все команды из справочника, а не часть', () => {
    const команд = commandCatalogue().reduce((всего, группа) => всего + группа.items.length, 0);
    const строк = html.match(/<tr>/gu)?.length ?? 0;
    expect(строк).toBe(команд);
    expect(команд).toBeGreaterThan(50);
  });
});
