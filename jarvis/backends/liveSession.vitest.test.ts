import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LiveSession, buildLiveArgs, sameSession, userMessage, type SessionKey } from './liveSession';
import { forgetChild, trackedChildren } from '../tasks/reaper';
import type { BackendEvent } from './types';

const NL = String.fromCharCode(10);

const KEY: SessionKey = {
  cwd: 'C:/работа',
  tools: 'Read,Write',
  permissionMode: 'acceptEdits',
  mcpConfig: 'C:/конфиг.json',
};

describe('аргументы живой сессии', () => {
  it('просит потоковый вход — иначе процесс умрёт после первой реплики', () => {
    expect(buildLiveArgs(KEY)).toContain('--input-format');
    expect(buildLiveArgs(KEY).join(' ')).toContain('--input-format stream-json');
  });

  // Без --verbose CLI отказывается отдавать поток вовсе. Узнали дорого.
  it('не забывает --verbose', () => {
    expect(buildLiveArgs(KEY)).toContain('--verbose');
  });

  it('передаёт инструменты только вместе с конфигом MCP', () => {
    expect(buildLiveArgs(KEY)).toContain('--allowedTools');
    expect(buildLiveArgs({ ...KEY, mcpConfig: undefined })).not.toContain('--allowedTools');
  });
});

describe('когда сессию можно переиспользовать', () => {
  it('те же папка, инструменты и режим — та же сессия', () => {
    expect(sameSession(KEY, { ...KEY })).toBe(true);
  });

  // Всё это задаётся при запуске процесса и потом не меняется.
  it.each([
    ['другая папка', { cwd: 'C:/другая' }],
    ['другие инструменты', { tools: 'Read' }],
    ['другой режим', { permissionMode: 'plan' }],
    ['другой конфиг', { mcpConfig: 'C:/иной.json' }],
    ['другая модель', { model: 'haiku' }],
  ])('%s — нужна новая', (_что, чем) => {
    expect(sameSession(KEY, { ...KEY, ...чем })).toBe(false);
  });
});

describe('реплика человека', () => {
  it('одна строка JSON и перевод строки', () => {
    const line = userMessage('открой блендер');
    expect(line.endsWith(NL)).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'открой блендер' }] },
    });
  });
});

/** Подставной процесс: отвечает тем, что ему велят, и помнит, что получил. */
function поддельныйПроцесс(pid = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter;
    stdin: { write: (s: string) => void };
    kill: () => void;
    exitCode: number | null;
    pid: number;
  };
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  const написано: string[] = [];
  child.stdout = stdout;
  child.stderr = new EventEmitter();
  child.stdin = { write: (s: string) => { написано.push(s); } };
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.exitCode = null;
  child.pid = pid;

  const сказать = (obj: unknown): void => { stdout.emit('data', JSON.stringify(obj) + NL); };
  return { child, написано, сказать };
}

function сессия(поддельный: ReturnType<typeof поддельныйПроцесс>) {
  return new LiveSession({
    key: KEY,
    command: 'claude',
    consumeLine: (raw, emit) => {
      if (raw.type === 'assistant') emit({ type: 'assistant-text', backend: 'claude-code', text: 'ответ' });
    },
    spawnProcess: (() => поддельный.child) as never,
    now: () => 1_000,
  });
}

