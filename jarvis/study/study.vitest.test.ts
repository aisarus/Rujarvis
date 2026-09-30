import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateLectureBank, jsonFromReply, readLectureSource, sectionBatches } from './generate';
import { topicKnowledge } from './knowledge';
import { parseOpenVerdict } from './openAnswer';
import { checkGenerated, parseStamp } from './quality';
import { StudyService } from './service';
import { isDue, reviewCard } from './srs';
import { StudyStore } from './store';
import type { EvidenceEvent, StudyTopic } from './types';

const папки: string[] = [];
afterEach(async () => {
  for (const папка of папки.splice(0)) await rm(папка, { recursive: true, force: true });
});

async function временная(): Promise<string> {
  const папка = await mkdtemp(path.join(tmpdir(), 'jarvis-study-'));
  папки.push(папка);
  return папка;
}

const ДЕНЬ = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 9, 20, 12, 0).getTime();

function событие(outcome: 'success' | 'failure', at: number, kind: EvidenceEvent['kind'] = 'recognition', source: EvidenceEvent['source'] = 'quiz'): EvidenceEvent {
  return { id: String(Math.random()), topicId: 't', itemId: 'q', kind, source, outcome, at };
}

describe('шкала знания — честно, без процентов', () => {
  it('одним удачным ответом «знаю» не заработать', () => {
    expect(topicKnowledge([], false, T0).state).toBe('unseen');
    expect(topicKnowledge([], true, T0).state).toBe('covered');
    expect(topicKnowledge([событие('success', T0)], true, T0).state).toBe('fragile');
    // Четыре удачи за один день и одним способом — всё ещё шатко.
    expect(topicKnowledge([1, 2, 3, 4].map((i) => событие('success', T0 + i)), true, T0 + 10).state).toBe('fragile');
  });

  it('«знаю» — четыре удачи, два дня, два способа, без свежей ошибки', () => {
    const события = [
      событие('success', T0 - 2 * ДЕНЬ),
      событие('success', T0 - 2 * ДЕНЬ + 1, 'recall', 'card'),
      событие('success', T0 - ДЕНЬ),
      событие('success', T0 - ДЕНЬ + 1, 'recall', 'card'),
    ];
    expect(topicKnowledge(события, true, T0)).toMatchObject({ state: 'strong', risk: 'low' });
    // Свежая ошибка перевешивает — уже не «знаю».
    expect(topicKnowledge([...события, событие('failure', T0)], true, T0).state).not.toBe('strong');
    // Самопроверки задач «знаю» не дают: их видел только человек.
    const задачи = события.map((e) => ({ ...e, source: 'task' as const, kind: 'application' as const }));
    expect(topicKnowledge(задачи, true, T0).state).toBe('fragile');
    // Через месяц без повторения — риск забыть высокий, и «знаю» гаснет.
    expect(topicKnowledge(события, true, T0 + 30 * ДЕНЬ)).toMatchObject({ state: 'fragile', risk: 'high' });
  });

  it('«слабо» — две ошибки и последняя ошибка', () => {
    expect(topicKnowledge([событие('success', T0 - 3), событие('failure', T0 - 2), событие('failure', T0 - 1)], true, T0).state).toBe('weak');
  });
});

describe('карточки: «Ещё раз» и «Знаю»', () => {
  it('интервалы растут: день, три, восемь; «ещё раз» — через десять минут и сначала', () => {
    let s = reviewCard(undefined, 'know', T0);
    expect(s.interval).toBe(1);
    s = reviewCard(s, 'know', T0);
    expect(s.interval).toBe(3);
    s = reviewCard(s, 'know', T0);
    expect(s.interval).toBe(8);
    s = reviewCard(s, 'again', T0);
    expect(s).toMatchObject({ interval: 0, lapses: 1, due: T0 + 10 * 60_000 });
    expect(isDue(s, T0 + 5 * 60_000)).toBe(false);
    expect(isDue(undefined, T0)).toBe(true);
  });
});

