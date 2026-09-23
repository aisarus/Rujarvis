import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { TALK_TOOLS, TalkSession, talkToolNames, type TalkLive } from './talkSession';
import type { BackendResult } from '../backends/types';
import type { SessionKey } from '../backends/liveSession';

function ok(text: string): BackendResult {
  return { ok: true, backend: 'claude-code', text, durationMs: 1, filesChanged: [], commands: [] };
}

function failed(error: string): BackendResult {
  return {
    ok: false,
    backend: 'claude-code',
    text: '',
    durationMs: 1,
    filesChanged: [],
    commands: [],
    error,
  };
}

/** Живая сессия, которой нет: отвечает заготовленным и помнит, о чём спрашивали. */
class Поддельная implements TalkLive {
  readonly prompts: string[] = [];
  private spoken = false;
  alive = true;
  disposedWhy: string | null = null;

  constructor(private readonly answers: BackendResult[]) {}

  isAlive(): boolean {
    return this.alive;
  }

  hasSpoken(): boolean {
    return this.spoken;
  }

  ask(prompt: string): { result(): Promise<BackendResult> } {
    this.prompts.push(prompt);
    this.spoken = true;
    const answer = this.answers.shift() ?? ok('');
    return { result: () => Promise.resolve(answer) };
  }

  dispose(why = 'закрыта'): void {
    this.alive = false;
    this.disposedWhy = why;
  }

  warm(): void {
    this.прогрета += 1;
  }

  прогрета = 0;
}

let dir: string;
let сказанное: string[];
let записи: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-talksession-'));
  сказанное = [];
  записи = [];
});

function завести(
  сессии: Поддельная[],
  cliPath: () => Promise<string | null> = () => Promise.resolve('claude'),
): { разговор: TalkSession; ключи: SessionKey[] } {
  const ключи: SessionKey[] = [];
  let next = 0;
  const разговор = new TalkSession({
    cliPath,
    cwd: dir,
    mcpConfig: path.join(dir, 'talk.json'),
    delta: { journalFile: path.join(dir, 'journal.json'), planFile: path.join(dir, 'plan.json') },
    state: () => ({ work: ['Цель: собрать отчёт'], recent: ['открыл Chrome'], instructions: '' }),
    speak: (text) => {
      сказанное.push(text);
    },
    log: (line) => {
      записи.push(line);
    },
    createSession: (key) => {
      ключи.push(key);
      const сессия = сессии[next];
      next += 1;
      if (!сессия) throw new Error('лишняя сессия');
      return сессия;
    },
  });
  return { разговор, ключи };
}

