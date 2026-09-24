/**
 * Мост вопросов «разрешаете?» от хука агента к человеку.
 *
 * Хук PreToolUse — отдельный процесс, который Claude Code запускает перед
 * каждым вызовом инструмента. Спросить голосом он не может: голос живёт в
 * главном процессе. Поэтому вопрос ложится файлом, главный процесс задаёт его
 * вслух и кладёт ответ рядом. Тот же приём, что у моста разговора
 * (`dialogue/talkBridge.ts`): файл на вопрос и файл на ответ, у каждого один
 * писатель.
 *
 * Молчание — это отказ. Хук, не дождавшийся ответа, запрещает действие.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { RiskLevel } from '../types';

export interface GateQuestion {
  id: string;
  summary: string;
  level: RiskLevel;
  at: number;
}

export type GateHandler = (question: GateQuestion) => Promise<boolean> | boolean;

/** Имя файла — только из этих знаков: id приходит из чужого процесса. */
const SAFE_ID = /^[a-z0-9-]{1,64}$/iu;
const LEVELS = new Set<RiskLevel>(['safe', 'normal', 'sensitive', 'dangerous']);

/**
 * Сколько ждать ответа человека.
 *
 * Чуть дольше, чем голосовой вопрос ждёт ответа сам (45 секунд), чтобы отказ
 * по сроку пришёл оттуда, где его слышно, а не молча отсюда.
 */
export const GATE_WAIT_MS = 60_000;
const STEP_MS = 100;

export class GateBridge {
  constructor(
    private readonly dir: string,
    private readonly options: { waitMs?: number; stepMs?: number; now?: () => number } = {},
  ) {}

  /** Сторона хука: спросить и дождаться. `false` — и на отказ, и на молчание. */
  async ask(summary: string, level: RiskLevel): Promise<boolean> {
    const now = this.options.now ?? Date.now;
    const id = randomUUID();
    const question: GateQuestion = { id, summary, level, at: now() };
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file('ask', id), JSON.stringify(question), 'utf8');
    } catch {
      return false;
    }

    const deadline = now() + (this.options.waitMs ?? GATE_WAIT_MS);
    while (now() < deadline) {
      const answer = this.readAnswer(id);
      if (answer !== null) return answer;
      await pause(this.options.stepMs ?? STEP_MS);
    }
    drop(this.file('ask', id));
    return false;
  }

  /** Вопросы прошлого запуска: задавать их сейчас — неожиданность, а не забота. */
  clear(): void {
    try {
      for (const name of readdirSync(this.dir)) drop(path.join(this.dir, name));
    } catch {
      // Папки нет — и чистить нечего.
    }
  }

  /** Сторона главного процесса: задавать приходящие вопросы по одному. */
  serve(handler: GateHandler): () => void {
    mkdirSync(this.dir, { recursive: true });
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.round(handler).finally(() => {
        busy = false;
      });
    }, this.options.stepMs ?? STEP_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async round(handler: GateHandler): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith('ask-') || !name.endsWith('.json')) continue;
      const file = path.join(this.dir, name);
      const question = readQuestion(file);
      drop(file);
      if (!question) continue;
      let allow = false;
      try {
        allow = (await handler(question)) === true;
      } catch {
        allow = false;
      }
      try {
        writeFileSync(this.file('ok', question.id), JSON.stringify({ allow }), 'utf8');
      } catch {
        // Хук уйдёт по сроку и получит отказ.
      }
    }
  }

  private file(kind: 'ask' | 'ok', id: string): string {
    return path.join(this.dir, `${kind}-${id}.json`);
  }

  private readAnswer(id: string): boolean | null {
    const file = this.file('ok', id);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { allow?: unknown };
      drop(file);
      return parsed.allow === true;
    } catch {
      return null;
    }
  }
}

function readQuestion(file: string): GateQuestion | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<GateQuestion>;
    if (typeof parsed.id !== 'string' || !SAFE_ID.test(parsed.id)) return null;
    if (typeof parsed.summary !== 'string' || !LEVELS.has(parsed.level as RiskLevel)) return null;
    return {
      id: parsed.id,
      summary: parsed.summary,
      level: parsed.level as RiskLevel,
      at: typeof parsed.at === 'number' ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

function drop(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* уже нет */
  }
}

/**
 * Пауза, которая держит процесс живым. Без `unref` нарочно: в процессе хука
 * больше ничего не ждёт, и отпущенный таймер завершал его через 90 мс —
 * вопрос уже лежал в папке, а ответа никто не дожидался.
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
