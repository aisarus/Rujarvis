/**
 * На чём Джарвис уже спотыкался.
 *
 * ## Откуда это
 *
 * Приём Aegis (`operator/src/lessons.js`), и его объяснение стоит привести
 * целиком, потому что оно и есть замысел:
 *
 * > Память между прогонами была, и была бесполезной. Она хранила исход,
 * > оценку, раздачу и деньги — факты о прошлом, из которых не следует ни одного
 * > действия. А то, что действительно меняет поведение, уже лежало в журналах и
 * > никем не читалось: стены, о которые прогоны бились.
 *
 * Это и есть самонаращивающийся системный промпт, о котором просил человек, —
 * и он не стоит ни одного вызова модели и ни одной копейки. Ничего не надо
 * «обучать»: неудача, уже записанная в журнал, сама становится строкой
 * следующего промпта.
 *
 * ## Откуда берётся у Джарвиса
 *
 * Два источника, оба появились сегодня:
 *
 *   - записи журнала вида `error` — задача, которая не вышла;
 *   - шаги плана в состоянии «не вышло» с пометкой, чем именно.
 *
 * Второй источник ценнее: пометку пишет сам агент, и там сказано, обо что он
 * споткнулся, а не просто что споткнулся.
 *
 * ## Что здесь важно не перепутать
 *
 * **Считаем не повторы, а разные подходы.** У Aegis мерой был прогон: стена,
 * встреченная в пяти прогонах, — свойство системы, а двадцать ударов внутри
 * одного прогона — беда того прогона.
 *
 * Первой попыткой я взял мерой сутки — и проверка на настоящем журнале сразу
 * это опровергла: все пять неудач дня оказались «однодневными», и в промпт не
 * уходило ничего. Джарвис не узнал бы ничего до завтра. Прогон Aegis — это не
 * день, это отдельная работа, а их за вечер десятки.
 *
 * Поэтому мера — подход: неудачи, разнесённые больше чем на десять минут.
 * Повтор через минуту — это одна и та же попытка, растянутая на два захода.
 *
 * **Список короткий.** Вход — самая дорогая часть работы агента. Длинный
 * перечень читается как шум и не меняет ничего; три строки меняют.
 */

import type { JarvisEvent } from './journal';
import type { Plan } from '../agent/plan';

/**
 * По этому куску уроки и объединяются.
 *
 * Подробности — имена файлов, номера — в каждый раз свои, а начало у одной и
 * той же стены одинаковое.
 */
const KEY_CHARS = 60;

/** Длиннее этого урок не читается: в промпт едет начало. */
const SAID_LIMIT = 200;

/**
 * Сколько времени между неудачами считать разными подходами.
 *
 * Десять минут: человек, переспросивший то же самое через минуту, не встретил
 * вторую стену — он ударился о ту же. А вернувшийся через полчаса пробует
 * заново, и если стена та же, это уже её свойство.
 */
const OCCASION_MS = 10 * 60_000;

export interface Lesson {
  /** Чем всё кончилось, словами. */
  said: string;
  /** Сколько раз встречалось всего. */
  hits: number;
  /** В скольких разных подходах. Это и есть мера настоящести урока. */
  occasions: number;
}

export interface LessonSources {
  /** Записи журнала — берутся только неудачи. */
  events?: readonly JarvisEvent[];
  /** Планы: нынешний и, если хранятся, прошлые. */
  plans?: readonly (Plan | null)[];
}

