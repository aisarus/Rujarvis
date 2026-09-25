/**
 * Снимок машины и разница между двумя снимками.
 *
 * ## Зачем
 *
 * Все проверки Джарвиса отвечали на вопрос «фраза превратилась в верную
 * команду?» — и почти нигде не проверяли, что действие правда произошло. Два
 * бага 20.09.2026 жили ровно в этом зазоре: «диктую» разбиралось верно и
 * падало при выполнении, «тишина» разбиралась верно и не останавливала речь.
 *
 * Отсюда правило: сквозная проверка — это `фраза → diff(до, после)`, а не
 * «разбор вернул то, что ожидали». Ожидаемая разница состояния и есть
 * определение того, что команда работает.
 *
 * ## Что сюда входит
 *
 * Только наблюдаемое снаружи и дешёвое: какое окно впереди, какие окна
 * открыты, какие программы запущены. Этого хватает, чтобы отличить запуск от
 * незапуска, переключение от неудачи и смену вкладки от её отсутствия —
 * заголовок окна браузера меняется вместе с вкладкой.
 *
 * Разбор здесь чистый и проверяется без машины; снимать снимок умеет тот, у
 * кого есть драйвер.
 */

/** Окно, каким его видно снаружи. */
export interface SeenWindow {
  title: string;
  process?: string;
  focused: boolean;
}

/** Состояние машины в один момент. */
export interface Snapshot {
  at: number;
  /** Заголовок окна, которое сейчас впереди. */
  front: string;
  windows: SeenWindow[];
  /** Имена запущенных программ. */
  processes: string[];
}

/** Что изменилось между двумя снимками. */
export interface Diff {
  /** Окно впереди сменилось: было и стало. */
  front?: { was: string; now: string };
  /** Появившиеся окна. */
  opened: string[];
  /** Исчезнувшие окна. */
  closed: string[];
  /** Запустившиеся программы. */
  started: string[];
  /** Закрывшиеся программы. */
  stopped: string[];
  /** Окна, у которых сменился заголовок, не меняя числа окон. */
  renamed: Array<{ was: string; now: string }>;
}

/**
 * Что есть в `a` и чего не хватает в `b` — С УЧЁТОМ ПОВТОРОВ.
 *
 * Раньше здесь было множество, и одинаковые заголовки схлопывались: два окна
 * «Документ», из которых закрыли одно, давали пустую разницу. Проверка
 * «ничего не должно было случиться» такое закрытие не замечала.
 */
function only<T>(a: readonly T[], b: readonly T[]): T[] {
  const остаток = new Map<T, number>();
  for (const item of b) остаток.set(item, (остаток.get(item) ?? 0) + 1);
  const лишние: T[] = [];
  for (const item of a) {
    const сколько = остаток.get(item) ?? 0;
    if (сколько > 0) остаток.set(item, сколько - 1);
    else лишние.push(item);
  }
  return лишние;
}

/**
 * Разница между снимками.
 *
 * Переименование считается отдельно от открытия и закрытия, и это не
 * придирка: смена вкладки в браузере выглядит как смена заголовка у того же
 * окна. Считать её парой «закрылось и открылось» значило бы не отличить
 * переключение вкладки от закрытия браузера.
 */
export function diff(before: Snapshot, after: Snapshot): Diff {
  const wasTitles = before.windows.map((w) => w.title);
  const nowTitles = after.windows.map((w) => w.title);

  const opened = only(nowTitles, wasTitles);
  const closed = only(wasTitles, nowTitles);

  // Пара «исчезло одно, появилось одно» у одной программы — это переименование.
  //
  // Но только если у программы НЕ ИЗМЕНИЛОСЬ число окон. Иначе закрытие
  // одного окна Edge и открытие другого выглядело как смена вкладки: оба
  // события исчезали из разницы, и проверка «сменился заголовок» засчитывала
  // успех там, где случилось совсем другое.
  const сколькоОкон = (снимок: Snapshot, process: string): number =>
    снимок.windows.filter((w) => w.process === process).length;

  const renamed: Diff['renamed'] = [];
  for (const gone of [...closed]) {
    const owner = before.windows.find((w) => w.title === gone)?.process;
    if (!owner) continue;
    if (сколькоОкон(before, owner) !== сколькоОкон(after, owner)) continue;
    const born = opened.find(
      (title) => after.windows.find((w) => w.title === title)?.process === owner,
    );
    if (!born) continue;
    renamed.push({ was: gone, now: born });
    closed.splice(closed.indexOf(gone), 1);
    opened.splice(opened.indexOf(born), 1);
  }

  const result: Diff = {
    opened,
    closed,
    started: only(after.processes, before.processes),
    stopped: only(before.processes, after.processes),
    renamed,
  };
  if (before.front !== after.front) result.front = { was: before.front, now: after.front };
  return result;
}

/** Ничего не изменилось? Для честного «команда не сработала». */
export function nothingChanged(d: Diff): boolean {
  return (
    d.front === undefined &&
    d.opened.length === 0 &&
    d.closed.length === 0 &&
    d.started.length === 0 &&
    d.stopped.length === 0 &&
    d.renamed.length === 0
  );
}

