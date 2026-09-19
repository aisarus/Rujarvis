import { describe, expect, it } from 'vitest';

import { buildAudioBridgeHtml } from './audioBridgePage';

/**
 * Страница микрофона целиком лежит внутри шаблонной строки.
 *
 * Значит, одна обратная кавычка где угодно в ней — хоть в комментарии — рвёт
 * строку пополам, и остаток кода просто не доезжает до браузера. Ровно это и
 * случилось: комментарий про причину закрытия записи назвал поле в обратных
 * кавычках, и сборка легла с «Expected ";"». Проверка типов этого не увидела.
 *
 * Здесь проверяется то, что видно снаружи: собранная страница должна
 * содержать весь свой код, а не первую его половину.
 */
describe('buildAudioBridgeHtml', () => {
  const html = buildAudioBridgeHtml();

  it('доезжает до конца, а не обрывается на середине', () => {
    // Последнее, что есть в странице: обработчики команд от главного процесса.
    expect(html).toContain('jarvis-audio:stop-speaking');
    expect(html).toContain('</script>');
  });

  it('содержит настройки сегментации целиком', () => {
    for (const marker of ['SPEECH_RMS', 'SILENCE_MS_TO_CLOSE', 'MAX_UTTERANCE_MS']) {
      expect(html).toContain(marker);
    }
  });

  it('сообщает, почему запись закрылась', () => {
    // Без этого оборванная на полуслове мысль снова уйдёт задачей.
    expect(html).toContain('closedBy');
    expect(html).toContain("'length'");
  });
});
