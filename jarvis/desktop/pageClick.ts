/**
 * Нажать на чужой странице: открыть дверь, а не ходить по сайту.
 *
 * Перенесено из Aegis (`operator/src/page-click.js`).
 *
 * ## Зачем
 *
 * Половина сильных работ в вебе спрятана за входом: PLAY REEL, CLICK TO START,
 * ENTER. Снимок такой страницы — это дверь, а не работа. Отдельная беда: у
 * Бруно Симон «CLICK TO START» **нарисовано на холсте**, в разметке этих слов
 * нет вовсе, и найти дверь по тексту там нельзя в принципе.
 *
 * ## Два пути, и порядок важен
 *
 *   - **по разметке** — нашли элемент по видимому тексту или роли, взяли
 *     середину. Дёшево, точно, повторяемо. Так открывается почти всё.
 *   - **по пикселям** — агент смотрит на снимок и называет координаты. Дороже и
 *     промахивается, но только так берутся двери, нарисованные на холсте.
 *
 * Сперва разметка, пиксели запасным путём. Наоборот — дорого и глупо.
 *
 * ## Чего этот рычаг не делает
 *
 * Не покупает, не входит в учётные записи, не заводит их и не отправляет форм.
 * Это не осторожность, а устройство: наружу от имени человека действует
 * человек, а не помощник. Ровно те красные линии, которые человек назвал сам:
 * трата денег, общение с другими людьми, необратимые действия.
 *
 * Список ниже — не полный перечень зла, а перечень слов, при виде которых
 * рычаг обязан остановиться и сказать почему.
 */

const DANGEROUS = [
  'buy',
  'purchase',
  'checkout',
  'pay',
  'order now',
  'subscribe',
  'donate',
  'sign in',
  'sign up',
  'log in',
  'login',
  'register',
  'create account',
  'delete',
  'submit',
  'send',
  'купить',
  'оплатить',
  'подписаться',
  'войти',
  'зарегистрироваться',
  'удалить',
  'отправить',
  'создать аккаунт',
  'создать учётную запись',
  'оформить заказ',
  'в корзину',
  'add to cart',
];

/**
 * Согласие на слежку.
 *
 * Выбираем отказ, а не «принять всё». Человека об этом никто не спрашивал, и
 * соглашаться за него помощник не вправе.
 */
const CONSENT_YES = ['accept all', 'allow all', 'принять все', 'принять всё', 'разрешить все'];

const CONSENT_NO = [
  'reject all',
  'decline',
  'only necessary',
  'necessary only',
  'отклонить',
  'только необходимые',
  'отказаться',
];

/**
 * Можно ли жать по такому тексту.
 *
 * Возвращает `null` (можно) или объяснение отказа. Отказ обязан говорить, что
 * делать вместо: отказ без выхода — тупик, и следующая попытка выйдет такой же.
 */
export function mayClick(what: unknown): string | null {
  const text = String(what ?? '').trim().toLowerCase();
  if (!text) return 'нечего искать: назови, что на двери написано, или дай координаты';

  if (CONSENT_YES.some((word) => text.includes(word))) {
    return (
      'на слежку за человеком помощник не соглашается. Жми отказ: «reject all», ' +
      '«only necessary», «отклонить» — работа откроется и так'
    );
  }

  const dangerous = DANGEROUS.find((word) => text.includes(word));
  if (dangerous) {
    return (
      `«${dangerous}» — это действие наружу от имени человека: покупка, учётная запись ` +
      'или отправка. Такое он делает сам. Ищи вход в работу: «enter», «start», ' +
      '«play», «смотреть»'
    );
  }

  return null;
}

/** Похоже ли это на отказ от слежки — такое жать можно и нужно. */
export function isConsentRefusal(what: unknown): boolean {
  const text = String(what ?? '').toLowerCase();
  return CONSENT_NO.some((word) => text.includes(word));
}

/**
 * Скрипт поиска двери по видимому тексту.
 *
 * Возвращает `{ x, y, what, tag }` середины найденного или `null`. Ищем только
 * то, что ВИДНО: скрытый элемент нажать нельзя, а промах по нему выглядит как
 * «нажал и ничего не произошло».
 */
export function findByText(what: string): string {
  const wanted = JSON.stringify(String(what ?? '').toLowerCase());

  return `(() => {
    const надо = ${wanted};
    const годные = [];
    for (const el of document.querySelectorAll('a,button,[role="button"],[onclick],input[type="button"],input[type="submit"],div,span,li')) {
      const свой = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
      if (!свой || свой.length > 120) continue;
      if (!свой.toLowerCase().includes(надо)) continue;
      const к = el.getBoundingClientRect();
      if (к.width < 4 || к.height < 4) continue;
      if (к.bottom < 0 || к.right < 0 || к.top > innerHeight || к.left > innerWidth) continue;
      const в = getComputedStyle(el);
      if (в.visibility === 'hidden' || в.display === 'none' || Number(в.opacity) === 0) continue;
      годные.push([к.width * к.height, { x: Math.round(к.left + к.width / 2), y: Math.round(к.top + к.height / 2), what: свой.slice(0, 60), tag: el.tagName }]);
    }
    if (!годные.length) return null;
    // Самый МЕЛКИЙ подходящий: кнопка «ENTER» лежит внутри обёртки, у которой
    // тот же текст, и нажимать надо кнопку, а не половину страницы.
    годные.sort((a, b) => a[0] - b[0]);
    return годные[0][1];
  })()`;
}

export { DANGEROUS, CONSENT_NO, CONSENT_YES };
