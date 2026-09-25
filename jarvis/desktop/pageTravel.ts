/**
 * Съёмка и ощупывание страницы: где приборы встречаются с браузером.
 *
 * Приборы (`pageRider`, `wheelTravel`, `measure/depth`, `measure/frameInk`)
 * нарочно ничего не знают ни про Playwright, ни про пиксели: одни отдают текст
 * скрипта, другие принимают рычаги колбэками. Поэтому их можно проверить
 * тестом за миллисекунду.
 *
 * Здесь — единственное место, где они соединяются с настоящей страницей. Кода
 * тут мало и он скучный, и это правильно: всё, что можно было решить правилом,
 * решено в правилах.
 *
 * ## Замер на живом сайте
 *
 * `bruno-simon.com`, тот самый, который человек назвал образцом:
 *
 *     запас по числам:  вбок 1580, вниз 0
 *     проезд вбок:      2 кадра
 *     чернил в кадрах:  0% и 12%
 *
 * Первый кадр — это ровно то, что отдал бы обычный снимок: пустая заставка,
 * ноль процентов. Судить по нему о работе нельзя, и отказ «тут ничего нет» был
 * бы верен по замеру и ложен по сути. Содержимое начинается со второго кадра,
 * и добраться до него можно только проездом по правильной оси.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as browser from './browser';
import { findRider, longerAxis, rideTo, type Axis } from './pageRider';
import { mayClick } from './pageClick';
import { wheelTravel } from './wheelTravel';
import { frameInk, sameFrame } from '../measure/frameInk';
import { pageDepth, probePlan, type Probe } from '../measure/depth';

/** Сколько кадров максимум снимаем обычным проездом. */
const MANY_SCREENS = 8;

function shotsDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'jarvis-shots-'));
}

export interface Ride {
  axis: Axis | null;
  /** Чем ехали: скриптом или настоящим колесом. */
  how: 'скриптом' | 'колесом' | 'один экран';
  files: string[];
  /** Дошли ли до конца — или упёрлись в потолок кадров. */
  arrived: boolean;
  fact: string;
}

/**
 * Снять страницу целиком по той оси, где у неё запас.
 *
 * Три дороги, и порядок не случаен:
 *
 *   1. Обычный проезд по найденному ездоку — дёшево и точно.
 *   2. Настоящее колесо — если ездока нет вовсе. Так устроены горизонтальные
 *      новеллы: скриптом они неподвижны.
 *   3. Один экран — если и колесо ничего не изменило. Это честный ответ, а не
 *      неудача: у страницы в один экран так и есть один экран.
 */
