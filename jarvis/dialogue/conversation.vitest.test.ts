import { describe, expect, it } from 'vitest';

import type { TaskMemory } from '../memory/store';
import {
  CONVERSATION_WINDOW_MS,
  continuesConversation,
  openConversation,
} from './conversation';

const NOW = 1_700_000_000_000;

function task(overrides: Partial<TaskMemory> = {}): TaskMemory {
  return {
    id: 'task-1',
    utterance: 'создай в блендере красную сферу',
    outcome: 'сфера готова',
    ok: true,
    backend: 'claude-code',
    finishedAt: NOW - 60_000,
    sessionId: 'сессия-1',
    ...overrides,
  };
}

describe('openConversation', () => {
  it('открыт после удавшейся задачи с сессией', () => {
    expect(openConversation(task(), NOW)).toEqual({
      sessionId: 'сессия-1',
      backend: 'claude-code',
      utterance: 'создай в блендере красную сферу',
      outcome: 'сфера готова',
    });
  });

  it('закрыт, когда задач ещё не было', () => {
    expect(openConversation(undefined, NOW)).toBeNull();
  });

  it('закрыт без идентификатора сессии', () => {
    // Продолжать нечего: бэкенд не дал, к чему возвращаться.
    expect(openConversation(task({ sessionId: undefined }), NOW)).toBeNull();
  });

  it('закрыт после провалившейся задачи', () => {
    // Контекст провала — это история ошибки. Новую работу в нём начинать
    // значит начинать с чужих граблей.
    expect(openConversation(task({ ok: false }), NOW)).toBeNull();
  });

  it('закрыт, когда разговор остыл', () => {
    const cold = task({ finishedAt: NOW - CONVERSATION_WINDOW_MS - 1 });
    expect(openConversation(cold, NOW)).toBeNull();
  });

  it('открыт на самой границе окна', () => {
    const edge = task({ finishedAt: NOW - CONVERSATION_WINDOW_MS });
    expect(openConversation(edge, NOW)).not.toBeNull();
  });
});

const open = openConversation(task(), NOW);

describe('continuesConversation', () => {
  it.each([
    ['сделай её зелёной', 0.35, 'chat'],
    ['а теперь синюю', 0.35, 'chat'],
    ['нет, другую', 0.3, 'chat'],
    ['что у меня получилось?', 0.35, 'chat'],
    ['ау, жив?', 0.3, 'chat'],
  ])('«%s» — это ход разговора', (utterance, confidence, intent) => {
    // Ровно те фразы, на которые человек слышал «не понял»: сами по себе они
    // не значат ничего, а после сделанной сферы значат всё.
    expect(
      continuesConversation(utterance, { confidence, intent: intent as never }, open),
    ).toBe(true);
  });

  it('«продолжай» продолжает разговор, а не начинает новый', () => {
    expect(
      continuesConversation('продолжай', { confidence: 0.3, intent: 'continue' }, open),
    ).toBe(true);
  });

  it('вежливость разговором не считается', () => {
    // Иначе «спасибо» поднимет целый запуск агента — долго и незачем.
    for (const polite of ['спасибо', 'ага', 'ну ладно']) {
      expect(continuesConversation(polite, { confidence: 0.3, intent: 'chat' }, open)).toBe(
        false,
      );
    }
  });

  it('самостоятельная просьба остаётся самостоятельной', () => {
    // Она и так уверенно маршрутизируется; подменять ей бэкенд незачем.
    expect(
      continuesConversation('открой хром', { confidence: 0.8, intent: 'launch' }, open),
    ).toBe(false);
  });

  it('без открытого разговора продолжать нечего', () => {
    expect(continuesConversation('сделай её зелёной', { confidence: 0.35, intent: 'chat' }, null)).toBe(
      false,
    );
  });

  it('пустая фраза не разговор', () => {
    expect(continuesConversation('   ', { confidence: 0.3, intent: 'chat' }, open)).toBe(false);
  });
});
