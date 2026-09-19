/**
 * План работы: что Джарвис собирается сделать и где он сейчас.
 *
 * ## Зачем
 *
 * Человек описал работу так: «джарвис получил команду, составил план и
 * работает». Пример его словами — сделать сайт по биографии в концепции Бруно
 * Симон: залезть в положенный архив, сходить в гитхаб, срежиссировать сайт,
 * написать сценарий, слепить 3D-модели, найти и скачать текстуры, написать
 * физику, всё собрать. По одной команде.
 *
 * Такая работа идёт десятки минут, и без записанного плана она непроглядна с
 * обеих сторон. Человек не знает, на каком он шаге и сколько осталось. Агент
 * держит план только у себя в голове — а голова у него обнуляется вместе с
 * запуском, и следующий запуск начинает не с четвёртого шага, а заново.
 *
 * ## Что это такое
 *
 * Список шагов с состоянием, и ничего больше. Ни планировщика, ни очереди, ни
 * расписания: план составляет агент, он умеет это лучше любых наших правил.
 * Здесь — только место, где план лежит, и слова, которыми о нём говорят.
 *
 * ## Почему состояние именно такое
 *
 * Четыре состояния вместо галочки. «Не вышло» — отдельно от «ждёт»: шаг, на
 * котором споткнулись, и шаг, до которого не дошли, — разные вещи, и человек,
 * читающий окно, должен видеть разницу. «Делаю» — тоже отдельно: без него
 * непонятно, работа идёт или встала.
 */

export type StepState = 'ждёт' | 'делаю' | 'сделано' | 'не вышло';

export interface PlanStep {
  text: string;
  state: StepState;
  /** Чем кончилось: что получилось или обо что споткнулись. */
  note?: string;
}

export interface Plan {
  /** Ради чего всё это — команда человека, слово в слово. */
  goal: string;
  steps: PlanStep[];
  startedAt: number;
  updatedAt: number;
}

/** Больше этого шагов человек не читает, а агент не удерживает. */
const MAX_STEPS = 30;
const MAX_TEXT = 200;

function trim(value: string): string {
  const clean = value.replace(/\s+/gu, ' ').trim();
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
}

export function makePlan(goal: string, steps: readonly string[], at: number): Plan {
  return {
    goal: trim(goal),
    steps: steps
      .map((text) => trim(text))
      .filter(Boolean)
      .slice(0, MAX_STEPS)
      .map((text) => ({ text, state: 'ждёт' as const })),
    startedAt: at,
    updatedAt: at,
  };
}

/**
 * Отметить шаг.
 *
 * Номер приходит от агента, а он ошибается: называет шаг, которого нет, или
 * сбивается на единицу. Несуществующий номер — не повод ронять работу, план
 * просто остаётся как был.
 */
export function markStep(
  plan: Plan,
  index: number,
  state: StepState,
  at: number,
  note?: string,
): Plan {
  if (!Number.isInteger(index) || index < 0 || index >= plan.steps.length) return plan;

  const steps = plan.steps.map((step, position) =>
    position === index
      ? { ...step, state, ...(note ? { note: trim(note) } : {}) }
      : step,
  );
  return { ...plan, steps, updatedAt: at };
}

/** Шаг, который идёт прямо сейчас, или следующий незанятый. */
export function currentStep(plan: Plan): { index: number; step: PlanStep } | null {
  const doing = plan.steps.findIndex((step) => step.state === 'делаю');
  const index = doing >= 0 ? doing : plan.steps.findIndex((step) => step.state === 'ждёт');
  if (index < 0) return null;
  return { index, step: plan.steps[index] as PlanStep };
}

export function planDone(plan: Plan): boolean {
  return (
    plan.steps.length > 0 &&
    plan.steps.every((step) => step.state === 'сделано' || step.state === 'не вышло')
  );
}

/** Сколько сделано из скольких — то, что человек спрашивает первым. */
export function planProgress(plan: Plan): { done: number; total: number } {
  return {
    done: plan.steps.filter((step) => step.state === 'сделано').length,
    total: plan.steps.length,
  };
}

/**
 * План словами — для агента, который вернулся к работе.
 *
 * Номера проставлены здесь, а не в данных: агент отмечает шаги по номеру, и
 * номер должен быть ровно тот, который он видел.
 */
export function renderPlan(plan: Plan | null): string {
  if (!plan || plan.steps.length === 0) return 'Плана пока нет.';

  const { done, total } = planProgress(plan);
  const lines = plan.steps.map(
    (step, index) =>
      `${index}. [${step.state}] ${step.text}${step.note ? ` — ${step.note}` : ''}`,
  );

  return [
    `Задача: ${plan.goal}`,
    `Сделано ${done} из ${total}.`,
    ...lines,
  ].join('\n');
}

/**
 * План одной строкой — для голоса и заголовка окна.
 *
 * Человек, спросивший «где ты», не хочет слушать тридцать пунктов.
 */
export function planSummary(plan: Plan | null): string {
  if (!plan || plan.steps.length === 0) return 'Плана пока нет.';

  const { done, total } = planProgress(plan);
  const current = currentStep(plan);
  if (!current) return `План выполнен: ${done} из ${total}.`;
  return `Шаг ${current.index + 1} из ${total}: ${current.step.text}`;
}
