/**
 * Настройки графа Obsidian для хранилища с лекциями: у каждого курса свой цвет,
 * расшифровок и одиночных точек нет, кучки держатся вместе.
 *
 * Настройки сливаются с тем, что уже есть в `.obsidian/graph.json`: неизвестные
 * ключи и цвета, которые человек завёл сам, остаются, а курс, у которого цвет уже
 * есть, его не меняет — в том числе цвет, который человек ему выбрал.
 *
 * Силы подобраны на настоящем Obsidian 04.11.2026, на копии хранилища владельца:
 * 13 курсов, 69 заметок. При 0.35/14/90 курсы расходились дальше, но правый край не
 * влезал в окно; при 0.6/10/40 кучки сливались; 0.5/12/60 показывает все сразу и
 * раздельно. Отталкивание больше 20 Obsidian сам срезает до 20.
 */

import { COURSE_WORDS } from '../lecture/courses';

export const GRAPH_FORCES = { centerStrength: 0.5, repelStrength: 12, linkStrength: 1, linkDistance: 60 } as const;

/** Цвета хорошо различимы и на тёмной теме, и на светлой; порядок постоянный. */
const ЦВЕТА = [
  0xe6194b, 0x3cb44b, 0xffe119, 0x4363d8, 0xf58231, 0x911eb4, 0x42d4f4, 0xf032e6, 0xbfef45, 0xfabed4, 0x469990, 0xdcbeff, 0x9a6324, 0xfffac8, 0xaaffc3, 0x808000, 0xffd8b1,
];

export interface GraphColorGroup {
  query: string;
  color: { a: number; rgb: number };
}

export type GraphSettings = Record<string, unknown>;

export interface GraphMerge {
  settings: GraphSettings;
  /** Курсы, которым цвет дан только что. */
  newGroups: number;
  /** Сколько курсов всего с цветом. */
  courses: number;
  /** Отличается ли от того, что было. */
  changed: boolean;
}

/**
 * Запрос цветовой группы курса: `path` считается от корня хранилища. Косая черта в
 * конце обязательна: `path` ищет подстроку, и без неё «История» красила бы и
 * «История человечества» (проверено в настоящем Obsidian 04.11.2026, с чертой цвета
 * разные).
 */
function запросКурса(папкаЛекций: string, курс: string): string {
  return `path:"${папкаЛекций ? `${папкаЛекций}/` : ''}${курс}/"`;
}

/** Тот же ли это запрос: кавычки и косая черта в конце ничего не меняют. */
function суть(запрос: string): string {
  return запрос.trim().replace(/"/gu, '').replace(/\/+$/u, '').toLowerCase();
}

function группы(значение: unknown): GraphColorGroup[] {
  return Array.isArray(значение) ? (значение as GraphColorGroup[]) : [];
}

/** Первый цвет, которого ещё нет; палитра кончилась — следующий оттенок золотым сечением. */
function свободныйЦвет(заняты: Set<number>): number {
  const из = ЦВЕТА.find((цвет) => !заняты.has(цвет));
  if (из !== undefined) return из;
  for (let шаг = заняты.size; ; шаг += 1) {
    const цвет = оттенок((шаг * 137.508) % 360);
    if (!заняты.has(цвет)) return цвет;
  }
}

function оттенок(h: number): number {
  const канал = (n: number): number => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (0.75 - 0.5 * Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return (канал(5) << 16) | (канал(3) << 8) | канал(1);
}

/** Фильтр: что было у человека, плюс исключение расшифровок на обоих языках. */
function фильтр(было: unknown): string {
  const условия = [typeof было === 'string' ? было.trim() : ''];
  for (const { transcriptSuffix } of Object.values(COURSE_WORDS)) {
    const условие = `-file:"— ${transcriptSuffix}"`;
    if (!условия[0]?.includes(условие)) условия.push(условие);
  }
  return условия.filter(Boolean).join(' ');
}

/** Слить настройки. `existing` — разобранный `graph.json` или null, если файла нет. */
export function mergeGraphSettings(existing: GraphSettings | null, папкаЛекций: string, курсы: readonly string[]): GraphMerge {
  const было = existing ?? {};
  // Запись без косой черты — наша прежняя, а не человека: чиним её, цвет курса остаётся.
  const colorGroups = группы(было.colorGroups).map((г) => {
    const курс = курсы.find((к) => г?.query === запросКурса(папкаЛекций, к).replace(/\/"$/u, '"'));
    return курс ? { ...г, query: запросКурса(папкаЛекций, курс) } : г;
  });
  const известны = new Set(colorGroups.map((г) => суть(String(г?.query ?? ''))));
  const заняты = new Set(colorGroups.map((г) => г?.color?.rgb).filter((цвет): цвет is number => typeof цвет === 'number'));
  let newGroups = 0;
  for (const курс of [...курсы].sort((a, b) => a.localeCompare(b))) {
    const query = запросКурса(папкаЛекций, курс);
    if (известны.has(суть(query))) continue;
    const rgb = свободныйЦвет(заняты);
    заняты.add(rgb);
    известны.add(суть(query));
    colorGroups.push({ query, color: { a: 1, rgb } });
    newGroups += 1;
  }
  const settings: GraphSettings = {
    ...было,
    search: фильтр(было.search),
    hideUnresolved: true,
    showOrphans: false,
    colorGroups,
    ...GRAPH_FORCES,
  };
  return { settings, newGroups, courses: курсы.length, changed: JSON.stringify(settings) !== JSON.stringify(было) };
}
