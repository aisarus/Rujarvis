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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

  /**
   * Записать план. Возвращает, дошло ли до диска.
   *
   * Отказ глотался молча, и инструмент отвечал человеку успехом: «дописал
   * шагом три» звучало, шага в плане не появлялось. Ронять помощника из-за
   * занятого диска по-прежнему не будем — но и врать не будем.
   */
  write(plan: Plan): boolean {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      // Через временный файл: обрыв посреди записи оставлял обрезанный JSON,
      // а следующий читатель принимал его за отсутствующий план.
      const черновик = `${this.file}.${process.pid}.tmp`;
      writeFileSync(черновик, JSON.stringify(plan, null, 2), 'utf8');
      renameSync(черновик, this.file);
      return true;
    } catch (error) {
      console.error(`[jarvis] план не записался: ${error instanceof Error ? error.message : String(error)}`);
      return false;
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