describe('ход за ходом', () => {
  it('первая реплика уходит в процесс', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    s.ask('раз');
    expect(п.написано).toHaveLength(1);
    expect(JSON.parse(п.написано[0] as string).message.content[0].text).toBe('раз');
  });

  // Ходы идут строго по одному: CLI обрабатывает их последовательно, и послать
  // второй, не дождавшись первого, — гонка с непонятным исходом.
  it('вторая реплика ждёт, пока кончится первая', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    const первый = s.ask('раз');
    s.ask('два');

    expect(п.написано).toHaveLength(1);
    п.сказать({ type: 'result', subtype: 'success', result: 'готово' });
    await первый.result();

    expect(п.написано).toHaveLength(2);
    expect(JSON.parse(п.написано[1] as string).message.content[0].text).toBe('два');
  });

  it('итог хода приходит с текстом', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    const ход = s.ask('раз');
    п.сказать({ type: 'result', subtype: 'success', result: 'готово' });

    const итог = await ход.result();
    expect(итог.ok).toBe(true);
    expect(итог.text).toBe('готово');
  });

  it('провал хода называется провалом', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    const ход = s.ask('раз');
    п.сказать({ type: 'result', subtype: 'error_during_execution', is_error: true });

    const итог = await ход.result();
    expect(итог.ok).toBe(false);
    expect(итог.error).toBeTruthy();
  });

  it('сессия остаётся живой после хода', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    const ход = s.ask('раз');
    п.сказать({ type: 'result', subtype: 'success', result: 'готово' });
    await ход.result();

    expect(s.isAlive()).toBe(true);
    expect(s.isBusy()).toBe(false);
  });
});