function clean(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Ключ, по которому уроки объединяются.
 *
 * У Aegis это просто первые шестьдесят знаков: там сообщения длинные, и стена
 * успевает назваться до того, как начнутся подробности. У Джарвиса сообщения
 * короткие — «не смог: открыть блендер», — и подробность попадает прямо в
 * ключ. Замер на собственных тестах: две записи про один и тот же блендер с
 * разными именами файлов не объединились вовсе.
 *
 * Поэтому сначала убираем то, что в каждый раз своё: пути, имена файлов,
 * числа. Одна и та же стена после этого выглядит одинаково.
 */
function keyFor(said: string): string {
  return said
    .toLowerCase()
    // Путь целиком: «c:/users/...», «/home/...», «папка\файл».
    .replace(/\S*[\\/]\S*/gu, ' путь ')
    // Имя файла с расширением: «один.blend», «отчёт.xlsx».
    .replace(/\S+\.[a-zа-яё0-9]{2,5}(?!\p{L})/giu, ' файл ')
    .replace(/\d+/gu, 'N')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, KEY_CHARS);
}

/** Неудачи из журнала и планов, в одном виде. */
function wallsIn({ events = [], plans = [] }: LessonSources): Array<{ said: string; at: number }> {
  const walls: Array<{ said: string; at: number }> = [];

  for (const event of events) {
    if (event.kind !== 'error') continue;
    const said = clean(event.text ?? '');
    if (said) walls.push({ said, at: event.at });
  }

  for (const plan of plans) {
    if (!plan) continue;
    for (const step of plan.steps) {
      if (step.state !== 'не вышло') continue;
      // Пометка ценнее самого шага: в ней сказано, обо что споткнулись.
      const said = clean(step.note ? `${step.text} — ${step.note}` : step.text);
      if (said) walls.push({ said, at: plan.updatedAt || plan.startedAt });
    }
  }

  return walls;
}

/**
 * Ключ, к которому стоит приписать этот.
 *
 * «Блендер не открылся» и «блендер не открылся, потому что окно умерло вместе с
 * сервером» — одна и та же стена, названная коротко и подробно. Если один ключ
 * начинается с другого, это она.
 */
function mergeKey(key: string, byKey: Map<string, unknown>): string {
  for (const known of byKey.keys()) {
    if (known.startsWith(key) || key.startsWith(known)) return known;
  }
  return key;
}

export function lessonsFrom(sources: LessonSources): Lesson[] {
  const byKey = new Map<string, { said: string; hits: number; occasions: Set<number> }>();

  for (const { said, at } of wallsIn(sources)) {
    // Одна стена, названная коротко и подробно, — всё ещё одна стена. Ключ,
    // оказавшийся началом уже виденного (или наоборот), к нему и приписывается.
    const key = mergeKey(keyFor(said), byKey);
    const row = byKey.get(key) ?? { said, hits: 0, occasions: new Set<number>() };
    row.hits += 1;
    if (Number.isFinite(at) && at > 0) row.occasions.add(Math.floor(at / OCCASION_MS));
    // Держим самый длинный вариант текста: он подробнее объясняет.
    if (said.length > row.said.length) row.said = said;
    byKey.set(key, row);
  }

  return [...byKey.values()]
    .map((row) => ({ said: row.said, hits: row.hits, occasions: row.occasions.size }))
    .sort((left, right) => right.occasions - left.occasions || right.hits - left.hits);
}

/**
 * Урок словами — для промпта.
 *
 * `minOccasions` по умолчанию два: встреченное однажды — случай, а не урок.
 * Показывать случаи значит наполнять промпт шумом, за который платят временем
 * каждой задачи.
 */
export function describeLessons(
  lessons: readonly Lesson[],
  options: { limit?: number; minOccasions?: number } = {},
): string | null {
  const limit = options.limit ?? 3;
  const minOccasions = options.minOccasions ?? 2;

  const worth = lessons.filter((lesson) => lesson.occasions >= minOccasions).slice(0, limit);
  if (worth.length === 0) return null;

  return [
    'НА ЧЁМ ТЫ УЖЕ СПОТЫКАЛСЯ (не повторяй):',
    ...worth.map((lesson) => {
      const where =
        lesson.occasions === 1 ? 'один раз' : `в ${lesson.occasions} разных подхода`;
      return `- ${lesson.said.slice(0, SAID_LIMIT)} (${where}, всего ${lesson.hits})`;
    }),
  ].join('\n');
}

export { KEY_CHARS, SAID_LIMIT };
