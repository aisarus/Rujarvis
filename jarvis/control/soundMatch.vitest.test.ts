import { describe, expect, it } from 'vitest';

import { pickBySound, soundScore, soundWords } from './soundMatch';

describe('сравнение на слух', () => {
  it('латиница и кириллица сходятся в одно звучание', () => {
    expect(soundWords('Claude')).toEqual(soundWords('клод'));
    expect(soundWords('клад')).toEqual(soundWords('клод'));
    expect(soundWords('Edge')).toEqual(soundWords('эдж'));
    expect(soundWords('Code')).toEqual(soundWords('код'));
    expect(soundWords('YouTube')).toEqual(soundWords('ютуб'));
    expect(soundWords('Steam')).toEqual(soundWords('стим'));
    expect(soundWords('WhatsApp')).toEqual(soundWords('ватсап'));
  });

  it('живой журнал 30.09.2026: «клад» и «клод» — Claude, «чат» — ChatGPT', () => {
    const окна = ['Jarvis', 'Учёба', 'Claude', 'Настройки', 'ChatGPT', 'Дзен — главная и еще 1 страница — Личный: Microsoft Edge'];
    for (const сказано of ['клад', 'клод', 'Claude', 'клауд']) {
      expect(pickBySound(сказано, окна, (x) => x), сказано).toMatchObject({ item: 'Claude', sure: true });
    }
    expect(pickBySound('чат', окна, (x) => x)).toMatchObject({ item: 'ChatGPT', sure: true });
    expect(pickBySound('эдж', окна, (x) => x)?.item).toMatch(/Edge/u);
  });

  it('не угадывает: «клуб» далеко от Claude — не уверенно, а незнакомое — ничего', () => {
    const окна = ['Jarvis', 'Claude', 'ChatGPT'];
    expect(pickBySound('клуб', окна, (x) => x)?.sure ?? false).toBe(false);
    expect(pickBySound('блокнот', окна, (x) => x)).toBeNull();
  });

  it('две близкие цели — вопрос, а не выбор', () => {
    const вкладки = ['ChatGPT — план', 'ChatGPT — код'];
    const выбор = pickBySound('чат', вкладки, (x) => x);
    expect(выбор?.sure).toBe(false);
    expect(выбор?.close).toHaveLength(1);
  });

  it('кнопки внутри окна: «код» — Code, «чат» — Chat and Cowork, связки не мешают', () => {
    const кнопки = ['Chat and Cowork, awaiting your input', 'Code', 'Remote Control', 'Terminal', 'Browser'];
    expect(pickBySound('код', кнопки, (x) => x)?.item).toBe('Code');
    expect(pickBySound('на чат', кнопки, (x) => x)?.item).toBe('Chat and Cowork, awaiting your input');
    expect(pickBySound('терминал', кнопки, (x) => x)?.item).toBe('Terminal');
    // Слово, разбитое распознаванием на два.
    expect(soundScore('дис корд', 'Discord')).toBeGreaterThan(0.8);
  });
});
