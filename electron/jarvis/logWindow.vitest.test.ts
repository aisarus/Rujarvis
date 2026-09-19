import { describe, expect, it } from 'vitest';

import { buildLogWindowHtml } from './logWindow';

/**
 * Страница окна целиком лежит внутри шаблонной строки.
 *
 * Одна обратная кавычка где угодно в ней — хоть в комментарии — рвёт строку
 * пополам, и остаток кода не доезжает до браузера. Ровно так уже легла сборка
 * страницы микрофона, и проверка типов этого не увидела.
 */
describe('buildLogWindowHtml', () => {
  const html = buildLogWindowHtml();

  it('доезжает до конца, а не обрывается на середине', () => {
    expect(html).toContain('jarvis-log:backlog');
    expect(html).toContain('</script>');
    expect(html).toContain('</html>');
  });

  it('рисует и подпись шага, и подробность', () => {
    // Без подробности строка бесполезна: «Пишу файл» без имени файла не
    // говорит ничего.
    expect(html).toContain("className = 'text'");
    expect(html).toContain("className = 'detail'");
  });

  it('следует за низом ленты, пока человек её не тронул', () => {
    expect(html).toContain('follow');
    expect(html).toContain('scrollHeight');
  });

  it('вставляет текст как текст, а не как разметку', () => {
    // Строки приходят из вывода агента и из имён файлов. Складывать их в
    // innerHTML значит дать чужому тексту исполняться в окне.
    expect(html).not.toContain('innerHTML');
    expect(html).toContain('textContent');
  });

  it('не копит строки бесконечно', () => {
    expect(html).toContain('removeChild');
  });
});
