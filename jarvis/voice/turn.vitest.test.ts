import { describe, expect, it } from 'vitest';

import { UtteranceBuffer } from './turn';

function buffer(gapMs = 2_500) {
  let clock = 1_000_000;
  const instance = new UtteranceBuffer({ gapMs, now: () => clock });
  return {
    instance,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('UtteranceBuffer', () => {
  it('не отдаёт мысль, пока человек может её продолжить', () => {
    const { instance } = buffer();
    instance.push('у тебя в картинках лежит красная сфера');

    expect(instance.isComplete()).toBe(false);
  });

  it('отдаёт, когда человек замолчал', () => {
    // Фраза БЕЗ глагола просьбы — иначе проверялась не пауза.
    //
    // «открой блендер» содержит просьбу, и мысль отдавалась сразу после
    // `push`: `advance` ни на что не влиял, и сломанное сравнение с паузой
    // оставляло проверку зелёной.
    const { instance, advance } = buffer();
    instance.push('у тебя в картинках лежит красная сфера');

    // До конца паузы мысль ещё не готова.
    advance(1_000);
    expect(instance.isComplete()).toBe(false);

    advance(1_600);
    expect(instance.isComplete()).toBe(true);
    expect(instance.take()).toBe('у тебя в картинках лежит красная сфера');
  });

  it('склеивает продолжение в одну мысль', () => {
    // Ровно тот случай из лога: две фразы стали двумя задачами, и вторая не
    // знала, что такое «её».
    const { instance, advance } = buffer();
    instance.push('у тебя в картинках лежит красная сфера');
    advance(1_000);
    instance.push('сделай в блендере её 3d модель');
    advance(2_600);

    expect(instance.take()).toBe(
      'у тебя в картинках лежит красная сфера. Сделай в блендере её 3d модель',
    );
  });

  it('продолжение отодвигает срок, а не сокращает его', () => {
    const { instance, advance } = buffer();
    instance.push('первое');
    advance(2_000);
    instance.push('второе');
    advance(1_000);

    // С первой фразы прошло три секунды, но со второй — только одна.
    expect(instance.isComplete()).toBe(false);
  });

  it('склеивает сколько угодно частей', () => {
    const { instance, advance } = buffer();
    for (const part of ['раз', 'два', 'три']) {
      instance.push(part);
      advance(500);
    }
    advance(2_600);

    expect(instance.take()).toBe('раз. Два. Три');
  });

  it('после выдачи начинает с чистого листа', () => {
    const { instance, advance } = buffer();
    instance.push('открой блендер');
    advance(2_600);
    instance.take();

    expect(instance.pending).toBe('');
    expect(instance.isComplete()).toBe(false);
  });

  it('не выдумывает мысль из ничего', () => {
    const { instance, advance } = buffer();
    advance(10_000);

    expect(instance.isComplete()).toBe(false);
    expect(instance.take()).toBe('');
  });

  it('не склеивает пустое', () => {
    const { instance, advance } = buffer();
    instance.push('открой блендер');
    instance.push('   ');
    advance(2_600);

    expect(instance.take()).toBe('открой блендер');
  });

  it('не повторяет точку, если человек её уже поставил', () => {
    const { instance, advance } = buffer();
    instance.push('сфера лежит в картинках.');
    advance(500);
    instance.push('сделай модель');
    advance(2_600);

    expect(instance.take()).toBe('сфера лежит в картинках. Сделай модель');
  });

  it('сохраняет вопросительный знак', () => {
    const { instance, advance } = buffer();
    instance.push('что там лежит?');
    advance(500);
    instance.push('покажи');
    advance(2_600);

    expect(instance.take()).toBe('что там лежит? Покажи');
  });

  it('говорит, сколько ещё ждать', () => {
    // Фраза без просьбы: только такие и ждут продолжения.
    const { instance, advance } = buffer();
    instance.push('там была красная сфера');
    advance(1_000);

    expect(instance.msUntilComplete()).toBe(1_500);
  });
});

describe('просьба не ждёт', () => {
  it('фраза с просьбой отдаётся сразу', () => {
    // Ожидание в две с половиной секунды на каждой команде — это цена,
    // которую человек платит голосом. Готовую просьбу ждать незачем.
    const { instance } = buffer();
    instance.push('создай в блендере красную сферу');

    expect(instance.isComplete()).toBe(true);
    expect(instance.take()).toBe('создай в блендере красную сферу');
  });

  it('фраза без просьбы по-прежнему ждёт продолжения', () => {
    // «У тебя в картинках лежит сфера» — это контекст, а не задача.
    const { instance } = buffer();
    instance.push('у тебя в картинках лежит красная сфера');

    expect(instance.isComplete()).toBe(false);
  });

  it('контекст плюс просьба склеиваются и уходят сразу', () => {
    const { instance, advance } = buffer();
    instance.push('у тебя в картинках лежит красная сфера');
    advance(800);
    instance.push('сделай в блендере её 3d модель');

    expect(instance.isComplete()).toBe(true);

    const whole = instance.take();
    expect(whole).toContain('красная сфера');
    expect(whole).toContain('3d модель');
  });

  it('вопрос тоже не ждёт', () => {
    const { instance } = buffer();
    instance.push('что сейчас на экране');
    expect(instance.isComplete()).toBe(true);
  });
});

describe('UtteranceBuffer и оборванная запись', () => {
  it('не отдаёт мысль, которую запись обрезала на полуслове', () => {
    // Запись закрывается по потолку в тридцать секунд, а не по тишине. Это
    // значит ровно одно: человек ещё говорил. Замер из журнала — фраза
    // «Сделай вместо зеленой сферы мультяшную красивую разноцветную» ушла
    // задачей, а «космическую ракету в стиле Бруно Симон» приехало отдельно.
    const { instance } = buffer();
    instance.push('сделай вместо зелёной сферы мультяшную красивую разноцветную', {
      unfinished: true,
    });

    expect(instance.isComplete()).toBe(false);
  });

  it('отдаёт её целиком, когда человек договорил', () => {
    const { instance } = buffer();
    instance.push('сделай вместо зелёной сферы мультяшную красивую разноцветную', {
      unfinished: true,
    });
    instance.push('космическую ракету в стиле Бруно Симон');

    expect(instance.isComplete()).toBe(true);
    expect(instance.take()).toContain('Бруно Симон');
  });

  it('не теряет оборванную мысль, если продолжения так и не было', () => {
    // Человека могли обрезать на последнем слове. Ждать вечно — потерять
    // сказанное совсем, а это хуже неполной фразы.
    const { instance, advance } = buffer();
    instance.push('сделай вместо зелёной сферы мультяшную красивую', { unfinished: true });
    advance(2_500);

    expect(instance.isComplete()).toBe(true);
  });

  it('обычная запись по-прежнему уходит сразу', () => {
    // Скорость человек называл отдельным требованием: «открой блендер» не
    // должно ждать ничего.
    const { instance } = buffer();
    instance.push('открой блендер');

    expect(instance.isComplete()).toBe(true);
  });
});

describe('длинная мысль: «диктую»', () => {
  it('ждёт пять секунд между кусками, а не две с половиной', () => {
    // Человек назвал это число сам: «максимальный перерыв между словами у
    // слушателя становится 5 секунд».
    const { instance, advance } = buffer();
    instance.listenLong = true;
    instance.push('хочу сайт по своей биографии');

    advance(4_000);
    expect(instance.isComplete()).toBe(false);

    advance(1_100);
    expect(instance.isComplete()).toBe(true);
  });

  it('не отдаёт мысль на глаголе просьбы посреди фразы', () => {
    // Именно это правило рубило длинные фразы пополам: «сделай» встречается в
    // середине мысли не реже, чем в конце. В журнале это выглядело как
    // «Сделай вместо зеленой сферы мультяшную красивую разноцветную» — и
    // отдельно приехавшая «космическую ракету в стиле Бруно Симон».
    const { instance, advance } = buffer();
    instance.listenLong = true;
    instance.push('сделай мне сайт');

    expect(instance.isComplete()).toBe(false);

    advance(5_100);
    expect(instance.isComplete()).toBe(true);
  });

  it('собирает длинную речь в одну мысль', () => {
    const { instance, advance } = buffer();
    instance.listenLong = true;
    instance.push('хочу сайт по своей биографии');
    advance(3_000);
    instance.push('в концепции Бруно Симон');
    advance(4_000);
    instance.push('и чтобы там была физика');
    advance(5_100);

    expect(instance.isComplete()).toBe(true);
    const whole = instance.take();
    expect(whole).toContain('биографии');
    expect(whole).toContain('Бруно Симон');
    expect(whole).toContain('физика');
  });

  it('кончается вместе с мыслью, а не длится весь вечер', () => {
    // «Диктую» сказано про одно сообщение.
    const { instance, advance } = buffer();
    instance.listenLong = true;
    instance.push('длинная мысль');
    advance(5_100);
    instance.take();

    expect(instance.listenLong).toBe(false);

    instance.push('открой блендер');
    expect(instance.isComplete()).toBe(true);
  });

  it('обычный режим не трогает', () => {
    const { instance } = buffer();
    instance.push('открой блендер');

    expect(instance.isComplete()).toBe(true);
  });
});