const темы: StudyTopic[] = [
  { id: 'L#1', lecture: 'L', title: 'Спрос', from: 0, to: 300 },
  { id: 'L#2', lecture: 'L', title: 'Предложение', from: 300, to: 600 },
];

function вопрос(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    section: 1,
    at: '02:10',
    prompt: 'מהו ביקוש?',
    promptRu: 'Что такое спрос?',
    options: [
      { text: 'רצון לקנות', ru: 'желание купить', why: 'почти', correct: false },
      { text: 'כמות מבוקשת במחיר', ru: 'количество при цене', why: 'да', correct: true },
      { text: 'היצע', ru: 'предложение', why: 'нет, это другая сторона', correct: false },
      { text: 'מחיר', ru: 'цена', why: 'нет', correct: false },
    ],
    explanation: 'Спрос — зависимость количества от цены.',
    hint: 'спрос — кривая, а не точка',
    answer: 'количество, которое купят при каждой цене',
    ...extra,
  };
}

describe('проверка того, что заготовила модель', () => {
  it('годный вопрос проходит; кривые выбрасываются с причиной', () => {
    const плохие = [
      вопрос({ prompt: 'ש1', options: [] }),
      вопрос({ prompt: 'ש2', options: (вопрос().options as Array<Record<string, unknown>>).map((o) => ({ ...o, correct: false })) }),
      вопрос({ prompt: 'ש3', promptRu: '' }),
      вопрос({ prompt: 'ש4', section: 9 }),
      вопрос({ prompt: 'ש5', options: Array.from({ length: 4 }, () => ({ text: 'то же', ru: 'то же', why: 'x' })) }),
      вопрос(), // повтор первого годного
    ];
    const { questions, warnings } = checkGenerated({ questions: [вопрос(), ...плохие] }, { lecture: 'L', topics: темы, translate: true });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ topicId: 'L#1', correctIndex: 1, source: { lecture: 'L', at: 130 } });
    expect(warnings).toHaveLength(6);
    // Верных два — тоже не вопрос.
    const два = checkGenerated(
      { questions: [вопрос({ options: (вопрос().options as Array<Record<string, unknown>>).map((o, k) => ({ ...o, correct: k < 2 })) })] },
      { lecture: 'L', topics: темы, translate: true },
    );
    expect(два.warnings[0]).toMatch(/несколько/u);
    // Сдвиг номера, как в первой заготовке: «Верно» в разборе у ловушки.
    const сдвиг = checkGenerated(
      { questions: [вопрос({ options: (вопрос().options as Array<Record<string, unknown>>).map((o, k) => ({ ...o, why: k === 0 ? 'Верно — так в лекции' : String(o.why) })) })] },
      { lecture: 'L', topics: темы, translate: true },
    );
    expect(сдвиг.questions).toHaveLength(0);
    expect(сдвиг.warnings[0]).toMatch(/противоречит/u);
    expect(warnings.join('\n')).toMatch(/четыре[\s\S]*верный[\s\S]*перевода[\s\S]*раздела 9[\s\S]*повторяются[\s\S]*повтор вопроса/u);
  });

  it('место вне своего раздела прижимается к началу раздела и попадает в предупреждения', () => {
    const { questions, warnings } = checkGenerated({ questions: [вопрос({ section: 2, at: '01:00' })] }, { lecture: 'L', topics: темы, translate: true });
    expect(questions[0]?.source.at).toBe(300);
    expect(warnings[0]).toMatch(/вне раздела/u);
  });

  it('карточка на одно понятие — одна, даже из двух пачек; задача без решения — выброшена', () => {
    const r = checkGenerated(
      {
        cards: [
          { section: 1, front: 'ביקוש (спрос)', back: 'x' },
          { section: 2, front: 'ביקוש (Спрос)', back: 'y' },
        ],
        tasks: [{ section: 2, problem: 'посчитай', steps: [], answer: '5' }],
      },
      { lecture: 'L', topics: темы, translate: true },
    );
    expect(r.cards).toHaveLength(1);
    expect(r.tasks).toHaveLength(0);
    expect(parseStamp('1:02:03')).toBe(3723);
    expect(parseStamp('ерунда')).toBeUndefined();
  });

  it('JSON из ответа модели — в блоке и без; вердикт открытого ответа', () => {
    expect(jsonFromReply('Вот:\n```json\n{"questions":[]}\n```')).toEqual({ questions: [] });
    expect(jsonFromReply('{"a":1} конец')).toEqual({ a: 1 });
    expect(() => jsonFromReply('без JSON')).toThrow(/нет JSON/u);
    expect(parseOpenVerdict('```json\n{"verdict":"partial","feedback":"не хватает цены"}\n```')).toEqual({ verdict: 'partial', feedback: 'не хватает цены' });
    expect(() => parseOpenVerdict('{"verdict":"maybe"}')).toThrow(/непонятный/u);
  });
});

