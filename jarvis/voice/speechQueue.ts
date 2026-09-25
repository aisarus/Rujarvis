/**
 * Один рот на двоих.
 *
 * ## Зачем
 *
 * До 22.09.2026 говорил один поток — работа, — и очередь была не нужна. Теперь
 * рядом идёт разговор, и он тоже говорит. Окно звука на новую фразу **обрывает**
 * текущую: старый проигрыватель ставится на паузу и выбрасывается. Без очереди
 * человек услышал бы половину фразы и начало следующей.
 *
 * ## Почему «замолчи» не тормозит очередь, а выбрасывает её
 *
 * Человек просит замолчать, когда не хочет слышать ни этого, ни следующего.
 * Очередь, которая после «тишины» договорит отложенное, — это ровно то
 * поведение, из-за которого просьбу приходится повторять.
 */

export interface SpeechMouth {
  /**
   * Произнести фразу. Обещание завершается, когда она **отзвучала**, а не
   * когда её отправили: иначе очередь выстроит синтез, а не речь.
   */
  say(text: string): Promise<void>;
  /** Оборвать то, что звучит сейчас. */
  cut(): void;
}

export class SpeechQueue {
  /** Хвост очереди: следующая фраза цепляется за него. */
  private tail: Promise<void> = Promise.resolve();
  /** Растёт на каждое «замолчи» и отменяет всё, что ещё не прозвучало. */
  private generation = 0;
  private speaking = false;

  constructor(private readonly mouth: SpeechMouth) {}

  isSpeaking(): boolean {
    return this.speaking;
  }

  speak(text: string): Promise<void> {
    if (!text.trim()) return Promise.resolve();

    const asked = this.generation;
    const run = this.tail.then(async () => {
      // Пока фраза стояла в очереди, могли попросить замолчать. Сказать её
      // теперь значило бы не услышать просьбу.
      if (asked !== this.generation) return;
      this.speaking = true;
      try {
        await this.mouth.say(text);
      } finally {
        this.speaking = false;
      }
    });

    // Хвост не должен обрываться на неудаче: упавший синтез одной фразы не
    // повод замолчать навсегда.
    this.tail = run.catch(() => undefined);
    return run;
  }

  stop(): void {
    this.generation += 1;
    this.speaking = false;
    this.mouth.cut();
  }
}
