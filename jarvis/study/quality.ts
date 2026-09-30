/**
 * Проверка того, что заготовила модель, — до того, как это увидит человек.
 *
 * Правила доверия из Lamdan (golden quiz contract): вопрос без опоры в
 * лекции выбрасывается, а не досочиняется; четыре варианта, ровно один
 * верный, все разные и непустые, у каждого — объяснение; ссылка на место в
 * лекции — внутри своего раздела. Всё отброшенное — в предупреждения банка,
 * а не молча.
 */

import type { QuizOption, QuizQuestion, SourceRef, StudyCard, StudyTask, StudyTopic } from './types';

export interface QualityContext {
  lecture: string;
  topics: readonly StudyTopic[];
  /** Лекция на другом языке — у вопроса и вариантов обязан быть перевод. */
  translate: boolean;
}

export interface Checked {
  questions: QuizQuestion[];
  cards: StudyCard[];
  tasks: StudyTask[];
  warnings: string[];
}

function строка(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function нормально(текст: string): string {
  return текст.toLowerCase().replace(/[֑-ׇ]/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** «14:05» или «1:02:03» → секунды; непонятное — undefined. */
export function parseStamp(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v);
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/u.exec(строка(v));
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

/** Тема по номеру раздела и место в лекции, прижатое к разделу. */
function опора(
  ctx: QualityContext,
  section: unknown,
  at: unknown,
  что: string,
  warnings: string[],
): { topic: StudyTopic; source: SourceRef } | null {
  const номер = Number(section);
  const topic = Number.isInteger(номер) ? ctx.topics[номер - 1] : undefined;
  if (!topic) {
    warnings.push(`${что}: нет раздела ${String(section)} — выброшено`);
    return null;
  }
  let секунда = parseStamp(at);
  if (секунда !== undefined && topic.from !== undefined && topic.to !== undefined && (секунда < topic.from - 60 || секунда > topic.to + 60)) {
    warnings.push(`${что}: место ${String(at)} вне раздела «${topic.title}» — взято начало раздела`);
    секунда = topic.from;
  }
  return { topic, source: { lecture: ctx.lecture, at: секунда ?? topic.from } };
}

/**
 * Разбор спорит с пометкой: у верного варианта «Неверно…», у ловушки
 * «Верно…». Ровно так выглядела первая заготовка со сдвинутым номером — и
 * такой вопрос учил бы неправильному.
 */
function противоречит(options: readonly QuizOption[], correctIndex: number): boolean {
  // `\b` в JavaScript знает только латиницу: после «Верно» его нет. Граница
  // слова — «дальше не буква».
  const да = /^\s*(верно|правильно|correct|right)(?!\p{L})/iu;
  const нет = /^\s*(неверно|неправильно|нет|wrong|incorrect|no)(?!\p{L})/iu;
  return options.some((o, k) => (k === correctIndex ? нет.test(o.rationale) : да.test(o.rationale)));
}

export function checkGenerated(raw: unknown, ctx: QualityContext): Checked {
  const warnings: string[] = [];
  const данные = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const массив = (ключ: string): Array<Record<string, unknown>> =>
    Array.isArray(данные[ключ]) ? (данные[ключ] as unknown[]).filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object') : [];

  const questions: QuizQuestion[] = [];
  const видели = new Set<string>();
  for (const [i, q] of массив('questions').entries()) {
    const что = `вопрос ${i + 1}`;
    const prompt = строка(q.prompt);
    const сырые = (Array.isArray(q.options) ? q.options : []).map((o: unknown) => (o && typeof o === 'object' ? o : {}) as Record<string, unknown>);
    const options: QuizOption[] = сырые.map((опц) => ({ text: строка(опц.text), translation: строка(опц.ru) || undefined, rationale: строка(опц.why) }));
    // Верный — пометкой у самого варианта, а не номером: номер модель
    // считала с единицы, код — с нуля, и первая заготовка (30.09.2026) вышла
    // со сдвигом — «верно» в разборе у одного варианта, засчитан другой.
    const верные = сырые.map((опц, k) => (опц.correct === true ? k : -1)).filter((k) => k >= 0);
    const correctIndex = верные.length === 1 ? (верные[0] as number) : -1;
    const почему =
      !prompt ? 'пустой вопрос'
      : options.length !== 4 ? `вариантов ${options.length}, а не четыре`
      : options.some((o) => !o.text) ? 'пустой вариант'
      : new Set(options.map((o) => нормально(o.text))).size !== 4 ? 'варианты повторяются'
      : correctIndex < 0 ? (верные.length > 1 ? 'верных вариантов несколько' : 'верный вариант не указан')
      : противоречит(options, correctIndex) ? 'разбор противоречит пометке верного варианта'
      : options.some((o) => !o.rationale) ? 'не у каждого варианта есть объяснение'
      : ctx.translate && (!строка(q.promptRu) || options.some((o) => !o.translation)) ? 'нет перевода'
      : !строка(q.explanation) ? 'нет разбора'
      : видели.has(нормально(prompt)) ? 'повтор вопроса'
      : '';
    if (почему) {
      warnings.push(`${что}: ${почему} — выброшено`);
      continue;
    }
    const место = опора(ctx, q.section, q.at, что, warnings);
    if (!место) continue;
    видели.add(нормально(prompt));
    questions.push({
      id: `${ctx.lecture}#q${questions.length + 1}`,
      topicId: место.topic.id,
      prompt,
      promptTranslation: ctx.translate ? строка(q.promptRu) : undefined,
      options,
      correctIndex,
      explanation: строка(q.explanation),
      memoryHint: строка(q.hint),
      answer: строка(q.answer) || (options[correctIndex]?.translation ?? options[correctIndex]?.text ?? ''),
      source: место.source,
    });
  }

  const cards: StudyCard[] = [];
  const лица = new Set<string>();
  for (const [i, c] of массив('cards').entries()) {
    const front = строка(c.front);
    const back = строка(c.back);
    if (!front || !back) {
      warnings.push(`карточка ${i + 1}: пустая сторона — выброшено`);
      continue;
    }
    // Одно понятие звучит в нескольких разделах — карточка одна.
    if (лица.has(нормально(front))) continue;
    лица.add(нормально(front));
    const место = опора(ctx, c.section, c.at, `карточка ${i + 1}`, warnings);
    if (!место) continue;
    cards.push({ id: `${ctx.lecture}#c${cards.length + 1}`, topicId: место.topic.id, front, back, source: место.source, origin: 'concept' });
  }

  const tasks: StudyTask[] = [];
  for (const [i, t] of массив('tasks').entries()) {
    const problem = строка(t.problem);
    const steps = Array.isArray(t.steps) ? t.steps.map(строка).filter(Boolean) : [];
    const answer = строка(t.answer);
    if (!problem || steps.length === 0 || !answer) {
      warnings.push(`задача ${i + 1}: нет условия, решения или ответа — выброшено`);
      continue;
    }
    const место = опора(ctx, t.section, t.at, `задача ${i + 1}`, warnings);
    if (!место) continue;
    tasks.push({ id: `${ctx.lecture}#t${tasks.length + 1}`, topicId: место.topic.id, problem, hint: строка(t.hint), steps, answer, source: место.source });
  }
  return { questions, cards, tasks, warnings };
}
