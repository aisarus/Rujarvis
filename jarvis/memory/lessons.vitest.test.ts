import { describe, expect, it } from 'vitest';

import { describeLessons, lessonsFrom } from './lessons';
import type { JarvisEvent } from './journal';
import { makePlan, markStep } from '../agent/plan';

const APART = 30 * 60_000; // больше подхода в десять минут
const AT = 1_700_000_000_000;

function error(text: string, at: number): JarvisEvent {
  return { at, kind: 'error', text };
}

describe('lessonsFrom', () => {
  it('берёт из журнала только неудачи', () => {
    const lessons = lessonsFrom({
      events: [
        error('не смог: блендер не открылся', AT),
        { at: AT, kind: 'result', text: 'сделал сферу' },
        { at: AT, kind: 'launch', text: 'открыл хром' },
      ],
    });

    expect(lessons.map((lesson) => lesson.said)).toEqual(['не смог: блендер не открылся']);
  });

  it('берёт из плана шаги, которые не вышли, вместе с пометкой', () => {
    // Пометка ценнее самого шага: в ней сказано, обо что споткнулись.
    const plan = markStep(
      makePlan('сделать сайт', ['разобрать архив', 'слепить модели'], AT),
      1,
      'не вышло',
      AT,
      'блендер не отвечает на скрипт',
    );

    const lessons = lessonsFrom({ plans: [plan] });

    expect(lessons[0]?.said).toBe('слепить модели — блендер не отвечает на скрипт');
  });

  it('считает разные дни, а не повторы', () => {
    // Стена, о которую бились десять раз подряд, — один затык. Стена, к
    // которой вернулись через полчаса и снова встретили, — её свойство.
    const lessons = lessonsFrom({
      events: [
        error('кириллица в скрипте приехала мусором', AT),
        error('кириллица в скрипте приехала мусором', AT + 60_000),
        error('кириллица в скрипте приехала мусором', AT + 2 * APART),
      ],
    });

    expect(lessons[0]).toMatchObject({ hits: 3, occasions: 2 });
  });

  it('объединяет похожее по началу, а подробности не мешают', () => {
    const lessons = lessonsFrom({
      events: [
        error('блендер не открылся: файл C:/один.blend не найден', AT),
        error('блендер не открылся: файл C:/другой.blend не найден', AT + APART),
      ],
    });

    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.occasions).toBe(2);
  });

  it('держит самый подробный вариант текста', () => {
    const lessons = lessonsFrom({
      events: [
        error('блендер не открылся', AT),
        error('блендер не открылся, потому что окно умерло вместе с сервером', AT + APART),
      ],
    });

    expect(lessons[0]?.said).toContain('окно умерло вместе с сервером');
  });

  it('сначала то, что встречалось в большем числе дней', () => {
    const lessons = lessonsFrom({
      events: [
        error('редкая беда', AT),
        error('частая беда', AT),
        error('частая беда', AT + APART),
        error('частая беда', AT + 2 * APART),
      ],
    });

    expect(lessons[0]?.said).toBe('частая беда');
  });

  it('переживает пустоту', () => {
    expect(lessonsFrom({})).toEqual([]);
    expect(lessonsFrom({ plans: [null] })).toEqual([]);
  });
});

describe('describeLessons', () => {
  it('молчит про то, что случилось однажды', () => {
    // Встреченное однажды — случай, а не урок. Показывать случаи значит
    // наполнять промпт шумом, за который платят временем каждой задачи.
    const lessons = lessonsFrom({ events: [error('разовая беда', AT)] });

    expect(describeLessons(lessons)).toBeNull();
  });

  it('говорит про то, что повторилось в разные дни', () => {
    const lessons = lessonsFrom({
      events: [error('кириллица в скрипте', AT), error('кириллица в скрипте', AT + APART)],
    });
    const text = describeLessons(lessons);

    expect(text).toContain('НА ЧЁМ ТЫ УЖЕ СПОТЫКАЛСЯ');
    expect(text).toContain('кириллица в скрипте');
    expect(text).toContain('2 разных подхода');
  });

  it('не отдаёт длинный список', () => {
    // Вход — самая дорогая часть работы агента, и длинный перечень читается
    // как шум.
    // Стены должны быть разными по существу, а не по номеру: номера прибор
    // нарочно стирает, и «беда номер 1» с «беда номер 2» для него одна стена.
    const walls = [
      'кириллица в скрипте приехала мусором',
      'блендер не открылся',
      'окно умерло вместе с сервером',
      'проверка здоровья соврала про сервер',
      'запись оборвалась на полуслове',
    ];
    const events: JarvisEvent[] = [];
    for (const wall of walls) events.push(error(wall, AT), error(wall, AT + APART));

    const text = describeLessons(lessonsFrom({ events })) ?? '';
    // Заголовок плюс три строки.
    expect(text.split('\n')).toHaveLength(4);
  });
});

/**
 * Не всякая неудача — урок.
 *
 * Замер 20.09.2026 на настоящем журнале: из 34 записей об ошибках 21 была
 * отменой человека, 10 — нашей поломкой окружения, и только две настоящими.
 * То есть раздел «на чём ты спотыкался» состоял из шума на 94% — и за этот
 * шум платится временем каждой задачи.
 */
describe('остановка человека уроком не считается', () => {
  it.each([
    'не смог: ДИНАМИЧНАЯ МУЗЫКА — Отменено',
    'не смог: что делаешь — Отменено',
    'не смог: открой блендер — Failed to authenticate. API Error: 401',
    'не смог: сделай мультик — Claude Code превысил отведённое время',
  ])('«%s» в уроки не попадает', (сказано) => {
    const events: JarvisEvent[] = [error(сказано, AT), error(сказано, AT + APART)];
    expect(lessonsFrom({ events })).toHaveLength(0);
  });

  it('настоящая стена остаётся', () => {
    const стена = 'инструмент scroll: Не удалось: значение не влезает в UInt32';
    const events: JarvisEvent[] = [error(стена, AT), error(стена, AT + APART)];
    expect(describeLessons(lessonsFrom({ events }))).toContain('UInt32');
  });

  // Отмена рядом со стеной не должна уносить стену за собой.
  it('отмена не заслоняет стену', () => {
    const стена = 'инструмент window_key: Не удалось: Ctrl потерян';
    const events: JarvisEvent[] = [
      error('не смог: что-то — Отменено', AT),
      error(стена, AT),
      error(стена, AT + APART),
    ];
    const текст = describeLessons(lessonsFrom({ events })) ?? '';
    expect(текст).toContain('Ctrl потерян');
    expect(текст).not.toContain('Отменено');
  });
});
