import { describe, expect, it } from 'vitest';

import { NoteBox, renderNotes } from './notes';

const AT = 1_700_000_000_000;

describe('NoteBox', () => {
  it('копит сказанное во время работы', () => {
    const box = new NoteBox();
    box.add('крышу сделай синей', AT);
    box.add('и окна побольше', AT + 1000);

    expect(box.pending.map((note) => note.text)).toEqual([
      'крышу сделай синей',
      'и окна побольше',
    ]);
  });

  it('отдаёт всё разом и очищает', () => {
    // Агент, заглянувший дважды, не должен учесть одну правку дважды: «на два
    // тона темнее», применённое трижды, — это уже чёрный цвет.
    const box = new NoteBox();
    box.add('крышу синей', AT);

    expect(box.take()).toHaveLength(1);
    expect(box.take()).toHaveLength(0);
    expect(box.empty).toBe(true);
  });

  it('не кладёт одно и то же дважды', () => {
    // Человек повторяет себя, когда не слышит ответа. Это один и тот же
    // человек с одной и той же правкой, а не две правки.
    const box = new NoteBox();
    box.add('крышу синей', AT);
    box.add('крышу синей', AT + 3000);

    expect(box.pending).toHaveLength(1);
  });

  it('не хранит пустое', () => {
    const box = new NoteBox();
    box.add('   ', AT);

    expect(box.empty).toBe(true);
  });

  it('не растёт бесконечно', () => {
    const box = new NoteBox({ limit: 3 });
    for (let i = 0; i < 10; i += 1) box.add(`правка ${i}`, AT + i);

    expect(box.pending).toHaveLength(3);
    expect(box.pending[2]?.text).toBe('правка 9');
  });
});

describe('renderNotes', () => {
  it('объясняет агенту, что это правки, а не новая задача', () => {
    const text = renderNotes([{ at: AT, text: 'крышу сделай синей' }]);

    expect(text).toContain('крышу сделай синей');
    expect(text).toContain('поправки');
    expect(text).toContain('не новая задача');
  });

  it('честно говорит, когда сказать нечего', () => {
    // Молчание должно читаться как молчание, а не как пустой список, в котором
    // агент заподозрит поломку и полезет проверять.
    expect(renderNotes([])).toContain('ничего не говорил');
  });
});
