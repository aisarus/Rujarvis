import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { BackendEvent } from '../backends/types';
import { SILENT_EVENTS, describeEvent } from './storyline';

/**
 * Сторож человеческого пересказа.
 *
 * ## Откуда это
 *
 * Приём Aegis (`operator/app/tests/ledger-view.test.js:446`). Там тест не
 * перечисляет виды событий руками — он выгребает их регуляркой из самого ядра и
 * требует, чтобы каждый получил человеческую фразу. Причина записана над ним:
 *
 * > «7 сентября владелец читал в журнале `· stage {"closed":3,...}`. Чинить
 * > это по одному виду бессмысленно: ядро дописывает новые быстрее, чем окно
 * > их узнаёт.»
 *
 * ## Зачем он Джарвису
 *
 * Окно «что делаю» строится из `describeEvent`, а тот кончается `default:
 * return null`. Новый вид `BackendEvent` **молча исчезнет из ленты** — и
 * заметить это можно будет только глазами, случайно, посреди получасовой
 * работы.
 *
 * Сторож читает объединение `BackendEvent` в исходнике и требует от каждого
 * вида одного из двух: либо строка словами, либо место в `SILENT_EVENTS` с
 * объяснением. Молчание должно быть решением, а не забывчивостью.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Все виды событий — из самого объявления типа, а не из списка руками. */
function eventKinds(): string[] {
  const source = readFileSync(path.join(HERE, '..', 'backends', 'types.ts'), 'utf8');

  const from = source.indexOf('export type BackendEvent');
  expect(from, 'в types.ts не нашлось объявления BackendEvent').toBeGreaterThan(-1);
  // Объединение кончается на первой пустой строке после объявления: дальше
  // идут другие типы, и их варианты нам не нужны.
  const rest = source.slice(from);
  const until = rest.indexOf(';\n');
  const block = until > 0 ? rest.slice(0, until) : rest;

  const kinds = [...block.matchAll(/type:\s*'([^']+)'/gu)].map((match) => match[1] as string);
  expect(kinds.length, 'из объявления BackendEvent не вынулось ни одного вида').toBeGreaterThan(3);
  return [...new Set(kinds)];
}

describe('окно умеет пересказать каждое событие', () => {
  it('ни один вид не остаётся без слов', () => {
    const mute: string[] = [];
    const broke: string[] = [];

    for (const kind of eventKinds()) {
      if (SILENT_EVENTS.includes(kind)) continue;

      let line: ReturnType<typeof describeEvent> = null;
      try {
        // Нарочно неполное событие: у настоящего есть поля, но сторож проверяет
        // не разбор полей, а наличие ветки. Падение здесь — тоже находка: в
        // ленту приходят и оборванные события.
        line = describeEvent({ type: kind } as unknown as BackendEvent, 0);
      } catch {
        broke.push(kind);
        continue;
      }

      if (!line || !line.text.trim()) mute.push(kind);
    }

    expect(
      broke,
      `на этих видах пересказ падает, а не отвечает: ${broke.join(', ')}`,
    ).toEqual([]);
    expect(
      mute,
      `эти виды исчезнут из окна молча — напиши им фразу в describeEvent ` +
        `или, если молчание намеренное, назови их в SILENT_EVENTS: ${mute.join(', ')}`,
    ).toEqual([]);
  });

  it('молчаливые виды и правда есть в типе', () => {
    // Иначе список молчунов превращается в свалку: туда попадает вид, которого
    // давно нет, и сторож пропускает настоящую пропажу.
    const kinds = eventKinds();
    const stale = SILENT_EVENTS.filter((kind) => !kinds.includes(kind));

    expect(stale, `этих видов в BackendEvent больше нет: ${stale.join(', ')}`).toEqual([]);
  });
});
