import { describe, expect, it } from 'vitest';

import { parseLiveEdit } from './edits';

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
});
