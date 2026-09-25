/**
 * План на диске.
 *
 * ## Почему на диске, а не в памяти агента
 *
 * Голова агента обнуляется вместе с запуском. Работа, которую человек описал —
 * сайт по одной команде: архив, гитхаб, модели, текстуры, физика — в один
 * запуск не укладывается, а запуск, который начинает не с четвёртого шага, а
 * заново, не закончится никогда.
 *
 * Вторая причина та же, что у ящика правок: план пишет агент внутри
 * MCP-сервера, а показывает окно внутри приложения. Это два процесса, и файл —
 * единственное, что у них общее.
 *
 * Третья: человек может посмотреть его глазами. План, который нельзя открыть
 * и прочитать, — это план, про который нельзя сказать, врёт он или нет.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Plan, PlanStep, StepState } from './plan';

const STATES: readonly StepState[] = ['ждёт', 'делаю', 'сделано', 'не вышло'];

export class PlanStore {
  constructor(private readonly file: string) {}

  read(): Plan | null {
    try {
      if (!existsSync(this.file)) return null;
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return asPlan(parsed);
    } catch {
      // Битый файл — то же, что отсутствие плана. Работу ронять незачем.
      return null;
    }
  }

  write(plan: Plan): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(plan, null, 2), 'utf8');
    } catch {
      // Диск занят. Потерянный план хуже, чем сохранённый, но лучше, чем
      // упавший посреди работы помощник.
    }
  }

  clear(): void {
    try {
      if (existsSync(this.file)) writeFileSync(this.file, 'null', 'utf8');
    } catch {
      // См. выше.
    }
  }
}

/**
 * Проверка того, что прочитано с диска.
 *
 * Файл мог быть написан прошлой версией, поправлен руками или испорчен на
 * половине записи. Доверять ему на слово — значит уронить окно на первом же
 * шаге без поля `state`.
 */
function asPlan(value: unknown): Plan | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<Plan>;
  if (typeof raw.goal !== 'string' || !Array.isArray(raw.steps)) return null;

  const steps: PlanStep[] = [];
  for (const item of raw.steps) {
    if (typeof item !== 'object' || item === null) continue;
    const step = item as Partial<PlanStep>;
    if (typeof step.text !== 'string' || !step.text) continue;
    steps.push({
      text: step.text,
      state: STATES.includes(step.state as StepState) ? (step.state as StepState) : 'ждёт',
      ...(typeof step.note === 'string' && step.note ? { note: step.note } : {}),
    });
  }

  return {
    goal: raw.goal,
    steps,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}
