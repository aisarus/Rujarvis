/**
 * Компьютер-юз на маке: глаза и руки по чужим окнам.
 *
 * На Windows это делает `cua-driver` — отдельная программа с деревом
 * доступности и кликами по номеру элемента. На маке её нет и ставить нечего:
 * всё нужное уже есть в системе и уже измерено (`darwinDriver.ts`). Здесь эти
 * части собраны в те же шесть действий, чтобы наверху — в описаниях
 * инструментов, которые читает модель, — не менялось ничего.
 *
 * Порядок работы тот же, что на Windows, и по той же причине: оглядеться
 * снимком, действовать поиском по имени, нажимать по номеру. Полное дерево
 * наружу не выставлено намеренно — задача в двадцать шагов стоит по нему
 * вдесятеро дороже.
 *
 * Перед каждым действием окно выводится вперёд. Это не вежливость: у
 * неактивного окна дерево и отрисовка схлопываются, и снимок выходит пустым
 * или устаревшим. На Windows это записано у `cua.look` ровно теми же словами.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

// Пауза перед вторым вопросом о дереве. Chromium строит его не мгновенно:
// на macos-latest между просьбой и готовым деревом проходит заметное время.
const ПАУЗА_ДЕРЕВА_МС = 700;
const новаяПопытка = (): Promise<void> =>
  new Promise((готово) => {
    const таймер = setTimeout(готово, ПАУЗА_ДЕРЕВА_МС);
    таймер.unref?.();
  });

import { chooseElement, type UiElement } from '../control/elements';

import { DarwinDriver } from './darwinDriver';
import type { CuaElement, CuaWindow } from './cuaProtocol';
import type { ScreenBounds } from './driver';

const запустить = promisify(execFile);

/** Дерево схлопывается, когда окно не отрисовано. Меньше этого — не окно. */
const ДЕРЕВО_ЖИВО = 8;

/**
 * Самая длинная сторона снимка окна.
 *
 * Снимок — главная статья расхода: окно 1199×674 стоит около 1078 токенов
 * (замер 20.09.2026 на Windows). На маке `screencapture` отдаёт область как
 * есть, а на Retina — вдвое крупнее координат, поэтому лишнее ужимается
 * `sips`. Предел тот же, что просит cua-driver своим `max_dimension`.
 */
const САМАЯ_ДЛИННАЯ_СТОРОНА = 1200;

/** Размер PNG из его же заголовка: IHDR лежит с 16-го байта. */
function размерPng(файл: string): { width: number; height: number } {
  const данные = readFileSync(файл);
  return { width: данные.readUInt32BE(16), height: данные.readUInt32BE(20) };
}

/**
 * Совпавшие по имени, точное вперёд.
 *
 * То же правило, что у Windows (`matchingElements`): в окне рядом живут
 * «Terminal» и «Run in terminal», и по запросу «Terminal» нужна первая.
 * Номер элемента — его место в дереве окна, и считается он по ВСЕМУ дереву,
 * а не по находкам: по этому же номеру потом нажимают.
 */
export function matchingElements(elements: readonly UiElement[], wanted: string): CuaElement[] {
  const нужно = wanted.trim().toLowerCase();
  if (!нужно) return [];

  const пронумерованные = elements.map((элемент, место) => ({ index: место + 1, элемент }));
  const подпись = (элемент: UiElement): string => (элемент.name || элемент.id).toLowerCase();

  const попали = пронумерованные.filter((строка) => подпись(строка.элемент).includes(нужно));
  const точные = попали.filter((строка) => подпись(строка.элемент) === нужно);
  const порядок = [...точные, ...попали.filter((строка) => !точные.includes(строка))];

  if (порядок.length > 0) {
    return порядок.map((строка) => ({
      index: строка.index,
      role: строка.элемент.type,
      name: строка.элемент.name || строка.элемент.id,
    }));
  }

  // Дословно не нашлось — спрашиваем того, кто знает синонимы и языки
  // интерфейса: «закрыть» и `close`, «сохранить» и `save`. Это тот же выбор,
  // которым работают голосовые команды, и второго такого словаря заводить
  // незачем.
  const похожий = chooseElement(wanted, elements);
  if (!похожий) return [];
  const место = elements.indexOf(похожий);
  return место < 0
    ? []
    : [{ index: место + 1, role: похожий.type, name: похожий.name || похожий.id }];
}

