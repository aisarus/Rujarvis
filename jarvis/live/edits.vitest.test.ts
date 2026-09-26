import { describe, expect, it } from 'vitest';

import { parseLiveEdit, нечегоПравить } from './edits';

describe('parseLiveEdit', () => {
  it('красит активный объект', () => {
    const edit = parseLiveEdit('сделай её синей');

    expect(edit?.code).toContain('diffuse_color');
    expect(edit?.code).toContain('0.1, 0.2, 0.9');
    expect(edit?.said).toContain('синим');
  });

  it.each([
    ['сделай её красной', '0.9, 0.1, 0.1'],
    ['сделай его зелёным', '0.1, 0.8, 0.2'],
    ['покрась в чёрный', '0.05, 0.05, 0.05'],
  ])('«%s» — это цвет %s', (phrase, rgb) => {
    expect(parseLiveEdit(phrase)?.code).toContain(rgb);
  });

  it('не принимает название цвета за имя объекта', () => {
    // «Сделай её синей» искало в сцене объект по имени «синей» и не находило
    // ничего — человек видел, что ничего не покрасилось. Поймано на
    // самопроверке плана, до единой написанной строчки.
    const edit = parseLiveEdit('сделай её синей');

    expect(edit?.code).toContain('bpy.context.active_object');
    expect(edit?.code).not.toContain('"син"');
  });

  it('двигает вверх на заданное', () => {
    expect(parseLiveEdit('подними на три')?.code).toContain('location.z += 3');
  });

  it('не принимает число за имя объекта', () => {
    expect(parseLiveEdit('подними на тридцать')?.code).toContain('bpy.context.active_object');
  });

  it('поворачивает в градусах', () => {
    expect(parseLiveEdit('поверни на тридцать')?.code).toContain('radians(30)');
  });

  it('меняет размер', () => {
    expect(parseLiveEdit('увеличь в два раза')?.code).toContain('scale');
    expect(parseLiveEdit('уменьши в два раза')?.code).toContain('1/2');
  });

  it('умеет удалить, спрятать и показать', () => {
    expect(parseLiveEdit('удали это')?.code).toContain('bpy.data.objects.remove');
    expect(parseLiveEdit('спрячь это')?.code).toContain('hide_viewport = True');
    expect(parseLiveEdit('покажи это')?.code).toContain('hide_viewport = False');
  });

  it('играет и останавливает анимацию', () => {
    expect(parseLiveEdit('играй анимацию')?.code).toContain('screen.animation_play');
    expect(parseLiveEdit('останови анимацию')?.code).toContain('screen.animation_cancel');
  });

  it('находит объект по имени', () => {
    expect(parseLiveEdit('сделай ракету синей')?.code).toContain('ракет');
  });

  it('молчит на всём, что не в таблице', () => {
    // Не совпало — уходит агенту, как раньше. Человек не видит границы.
    for (const phrase of [
      'сделай ракету красивее',
      'добавь пламя из сопел',
      'открой блендер',
      'сделай сайт по моей биографии',
      'что ты делаешь',
    ]) {
      expect(parseLiveEdit(phrase)).toBeNull();
    }
  });

  it('не перехватывает чужие «покажи»', () => {
    // «Покажи лог», «покажи план», «покажи папку» разбирают другие слои.
    for (const phrase of ['покажи лог', 'покажи план', 'покажи папку', 'покажи окно']) {
      expect(parseLiveEdit(phrase)).toBeNull();
    }
  });

  it('прощает заполнители посреди фразы', () => {
    expect(parseLiveEdit('ну сделай её сейчас синей')).not.toBeNull();
  });

  it('переживает пустое', () => {
    expect(parseLiveEdit('')).toBeNull();
    expect(parseLiveEdit('   ')).toBeNull();
  });

  it('складывает десятки с единицами', () => {
    // Раньше бралось первое число: «сорок пять» поворачивало на 40.
    expect(parseLiveEdit('поверни на сорок пять')?.code).toContain('radians(45)');
    expect(parseLiveEdit('rotate it forty five')?.code).toContain('radians(45)');
  });

  it('названный и не найденный объект — отказ, а не выделенный', () => {
    // «Удали файл» при живом блендере стирало бы то, что выделено.
    const code = parseLiveEdit('сделай ракету синей')?.code ?? '';
    expect(code).toContain(', None)');
    expect(code).not.toContain('), bpy.context.active_object)');
  });

  it('не принимает за правку сцены просьбы про файлы, окна и страницы', () => {
    for (const phrase of ['удали файл', 'покажи лог', 'delete the file', 'show the log', 'hide the window']) {
      expect(parseLiveEdit(phrase), phrase).toBeNull();
    }
  });

  it('не путает «план» с «планетой»', () => {
    expect(parseLiveEdit('сделай планету синей')?.code).toContain('планет');
  });
});