describe('когда всё ломается', () => {
  // Молча оставить ждущего хуже, чем сказать «не вышло»: задача повиснет
  // навсегда, и человек будет смотреть на пустой экран.
  it('смерть процесса завершает незаконченный ход', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    const ход = s.ask('раз');
    п.child.emit('exit', 1);

    const итог = await ход.result();
    expect(итог.ok).toBe(false);
    expect(s.isAlive()).toBe(false);
  });

  it('очередь не виснет, когда сессия умерла', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    const первый = s.ask('раз');
    const второй = s.ask('два');
    п.child.emit('exit', 1);

    await expect(первый.result()).resolves.toMatchObject({ ok: false });
    await expect(второй.result()).resolves.toMatchObject({ ok: false });
  });

  // «Стоп» обязан срабатывать. Прервать один ход нечем, поэтому закрывается
  // вся сессия: лишний холодный старт дешевле невыполненной остановки.
  it('отмена закрывает сессию и отвечает', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    const ход = s.ask('раз');
    ход.cancel();

    const итог = await ход.result();
    expect(итог.ok).toBe(false);
    expect(s.isAlive()).toBe(false);
  });

  it('после смерти новый ход отвечает сразу, а не ждёт', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    s.dispose();

    const итог = await s.ask('раз').result();
    expect(итог.ok).toBe(false);
    expect(итог.error).toBeTruthy();
  });

  it('молчание дольше срока убивает сессию, а не вешает её', async () => {
    vi.useFakeTimers();
    try {
      const п = поддельныйПроцесс();
      const s = new LiveSession({
        key: KEY,
        command: 'claude',
        consumeLine: () => {},
        spawnProcess: (() => п.child) as never,
        turnTimeoutMs: 1_000,
      });
      const ход = s.ask('раз');
      vi.advanceTimersByTime(1_500);

      const итог = await ход.result();
      expect(итог.ok).toBe(false);
      expect(s.isAlive()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('события доходят до вызывающего', () => {
  it('поток отдаёт события хода и заканчивается итогом', async () => {
    const п = поддельныйПроцесс();
    const s = сессия(п);
    const ход = s.ask('раз');

    const собрано: BackendEvent[] = [];
    const чтение = (async () => {
      for await (const событие of ход.events) собрано.push(событие);
    })();

    п.сказать({ type: 'assistant' });
    п.сказать({ type: 'result', subtype: 'success', result: 'готово' });
    await ход.result();
    await чтение;

    expect(собрано.map((e) => e.type)).toEqual(['started', 'assistant-text', 'completed']);
  });
});

/**
 * Предел считает молчание, а не работу.
 *
 * Таймер назывался «сессия молчит», а отсчитывал всё время хода. Из-за этого
 * прогон «3D-модель по 2D-видео» был убит на 1200-й секунде посреди правки
 * файла — при живом потоке событий. Двадцать минут работы выброшены.
 */
describe('долгая работа не считается зависанием', () => {
  function сессияСПределом(
    поддельный: ReturnType<typeof поддельныйПроцесс>,
    предел: number,
  ): LiveSession {
    return new LiveSession({
      key: KEY,
      command: 'claude',
      consumeLine: () => {},
      spawnProcess: (() => поддельный.child) as never,
      turnTimeoutMs: предел,
    });
  }

  it('работа, которая шумит, живёт дольше предела', async () => {
    vi.useFakeTimers();
    try {
      const п = поддельныйПроцесс();
      const s = сессияСПределом(п, 1_000);
      const ход = s.ask('собери мультик');

      // Восемь раз по 600 мс: суммарно 4.8 секунды при пределе в одну.
      for (let i = 0; i < 8; i += 1) {
        await vi.advanceTimersByTimeAsync(600);
        п.сказать({ type: 'assistant', шаг: i });
      }

      let оборвалось = false;
      void ход.result().then((r) => { оборвалось = !r.ok; });
      await vi.advanceTimersByTimeAsync(0);
      expect(оборвалось).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('молчание дольше предела обрывает', async () => {
    vi.useFakeTimers();
    try {
      const п = поддельныйПроцесс();
      const s = сессияСПределом(п, 1_000);
      const ход = s.ask('зависни');
      const итог = ход.result();
      await vi.advanceTimersByTimeAsync(1_500);
      const r = await итог;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('молчит');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * У ожидания есть граница, у работы — нет.
 *
 * Предел, ставший счётчиком молчания, снял с разговора границу «человек уже не
 * ждёт»: отвечающий по букве в секунду тянулся бы бесконечно. Потолок
 * возвращает её — и только там, где срок задан явно.
 */
describe('потолок на ход', () => {
  it('шумящий ход всё равно обрывается по потолку', async () => {
    vi.useFakeTimers();
    try {
      const п = поддельныйПроцесс();
      const s = new LiveSession({
        key: KEY,
        command: 'claude',
        consumeLine: () => {},
        spawnProcess: (() => п.child) as never,
        turnTimeoutMs: 10_000,
        turnCeilingMs: 1_000,
      });
      const ход = s.ask('отвечай по букве');
      const итог = ход.result();

      for (let i = 0; i < 5; i += 1) {
        await vi.advanceTimersByTimeAsync(300);
        п.сказать({ type: 'assistant', буква: i });
      }

      const r = await итог;
      expect(r.ok).toBe(false);
      expect(r.error).toContain('не уложился');
    } finally {
      vi.useRealTimers();
    }
  });

  // Работе потолок не задаётся, и она живёт ровно по молчанию.
  it('без потолка долгая работа продолжается', async () => {
    vi.useFakeTimers();
    try {
      const п = поддельныйПроцесс();
      const s = new LiveSession({
        key: KEY,
        command: 'claude',
        consumeLine: () => {},
        spawnProcess: (() => п.child) as never,
        turnTimeoutMs: 1_000,
      });
      const ход = s.ask('работай долго');
      let оборвалось = false;
      void ход.result().then((r) => { оборвалось = !r.ok; });

      for (let i = 0; i < 10; i += 1) {
        await vi.advanceTimersByTimeAsync(600);
        п.сказать({ type: 'assistant', шаг: i });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(оборвалось).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('аварийный выключатель достаёт и живые сессии', () => {
  // Сессия — это процесс CLI со своим MCP-сервером и PowerShell, тот самый
  // набор, который за сутки небрежности накопился здесь на 956 МБ. Разовые
  // прогоны отмечались давно, живые не отмечались вовсе — и «убейся» проходило
  // мимо них.
  const PID = 987_654;

  afterEach(() => {
    forgetChild(PID);
  });

  it('pid попадает в реестр при подъёме', () => {
    const п = поддельныйПроцесс(PID);
    сессия(п).warm();

    expect(trackedChildren()).toContain(PID);
  });

  it('и уходит из реестра, когда процесс кончился', () => {
    const п = поддельныйПроцесс(PID);
    const s = сессия(п);
    s.warm();
    п.child.kill();

    expect(trackedChildren()).not.toContain(PID);
  });
});