export class DarwinWindowTools {
  private readonly driver = new DarwinDriver();

  /**
   * Какой заголовок был у окна под этим номером.
   *
   * System Events нумерует окна программы по порядку, а порядок меняется от
   * того, что окно подняли, — и поднимает его каждое действие отсюда. Модель,
   * взявшая номер из `window_list`, через шаг попадала бы в чужое окно той же
   * программы. Поэтому номер, однажды показанный наружу, привязывается к
   * заголовку: при следующем обращении ищем сперва по нему, а порядковый
   * номер остаётся запасным ходом.
   */
  private readonly заголовки = new Map<string, string>();

  /** Что нашли в окне в прошлый раз: по этим номерам потом и нажимают. */
  private readonly деревья = new Map<string, UiElement[]>();

  private ключ(pid: number, windowId: number): string {
    return `${pid}:${windowId}`;
  }

  async windows(): Promise<CuaWindow[]> {
    const окна = await this.driver.windows();
    return окна.map((окно) => {
      this.заголовки.set(this.ключ(окно.pid, окно.index), окно.title);
      return { app: окно.app, pid: окно.pid, title: окно.title, windowId: окно.index };
    });
  }

  /**
   * Найти окно заново и вывести его вперёд.
   *
   * Возвращает рамку уже ПОСЛЕ подъёма: свёрнутое окно разворачивается, и до
   * подъёма его положение и размер — нули.
   */
  private async поднять(pid: number, windowId: number): Promise<ScreenBounds & { title: string }> {
    const заголовок = this.заголовки.get(this.ключ(pid, windowId));
    const было = await this.driver.windows();
    const свои = было.filter((окно) => окно.pid === pid);
    const цель =
      (заголовок ? свои.find((окно) => окно.title === заголовок) : undefined) ??
      свои.find((окно) => окно.index === windowId);

    if (!цель) {
      const рядом = свои.map((окно) => `${окно.index}: «${окно.title}»`).join(', ');
      throw new Error(
        `Окна ${windowId} у программы ${pid} нет.` +
          (рядом ? ` У неё есть: ${рядом}.` : ' У неё вообще нет окон.') +
          ' Возьми номер из window_list.',
      );
    }

    await this.driver.raise(цель.pid, цель.index, цель.title || цель.app, цель.title);

    const стало = (await this.driver.windows()).find(
      (окно) => окно.pid === pid && окно.title === цель.title,
    );
    const рамка = стало ?? цель;
    return { x: рамка.x, y: рамка.y, width: рамка.width, height: рамка.height, title: рамка.title };
  }

  /**
   * Снять окно в файл.
   *
   * Снимается область экрана, а не окно само по себе: `screencapture -R` умеет
   * только область. Поэтому окно и выводится вперёд — иначе в кадр попало бы
   * то, что лежит сверху.
   */
  async look(
    pid: number,
    windowId: number,
    file: string,
  ): Promise<{ width: number; height: number; path: string }> {
    const рамка = await this.поднять(pid, windowId);
    if (рамка.width <= 0 || рамка.height <= 0) {
      throw new Error(`Окно «${рамка.title}» без размера — снимать нечего.`);
    }

    await this.driver.screenshot(file, рамка);

    let размер = размерPng(file);
    if (Math.max(размер.width, размер.height) > САМАЯ_ДЛИННАЯ_СТОРОНА) {
      await запустить('sips', ['-Z', String(САМАЯ_ДЛИННАЯ_СТОРОНА), file], { timeout: 20_000 });
      размер = размерPng(file);
    }
    return { width: размер.width, height: размер.height, path: file };
  }