describe('parseLiveEdit in English', () => {
  it.each([
    ['make it blue', '0.1, 0.2, 0.9'],
    ['paint the cube red', '0.9, 0.1, 0.1'],
    ['turn it green', '0.1, 0.8, 0.2'],
  ])('«%s» is colour %s', (phrase, rgb) => {
    expect(parseLiveEdit(phrase)?.code).toContain(rgb);
  });

  it('moves, rotates and scales', () => {
    expect(parseLiveEdit('raise it by three')?.code).toContain('location.z += 3');
    expect(parseLiveEdit('move it left')?.code).toContain('location.x -= 1');
    expect(parseLiveEdit('rotate it thirty')?.code).toContain('radians(30)');
    expect(parseLiveEdit('make it bigger')?.code).toContain('scale');
    expect(parseLiveEdit('make it smaller')?.code).toContain('1/2');
  });

  it('deletes, hides and shows', () => {
    expect(parseLiveEdit('delete it')?.code).toContain('bpy.data.objects.remove');
    expect(parseLiveEdit('hide it')?.code).toContain('hide_viewport = True');
    expect(parseLiveEdit('show it')?.code).toContain('hide_viewport = False');
  });

  it('plays and cancels the animation', () => {
    expect(parseLiveEdit('play animation')?.code).toContain('animation_play');
    expect(parseLiveEdit('cancel the animation')?.code).toContain('animation_cancel');
  });

  it('finds an object by name', () => {
    expect(parseLiveEdit('make the rocket blue')?.code).toContain('"rocket"');
  });

  it('takes the colour word for a colour, not a name', () => {
    expect(parseLiveEdit('make it blue')?.code).toContain('bpy.context.active_object');
  });

  it('leaves alone what is not in the table', () => {
    for (const phrase of ['scroll down', 'page down', 'arrow down', 'reduce noise', 'open blender', 'what are you doing']) {
      expect(parseLiveEdit(phrase), phrase).toBeNull();
    }
  });
});

describe('живая правка не делает того, о чём не просили', () => {
  /**
   * Замечания CodeRabbit (кусок 3, PR №42). Все четыре кончались тем, что
   * человек слышал отчёт о сделанном, а в сцене происходило другое — или
   * ничего.
   */
  it('дробное расстояние не рвётся на две цифры', () => {
    const правка = parseLiveEdit('подними на 0,5');
    expect(правка).not.toBeNull();
    // Раньше число бралось первое — ноль, — Блендер не двигал ничего, а
    // человек слышал «Сдвинул».
    expect(правка?.code).toContain('0.5');
  });

  it('запрет не превращается в действие', () => {
    expect(parseLiveEdit("don't rotate it")).toBeNull();
    expect(parseLiveEdit('не крась это в синий')).toBeNull();
  });

  it('неоднозначное имя не выбирается молча', () => {
    const правка = parseLiveEdit('удали ракету');
    expect(правка?.code).toContain('_один(');
    // Отказ виден в самом скрипте: несколько совпадений — это ошибка, а не
    // «возьму первого попавшегося».
    expect(правка?.code).toContain('raise RuntimeError');
  });

  it('покраска проверяет, что красить было чем', () => {
    const правка = parseLiveEdit('сделай ракету синей');
    expect(правка?.code).toContain('м.users > 1');
    expect(правка?.code).toContain('OUTPUT_MATERIAL');
    expect(правка?.code).toContain('if вход is None');
  });

  it('анимация отвечает по итогу, а не по факту вызова', () => {
    expect(parseLiveEdit('запусти анимацию')?.code).toContain('CANCELLED');
    expect(parseLiveEdit('останови анимацию')?.code).toContain('is_animation_playing');
  });
});

describe('нечегоПравить', () => {
  it('узнаёт свою же фразу из собранного скрипта', () => {
    // Тот самый шов, на котором ломается передача агенту: фраза живёт в двух
    // местах — в скрипте для блендера и в опознавателе. Поменяют одну,
    // забудут другую — и «Покрась сферу в зелёный» снова умрёт на месте,
    // молча, как 26.09.2026 у живого человека.
    const правка = parseLiveEdit('покрась сферу в зелёный');
    const строки = (правка?.code ?? '').split(String.fromCharCode(10));
    // Именно строка сразу за проверкой на пустоту: RuntimeError в скрипте
    // несколько, и первый из них — «подходит несколько», совсем другой случай.
    const где = строки.findIndex((строка) => строка.startsWith('if о is None:'));
    const сообщение = где >= 0 ? строки[где + 1] : undefined;

    expect(сообщение).toContain('RuntimeError');
    expect(нечегоПравить(сообщение ?? '')).toBe(true);
  });

  it('оба языка, какой бы ни был выбран', () => {
    expect(нечегоПравить('RuntimeError: не нашёл, что править')).toBe(true);
    expect(нечегоПравить('RuntimeError: nothing to edit found')).toBe(true);
  });

  it('вопрос человеку агенту не отдаётся', () => {
    // «Подходит несколько» — это честный вопрос, какой из объектов имелся в
    // виду. Передать его агенту значит дать ему угадать за человека.
    expect(нечегоПравить('под это имя подходит несколько: Sphere, Sphere.001')).toBe(false);
    expect(нечегоПравить('у этого материала нечего красить')).toBe(false);
  });
});
