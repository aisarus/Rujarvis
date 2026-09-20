import { describe, expect, it } from 'vitest';

import { askAbout, obviousAside, readAnswer } from './aside';

describe('очевидное решается без модели', () => {
  it('вежливость не поправка и не задача', () => {
    expect(obviousAside('спасибо')).toEqual({ kind: 'ignore', why: 'вежливость' });
    expect(obviousAside('ага, понял')).toEqual({ kind: 'ignore', why: 'вежливость' });
  });

  // Одно слово посреди работы — почти всегда обрывок распознавания.
  // Заводить по нему задачу значит дать человеку работу, о которой не просили.
  it('одно слово пропускает мимо', () => {
    expect(obviousAside('джарвис')).toEqual({ kind: 'ignore', why: 'слишком коротко' });
    expect(obviousAside('ну')).toEqual({ kind: 'ignore', why: 'слишком коротко' });
  });

  it('«а пока» и «параллельно» — прямая просьба о второй задаче', () => {
    expect(obviousAside('а пока найди мне картинки')).toEqual({ kind: 'task' });
    expect(obviousAside('параллельно собери отчёт')).toEqual({ kind: 'task' });
    expect(obviousAside('заодно проверь почту')).toEqual({ kind: 'task' });
    expect(obviousAside('отдельно посчитай расходы')).toEqual({ kind: 'task' });
  });

  it('«правка» и «туда же» — прямая просьба поправить', () => {
    expect(obviousAside('правка: шрифт крупнее')).toEqual({ kind: 'note' });
    expect(obviousAside('туда же добавь подвал')).toEqual({ kind: 'note' });
    expect(obviousAside('к этой же задаче добавь кнопку')).toEqual({ kind: 'note' });
  });

  it('обычную фразу оставляет модели', () => {
    expect(obviousAside('сделай шрифт покрупнее')).toBeNull();
    expect(obviousAside('найди фотографии заката')).toBeNull();
  });
});

describe('вопрос модели', () => {
  it('называет и работу, и сказанное', () => {
    const question = askAbout('найди картинки', 'Сайт-портфолио');
    expect(question).toContain('Сайт-портфолио');
    expect(question).toContain('найди картинки');
  });

  it('требует ответа одним словом', () => {
    expect(askAbout('что-нибудь', 'Работа')).toMatch(/правка|отдельно/u);
  });
});

describe('ответ модели', () => {
  it('понимает оба слова', () => {
    expect(readAnswer('правка')).toEqual({ kind: 'note' });
    expect(readAnswer('отдельно')).toEqual({ kind: 'task' });
  });

  it('не спотыкается о лишнее вокруг слова', () => {
    expect(readAnswer('  Отдельно.  ')).toEqual({ kind: 'task' });
    expect(readAnswer('Это правка к текущей работе')).toEqual({ kind: 'note' });
  });

  // Страховка: молчание или чепуха от модели не должны заводить работу,
  // о которой человек не просил. Заметка безобиднее лишней задачи.
  it('на непонятный ответ выбирает заметку', () => {
    expect(readAnswer('')).toEqual({ kind: 'note' });
    expect(readAnswer('не знаю')).toEqual({ kind: 'note' });
    expect(readAnswer('{"error":"timeout"}')).toEqual({ kind: 'note' });
  });

  it('при обоих словах разом верит первому', () => {
    expect(readAnswer('отдельно, а не правка')).toEqual({ kind: 'task' });
    expect(readAnswer('правка, не отдельно')).toEqual({ kind: 'note' });
  });
});