export async function ridePage(): Promise<Ride> {
  const вбок = (await browser.evaluate(findRider('вбок'))) as { полный: number; видимый: number };
  const вниз = (await browser.evaluate(findRider('вниз'))) as { полный: number; видимый: number };
  const sideways = Number(вбок?.полный ?? 0);
  const down = Number(вниз?.полный ?? 0);
  const axis = longerAxis(sideways, down);
  const dir = shotsDir();
  const files: string[] = [];

  const size = await browser.viewport();
  // Шаг берём от ЕЗДОКА, а не от окна.
  //
  // Едет найденный контейнер, и если он уже окна (600 в окне 1200), шаг в
  // ширину окна пропускал половину содержимого мимо кадров — а «доехали»
  // всё равно отвечало «да».
  const видимый = axis === 'вбок' ? Number(вбок?.видимый ?? 0) : Number(вниз?.видимый ?? 0);
  const окно = axis === 'вбок' ? size.width : size.height;
  const step = видимый > 0 ? Math.min(видимый, окно) : окно;
  const total = axis === 'вбок' ? sideways : down;

  if (axis && total > step) {
    // Дорога первая: ездок найден, едем скриптом.
    const screens = Math.min(MANY_SCREENS, Math.ceil(total / step));
    for (let index = 0; index < screens; index += 1) {
      await browser.evaluate(rideTo(axis, index * step));
      // Странице надо дать дорисоваться: ленивые картинки и переходы.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const file = path.join(dir, `кадр-${index + 1}.png`);
      await browser.screenshot(file);
      files.push(file);
    }
    await browser.evaluate(rideTo(axis, 0));
    return {
      axis,
      how: 'скриптом',
      files,
      arrived: screens * step >= total,
      fact: `проехали ${axis}: ${files.length} кадров из ${Math.round(total)} пикселей`,
    };
  }

  // Дорога вторая: ездока нет — пробуем настоящее колесо.
  //
  // Замер Aegis на такой странице: `scrollLeft = 1500` двигает на 0 пикселей,
  // колесо — на 1800. Спросить «где мы» у неё не у кого, поэтому конец дороги
  // ищется картинкой.
  const travel = await wheelTravel<Buffer>({
    push: async ({ delta, pushes }) => {
      for (let i = 0; i < pushes; i += 1) {
        await browser.wheel(0, delta / pushes);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    },
    shoot: async () => browser.shoot(),
    // Неразобранный снимок — не «тот же кадр». Считать его тем же значило бы
    // объявить, что приехали, и снять заставку вместо работы.
    same: (left, right) => sameFrame(left, right) === true,
    rewind: async () => {
      await browser.wheel(0, -20_000);
    },
  });

  if (travel) {
    travel.shots.forEach((shot, index) => {
      const file = path.join(dir, `кадр-${index + 1}.png`);
      writeFileSync(file, shot);
      files.push(file);
    });
    return {
      axis: axis ?? 'вниз',
      how: 'колесом',
      files,
      arrived: travel.arrived,
      fact: `скриптом страница неподвижна, проехали настоящим колесом: ${files.length} кадров`,
    };
  }

  const only = path.join(dir, 'кадр-1.png');
  await browser.screenshot(only);
  return {
    axis: null,
    how: 'один экран',
    files: [only],
    arrived: true,
    fact: 'страница помещается в один экран: ехать некуда',
  };
}

/**
 * Потрогать страницу и посчитать, сколько разного она показала.
 *
 * Нажимаем только то, что прошло запреты: покупка, вход, регистрация и
 * отправка формы — не наше дело, и «принять все куки» тоже.
 */
export async function probePage(probes = 12): Promise<ReturnType<typeof pageDepth>> {
  const controls = await browser.listControls(8);
  const safe = controls.filter((label) => mayClick(label) === null);
  const plan = probePlan({ handles: safe.length, probes });

  const seen: Buffer[] = [];
  const done: Probe[] = [];
  let handle = 0;

  const first = await browser.shoot();
  if (first) seen.push(first);

  for (const step of plan) {
    try {
      if (step.what === 'прокрутить') await browser.wheel(0, 700);
      else if (step.what === 'нажать') {
        const label = safe[handle % Math.max(1, safe.length)];
        handle += 1;
        if (label) await browser.clickText(label);
      } else if (step.what === 'клавиша') await browser.pressKey('ArrowDown');
      else {
        // «Подвигать мышью»: наведение будит то, что реагирует на курсор.
        const size = await browser.viewport();
        await browser.hover(
          Math.round(size.width * (0.2 + 0.1 * (done.length % 6))),
          Math.round(size.height * 0.5),
        );
      }
    } catch {
      // Проба, которая не выполнилась, — это проба без ответа, а не поломка
      // всего замера.
      done.push({ what: step.what, changed: false, fresh: false });
      continue;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    const shot = await browser.shoot();
    if (!shot) {
      done.push({ what: step.what, changed: false, fresh: false });
      continue;
    }

    const last = seen[seen.length - 1];
    const changed = last ? sameFrame(last, shot) === false : true;
    const fresh = changed && seen.every((old) => sameFrame(old, shot) !== true);
    if (fresh) seen.push(shot);
    done.push({ what: step.what, changed, fresh });
  }

  return pageDepth(done, seen.length);
}

/** Сколько в кадре нарисовано — для проверки, что окно не пустое. */
export async function inkOfPage(): Promise<number | null> {
  const shot = await browser.shoot();
  const ink = shot ? frameInk(shot) : null;
  return ink ? ink.share : null;
}
