import { describe, expect, it } from 'vitest';

import { DEFAULT_VOICE, voiceForLanguage, VOICES } from './tts';

/**
 * Голос обязан следовать за языком.
 *
 * Дыра, которую это закрывает: список голосов в мастере показывается по языку,
 * а проверка «можно ли дальше» смотрит на ВЫБРАННЫЙ голос. Человек выбирал
 * English, видел пустой список английских голосов — и всё равно шёл дальше,
 * потому что выбранной оставалась установленная русская Ирина. Настройка
 * заканчивалась, интерфейс и слух были английскими, а говорил Джарвис
 * по-русски.
 */
describe('голос под язык', () => {
  it('переход на английский уводит с русского голоса', () => {
    expect(voiceForLanguage('en', 'vits-piper-ru_RU-irina-medium')).toBe(DEFAULT_VOICE.en);
  });

  it('переход на русский уводит с английского голоса', () => {
    expect(voiceForLanguage('ru', 'vits-piper-en_US-lessac-medium')).toBe(DEFAULT_VOICE.ru);
  });

  it('выбор человека внутри языка не отнимается', () => {
    // Он выбрал Дмитрия вместо Ирины — оба русские, менять нечего.
    expect(voiceForLanguage('ru', 'vits-piper-ru_RU-dmitri-medium')).toBe('vits-piper-ru_RU-dmitri-medium');
  });

  it('без выбранного голоса берётся голос по умолчанию', () => {
    expect(voiceForLanguage('en', undefined)).toBe(DEFAULT_VOICE.en);
    expect(voiceForLanguage('ru', 'такого-голоса-нет')).toBe(DEFAULT_VOICE.ru);
  });

  it('голос по умолчанию для каждого языка существует и на этом языке', () => {
    for (const язык of ['ru', 'en'] as const) {
      const голос = VOICES.find((v) => v.id === DEFAULT_VOICE[язык]);
      expect(голос, `голос по умолчанию для ${язык}`).toBeDefined();
      expect(голос?.language).toBe(язык);
    }
  });
});
