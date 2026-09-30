import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  pickTalkAgent,
  TALK_TOOLS,
  TalkSession,
  talkToolNames,
  talkUnavailableReason,
  type TalkAgent,
  type TalkLive,
  type TalkSessionOptions,
} from './talkSession';
import type { BackendAvailability, BackendResult } from '../backends/types';
import type { SessionKey } from '../backends/liveSession';

function ok(text: string): BackendResult {
  return { ok: true, backend: 'claude-code', text, durationMs: 1, filesChanged: [], commands: [] };
}

function failed(error: string, cancelled = false): BackendResult {
  return {
    ok: false,
    backend: 'claude-code',
    text: '',
    durationMs: 1,
    filesChanged: [],
    commands: [],
    cancelled,
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
  agent: () => Promise<TalkAgent | null> = () => Promise.resolve({ id: 'claude-code', path: 'claude' }),
  агенты: Array<TalkAgent['id']> = [],
  ещё: Partial<TalkSessionOptions> = {},
): { разговор: TalkSession; ключи: SessionKey[] } {
  const ключи: SessionKey[] = [];
  let next = 0;
  const разговор = new TalkSession({
    ...ещё,
    agent,
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
    createSession: (key, _command, агент) => {
      ключи.push(key);
      агенты.push(агент);
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

    expect(сказанное).toEqual(['Разговор недоступен: не нашёл ни Claude Code, ни Codex.']);
  });

  it('без агента молчит при запуске, а на фразу называет причину — и повторяет не чаще раза в минуту', async () => {
    // Живой тест на маке 27.09.2026: Codex не был подключён, «Разговор
    // недоступен» прозвучало один раз при старте, и дальше каждая фраза
    // человека глоталась молча — «ничего не работает».
    let часы = 1_000_000;
    const { разговор } = завести([], () => Promise.resolve(null), [], {
      unavailable: () => Promise.resolve('Codex установлен, но вход не выполнен. Запустите codex login'),
      now: () => часы,
    });

    await разговор.warm();
    expect(сказанное).toEqual([]);

    await разговор.hear('открой почту');
    expect(сказанное).toEqual(['Разговор недоступен: Codex установлен, но вход не выполнен. Запустите codex login.']);

    часы += 30_000;
    await разговор.hear('ну открой же');
    expect(сказанное).toHaveLength(1);

    часы += 31_000;
    await разговор.hear('ау');
    expect(сказанное).toHaveLength(2);
  });

  it('причина словами: нет ни одного агента, или конкретная беда установленного', () => {
    const нет = (id: 'claude-code' | 'codex'): BackendAvailability => ({
      id,
      installed: false,
      authenticated: false,
      ready: false,
      checkedAt: 0,
      reason: `${id} не установлен`,
    });
    expect(talkUnavailableReason([нет('claude-code'), нет('codex')])).toBe('не нашёл ни Claude Code, ни Codex');
    expect(
      talkUnavailableReason([
        нет('claude-code'),
        {
          id: 'codex',
          installed: true,
          authenticated: false,
          ready: false,
          checkedAt: 0,
          reason: 'Codex установлен, но вход не выполнен. Запустите codex login и войдите через ChatGPT.',
        },
      ]),
    ).toBe('Codex установлен, но вход не выполнен. Запустите codex login и войдите через ChatGPT');
  });

  it('кому вести разговор: Claude Code первым, без него — Codex, без обоих — никому', () => {
    const готов = (id: 'claude-code' | 'codex', ready = true): BackendAvailability => ({
      id,
      installed: true,
      authenticated: ready,
      ready,
      path: `/bin/${id}`,
      checkedAt: 0,
    });
    expect(pickTalkAgent([готов('codex'), готов('claude-code')])?.id).toBe('claude-code');
    expect(pickTalkAgent([готов('claude-code', false), готов('codex')])).toEqual({ id: 'codex', path: '/bin/codex' });
    expect(pickTalkAgent([готов('claude-code', false), готов('codex', false)])).toBeNull();
    expect(pickTalkAgent([])).toBeNull();
  });

  it('с одним Codex разговор есть — поднимается на Codex', async () => {
    // Тестер на маке может прийти с одним Codex. До 27.09.2026 разговор
    // искал только Claude Code и отвечал «недоступен».
    const агенты: Array<TalkAgent['id']> = [];
    const сессия = new Поддельная([ok('Слушаю.')]);
    const { разговор } = завести([сессия], () => Promise.resolve({ id: 'codex', path: 'codex' }), агенты);

    await разговор.hear('привет');

    expect(агенты).toEqual(['codex']);
    expect(сказанное).toEqual(['Слушаю.']);
    expect(записи.some((line) => line.includes('Codex'))).toBe(true);
  });

  it('за отменённый ход не извиняется', async () => {
    // «Стоп» и «забудь» гасят сессию, и её ход возвращается неудачей. Это
    // исполненная просьба человека, а не поломка.
    //
    // Отмена — ПРИЗНАК результата. Раньше её узнавали по слову «отмен» в
    // тексте ошибки: настоящая беда с этим словом внутри пряталась, а отмена
    // с другой формулировкой («Человек попросил забыть») вызывала извинение
    // на пустом месте.
    const { разговор } = завести([new Поддельная([failed('Человек попросил забыть', true)])]);

    await разговор.hear('что там');

    expect(сказанное).toEqual([]);
  });

  it('о настоящей неудаче говорит вслух', async () => {
    const { разговор } = завести([new Поддельная([failed('Сессия молчит слишком долго')])]);

    await разговор.hear('что там');

    expect(сказанное).toEqual(['Не смог ответить.']);
  });

  it('беда со словом «отмена» внутри больше не прячется', async () => {
    const { разговор } = завести([new Поддельная([failed('не удалось отменить прошлый ход')])]);

    await разговор.hear('что там');

    expect(сказанное).toEqual(['Не смог ответить.']);
  });

  it('живёт в своей папке и только со своими рычагами', async () => {
    const { разговор, ключи } = завести([new Поддельная([ok('Да.')])]);

    await разговор.hear('привет');

    expect(ключи[0]?.cwd).toBe(dir);
    expect(ключи[0]?.permissionMode).toBe('default');
    // Список записан ЛИТЕРАЛОМ, а не вызовом той же функции.
    //
    // Сравнение с `talkToolNames()` — это сравнение значения с самим собой:
    // лишний глагол в `TALK_TOOLS` (скажем, запуск оболочки) проехал бы
    // незамеченным, а это граница безопасности разговора.
    expect(ключи[0]?.tools.split(',')).toEqual([
      'mcp__jarvis-talk__start_work',
      'mcp__jarvis-talk__add_note',
      'mcp__jarvis-talk__stop_work',
      'mcp__jarvis-talk__pause_work',
      'mcp__jarvis-talk__resume_work',
      'mcp__jarvis-talk__add_step',
      'mcp__jarvis-talk__work_now',
      // Руки на экране: исполняет Джарвис (`uiHands.ts`) с отказом модели в
      // покупке, отправке, Enter и перезаписи.
      'mcp__jarvis-talk__screen_overview',
      'mcp__jarvis-talk__switch_to',
      'mcp__jarvis-talk__press_control',
      'mcp__jarvis-talk__open_menu',
      'mcp__jarvis-talk__press_keys',
      'mcp__jarvis-talk__type_text',
      'mcp__jarvis-talk__send_to_claude',
      'mcp__jarvis-talk__claude_waiting',
      'mcp__jarvis-talk__open_claude_session',
      'mcp__jarvis-talk__new_claude_session',
      'mcp__jarvis-talk__open_site',
    ]);
    expect(ключи[0]?.tools).not.toContain('Bash');
    expect(ключи[0]?.tools).not.toContain('Write');
    // Каждый глагол — через рабочий поток: своего имени вне сервера нет ни у
    // одного.
    for (const name of talkToolNames()) expect(name.startsWith('mcp__jarvis-talk__')).toBe(true);
  });
});

describe('повтор, пока идёт ход', () => {
  /** Сессия, которая отвечает не сразу: без этого очередь нечем проверить. */
  class Медленная implements TalkLive {
    readonly prompts: string[] = [];
    private spoken = false;
    private отпустить: ((r: BackendResult) => void) | null = null;

    isAlive(): boolean { return true; }
    hasSpoken(): boolean { return this.spoken; }

    ask(prompt: string): { result(): Promise<BackendResult> } {
      this.prompts.push(prompt);
      this.spoken = true;
      return { result: () => new Promise<BackendResult>((r) => { this.отпустить = r; }) };
    }

    ответить(text: string): void { this.отпустить?.(ok(text)); }
    dispose(): void {}
  }

  it('второй раз ту же фразу в очередь не ставит', async () => {
    // Человек повторяет, когда не слышит ответа. Живая сессия обрабатывает
    // ходы по очереди, поэтому повтор не ускоряет ответ, а утраивает ожидание.
    const сессия = new Медленная();
    const { разговор } = завести([сессия as unknown as Поддельная]);

    void разговор.hear('сделай сферу зелёной');
    await new Promise((r) => setImmediate(r));
    void разговор.hear('сделай сферу зелёной');
    await new Promise((r) => setImmediate(r));

    expect(сессия.prompts).toHaveLength(1);
    expect(записи.some((line) => line.includes('повтор, уже думаю'))).toBe(true);
  });

  it('другую фразу пропускает, даже пока думает над первой', async () => {
    // Отбрасывать всё подряд нельзя: «стоп» и поправка обязаны доходить.
    const сессия = new Медленная();
    const { разговор } = завести([сессия as unknown as Поддельная]);

    void разговор.hear('первая');
    await new Promise((r) => setImmediate(r));
    void разговор.hear('вторая');
    await new Promise((r) => setImmediate(r));

    expect(сессия.prompts).toHaveLength(2);
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