  /** Дерево окна, поднятого вперёд, с номерами по местам в нём. */
  private async дерево(pid: number, windowId: number): Promise<UiElement[]> {
    await this.поднять(pid, windowId);
    let { elements } = await this.driver.elements();

    // Пусто — это ещё не «нечего нажимать».
    //
    // Chromium (Electron, Chrome, Edge, VS Code, Slack) строит дерево
    // доступности только по просьбе вспомогательной программы. Пока не
    // попросили, внутри окна не видно НИЧЕГО: замер на macos-latest 25.09.2026
    // дал ноль элементов при живом окне. Просим и спрашиваем заново — строится
    // дерево не мгновенно, поэтому с паузой.
    if (elements.length < ДЕРЕВО_ЖИВО) {
      await this.driver.askForAccessibility(pid);
      await новаяПопытка();
      ({ elements } = await this.driver.elements());
    }

    if (elements.length < ДЕРЕВО_ЖИВО) {
      throw new Error(
        `Окно отдало всего ${elements.length} элементов — похоже, оно не отрисовано. ` +
          'Сделай снимок окна и повтори.',
      );
    }
    this.деревья.set(this.ключ(pid, windowId), elements);
    return elements;
  }

  async find(pid: number, windowId: number, wanted: string): Promise<CuaElement[]> {
    return matchingElements(await this.дерево(pid, windowId), wanted);
  }

  /**
   * Достать элемент по номеру.
   *
   * Если дерева ещё нет — читаем заново: модель могла взять номер из прошлого
   * прогона, и ответить «сделай window_find» дешевле, чем нажать наугад.
   */
  private async элемент(pid: number, windowId: number, index: number): Promise<UiElement> {
    const было = this.деревья.get(this.ключ(pid, windowId)) ?? (await this.дерево(pid, windowId));
    const найден = было[index - 1];
    if (!найден) {
      throw new Error(
        `Элемента [${index}] в окне нет — в нём ${было.length} элементов. Сделай window_find заново.`,
      );
    }
    return найден;
  }

  async press(pid: number, windowId: number, index: number): Promise<string> {
    const элемент = await this.подтвердить(pid, windowId, index);
    await this.driver.click({ x: элемент.x, y: элемент.y });
    return `нажал «${элемент.name || элемент.id}» в (${элемент.x}, ${элемент.y})`;
  }

  /**
   * Поднять окно и УБЕДИТЬСЯ, что под этим номером тот же элемент.
   *
   * Дерево берётся из памяти от прошлого `window_find`, а подъём окна может
   * его развернуть, сдвинуть или прокрутить: клик уходил по старым
   * координатам в совсем другое место, а инструмент отвечал «Нажал элемент
   * [N]». Описание обещает обратное — «номер указывает на сам элемент».
   */
  private async подтвердить(pid: number, windowId: number, index: number): Promise<UiElement> {
    const прежний = await this.элемент(pid, windowId, index);
    await this.поднять(pid, windowId);

    // После подъёма читаем дерево ЗАНОВО и сверяем, кто теперь под номером.
    this.деревья.delete(this.ключ(pid, windowId));
    const сейчас = await this.дерево(pid, windowId);
    const теперь = сейчас[index - 1];

    if (!теперь || (теперь.name || теперь.id) !== (прежний.name || прежний.id)) {
      throw new Error(
        `После подъёма окна под номером [${index}] уже другой элемент` +
          (теперь ? `: «${теперь.name || теперь.id}» вместо «${прежний.name || прежний.id}»` : '') +
          '. Сделай window_find заново.',
      );
    }
    return теперь;
  }

  /**
   * Напечатать в поле.
   *
   * Сперва клик по полю: на маке печать уходит туда, где стоит курсор ввода, а
   * не в элемент — адресовать элемент напрямую нечем. Сам текст едет через
   * буфер обмена (см. `typeScript`): `keystroke` печатает кириллицу как
   * «aaaaaa», и это замерено.
   */
  async writeInto(pid: number, windowId: number, index: number, text: string): Promise<string> {
    const элемент = await this.подтвердить(pid, windowId, index);
    await this.driver.click({ x: элемент.x, y: элемент.y });
    await this.driver.type(text);
    return `напечатал в «${элемент.name || элемент.id}»`;
  }

  async key(pid: number, windowId: number, key: string): Promise<string> {
    await this.поднять(pid, windowId);
    await this.driver.key(key);
    return `нажал ${key}`;
  }

  /** Гасить нечего: ни демона, ни чужого процесса здесь нет. */
  dispose(): void {
    this.driver.dispose();
  }
}