describe('TalkSession', () => {
  it('первый ход несёт правила и состояние, второй — только фразу', async () => {
    const сессия = new Поддельная([ok('Привет.'), ok('Хорошо.')]);
    const { разговор } = завести([сессия]);

    await разговор.hear('привет');
    await разговор.hear('как дела');

    expect(сессия.prompts[0]).toContain('start_work');
    expect(сессия.prompts[0]).toContain('Цель: собрать отчёт');
    expect(сессия.prompts[1]).toBe('Человек сказал: как дела');
    expect(сказанное).toEqual(['Привет.', 'Хорошо.']);
  });

  it('пустой ответ — это молчание, а не заглушка', async () => {
    // У ответа по умолчанию есть запасная фраза «Готово, подробности на
    // экране». В разговоре она означала бы бормотание в ответ на «ага».
    const { разговор } = завести([new Поддельная([ok('   ')])]);

    await разговор.hear('ага');

    expect(сказанное).toEqual([]);
    expect(записи.some((line) => line.includes('промолчал'))).toBe(true);
  });

  it('пустую фразу человека не слышит вовсе', async () => {
    const сессия = new Поддельная([ok('не должно случиться')]);
    const { разговор } = завести([сессия]);

    await разговор.hear('   ');

    expect(сессия.prompts).toEqual([]);
  });

  it('разметку в голос не пускает', async () => {
    const { разговор } = завести([new Поддельная([ok('**Готово**: собрал отчёт.')])]);

    await разговор.hear('что там');

    expect(сказанное[0]).not.toContain('*');
    expect(сказанное[0]).toContain('собрал отчёт');
  });

  it('упавшая сессия не притворяется помнящей', async () => {
    const первая = new Поддельная([ok('Первый ответ.')]);
    const вторая = new Поддельная([ok('Второй ответ.')]);
    const { разговор } = завести([первая, вторая]);

    await разговор.hear('первая фраза');
    первая.alive = false;
    await разговор.hear('вторая фраза');

    expect(сказанное).toEqual(['Первый ответ.', 'Нить разговора потерял, начинаю заново.', 'Второй ответ.']);
    // Новая сессия ничего не помнит — значит первый ход ей снова полный.
    expect(вторая.prompts[0]).toContain('start_work');
  });

  it('нарочное «забудь» молчит: человек сам об этом попросил', async () => {
    const первая = new Поддельная([ok('Первый ответ.')]);
    const вторая = new Поддельная([ok('Слушаю.')]);
    const { разговор } = завести([первая, вторая]);

    await разговор.hear('первая фраза');
    разговор.forget();
    await разговор.hear('вторая фраза');

    expect(первая.disposedWhy).toBe('Человек попросил забыть');
    expect(сказанное).toEqual(['Первый ответ.', 'Слушаю.']);
  });

  it('без CLI жалуется один раз, а не на каждую фразу', async () => {
    const { разговор } = завести([], () => Promise.resolve(null));

    await разговор.hear('привет');
    await разговор.hear('ну привет же');

    expect(сказанное).toEqual(['Разговор недоступен: не нашёл Claude Code.']);
  });

  it('за отменённый ход не извиняется', async () => {
    // «Стоп» и «забудь» гасят сессию, и её ход возвращается неудачей. Это
    // исполненная просьба человека, а не поломка.
    const { разговор } = завести([new Поддельная([failed('Отменено')])]);

    await разговор.hear('что там');

    expect(сказанное).toEqual([]);
  });

  it('о настоящей неудаче говорит вслух', async () => {
    const { разговор } = завести([new Поддельная([failed('Сессия молчит слишком долго')])]);

    await разговор.hear('что там');

    expect(сказанное).toEqual(['Не смог ответить.']);
  });

  it('живёт в своей папке и только со своими рычагами', async () => {
    const { разговор, ключи } = завести([new Поддельная([ok('Да.')])]);

    await разговор.hear('привет');

    expect(ключи[0]?.cwd).toBe(dir);
    expect(ключи[0]?.permissionMode).toBe('default');
    expect(ключи[0]?.tools.split(',')).toEqual(talkToolNames());
    expect(ключи[0]?.tools).not.toContain('Bash');
    expect(ключи[0]?.tools).not.toContain('Write');
    // Каждый глагол — через рабочий поток: своего имени вне сервера нет ни у
    // одного.
    for (const name of talkToolNames()) expect(name.startsWith('mcp__jarvis-talk__')).toBe(true);
  });
});

describe('прогрев', () => {
  it('поднимает процесс, не тратя хода', async () => {
    // Лишний ход стоил бы подписки на каждом запуске — в том числе когда
    // человек за вечер не сказал ни слова.
    const сессия = new Поддельная([ok('не должно прозвучать')]);
    const { разговор } = завести([сессия]);

    await разговор.warm();

    expect(сессия.прогрета).toBe(1);
    expect(сессия.prompts).toEqual([]);
    expect(сказанное).toEqual([]);
  });

  it('прогретая сессия отвечает первой же фразе, а не заводится заново', async () => {
    const сессия = new Поддельная([ok('Слушаю.')]);
    const { разговор } = завести([сессия]);

    await разговор.warm();
    await разговор.hear('привет');

    // Вторая сессия не заводилась: «лишняя сессия» бросила бы подделка.
    expect(сказанное).toEqual(['Слушаю.']);
    expect(сессия.prompts).toHaveLength(1);
  });
});

describe('имена рычагов', () => {
  it('годятся для MCP: только латиница, цифры и подчёркивание', () => {
    // Кириллическое имя инструмента отклоняется целиком, вместе с сервером.
    for (const name of TALK_TOOLS) expect(name).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/u);
  });
});
