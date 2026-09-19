/**
 * Проезд страницы НАСТОЯЩИМ колесом, когда скриптом её не сдвинуть.
 *
 * Перенесено из Aegis (`operator/src/wheel-travel.js`) вместе с замером, из
 * которого прибор вырос.
 *
 * ## Замер на живой странице с перехватом колеса
 *
 *     запас по числам:            doc 0 | body 3946 | лента 3946
 *     после el.scrollLeft = 1500: уехало    0 px
 *     после настоящего колеса:    уехало 1800 px
 *
 * Страница, которая перехватывает колесо и двигает содержимое трансформом, для
 * скрипта **неподвижна**: нативного скроллера у неё нет, ставить `scrollLeft`
 * некуда, и `documentElement` честно отвечает «запаса ноль». Так устроен весь
 * жанр горизонтальных новелл — и так прогон Aegis пять раз подряд снял у чужой
 * работы заставку и пять раз получил отказ планки. Отказ был верен, съёмка —
 * нет.
 *
 * Это ровно тот случай, ради которого человек назвал целью сайт в концепции
 * Бруно Симон.
 *
 * ## Чем здесь меряется дорога
 *
 * Ни `scrollLeft`, ни `scrollY` у такой страницы не значат ничего, спросить
 * «где мы» не у кого. Остаётся единственный честный прибор — **картинка**:
 * толкнули, сняли, сравнили с прошлым кадром. Картинка изменилась — едем
 * дальше; перестала меняться — приехали.
 *
 * Поэтому здесь нет ни одного пикселя и ни одного браузера: толчок, съёмка и
 * сравнение приходят рычагами, а правило проверяется на поддельных кадрах.
 */

/**
 * Сколько экранов проезжаем.
 *
 * Восьми хватает на честную страницу, а бесконечную ленту прибор держать не
 * должен.
 */
const MANY_SCREENS = 8;

/**
 * Сколько толчков на один экран.
 *
 * Одним толчком страницы обычно едут на треть-половину экрана, и слать один
 * большой толчок нельзя: страницы с инерцией отвечают на него рывком и
 * промахом.
 */
const PUSHES_PER_SCREEN = 4;

export interface WheelTravelTools<Shot> {
  /** Послать настоящие события колеса. */
  push(options: { delta: number; pushes: number }): Promise<void>;
  /** Кадр или `null`, если снять не вышло. */
  shoot(): Promise<Shot | null>;
  /** Совпадают ли кадры. Сравнение растров — забота вызывающего. */
  same(left: Shot, right: Shot): boolean;
  /** Отогнать страницу обратно в начало. Необязательно. */
  rewind?(): Promise<void>;
  delta?: number;
  manyScreens?: number;
  pushesPerScreen?: number;
}

export interface WheelTravel<Shot> {
  shots: Shot[];
  /**
   * Чем кончилась дорога.
   *
   * `true` — картинка перестала меняться, приехали. `false` — упёрлись в
   * потолок кадров, и конца страницы мы не видели. Это разные новости, и
   * молчать о разнице нельзя.
   */
  arrived: boolean;
}

export async function wheelTravel<Shot>(
  tools: WheelTravelTools<Shot>,
): Promise<WheelTravel<Shot> | null> {
  const delta = tools.delta ?? 900;
  const manyScreens = tools.manyScreens ?? MANY_SCREENS;
  const pushesPerScreen = tools.pushesPerScreen ?? PUSHES_PER_SCREEN;

  const first = await tools.shoot();
  if (!first) return null;

  const shots: Shot[] = [first];
  let previous = first;
  let arrived = false;

  while (shots.length < manyScreens) {
    await tools.push({ delta, pushes: pushesPerScreen });
    const next = await tools.shoot();
    if (!next) {
      arrived = true;
      break;
    }
    // Картинка не изменилась — значит приехали.
    //
    // И это единственный честный признак конца: у такой страницы нет ни
    // высоты, ни положения, которые можно было бы спросить.
    if (tools.same(next, previous)) {
      arrived = true;
      break;
    }
    shots.push(next);
    previous = next;
  }

  // Отгонять назад надо только то, что уехало.
  //
  // Возврат — это двадцать толчков с паузами, почти три секунды. В Aegis он
  // поначалу стоял безусловно, и одноэкранная страница — а таких большинство —
  // платила эти секунды на КАЖДОЙ съёмке за откат, которого не было. Если
  // картинка от толчка не изменилась, страница не двигалась: возвращать нечего.
  if (shots.length < 2) return null;

  if (typeof tools.rewind === 'function') {
    try {
      await tools.rewind();
    } catch {
      // Снимки уже собраны — неудавшийся откат их не отменяет.
    }
  }

  return { shots, arrived };
}

export { MANY_SCREENS, PUSHES_PER_SCREEN };
