import { describe, expect, it } from 'vitest';

import { SpeechQueue, type SpeechMouth } from './speechQueue';

/** Рот, который отвечает не сразу: без этого очередь нечем проверить. */
function рот(): SpeechMouth & {
  начатые: string[];
  законченные: string[];
  договорить(text: string): void;
  обрывы: number;
} {
  const начатые: string[] = [];
  const законченные: string[] = [];
  const ждут = new Map<string, () => void>();
  let обрывы = 0;

  return {
    начатые,
    законченные,
    get обрывы() {
      return обрывы;
    },
    say(text: string) {
      начатые.push(text);
      return new Promise<void>((resolve) => {
        ждут.set(text, () => {
          законченные.push(text);
          resolve();
        });
      });
    },
    cut() {
      обрывы += 1;
      // Оборванная фраза всё равно кончается: окно звука сообщает об этом.
      for (const [text, done] of [...ждут.entries()]) {
        ждут.delete(text);
        done();
      }
    },
    договорить(text: string) {
      const done = ждут.get(text);
      ждут.delete(text);
      done?.();
    },
  };
}

const тик = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('SpeechQueue', () => {
  it('вторая фраза ждёт, пока отзвучит первая', async () => {
    // Иначе окно звука обрывает первую на полуслове: новая фраза ставит
    // старый проигрыватель на паузу и выбрасывает его.
    const м = рот();
    const очередь = new SpeechQueue(м);

    void очередь.speak('первая');
    void очередь.speak('вторая');
    await тик();

    expect(м.начатые).toEqual(['первая']);

    м.договорить('первая');
    await тик();

    expect(м.начатые).toEqual(['первая', 'вторая']);
  });

  it('«замолчи» выбрасывает отложенное, а не договаривает его', async () => {
    const м = рот();
    const очередь = new SpeechQueue(м);

    void очередь.speak('первая');
    void очередь.speak('вторая');
    await тик();

    очередь.stop();
    await тик();
    await тик();

    expect(м.обрывы).toBe(1);
    expect(м.начатые).toEqual(['первая']);
  });

  it('после «замолчи» говорить можно снова', async () => {
    const м = рот();
    const очередь = new SpeechQueue(м);

    void очередь.speak('первая');
    await тик();
    очередь.stop();
    await тик();

    void очередь.speak('новая');
    await тик();

    expect(м.начатые).toEqual(['первая', 'новая']);
  });

  it('упавшая фраза не глушит следующие', async () => {
    // Синтез мог не получиться. Замолчать до перезапуска из-за одной фразы —
    // худший исход: помощник выглядит живым и не отвечает.
    const очередь = new SpeechQueue({
      say: (text) => (text === 'плохая' ? Promise.reject(new Error('синтез упал')) : Promise.resolve()),
      cut: () => {},
    });

    await очередь.speak('плохая').catch(() => undefined);
    await expect(очередь.speak('хорошая')).resolves.toBeUndefined();
  });

  it('пустую фразу не произносит', async () => {
    const м = рот();
    await new SpeechQueue(м).speak('   ');
    expect(м.начатые).toEqual([]);
  });

  it('пока говорит — говорит, а не «вроде бы»', async () => {
    const м = рот();
    const очередь = new SpeechQueue(м);

    expect(очередь.isSpeaking()).toBe(false);
    void очередь.speak('фраза');
    await тик();
    expect(очередь.isSpeaking()).toBe(true);

    м.договорить('фраза');
    await тик();
    expect(очередь.isSpeaking()).toBe(false);
  });
});
