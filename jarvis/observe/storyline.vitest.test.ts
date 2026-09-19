import { describe, expect, it } from 'vitest';

import type { BackendEvent } from '../backends/types';
import { Storyline, describeEvent } from './storyline';

const AT = 1_700_000_000_000;

function tool(name: string, detail?: string): BackendEvent {
  return { type: 'tool', backend: 'claude-code', name, ...(detail ? { detail } : {}) };
}

describe('describeEvent', () => {
  it('называет шаг так, как его понял бы человек', () => {
    expect(describeEvent(tool('Write', String.raw`C:\Users\ariel\Desktop\Джарвис\Files\Ракета.blend`), AT))
      .toMatchObject({ kind: 'step', text: 'Пишу файл', detail: 'Ракета.blend' });
  });

  it('сокращает путь до имени файла', () => {
    // Человек читает поток на ходу. Полный путь в каждой строке — это стена,
    // в которой не видно, что происходит.
    const line = describeEvent(tool('Read', '/home/ariel/проект/очень/длинный/путь/к/файлу.ts'), AT);
    expect(line?.detail).toBe('файлу.ts');
  });

  it('узнаёт работу в блендере', () => {
    expect(describeEvent(tool('mcp__jarvis-desktop__blender_python'), AT))
      .toMatchObject({ kind: 'step', text: 'Работаю в блендере' });
  });

  it('показывает команду целиком, а не её название', () => {
    // «Выполняю команду» без самой команды бесполезно: смысл строки в том,
    // что именно было запущено.
    const line = describeEvent(
      { type: 'command', backend: 'claude-code', command: 'npm test', exitCode: 0 },
      AT,
    );
    expect(line).toMatchObject({ kind: 'command', detail: 'npm test' });
  });

  it('отмечает провалившуюся команду', () => {
    const line = describeEvent(
      { type: 'command', backend: 'claude-code', command: 'npm test', exitCode: 1 },
      AT,
    );
    expect(line?.kind).toBe('error');
  });

  it('передаёт слова агента как его слова', () => {
    const line = describeEvent(
      { type: 'assistant-text', backend: 'claude-code', text: 'Сделал ракету, сохранил в Files.' },
      AT,
    );
    expect(line).toMatchObject({ kind: 'said', text: 'Сделал ракету, сохранил в Files.' });
  });

  it('называет изменение файла по действию', () => {
    const line = describeEvent(
      {
        type: 'file-changed',
        backend: 'claude-code',
        change: { path: String.raw`C:\проект\Ракета.blend`, action: 'created' },
      },
      AT,
    );
    expect(line).toMatchObject({ kind: 'file', text: 'Создал файл', detail: 'Ракета.blend' });
  });

  it('не прячет ошибку', () => {
    const line = describeEvent(
      { type: 'error', backend: 'claude-code', message: 'блендер не отвечает', retryable: true },
      AT,
    );
    expect(line).toMatchObject({ kind: 'error', detail: 'блендер не отвечает' });
  });

  it('отмечает начало и конец работы', () => {
    expect(describeEvent({ type: 'started', backend: 'claude-code' }, AT)?.kind).toBe('start');
    const done = describeEvent(
      {
        type: 'completed',
        backend: 'claude-code',
        result: {
          ok: true, backend: 'claude-code', text: 'готово', durationMs: 1000,
          filesChanged: [], commands: [],
        },
      },
      AT,
    );
    expect(done?.kind).toBe('done');
  });

  it('показывает, чем кончилась работа, а не только что она кончилась', () => {
    // Человек, отошедший на двадцать минут, должен увидеть результат, а не
    // одно слово «готово».
    const line = describeEvent(
      {
        type: 'completed',
        backend: 'claude-code',
        result: {
          ok: true, backend: 'claude-code', text: 'Собрал сайт, открыл в браузере.',
          durationMs: 1000, filesChanged: [], commands: [],
        },
      },
      AT,
    );
    expect(line).toMatchObject({ kind: 'done', detail: 'Собрал сайт, открыл в браузере.' });
  });

  it('молчит о служебном', () => {
    // Поток статусов бэкенда человеку не нужен: это шум, в котором тонет дело.
    expect(describeEvent({ type: 'status', backend: 'claude-code', text: 'thinking' }, AT)).toBeNull();
  });

  it('не выдумывает шаг для незнакомого инструмента', () => {
    // Лучше показать сырое имя, чем соврать красивой фразой.
    const line = describeEvent(tool('SomeNewTool'), AT);
    expect(line).toMatchObject({ kind: 'step', text: 'SomeNewTool' });
  });
});

describe('Storyline', () => {
  it('копит строки в порядке появления', () => {
    const story = new Storyline();
    story.saw(tool('Read', 'a.ts'), AT);
    story.saw(tool('Write', 'b.ts'), AT + 10);

    expect(story.lines.map((l) => l.detail)).toEqual(['a.ts', 'b.ts']);
  });

  it('не растёт бесконечно', () => {
    // Автономная работа на час — это тысячи событий. Окно должно показывать
    // последнее, а не съедать память.
    const story = new Storyline({ limit: 3 });
    for (let i = 0; i < 10; i += 1) story.saw(tool('Read', `${i}.ts`), AT + i);

    expect(story.lines).toHaveLength(3);
    expect(story.lines[2]?.detail).toBe('9.ts');
  });

  it('пропускает то, о чём сказать нечего', () => {
    const story = new Storyline();
    story.saw({ type: 'status', backend: 'claude-code', text: 'x' }, AT);

    expect(story.lines).toHaveLength(0);
  });

  it('сообщает о каждой новой строке', () => {
    const seen: string[] = [];
    const story = new Storyline({ onLine: (line) => seen.push(line.text) });
    story.begin('Сделай ракету', AT);
    story.saw(tool('Write', 'a.ts'), AT + 1);

    expect(seen).toEqual(['Сделай ракету', 'Пишу файл']);
  });

  it('переживает окно, которое закрылось посреди рассказа', () => {
    const story = new Storyline({
      onLine: () => {
        throw new Error('окна больше нет');
      },
    });

    expect(() => story.saw(tool('Read', 'a.ts'), AT)).not.toThrow();
    expect(story.lines).toHaveLength(1);
  });

  it('показывает, что человек сказал во время работы', () => {
    // Видно должно быть, кто говорит: иначе человек, отлиставший назад, не
    // поймёт, откуда взялась поправка.
    const story = new Storyline();
    story.heard('крышу сделай синей', AT);

    expect(story.lines.at(-1)).toMatchObject({
      kind: 'note',
      text: 'Ты сказал',
      detail: 'крышу сделай синей',
    });
  });

  it('начинает новую главу с новой задачей', () => {
    const story = new Storyline();
    story.saw(tool('Read', 'a.ts'), AT);
    story.begin('Сделай ракету', AT + 5);

    expect(story.lines.at(-1)).toMatchObject({ kind: 'task', text: 'Сделай ракету' });
  });
});
