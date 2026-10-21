import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../lecture/courses';
import { generateLectureBank, jsonFromReply, readLectureSource, sectionBatches } from './generate';
import { topicKnowledge } from './knowledge';
import { parseOpenVerdict } from './openAnswer';
import { checkGenerated, parseStamp } from './quality';
import { StudyService, type StudyServiceOptions } from './service';
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
  async function служба(extra: Partial<StudyServiceOptions> = {}) {
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
      ...extra,
    });
    return { s, store, заметка, vault, tick: (ms: number) => { now += ms; } };
  }

  it('«Изменить» с новым названием: папка, страница, ссылки в лекциях и вся учёба переезжают', async () => {
    const { s, store, vault, заметка } = await служба();
    // Ссылка на страницу курса — как её ставит конспект.
    const было = await readFile(заметка, 'utf8');
    await writeFile(заметка, было.replace('# Спрос\n', '# Спрос\nРасшифровка: [[2026-10-20 — Спрос — расшифровка]] · [[Микро]]\n'), 'utf8');
    const квиз = s.startQuiz({ course: 'Микро', topic: '2026-10-20 — Спрос#1' });
    s.answerQuiz(квиз.id, 0, квиз.questions[0]!.options.findIndex((o) => o.text !== 'כמות מבוקשת במחיר'));
    const прогресс = store.progress('Микро');
    expect(прогресс.events).toHaveLength(1);
    const курсДо = s.course('Микро');

    expect(await s.editCourse('Микро', { name: 'Микроэкономика', hebrew: 'מיקרו כלכלה', code: '' })).toBe('Микроэкономика');

    // Хранилище: папка и страница под новым именем, всё прежнее на странице цело.
    expect(existsSync(path.join(vault, 'Микро'))).toBe(false);
    const страница = await readFile(path.join(vault, 'Микроэкономика', 'Микроэкономика.md'), 'utf8');
    expect(страница).toContain("курс: 'Микроэкономика'");
    expect(страница).toContain("иврит: 'מיקרו כלכלה'");
    expect(страница).toContain("расписание: 'вт 10:00-13:00'");
    expect(страница).toMatch(/^# Микроэкономика$/mu);
    const новаяЗаметка = path.join(vault, 'Микроэкономика', '2026-10-20 — Спрос.md');
    const текст = await readFile(новаяЗаметка, 'utf8');
    expect(parseFrontmatter(текст)?.course).toBe('Микроэкономика');
    expect(текст).toContain('· [[Микроэкономика]]');
    expect(текст).not.toContain('[[Микро]]');
    expect(existsSync(path.join(vault, 'Микроэкономика', '2026-10-20 — Спрос — расшифровка.md'))).toBe(true);

    // Учёба: банк, прогресс и карточка ошибки — под новым именем, старого нет.
    expect(store.courses()).toEqual(['Микроэкономика']);
    expect(store.progress('Микроэкономика')).toEqual(прогресс);
    expect(store.banks('Микроэкономика')[0]).toMatchObject({
      course: 'Микроэкономика',
      notesFile: новаяЗаметка,
      audioFile: path.join(vault, 'Микроэкономика', '2026-10-20 — Спрос.wav'),
    });
    const курсПосле = s.course('Микроэкономика');
    expect(курсПосле).toMatchObject({ counts: курсДо.counts, dueCards: курсДо.dueCards, lectureCount: 1, unprepared: [] });
    expect(курсПосле.lectures[0]?.topics.map((t) => t.state)).toEqual(курсДо.lectures[0]?.topics.map((t) => t.state));
    expect(s.today().courses.map((c) => c.name)).toEqual(['Микроэкономика']);
    expect(s.startQuiz({ course: 'Микроэкономика' }).questions).toHaveLength(2);
    // Квиз, начатый до переименования, закрыт: ответ не заведёт курс-призрак под старым именем.
    expect(() => s.answerQuiz(квиз.id, 0, 0)).toThrow(/нет/u);
    expect(store.courses()).toEqual(['Микроэкономика']);

    // Без нового названия — только свойства, имя то же.
    expect(await s.editCourse('Микроэкономика', { name: 'Микроэкономика', hebrew: '', code: '66-1' })).toBe('Микроэкономика');
    expect(s.course('Микроэкономика')).toMatchObject({ hebrew: undefined, code: '66-1' });
  });

  it('новое название занято, пустое или «Без курса» — понятная ошибка, и ничего не тронуто', async () => {
    const { s, store, vault } = await служба();
    s.createCourse('Статистика');
    await expect(s.renameCourse('Микро', 'статистика')).rejects.toThrow(/уже есть/u);
    await expect(s.renameCourse('Микро', 'Без курса')).rejects.toThrow(/без курса/u);
    await expect(s.renameCourse('Микро', ' / ')).rejects.toThrow(/пустое/u);
    await expect(s.renameCourse('Физика', 'Химия')).rejects.toThrow(/нет/u);
    expect(existsSync(path.join(vault, 'Микро', 'Микро.md'))).toBe(true);
    expect(existsSync(path.join(vault, 'Статистика', 'Статистика.md'))).toBe(true);
    expect(store.courses()).toEqual(['Микро']);
    // Имя, которое Windows не пускает в папку, приводится, а не роняет правку.
    expect(await s.renameCourse('Микро', 'Микро: введение')).toBe('Микро введение');
    expect(store.courses()).toEqual(['Микро введение']);
  });

  it('звук лекции: размер в карточке, «▶» только пока он есть, удаление насовсем — по одной и скопом', async () => {
    const { s, vault, заметка } = await служба({ recordingsAutoDays: () => 7 });
    const звук = path.join(vault, 'Микро', '2026-10-20 — Спрос.wav');
    expect(s.recordings()).toEqual({ count: 0, bytes: 0, deletable: 0, deletableBytes: 0, autoDays: 7 });
    await writeFile(звук, Buffer.alloc(4096));
    expect(s.course('Микро').lectures[0]?.audio).toEqual({ bytes: 4096 });
    expect(s.recordings()).toMatchObject({ count: 1, bytes: 4096, deletable: 1 });
    const квиз = s.startQuiz({ course: 'Микро', topic: '2026-10-20 — Спрос#1' });
    expect(s.answerQuiz(квиз.id, 0, 0).source.audioFile).toBe(звук);

    // Чужой файл мимо «Лекций» удалить нельзя.
    await expect(s.deleteRecording(path.join(path.dirname(vault), 'чужое.md'))).rejects.toThrow(/не лекция/u);
    expect(await s.deleteRecording(заметка)).toEqual({ bytes: 4096 });
    expect(existsSync(звук)).toBe(false);
    expect(s.course('Микро').lectures[0]?.audio).toBeUndefined();
    // Звука нет — кнопки «▶» нет: немой проигрыватель хуже никакого.
    const ещё = s.startQuiz({ course: 'Микро', topic: '2026-10-20 — Спрос#1' });
    expect(s.answerQuiz(ещё.id, 0, 0).source.audioFile).toBeUndefined();
    await expect(s.deleteRecording(заметка)).rejects.toThrow(/уже нет/u);

    await writeFile(звук, Buffer.alloc(100));
    expect(await s.deleteAllRecordings()).toEqual({ deleted: 1, bytes: 100, kept: 0, failed: 0 });
  });

  it('«Перенести…»: лекция с вопросами, карточками и прогрессом переезжает в другой курс', async () => {
    const { s, store, vault, заметка } = await служба();
    await writeFile(path.join(vault, 'Микро', '2026-10-20 — Спрос.wav'), Buffer.alloc(10));
    const квиз = s.startQuiz({ course: 'Микро', topic: '2026-10-20 — Спрос#1' });
    s.answerQuiz(квиз.id, 0, 0);
    s.addCardFromQuestion(квиз.id, 0);
    s.createCourse('Макро');

    expect(await s.moveLecture(заметка, 'макро')).toEqual({ course: 'Макро' });
    const новая = path.join(vault, 'Макро', '2026-10-20 — Спрос.md');
    expect(parseFrontmatter(await readFile(новая, 'utf8'))?.course).toBe('Макро');
    expect(existsSync(path.join(vault, 'Макро', '2026-10-20 — Спрос.wav'))).toBe(true);
    expect(existsSync(заметка)).toBe(false);
    // Учёба — вслед за лекцией: банк с новыми путями, ответы и карточка из ошибки.
    expect(store.banks('Микро')).toEqual([]);
    expect(store.banks('Макро')[0]).toMatchObject({ course: 'Макро', notesFile: новая, audioFile: path.join(vault, 'Макро', '2026-10-20 — Спрос.wav') });
    expect(store.progress('Микро').events).toEqual([]);
    expect(store.progress('Микро').extraCards).toEqual([]);
    expect(store.progress('Макро').events).toHaveLength(1);
    expect(store.progress('Макро').extraCards).toHaveLength(1);
    expect(s.course('Макро').lectures).toHaveLength(1);
    expect(s.course('Микро')).toMatchObject({ lectures: [], unprepared: [] });
    // Квиз, начатый до переноса, закрыт: ответ записал бы прогресс в прежний курс.
    expect(() => s.answerQuiz(квиз.id, 1, 0)).toThrow(/нет/u);
  });

  it('«Без курса» виден в окне, пока там есть лекции, и разносится по курсам', async () => {
    const { s, vault } = await служба();
    const папка = path.join(vault, 'Без курса');
    await mkdir(папка, { recursive: true });
    const заметка = path.join(папка, '2026-10-21.md');
    await writeFile(заметка, "---\nкурс: 'Без курса'\nлекция: 1\nдата: 2026-10-21\n---\n# Лекция\n", 'utf8');
    expect(s.today().courses.at(-1)).toMatchObject({ name: 'Без курса', unsorted: true, lectures: 1 });
    expect(s.course('Без курса')).toMatchObject({ unsorted: true, unprepared: [{ notesFile: заметка }] });

    await expect(s.moveLecture(заметка, 'Без курса')).rejects.toThrow(/Без курса/u);
    await expect(s.moveLecture(path.join(path.dirname(vault), 'чужое.md'), 'Микро')).rejects.toThrow(/не лекция/u);
    expect(await s.moveLecture(заметка, 'Микро')).toEqual({ course: 'Микро' });
    expect(s.today().courses.map((c) => c.name)).toEqual(['Микро']);
    // Плитка считает и лекции без вопросов: «лекций: 0» при записанных парах врало.
    expect(s.today().courses[0]?.lectures).toBe(2);
  });

  it('пока конспект дописывается, звук не трогается', async () => {
    const { s, vault, заметка } = await служба({ audioBusy: () => 'Сейчас дописывается конспект' });
    await writeFile(path.join(vault, 'Микро', '2026-10-20 — Спрос.wav'), Buffer.alloc(10));
    await expect(s.deleteRecording(заметка)).rejects.toThrow(/дописывается/u);
    await expect(s.deleteAllRecordings()).rejects.toThrow(/дописывается/u);
    expect(existsSync(path.join(vault, 'Микро', '2026-10-20 — Спрос.wav'))).toBe(true);
  });

  it('курс, в который пишется конспект, не переименовать и не удалить', async () => {
    const { s, vault } = await служба({
      busy: () => 'Сейчас идёт конспект',
      trash: async () => {
        throw new Error('в Корзину не должен');
      },
    });
    await expect(s.renameCourse('Микро', 'Макро')).rejects.toThrow(/идёт конспект/u);
    await expect(s.deleteCourse('Микро')).rejects.toThrow(/идёт конспект/u);
    expect(existsSync(path.join(vault, 'Микро', 'Микро.md'))).toBe(true);
  });

  it('удаление: папка курса с лекциями и учёба курса — в Корзину, а не насовсем; пустой курс — так же', async () => {
    const корзина = await временная();
    const ушло: string[] = [];
    const { s, store, vault } = await служба({
      trash: async (file) => {
        ушло.push(file);
        await rename(file, path.join(корзина, `${ушло.length} ${path.basename(file)}`));
      },
    });
    expect(s.course('Микро').lectureCount).toBe(1);
    expect(await s.deleteCourse('Микро')).toEqual({ lectures: 1 });
    expect(ушло).toEqual([path.join(vault, 'Микро'), store.courseDir('Микро')]);
    expect(existsSync(path.join(vault, 'Микро'))).toBe(false);
    expect(store.courses()).toEqual([]);
    expect(s.today().courses).toEqual([]);
    // Лекция цела — в Корзине с расшифровкой рядом; банк вопросов — тоже там.
    expect(existsSync(path.join(корзина, '1 Микро', '2026-10-20 — Спрос.md'))).toBe(true);
    expect(existsSync(path.join(корзина, '1 Микро', '2026-10-20 — Спрос — расшифровка.md'))).toBe(true);
    expect(await readdir(path.join(корзина, '2 Микро'))).toEqual(['2026-10-20 — Спрос.json']);

    s.createCourse('Пустой');
    expect(s.course('Пустой').lectureCount).toBe(0);
    expect(await s.deleteCourse('Пустой')).toEqual({ lectures: 0 });
    expect(existsSync(path.join(vault, 'Пустой'))).toBe(false);
    await expect(s.deleteCourse('Пустой')).rejects.toThrow(/нет/u);
  });

  it('языки курса: свои на странице курса, пусто — как в настройках; непонятный язык — ошибка', async () => {
    const { s, vault } = await служба({ languages: () => ({ lecture: 'he', notes: 'ru' }) });
    expect(s.course('Микро')).toMatchObject({ language: undefined, notesLanguage: undefined, defaults: { lecture: 'he', notes: 'ru' } });
    s.setCourseLanguages('Микро', 'en', 'en');
    const страница = await readFile(path.join(vault, 'Микро', 'Микро.md'), 'utf8');
    expect(страница).toContain('язык: en');
    expect(страница).toContain('конспект: en');
    expect(страница).toContain("иврит: 'מיקרו'");
    expect(s.course('Микро')).toMatchObject({ language: 'en', notesLanguage: 'en' });
    s.setCourseLanguages('Микро', '', '');
    expect(s.course('Микро')).toMatchObject({ language: undefined, notesLanguage: undefined });
    expect(await readFile(path.join(vault, 'Микро', 'Микро.md'), 'utf8')).not.toMatch(/язык|конспект/u);
    expect(() => s.setCourseLanguages('Микро', 'english', '')).toThrow(/язык лекций/u);
    expect(() => s.setCourseLanguages('Микро', '', 'he')).toThrow(/по-русски или по-английски/u);
    expect(s.createCourse('English Literature', { language: 'en', notesLanguage: 'en' })).toBe('English Literature');
    expect(s.course('English Literature')).toMatchObject({ language: 'en', notesLanguage: 'en' });
  });

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

  it('кнопки окна: экзамен, расписание, новый курс — в страницу курса; остальное на странице цело', async () => {
    const { s, vault } = await служба();
    await writeFile(path.join(vault, 'Микро', 'Микро.md'), "---\nкурс: 'Микро'\nиврит: 'מיקרו'\n---\n# Микро\n\nМои заметки о курсе.\n", 'utf8');
    s.setExam('Микро', '2027-02-10');
    s.setSchedule('Микро', [
      { day: 4, from: 600, to: 720 },
      { day: 2, from: 960, to: 1140 },
    ]);
    const страница = await readFile(path.join(vault, 'Микро', 'Микро.md'), 'utf8');
    expect(страница).toContain("иврит: 'מיקרו'");
    expect(страница).toContain('экзамен: 2027-02-10');
    expect(страница).toContain("расписание: 'вт 16:00-19:00; чт 10:00-12:00'");
    expect(страница).toContain('Мои заметки о курсе.');
    expect(s.course('Микро')).toMatchObject({ exam: '2027-02-10', schedule: 'вт 16:00, чт 10:00' });
    s.setExam('Микро', null);
    expect(s.course('Микро').exam).toBeUndefined();
    expect(() => s.setExam('Микро', '10.02.2027')).toThrow(/ГГГГ-ММ-ДД/u);
    expect(() => s.setSchedule('Микро', [{ day: 2, from: 900, to: 800 }])).toThrow(/задом наперёд/u);

    expect(s.createCourse('Статистика', { hebrew: 'סטטיסטיקה', code: '66-4104' })).toBe('Статистика');
    expect(s.course('Статистика')).toMatchObject({ hebrew: 'סטטיסטיקה', code: '66-4104', lectures: [] });
    expect(() => s.createCourse('статистика')).toThrow(/уже есть/u);
  });

  it('«в карточки» у верного ответа — карточка вручную, одна', async () => {
    const { s, store } = await служба();
    const квиз = s.startQuiz({ course: 'Микро', topic: '2026-10-20 — Спрос#1' });
    const верный = квиз.questions[0]!.options.findIndex((o) => o.text === 'כמות מבוקשת במחיר');
    s.answerQuiz(квиз.id, 0, верный);
    s.addCardFromQuestion(квиз.id, 0);
    s.addCardFromQuestion(квиз.id, 0);
    expect(store.progress('Микро').extraCards.map((c) => c.origin)).toEqual(['manual']);
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