/** Разница словами — для отчёта проверки и для журнала. */
export function describeDiff(d: Diff): string {
  if (nothingChanged(d)) return 'ничего не изменилось';
  const parts: string[] = [];
  if (d.front) parts.push(`впереди: «${d.front.was}» → «${d.front.now}»`);
  for (const { was, now } of d.renamed) parts.push(`заголовок: «${was}» → «${now}»`);
  if (d.opened.length > 0) parts.push(`открылось: ${d.opened.join(', ')}`);
  if (d.closed.length > 0) parts.push(`закрылось: ${d.closed.join(', ')}`);
  if (d.started.length > 0) parts.push(`запустилось: ${d.started.join(', ')}`);
  if (d.stopped.length > 0) parts.push(`остановилось: ${d.stopped.join(', ')}`);
  return parts.join('; ');
}

/**
 * Чего ждали от команды.
 *
 * Нарочно не «полное совпадение диффа»: на живой машине рядом всегда что-то
 * шевелится — уведомление, фоновая программа, часы в заголовке. Проверяется
 * наличие ожидаемого, а не отсутствие остального.
 */
export interface Expectation {
  /** Впереди должно оказаться окно, чей заголовок содержит это. */
  frontContains?: string;
  /** Должна запуститься программа с таким именем. */
  started?: string;
  /** Должна закрыться программа с таким именем. */
  stopped?: string;
  /** У какого-то окна должен смениться заголовок. */
  titleChanged?: boolean;
  /** Ровно ничего не должно измениться. */
  nothing?: boolean;
}

function has(list: readonly string[], needle: string): boolean {
  const wanted = needle.toLowerCase();
  return list.some((item) => item.toLowerCase().includes(wanted));
}

/**
 * Сбылось ли ожидание. `null` — сбылось, строка — чем не сбылось.
 *
 * Причина возвращается словами, а не булевым: «не сработало» без объяснения
 * заставляет воспроизводить вручную, а это и есть то, на что уходил день.
 */
/** Пометка «нечем мерить» в тексте ответа: вызывающий отличит её от провала. */
export const НЕЧЕМ = 'НЕЧЕМ МЕРИТЬ';

export function unmet(expect: Expectation, d: Diff, after?: Snapshot): string | null {
  if (expect.nothing) {
    // Дрейф фокуса не считается. На живом рабочем столе окно впереди меняется
    // само: всплыло уведомление, человек кликнул, программа доделала запуск.
    // Требовать полной неподвижности значит завалить проверку на пустом месте.
    // Смысл этого ожидания в другом: команда не должна была НИЧЕГО СДЕЛАТЬ —
    // ни запустить, ни закрыть, ни открыть окно.
    const сделано = [
      ...d.opened.map((t) => `открылось ${t}`),
      ...d.closed.map((t) => `закрылось ${t}`),
      ...d.started.map((p) => `запустилось ${p}`),
      ...d.stopped.map((p) => `остановилось ${p}`),
      // Переименование — тоже действие. Смена вкладки в браузере не меняет ни
      // числа окон, ни списка программ, и проверка «ничего не должно было
      // случиться» её не замечала.
      ...d.renamed.map((r) => `стало «${r.now}» вместо «${r.was}»`),
    ];
    return сделано.length === 0 ? null : `ожидали бездействия, а случилось: ${сделано.join(', ')}`;
  }
  if (expect.frontContains !== undefined) {
    // Смотрим на СОСТОЯНИЕ после, а не только на разницу. Команда «переключись
    // на эдж», когда Edge и так впереди, отработала верно и не изменила
    // ничего — требовать изменения значило бы объявить провалом успех.
    // Снимок после обязателен: без него состояние неизвестно.
    //
    // Раньше его отсутствие подставляло пустую строку, и проверка объявляла
    // провал — хотя нужное окно могло уже быть впереди и команда просто
    // ничего не меняла. Это «нечем мерить», и оно помечено словами.
    const front = after?.front ?? d.front?.now;
    if (front === undefined) return `${НЕЧЕМ}: снимка после действия нет`;
    if (!front.toLowerCase().includes(expect.frontContains.toLowerCase())) {
      return `впереди «${front || 'ничего'}», ждали «${expect.frontContains}»`;
    }
  }
  if (expect.started !== undefined && !has(d.started, expect.started)) {
    return `не запустилось «${expect.started}» (${describeDiff(d)})`;
  }
  if (expect.stopped !== undefined && !has(d.stopped, expect.stopped)) {
    return `не закрылось «${expect.stopped}» (${describeDiff(d)})`;
  }
  // Смотрим на переименование, а не на смену фокуса.
  //
  // Переключение между двумя уже открытыми окнами задаёт `front`, но
  // заголовок при этом ни у кого не менялся — а проверка смены вкладки
  // засчитывала это за успех.
  if (expect.titleChanged === true && d.renamed.length === 0) {
    return `заголовок не сменился (${describeDiff(d)})`;
  }
  return null;
}