/** Лекция в хранилище: свойства, два раздела со временем, «Понятия», организационное и расшифровка. */
async function лекция(root: string): Promise<string> {
  const папка = path.join(root, 'Микро');
  await mkdir(папка, { recursive: true });
  const заметка = path.join(папка, '2026-10-20 — Спрос.md');
  await writeFile(
    заметка,
    [
      '---', 'курс: Микро', 'лекция: 1', 'дата: 2026-10-20', 'начало: "10:00"', 'тема: Спрос', '---',
      '# Спрос', '', '## Кратко', 'О спросе.', '', '## Понятия', '- спрос (ביקוש) — сколько купят', '- цена (מחיר) — что платят', '',
      '## Конспект', '', '### Организационное (00:00–01:00)', '- экзамен в конце', '',
      '### Спрос (01:00–05:00)', '- спрос падает с ценой', '', '### Предложение (05:00–09:00)', '- предложение растёт с ценой', '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(папка, '2026-10-20 — Спрос — расшифровка.md'),
    '# Расшифровка\n\n**[00:10]** מבחן בסוף\n\n**[01:30]** הביקוש יורד\n\n**[05:20]** ההיצע עולה\n',
    'utf8',
  );
  return заметка;
}

describe('заготовка по лекции', () => {
  it('разделы — темы (без организационного), расшифровка — по своим разделам, «Понятия» — отдельно', async () => {
    const root = await временная();
    const src = await readLectureSource(await лекция(root), 'ru');
    expect(src?.topics.map((t) => [t.title, t.from, t.to])).toEqual([
      ['Спрос', 60, 300],
      ['Предложение', 300, 540],
    ]);
    expect(src?.sectionTranscript[0]).toBe('[01:30] הביקוש יורד');
    expect(src?.sectionTranscript[1]).toBe('[05:20] ההיצע עולה');
    expect(src?.concepts).toEqual(['спрос (ביקוש) — сколько купят', 'цена (מחיר) — что платят']);
    expect(sectionBatches(src!, 1)).toEqual([[0], [1]]);
    expect(sectionBatches(src!)).toEqual([[0, 1]]);
  });

  it('банк: по пачке на вызов модели, упавшая пачка — в предупреждения, остальное — в банк', async () => {
    const root = await временная();
    const заметка = await лекция(root);
    const просьбы: string[] = [];
    let раз = 0;
    const bank = await generateLectureBank(заметка, {
      lectureLanguage: 'he',
      notes: 'ru',
      now: T0,
      summarize: async (prompt) => {
        просьбы.push(prompt);
        раз += 1;
        return JSON.stringify({ questions: [вопрос({ section: 1, at: '01:30' }), вопрос({ section: 2, at: '05:20', prompt: 'מהו היצע?' })], cards: [{ section: 1, at: '01:30', front: 'ביקוש', back: 'спрос' }] });
      },
    });
    expect(раз).toBe(1);
    expect(просьбы[0]).toMatch(/РАЗДЕЛ 1: Спрос \(01:00–05:00\)[\s\S]*\[01:30\] הביקוש יורד/u);
    expect(просьбы[0]).not.toMatch(/Организационное/u);
    expect(просьбы[0]).toMatch(/на иврите[\s\S]*promptRu/u);
    expect(bank).toMatchObject({ course: 'Микро', number: 1, date: '2026-10-20', lecture: '2026-10-20 — Спрос' });
    expect(bank?.questions.map((q) => q.topicId)).toEqual(['2026-10-20 — Спрос#1', '2026-10-20 — Спрос#2']);
    expect(bank?.cards).toHaveLength(1);

    await expect(
      generateLectureBank(заметка, { lectureLanguage: 'he', notes: 'ru', summarize: async () => 'не JSON' }),
    ).rejects.toThrow(/заготовка не вышла/u);
  });
});

describe('служба учёбы: сегодня, квиз, карточки, экзамен, задачи', () => {
  async function служба() {
    const vault = await временная();
    const data = await временная();
    const заметка = await лекция(vault);
    await writeFile(path.join(vault, 'Микро', 'Микро.md'), "---\nкурс: 'Микро'\nиврит: 'מיקרו'\nрасписание: 'вт 10:00-13:00'\nэкзамен: 2026-11-10\n---\n# Микро\n", 'utf8');
    const store = new StudyStore(path.join(data, 'study'));
    const bank = await generateLectureBank(заметка, {
      lectureLanguage: 'he',
      notes: 'ru',
      summarize: async () =>
        JSON.stringify({
          questions: [вопрос({ section: 1, at: '01:30' }), вопрос({ section: 2, at: '05:20', prompt: 'מהו היצע?' })],
          cards: [{ section: 1, at: '01:30', front: 'ביקוש', back: 'спрос' }],
          tasks: [{ section: 2, at: '05:30', problem: 'P=5, Q?', hint: 'подставь', steps: ['Q = 10 - P'], answer: '5' }],
        }),
    });
    store.saveBank(bank!);
    let now = T0;
    const s = new StudyService({
      store,
      vaultRoot: () => vault,
      notes: 'ru',
      now: () => now,
      summarize: async (prompt) => (prompt.includes('Ответ студента: количество') ? '{"verdict":"correct","feedback":"верно"}' : '{"verdict":"wrong","feedback":"нет"}'),
    });
    return { s, store, заметка, vault, tick: (ms: number) => { now += ms; } };
  }

  it('сегодня: пары по расписанию, новый квиз, карточки, экзамен через 21 день, задачи', async () => {
    const { s } = await служба();
    const сегодня = s.today();
    expect(сегодня.classes).toEqual([{ course: 'Микро', time: '10:00' }]);
    expect(сегодня.items.map((i) => i.kind)).toEqual(['cards', 'exam', 'quiz', 'tasks']);
    expect(сегодня.items[1]?.title).toMatch(/через 21 дн/u);
    const курс = s.course('Микро');
    expect(курс).toMatchObject({ hebrew: 'מיקרו', schedule: 'вт 10:00', dueCards: 1, unprepared: [] });
    expect(курс.lectures[0]?.topics.map((t) => t.state)).toEqual(['covered', 'covered']);
  });

  it('квиз: верный вариант окну не отдаётся до ответа; ошибка — в карточки; тема слабеет', async () => {
    const { s, store } = await служба();
    const квиз = s.startQuiz({ course: 'Микро', topic: '2026-10-20 — Спрос#1' });
    expect(квиз.questions).toHaveLength(1);
    expect(JSON.stringify(квиз.questions)).not.toMatch(/correct|rationale|why|explanation/u);
    const верный = квиз.questions[0]!.options.findIndex((o) => o.text === 'כמות מבוקשת במחיר');
    const неверный = (верный + 1) % 4;
    const отзыв = s.answerQuiz(квиз.id, 0, неверный);
    expect(отзыв).toMatchObject({ correct: false, correctIndex: верный, source: { label: 'лекция 1, 01:30', at: 90 } });
    expect(отзыв.rationales[верный]).toBe('да');
    // Повторный ответ не пишет второе свидетельство.
    s.answerQuiz(квиз.id, 0, верный);
    const p = store.progress('Микро');
    expect(p.events).toHaveLength(1);
    expect(p.extraCards).toHaveLength(1);
    expect(p.extraCards[0]?.origin).toBe('mistake');
    expect(s.dueCards('Микро')).toHaveLength(2);
  });

  it('открытый ответ проверяет модель по лекции: «верно» — удача, «неверно» — ещё и карточка', async () => {
    const { s, store } = await служба();
    const квиз = s.startQuiz({ course: 'Микро', lecture: '2026-10-20 — Спрос' });
    const r1 = await s.checkOpen(квиз.id, 0, 'количество, которое купят');
    expect(r1.verdict).toBe('correct');
    const r2 = await s.checkOpen(квиз.id, 1, 'не знаю');
    expect(r2.verdict).toBe('wrong');
    const p = store.progress('Микро');
    expect(p.events.map((e) => [e.kind, e.outcome])).toEqual([
      ['explanation', 'success'],
      ['explanation', 'failure'],
    ]);
    expect(p.extraCards).toHaveLength(1);
  });

  it('карточки: «знаю» уводит карточку на завтра и пишет свидетельство вспоминания', async () => {
    const { s, store, tick } = await служба();
    const [карта] = s.dueCards();
    s.reviewCard('Микро', карта!.id, 'know');
    expect(s.dueCards('Микро')).toHaveLength(0);
    tick(ДЕНЬ + 1);
    expect(s.dueCards('Микро')).toHaveLength(1);
    expect(store.progress('Микро').events[0]).toMatchObject({ kind: 'recall', source: 'card', outcome: 'success' });
  });

  it('экзамен: разбора до сдачи нет; не отвеченное не выдумывается; время вышло — ответы не принимаются', async () => {
    const { s, store, tick } = await служба();
    const экзамен = s.startExam('Микро', 10, 1);
    expect(экзамен.questions).toHaveLength(2);
    s.answerExam(экзамен.id, 0, 0);
    tick(2 * 60_000);
    s.answerExam(экзамен.id, 1, 0);
    const итог = s.submitExam(экзамен.id);
    expect(итог).toMatchObject({ total: 2, answered: 1, timedOut: true });
    expect(итог.chosen).toEqual([0, null]);
    const p = store.progress('Микро');
    expect(p.events.filter((e) => e.source === 'exam')).toHaveLength(1);
    expect(p.exams).toHaveLength(1);
    expect(() => s.answerExam(экзамен.id, 0, 1)).toThrow(/уже сдан/u);
  });

  it('задачи: решил — отмечено; лекция без банка — в «не заготовлено»', async () => {
    const { s, store, vault } = await служба();
    const [задача] = s.tasks('Микро');
    expect(задача).toMatchObject({ problem: 'P=5, Q?', solved: false, topic: 'Предложение' });
    s.markTask('Микро', задача!.id, true);
    expect(s.tasks('Микро')[0]?.solved).toBe(true);
    expect(store.progress('Микро').events[0]).toMatchObject({ kind: 'application', source: 'task' });

    await writeFile(
      path.join(vault, 'Микро', '2026-10-27 — Эластичность.md'),
      '---\nкурс: Микро\nлекция: 2\nдата: 2026-10-27\nтема: Эластичность\n---\n# Эластичность\n',
      'utf8',
    );
    expect(s.course('Микро').unprepared).toEqual([
      expect.objectContaining({ lecture: '2026-10-27 — Эластичность', number: 2, topic: 'Эластичность' }),
    ]);
    // Прогресс пишется атомарно: файл цел и читается.
    expect(JSON.parse(await readFile(path.join(store.root, 'Микро', 'progress.json'), 'utf8')).version).toBe(1);
  });
});
