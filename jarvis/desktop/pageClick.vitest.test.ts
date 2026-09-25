import { describe, expect, it } from 'vitest';

import { findByText, isConsentRefusal, mayClick } from './pageClick';

describe('mayClick', () => {
  it.each([
    'Buy now',
    'Оформить заказ',
    'Sign in with Google',
    'Зарегистрироваться',
    'Add to cart',
    'Удалить аккаунт',
    'Submit',
  ])('не жмёт «%s»', (label) => {
    // Красные линии человека: трата денег, учётные записи, необратимое. Наружу
    // от его имени действует он, а не помощник.
    expect(mayClick(label)).not.toBeNull();
  });

  it('объясняет отказ и говорит, что делать вместо', () => {
    // Отказ без выхода — тупик, и следующая попытка выйдет такой же.
    const why = mayClick('Buy now') ?? '';

    expect(why).toContain('«buy»');
    expect(why).toContain('enter');
  });

  it('не соглашается на слежку за человека', () => {
    const why = mayClick('Accept all cookies') ?? '';

    expect(why).toContain('отказ');
    expect(why).toContain('only necessary');
  });

  it.each(['Enter', 'CLICK TO START', 'Play reel', 'Смотреть работу', 'Далее'])(
    'пропускает вход в работу: «%s»',
    (label) => {
      expect(mayClick(label)).toBeNull();
    },
  );

  it('требует сказать, по чему жать', () => {
    expect(mayClick('')).toContain('назови');
    expect(mayClick(null)).toContain('назови');
  });
});

describe('isConsentRefusal', () => {
  it('узнаёт отказ от слежки — его жать нужно', () => {
    expect(isConsentRefusal('Reject all')).toBe(true);
    expect(isConsentRefusal('Только необходимые')).toBe(true);
  });

  it('не принимает за отказ согласие', () => {
    expect(isConsentRefusal('Accept all')).toBe(false);
  });
});

describe('findByText', () => {
  it('ищет только видимое', () => {
    // Скрытый элемент нажать нельзя, а промах по нему выглядит как «нажал и
    // ничего не произошло» — худший вид отказа.
    const script = findByText('enter');

    expect(script).toContain('visibility');
    expect(script).toContain('display');
    expect(script).toContain('opacity');
  });

  it('берёт самый мелкий подходящий, а не самый большой', () => {
    // Кнопка «ENTER» лежит внутри обёртки с тем же текстом, и нажимать надо
    // кнопку, а не половину страницы.
    expect(findByText('enter')).toContain('a[0] - b[0]');
  });

  it('вставляет искомое безопасно', () => {
    // Текст приходит от модели, и кавычка в нём не должна рвать скрипт.
    const script = findByText(`это "кавычка" и 'вторая'`);

    expect(script).toContain(JSON.stringify(`это "кавычка" и 'вторая'`.toLowerCase()));
  });

  it('возвращает середину найденного', () => {
    expect(findByText('enter')).toContain('к.left + к.width / 2');
  });
});
