import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isLive, listenerSource, liveDir, sendLive } from './blenderLive';

let root: string;
let previous: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'jarvis-live-'));
  previous = process.env.JARVIS_DATA_ROOT;
  process.env.JARVIS_DATA_ROOT = root;
});

afterEach(() => {
  if (previous === undefined) delete process.env.JARVIS_DATA_ROOT;
  else process.env.JARVIS_DATA_ROOT = previous;
  rmSync(root, { recursive: true, force: true });
});

const aliveFile = (): string => path.join(liveDir(), 'жив.txt');
const answerFile = (): string => path.join(liveDir(), 'ответ.json');
const commandFile = (): string => path.join(liveDir(), 'команда.py');

describe('слушатель', () => {
  it('исполняет команду в живом сеансе, а не в фоновом блендере', () => {
    // Смысл всей затеи. Человек сказал: «он создал ракету, я говорю — пусть
    // полетит в космос, и он, не закрывая этот файл, при мне делает анимацию».
    const source = listenerSource();

    expect(source).toContain('bpy.app.timers.register');
    expect(source).toContain('exec(compile(');
    expect(source).not.toContain('--background');
  });

  it('не роняет блендер на ошибке в скрипте', () => {
    // Ошибка в одной команде не должна уносить сеанс: человек смотрит на своё
    // окно, и закрыть его из-за опечатки — худшее, что можно сделать.
    const source = listenerSource();

    expect(source).toContain('except Exception:');
    expect(source).toContain('traceback.format_exc()');
  });

  it('отмечается живым на каждом круге', () => {
    expect(listenerSource()).toContain('отметиться()');
  });

  it('пишет ответ через переименование, а не поверх', () => {
    // Иначе читающий поймает файл на половине записи.
    expect(listenerSource()).toContain('os.replace(');
  });

  it('выключает заставку насовсем', () => {
    // Blender без файла показывает окно «создать новый или открыть готовый».
    // Пока оно висит, сцены не видно и скрипты бьют в пустоту. Человек сказал
    // прямо: «иначе весь воркфлоу с блендером рушится».
    const source = listenerSource();

    expect(source).toContain('show_splash = False');
    expect(source).toContain('save_userpref');
  });

  it('не содержит обратных кавычек', () => {
    // Этот текст едет через несколько слоёв записи, и одна обратная кавычка
    // рвала уже и страницу микрофона, и инструменты сервера.
    expect(listenerSource()).not.toContain(String.fromCharCode(96));
  });
});

describe('isLive', () => {
  it('без отметки считает, что блендера нет', () => {
    expect(isLive()).toBe(false);
  });

  it('свежая отметка значит, что он жив', () => {
    writeFileSync(aliveFile(), '1', 'utf8');
    expect(isLive()).toBe(true);
  });
});

describe('sendLive', () => {
  it('отказывается слать команду в никуда', async () => {
    // Молчаливый откат на фоновый блендер был бы худшим решением: работа
    // сделана, человек ничего не увидел, а отчёт бодрый.
    const answer = await sendLive('print(1)');

    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('живого блендера нет');
  });

  it('кладёт команду и забирает ответ', async () => {
    writeFileSync(aliveFile(), '1', 'utf8');

    const pending = sendLive('print("привет")');
    // Изображаем слушателя: дожидаемся команды и отвечаем.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(existsSync(commandFile())).toBe(true);
    expect(readFileSync(commandFile(), 'utf8')).toContain('привет');
    writeFileSync(
      answerFile(),
      JSON.stringify({ ok: true, printed: 'привет\n', error: null }),
      'utf8',
    );

    const answer = await pending;
    expect(answer.ok).toBe(true);
    expect(answer.printed).toContain('привет');
  });

  it('замечает, что блендер закрылся, не ответив', async () => {
    writeFileSync(aliveFile(), '1', 'utf8');
    const pending = sendLive('print(1)');
    await new Promise((resolve) => setTimeout(resolve, 250));
    rmSync(aliveFile());

    const answer = await pending;
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain('закрылся');
  });
});
