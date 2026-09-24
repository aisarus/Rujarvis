import { afterEach, describe, expect, it } from 'vitest';

import {
  addStep,
  currentStep,
  makePlan,
  markStep,
  planDone,
  planProgress,
  planSummary,
  renderPlan,
  stepStateLabel,
} from './plan';
import { setLanguage } from '../locale/language';

const AT = 1_700_000_000_000;

const GOAL = 'сделай сайт по моей биографии в концепции Бруно Симон';
const STEPS = [
  'разобрать архив, который положил человек',
  'посмотреть его гитхаб',
  'срежиссировать сайт и написать сценарий',
  'слепить 3D-модели',
  'найти и скачать текстуры',
  'написать физику',
  'собрать и открыть в браузере',
];

describe('makePlan', () => {
  it('складывает план из шагов, и все они ждут', () => {
    const plan = makePlan(GOAL, STEPS, AT);

    expect(plan.goal).toBe(GOAL);
    expect(plan.steps).toHaveLength(7);
    expect(plan.steps.every((step) => step.state === 'ждёт')).toBe(true);
  });

  it('выбрасывает пустые шаги', () => {
    expect(makePlan(GOAL, ['первый', '   ', 'второй'], AT).steps).toHaveLength(2);
  });

  it('не берёт бесконечный план', () => {
    // Тридцати шагов человек не читает, а агент не удерживает.
    const many = Array.from({ length: 100 }, (_, index) => `шаг ${index}`);
    expect(makePlan(GOAL, many, AT).steps).toHaveLength(30);
  });
});

describe('addStep', () => {
  it('дописывает шаг в конец, и он ждёт', () => {
    const plan = addStep(makePlan(GOAL, ['первый'], AT), 'второй', AT + 10);

    expect(plan?.steps.map((step) => step.text)).toEqual(['первый', 'второй']);
    expect(plan?.steps[1]?.state).toBe('ждёт');
    expect(plan?.updatedAt).toBe(AT + 10);
  });

  it('пустой текст не добавляет и честно об этом говорит', () => {
    // Молча вернуть тот же план значило бы сказать человеку «записал» про
    // незаписанное.
    expect(addStep(makePlan(GOAL, ['первый'], AT), '   ', AT)).toBeNull();
  });

  it('повтор не заводит второй такой же шаг', () => {
    expect(addStep(makePlan(GOAL, ['первый'], AT), 'первый', AT)).toBeNull();
  });

  it('в полный план не дописывает', () => {
    const many = Array.from({ length: 30 }, (_, i) => `шаг ${i}`);
    expect(addStep(makePlan(GOAL, many, AT), 'лишний', AT)).toBeNull();
  });
});

describe('markStep', () => {
  it('отмечает шаг и запоминает, чем он кончился', () => {
    const plan = markStep(makePlan(GOAL, STEPS, AT), 0, 'сделано', AT + 100, 'нашёл 12 картинок');

    expect(plan.steps[0]).toMatchObject({ state: 'сделано', note: 'нашёл 12 картинок' });
    expect(plan.steps[1]?.state).toBe('ждёт');
  });

  it('переживает номер, которого нет', () => {
    // Номер приходит от агента, а он сбивается. Ронять из-за этого получасовую
    // работу нельзя.
    const plan = makePlan(GOAL, STEPS, AT);
    for (const bad of [-1, 99, 1.5, Number.NaN]) {
      expect(markStep(plan, bad, 'сделано', AT).steps).toEqual(plan.steps);
    }
  });

  it('различает «не вышло» и «ждёт»', () => {
    // Шаг, на котором споткнулись, и шаг, до которого не дошли, — разные вещи.
    const plan = markStep(makePlan(GOAL, STEPS, AT), 3, 'не вышло', AT, 'блендер не открылся');

    expect(plan.steps[3]?.state).toBe('не вышло');
    expect(planProgress(plan).done).toBe(0);
  });
});

describe('currentStep', () => {
  it('показывает тот, который делают', () => {
    const plan = markStep(makePlan(GOAL, STEPS, AT), 2, 'делаю', AT);

    expect(currentStep(plan)?.index).toBe(2);
  });

  it('без начатого показывает первый неначатый', () => {
    const plan = markStep(makePlan(GOAL, STEPS, AT), 0, 'сделано', AT);

    expect(currentStep(plan)?.index).toBe(1);
  });

  it('молчит, когда делать нечего', () => {
    let plan = makePlan(GOAL, ['один'], AT);
    plan = markStep(plan, 0, 'сделано', AT);

    expect(currentStep(plan)).toBeNull();
    expect(planDone(plan)).toBe(true);
  });

  it('считает законченным и план, часть которого не вышла', () => {
    // Иначе работа висит «незаконченной» вечно из-за одного шага, который уже
    // не будет сделан.
    let plan = makePlan(GOAL, ['один', 'два'], AT);
    plan = markStep(plan, 0, 'сделано', AT);
    plan = markStep(plan, 1, 'не вышло', AT);

    expect(planDone(plan)).toBe(true);
  });

  it('пустой план законченным не считается', () => {
    expect(planDone(makePlan(GOAL, [], AT))).toBe(false);
  });
});

describe('renderPlan', () => {
  it('нумерует шаги так же, как их отмечают', () => {
    // Агент отмечает шаг по номеру, который видел. Разъехавшаяся нумерация —
    // это отмеченный не тот шаг.
    const plan = markStep(makePlan(GOAL, STEPS, AT), 0, 'сделано', AT);
    const text = renderPlan(plan);

    expect(text).toContain('0. [сделано] разобрать архив');
    expect(text).toContain('1. [ждёт] посмотреть его гитхаб');
    expect(text).toContain('Сделано 1 из 7.');
  });

  it('честно говорит, что плана нет', () => {
    expect(renderPlan(null)).toContain('Плана пока нет');
  });
});

describe('planSummary', () => {
  it('отвечает на «где ты» одной строкой', () => {
    // Человек, спросивший это голосом, не хочет слушать тридцать пунктов.
    const plan = markStep(makePlan(GOAL, STEPS, AT), 2, 'делаю', AT);

    expect(planSummary(plan)).toBe('Шаг 3 из 7: срежиссировать сайт и написать сценарий');
  });

  it('говорит, когда всё сделано', () => {
    let plan = makePlan(GOAL, ['один'], AT);
    plan = markStep(plan, 0, 'сделано', AT);

    expect(planSummary(plan)).toContain('выполнен');
  });
});

describe('stepStateLabel', () => {
  afterEach(() => setLanguage('ru'));

  it('говорит состояние на языке человека, не трогая служебное значение', () => {
    expect(stepStateLabel('не вышло')).toBe('не вышло');
    setLanguage('en');
    expect(stepStateLabel('не вышло')).toBe('failed');
    expect(stepStateLabel('делаю')).toBe('in progress');
  });
});
