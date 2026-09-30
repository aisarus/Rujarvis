/**
 * Учёба как её видит окно: «Сегодня», курсы с темами, квиз, карточки,
 * экзамен, задачи.
 *
 * Здесь нет ни окна, ни модели напрямую: банки и прогресс — из `StudyStore`,
 * курсы, расписание и экзамены — со страниц курсов в хранилище Obsidian,
 * проверка открытого ответа — через переданный `summarize`. Верный вариант
 * вопроса окну не отдаётся до ответа: сессия держит его здесь.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { listCourses, listLectures, readCourseInfo, writeCourseInfo, type CourseInfo, type CourseSlot } from '../lecture/courses';
import { sectionTitle, type NotesLanguage } from '../lecture/session';
import { readLectureSource } from './generate';
import { STATE_PRIORITY, topicKnowledge, type ForgettingRisk, type KnowledgeState } from './knowledge';
import { openAnswerPrompt, parseOpenVerdict, type OpenVerdict } from './openAnswer';
import { isDue, newCardState, reviewCard } from './srs';
import type { StudyStore } from './store';
import type { CourseProgress, EvidenceEvent, LectureBank, QuizQuestion, SourceRef, StudyCard, StudyTopic } from './types';

const ДЕНЬ = 24 * 60 * 60 * 1000;
const ДНИ = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export interface StudyServiceOptions {
  store: StudyStore;
  /** Папка «Лекции» в хранилище — курсы, расписание, экзамены. */
  vaultRoot: () => string;
  /** Проверка открытого ответа моделью. */
  summarize?: (prompt: string) => Promise<string>;
  /** Язык конспектов — по нему ищется раздел «Конспект» в заметке. */
  notes: NotesLanguage;
  now?: () => number;
}

export interface TopicView {
  id: string;
  title: string;
  state: KnowledgeState;
  risk: ForgettingRisk;
  failures: number;
  dueCards: number;
  questions: number;
  tasks: number;
}

export interface LectureView {
  lecture: string;
  number?: number;
  date: string;
  topic?: string;
  notesFile: string;
  quizzed: boolean;
  topics: TopicView[];
}

export interface CourseView {
  name: string;
  code?: string;
  hebrew?: string;
  credits?: number;
  lecturer?: string;
  schedule: string;
  /** Пары — для правки в окне. */
  slots: CourseSlot[];
  exam?: string;
  daysToExam?: number;
  dueCards: number;
  counts: Record<KnowledgeState, number>;
  lectures: LectureView[];
  /** Лекции курса в хранилище, к которым учёба ещё не заготовлена; `empty` — в конспекте нет материала. */
  unprepared: Array<{ lecture: string; notesFile: string; date: string; number?: number; topic?: string; empty: boolean }>;
}

export type StudyAction =
  | { type: 'cards'; course?: string }
  | { type: 'quiz'; course: string; lecture?: string; topic?: string }
  | { type: 'exam'; course: string }
  | { type: 'tasks'; course: string; lecture?: string };

export interface TodayItem {
  kind: 'cards' | 'quiz' | 'weak' | 'refresh' | 'exam' | 'tasks';
  title: string;
  detail: string;
  action: StudyAction;
}

export interface TodayView {
  date: string;
  classes: Array<{ course: string; time: string }>;
  items: TodayItem[];
  courses: Array<{ name: string; counts: Record<KnowledgeState, number>; lectures: number; dueCards: number }>;
}

/** Вопрос как его видит окно: без верного ответа, варианты перемешаны. */
export interface PublicQuestion {
  prompt: string;
  promptTranslation?: string;
  options: Array<{ text: string; translation?: string }>;
  topic: string;
  lecture: string;
}

export interface AnswerFeedback {
  correct: boolean;
  correctIndex: number;
  rationales: string[];
  explanation: string;
  memoryHint: string;
  source: SourceView;
}

export interface SourceView {
  label: string;
  at?: number;
  notesFile?: string;
  audioFile?: string;
}

interface Вопрос {
  course: string;
  q: QuizQuestion;
  /** Порядок вариантов, каким его видит окно: индекс в исходном вопросе. */
  order: number[];
  bank: LectureBank;
  chosen?: number;
}

interface Сессия {
  id: string;
  kind: 'quiz' | 'exam';
  course: string;
  items: Вопрос[];
  startedAt: number;
  deadline?: number;
  finished?: boolean;
}

export interface CardView {
  id: string;
  course: string;
  front: string;
  back: string;
  topic: string;
  source: SourceView;
}

export interface TaskView {
  id: string;
  course: string;
  topic: string;
  problem: string;
  hint: string;
  steps: string[];
  answer: string;
  solved: boolean;
  source: SourceView;
}

function пустыеСчёты(): Record<KnowledgeState, number> {
  return { unseen: 0, covered: 0, fragile: 0, weak: 0, strong: 0 };
}

function перемешать<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Есть ли в конспекте разделы с материалом — не одно организационное. */
function естьМатериал(notesFile: string): boolean {
  try {
    const текст = readFileSync(notesFile, 'utf8');
    const место = Math.max(текст.indexOf('## Конспект'), текст.indexOf('## Notes'));
    if (место < 0) return false;
    return [...текст.slice(место).matchAll(/^###[ \t]+(.+)$/gmu)].some((m) => !/^(организационное|course logistics)/iu.test(sectionTitle(m[1] ?? '')));
  } catch {
    return false;
  }
}

function время(минут: number): string {
  return `${String(Math.floor(минут / 60)).padStart(2, '0')}:${String(минут % 60).padStart(2, '0')}`;
}

export class StudyService {
  private readonly сессии = new Map<string, Сессия>();

  constructor(private readonly o: StudyServiceOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Курсы: из хранилища (страницы курсов) и из заготовок — вместе. */
  private курсы(): string[] {
    const из = new Set([...listCourses(this.o.vaultRoot()), ...this.o.store.courses()]);
    return [...из].sort((a, b) => a.localeCompare(b));
  }

  private инфо(course: string): CourseInfo {
    return readCourseInfo(this.o.vaultRoot(), course);
  }

  private все(course: string): { banks: LectureBank[]; progress: CourseProgress; cards: StudyCard[] } {
    const banks = this.o.store.banks(course);
    const progress = this.o.store.progress(course);
    return { banks, progress, cards: [...banks.flatMap((b) => b.cards), ...progress.extraCards] };
  }

  private источник(bank: LectureBank | undefined, source: SourceRef): SourceView {
    const номер = bank?.number ? `лекция ${bank.number}` : bank?.date ?? source.lecture;
    const мм = source.at !== undefined ? `, ${String(Math.floor(source.at / 60)).padStart(2, '0')}:${String(source.at % 60).padStart(2, '0')}` : '';
    return { label: `${номер}${мм}`, at: source.at, notesFile: bank?.notesFile, audioFile: bank?.audioFile };
  }

  private темы(banks: LectureBank[], progress: CourseProgress, cards: StudyCard[]): Map<string, TopicView> {
    const now = this.now();
    const события = new Map<string, EvidenceEvent[]>();
    for (const e of progress.events) события.set(e.topicId, [...(события.get(e.topicId) ?? []), e]);
    const out = new Map<string, TopicView>();
    for (const b of banks) {
      for (const t of b.topics) {
        const вопросов = b.questions.filter((q) => q.topicId === t.id).length;
        const карточек = cards.filter((c) => c.topicId === t.id);
        const задач = b.tasks.filter((x) => x.topicId === t.id).length;
        const k = topicKnowledge(события.get(t.id) ?? [], вопросов + карточек.length + задач > 0, now);
        out.set(t.id, {
          id: t.id,
          title: t.title,
          state: k.state,
          risk: k.risk,
          failures: k.failures,
          dueCards: карточек.filter((c) => isDue(progress.cards[c.id], now)).length,
          questions: вопросов,
          tasks: задач,
        });
      }
    }
    return out;
  }

  course(name: string): CourseView {
    const инфо = this.инфо(name);
    const { banks, progress, cards } = this.все(name);
    const темы = this.темы(banks, progress, cards);
    const counts = пустыеСчёты();
    for (const t of темы.values()) counts[t.state] += 1;
    const спрошено = new Set(progress.events.map((e) => e.itemId));
    const daysToExam = инфо.exam ? Math.ceil((new Date(`${инфо.exam}T09:00:00`).getTime() - this.now()) / ДЕНЬ) : undefined;
    return {
      name,
      code: инфо.code,
      hebrew: инфо.hebrew,
      credits: инфо.credits,
      lecturer: инфо.lecturer,
      schedule: инфо.slots.map((s) => `${ДНИ[s.day]} ${время(s.from)}`).join(', '),
      slots: инфо.slots,
      exam: инфо.exam,
      daysToExam,
      dueCards: [...темы.values()].reduce((n, t) => n + t.dueCards, 0),
      counts,
      lectures: banks.map((b) => ({
        lecture: b.lecture,
        number: b.number,
        date: b.date,
        topic: b.topic,
        notesFile: b.notesFile,
        quizzed: b.questions.some((q) => спрошено.has(q.id)),
        topics: b.topics.map((t) => темы.get(t.id)).filter((t): t is TopicView => Boolean(t)),
      })),
      unprepared: listLectures(this.o.vaultRoot(), name)
        .map((л) => ({ lecture: path.basename(л.file, '.md'), notesFile: л.file, date: л.meta.date, number: л.meta.number, topic: л.meta.topic, empty: !естьМатериал(л.file) }))
        .filter((л) => !banks.some((b) => b.lecture === л.lecture)),
    };
  }

  today(): TodayView {
    const now = this.now();
    const сегодня = new Date(now);
    const items: TodayItem[] = [];
    const classes: TodayView['classes'] = [];
    const courses: TodayView['courses'] = [];
    let карточек = 0;
    const слабые: Array<{ course: string; t: TopicView }> = [];
    const освежить: Array<{ course: string; t: TopicView }> = [];

    for (const name of this.курсы()) {
      const инфо = this.инфо(name);
      for (const s of инфо.slots) if (s.day === сегодня.getDay()) classes.push({ course: name, time: время(s.from) });
      const вид = this.course(name);
      карточек += вид.dueCards;
      courses.push({ name, counts: вид.counts, lectures: вид.lectures.length, dueCards: вид.dueCards });
      for (const л of вид.lectures) {
        if (!л.quizzed && л.topics.some((t) => t.questions > 0)) {
          items.push({
            kind: 'quiz',
            title: `Квиз: ${name}${л.number ? `, лекция ${л.number}` : ''}`,
            detail: л.topic ? `${л.topic} — ещё не проверял себя` : 'ещё не проверял себя',
            action: { type: 'quiz', course: name, lecture: л.lecture },
          });
        }
        for (const t of л.topics) {
          if (t.state === 'weak') слабые.push({ course: name, t });
          else if (t.risk === 'high' && (t.state === 'strong' || t.state === 'fragile')) освежить.push({ course: name, t });
        }
      }
      if (вид.daysToExam !== undefined && вид.daysToExam >= 0 && вид.daysToExam <= 30) {
        items.unshift({
          kind: 'exam',
          title: `Экзамен: ${name} — через ${вид.daysToExam} дн.`,
          detail: 'тренировка как на экзамене, со слабыми темами чаще',
          action: { type: 'exam', course: name },
        });
      }
      const нерешённых = this.tasks(name).filter((x) => !x.solved).length;
      if (нерешённых > 0 && вид.lectures.length > 0) {
        items.push({ kind: 'tasks', title: `Задачи: ${name}`, detail: `${нерешённых} не решено`, action: { type: 'tasks', course: name } });
      }
    }
    if (карточек > 0) items.unshift({ kind: 'cards', title: `Повторить карточки: ${карточек}`, detail: `около ${Math.max(1, Math.round(карточек / 2))} мин`, action: { type: 'cards' } });
    for (const { course, t } of слабые.sort((a, b) => b.t.failures - a.t.failures).slice(0, 3)) {
      items.push({ kind: 'weak', title: `Слабое место: ${t.title}`, detail: `${course} · ошибок: ${t.failures}`, action: { type: 'quiz', course, topic: t.id } });
    }
    for (const { course, t } of освежить.slice(0, 2)) {
      items.push({ kind: 'refresh', title: `Освежить: ${t.title}`, detail: `${course} · давно не повторял`, action: { type: 'quiz', course, topic: t.id } });
    }
    classes.sort((a, b) => a.time.localeCompare(b.time));
    return { date: new Date(now).toISOString().slice(0, 10), classes, items, courses };
  }

  // ——— Квиз и экзамен ———

  private выбрать(course: string, scope: { lecture?: string; topic?: string }, count: number): Вопрос[] {
    const { banks, progress, cards } = this.все(course);
    const все = banks.flatMap((bank) => bank.questions.map((q) => ({ bank, q })));
    const отобраны = все.filter(({ bank, q }) => (!scope.lecture || bank.lecture === scope.lecture) && (!scope.topic || q.topicId === scope.topic));
    let порядок: typeof отобраны;
    if (scope.lecture || scope.topic) {
      порядок = перемешать(отобраны);
    } else {
      // Весь курс: слабые и шаткие темы — первыми, внутри темы — вперемешку.
      const темы = this.темы(banks, progress, cards);
      const приоритет = (topicId: string): number => STATE_PRIORITY[темы.get(topicId)?.state ?? 'covered'];
      порядок = перемешать(отобраны).sort((a, b) => приоритет(a.q.topicId) - приоритет(b.q.topicId));
    }
    return порядок.slice(0, count).map(({ bank, q }) => ({ course, q, bank, order: перемешать([0, 1, 2, 3]) }));
  }

  private публично(items: Вопрос[]): PublicQuestion[] {
    return items.map(({ q, order, bank }) => ({
      prompt: q.prompt,
      promptTranslation: q.promptTranslation,
      options: order.map((i) => ({ text: q.options[i]?.text ?? '', translation: q.options[i]?.translation })),
      topic: bank.topics.find((t) => t.id === q.topicId)?.title ?? '',
      lecture: bank.number ? `лекция ${bank.number}` : bank.date,
    }));
  }

  startQuiz(scope: { course: string; lecture?: string; topic?: string }, count = 10): { id: string; questions: PublicQuestion[] } {
    const items = this.выбрать(scope.course, scope, count);
    const id = randomUUID();
    this.сессии.set(id, { id, kind: 'quiz', course: scope.course, items, startedAt: this.now() });
    return { id, questions: this.публично(items) };
  }

  private записать(course: string, e: Omit<EvidenceEvent, 'id' | 'at'>): void {
    this.o.store.updateProgress(course, (p) => {
      p.events.push({ ...e, id: randomUUID(), at: this.now() });
    });
  }

  private отзыв(item: Вопрос, chosen: number): AnswerFeedback {
    const { q, order, bank } = item;
    const correctIndex = order.indexOf(q.correctIndex);
    return {
      correct: chosen === correctIndex,
      correctIndex,
      rationales: order.map((i) => q.options[i]?.rationale ?? ''),
      explanation: q.explanation,
      memoryHint: q.memoryHint,
      source: this.источник(bank, q.source),
    };
  }

  /** Ответ в квизе: сразу разбор; ошибка сама становится карточкой. */
  answerQuiz(sessionId: string, index: number, chosen: number): AnswerFeedback {
    const s = this.сессии.get(sessionId);
    const item = s?.kind === 'quiz' ? s.items[index] : undefined;
    if (!s || !item) throw new Error('такого вопроса в квизе нет');
    const повтор = item.chosen !== undefined;
    item.chosen = item.chosen ?? chosen;
    const отзыв = this.отзыв(item, item.chosen);
    if (!повтор) {
      this.записать(s.course, { topicId: item.q.topicId, itemId: item.q.id, kind: 'recognition', source: 'quiz', outcome: отзыв.correct ? 'success' : 'failure' });
      if (!отзыв.correct) this.картаОшибки(s.course, item.q);
    }
    return отзыв;
  }

  private картаОшибки(course: string, q: QuizQuestion): void {
    const id = `${q.id}#ошибка`;
    this.o.store.updateProgress(course, (p) => {
      if (p.extraCards.some((c) => c.id === id)) {
        // Та же ошибка снова — карточку показать сейчас же.
        p.cards[id] = newCardState(this.now());
        return;
      }
      const верный = q.options[q.correctIndex];
      p.extraCards.push({
        id,
        topicId: q.topicId,
        front: q.promptTranslation ? `${q.prompt}\n${q.promptTranslation}` : q.prompt,
        back: `${верный?.text ?? ''}${верный?.translation ? ` — ${верный.translation}` : ''}\n${q.explanation}`,
        source: q.source,
        origin: 'mistake',
      });
    });
  }

  /** Открытый ответ голосом или текстом — проверяет модель по лекции. */
  async checkOpen(sessionId: string, index: number, answer: string): Promise<{ verdict: OpenVerdict; feedback: string; feedbackFull: AnswerFeedback }> {
    const s = this.сессии.get(sessionId);
    const item = s?.items[index];
    if (!s || !item) throw new Error('такого вопроса нет');
    if (!answer.trim()) throw new Error('пустой ответ');
    if (!this.o.summarize) throw new Error('проверять открытый ответ нечем');
    const тема = item.bank.topics.findIndex((t) => t.id === item.q.topicId);
    const текст = тема >= 0 ? await this.текстТемы(item.bank, тема) : '';
    const { verdict, feedback } = parseOpenVerdict(await this.o.summarize(openAnswerPrompt(item.q, answer, текст)));
    this.записать(s.course, {
      topicId: item.q.topicId,
      itemId: item.q.id,
      kind: 'explanation',
      source: 'open',
      outcome: verdict === 'correct' ? 'success' : 'failure',
    });
    if (verdict === 'wrong') this.картаОшибки(s.course, item.q);
    item.chosen = item.chosen ?? item.order.indexOf(item.q.correctIndex);
    return { verdict, feedback, feedbackFull: this.отзыв(item, item.chosen) };
  }

  /** Текст темы для проверки — пункты конспекта и расшифровка из заметки лекции. */
  private async текстТемы(bank: LectureBank, номер: number): Promise<string> {
    try {
      const src = await readLectureSource(bank.notesFile, this.o.notes);
      return [src?.sectionText[номер] ?? '', src?.sectionTranscript[номер] ?? ''].filter(Boolean).join('\n');
    } catch {
      return '';
    }
  }

  startExam(course: string, count = 20, minutes = 40): { id: string; deadline: number; questions: PublicQuestion[] } {
    const items = this.выбрать(course, {}, count);
    const id = randomUUID();
    const deadline = this.now() + minutes * 60_000;
    this.сессии.set(id, { id, kind: 'exam', course, items, startedAt: this.now(), deadline });
    return { id, deadline, questions: this.публично(items) };
  }

  /** Ответ на экзамене — без разбора: разбор после сдачи. */
  answerExam(sessionId: string, index: number, chosen: number): void {
    const s = this.сессии.get(sessionId);
    const item = s?.kind === 'exam' && !s.finished ? s.items[index] : undefined;
    if (!item) throw new Error('экзамен уже сдан или вопроса нет');
    if (s?.deadline && this.now() > s.deadline) return;
    item.chosen = chosen;
  }

  submitExam(sessionId: string): { total: number; correct: number; answered: number; timedOut: boolean; review: AnswerFeedback[]; chosen: Array<number | null> } {
    const s = this.сессии.get(sessionId);
    if (!s || s.kind !== 'exam') throw new Error('такого экзамена нет');
    const timedOut = Boolean(s.deadline && this.now() > s.deadline);
    const review = s.items.map((item) => this.отзыв(item, item.chosen ?? -1));
    if (!s.finished) {
      s.finished = true;
      // Без ответа — ни удачи, ни ошибки: не отвеченное не выдумывается.
      for (const [i, item] of s.items.entries()) {
        if (item.chosen === undefined) continue;
        this.записать(s.course, { topicId: item.q.topicId, itemId: item.q.id, kind: 'recognition', source: 'exam', outcome: review[i]?.correct ? 'success' : 'failure' });
        if (!review[i]?.correct) this.картаОшибки(s.course, item.q);
      }
      this.o.store.updateProgress(s.course, (p) => {
        p.exams.push({
          id: s.id,
          startedAt: s.startedAt,
          finishedAt: this.now(),
          total: s.items.length,
          correct: review.filter((r, i) => r.correct && s.items[i]?.chosen !== undefined).length,
          answered: s.items.filter((x) => x.chosen !== undefined).length,
          timedOut,
        });
      });
    }
    return {
      total: s.items.length,
      correct: review.filter((r, i) => r.correct && s.items[i]?.chosen !== undefined).length,
      answered: s.items.filter((x) => x.chosen !== undefined).length,
      timedOut,
      review,
      chosen: s.items.map((x) => x.chosen ?? null),
    };
  }

  // ——— Правка курса кнопками ———

  /** Дата экзамена — в страницу курса; null — убрать. */
  setExam(course: string, date: string | null): void {
    writeCourseInfo(this.o.vaultRoot(), course, { exam: date });
  }

  setSchedule(course: string, slots: CourseSlot[]): void {
    for (const s of slots) {
      if (!Number.isInteger(s.day) || s.day < 0 || s.day > 6 || !(s.from >= 0 && s.to > s.from && s.to <= 24 * 60)) throw new Error('пара без дня или со временем задом наперёд');
    }
    writeCourseInfo(this.o.vaultRoot(), course, { slots: [...slots].sort((a, b) => a.day - b.day || a.from - b.from) });
  }

  /** Новый курс — папка и страница в хранилище. Такой уже есть — ошибка, а не второй. */
  createCourse(name: string, extra: { hebrew?: string; code?: string } = {}): string {
    const имя = name.trim();
    if (!имя) throw new Error('пустое название курса');
    if (this.курсы().some((к) => к.toLowerCase() === имя.toLowerCase())) throw new Error(`курс «${имя}» уже есть`);
    writeCourseInfo(this.o.vaultRoot(), имя, { hebrew: extra.hebrew ?? '', code: extra.code ?? '' });
    return имя;
  }

  /** «В карточки» у вопроса квиза — вопрос на лицевой стороне, ответ с разбором на обороте. */
  addCardFromQuestion(sessionId: string, index: number): void {
    const s = this.сессии.get(sessionId);
    const item = s?.items[index];
    if (!s || !item) throw new Error('такого вопроса нет');
    const id = `${item.q.id}#вручную`;
    this.o.store.updateProgress(s.course, (p) => {
      if (p.extraCards.some((c) => c.id === id || c.id === `${item.q.id}#ошибка`)) return;
      const верный = item.q.options[item.q.correctIndex];
      p.extraCards.push({
        id,
        topicId: item.q.topicId,
        front: item.q.promptTranslation ? `${item.q.prompt}\n${item.q.promptTranslation}` : item.q.prompt,
        back: `${верный?.text ?? ''}${верный?.translation ? ` — ${верный.translation}` : ''}\n${item.q.explanation}`,
        source: item.q.source,
        origin: 'manual',
      });
    });
  }

  // ——— Карточки ———

  dueCards(course?: string, limit = 50): CardView[] {
    const now = this.now();
    const out: CardView[] = [];
    for (const name of course ? [course] : this.курсы()) {
      const { banks, progress, cards } = this.все(name);
      const темы = new Map<string, StudyTopic>(banks.flatMap((b) => b.topics.map((t) => [t.id, t] as const)));
      for (const c of cards) {
        if (!isDue(progress.cards[c.id], now)) continue;
        const bank = banks.find((b) => b.lecture === c.source.lecture);
        out.push({ id: c.id, course: name, front: c.front, back: c.back, topic: темы.get(c.topicId)?.title ?? '', source: this.источник(bank, c.source) });
      }
    }
    // Сначала те, что уже забывались, потом по сроку.
    const состояние = (c: CardView) => this.o.store.progress(c.course).cards[c.id];
    return out
      .map((c) => ({ c, s: состояние(c) }))
      .sort((a, b) => (b.s?.lapses ?? 0) - (a.s?.lapses ?? 0) || (a.s?.due ?? 0) - (b.s?.due ?? 0))
      .map(({ c }) => c)
      .slice(0, limit);
  }

  reviewCard(course: string, cardId: string, verdict: 'again' | 'know'): void {
    const { cards } = this.все(course);
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw new Error('такой карточки нет');
    this.o.store.updateProgress(course, (p) => {
      p.cards[cardId] = reviewCard(p.cards[cardId], verdict, this.now());
      p.events.push({ id: randomUUID(), at: this.now(), topicId: card.topicId, itemId: cardId, kind: 'recall', source: 'card', outcome: verdict === 'know' ? 'success' : 'failure' });
    });
  }

  // ——— Задачи ———

  tasks(course: string, lecture?: string): TaskView[] {
    const { banks, progress } = this.все(course);
    return banks
      .filter((b) => !lecture || b.lecture === lecture)
      .flatMap((b) =>
        b.tasks.map((t) => ({
          id: t.id,
          course,
          topic: b.topics.find((x) => x.id === t.topicId)?.title ?? '',
          problem: t.problem,
          hint: t.hint,
          steps: t.steps,
          answer: t.answer,
          solved: Boolean(progress.solvedTasks[t.id]),
          source: this.источник(b, t.source),
        })),
      );
  }

  /** Решил или нет — со слов человека: такое свидетельство «знаю» одно не даст. */
  markTask(course: string, taskId: string, solved: boolean): void {
    const task = this.o.store.banks(course).flatMap((b) => b.tasks).find((t) => t.id === taskId);
    if (!task) throw new Error('такой задачи нет');
    this.o.store.updateProgress(course, (p) => {
      if (solved) p.solvedTasks[taskId] = this.now();
      else delete p.solvedTasks[taskId];
      p.events.push({ id: randomUUID(), at: this.now(), topicId: task.topicId, itemId: taskId, kind: 'application', source: 'task', outcome: solved ? 'success' : 'failure' });
    });
  }
}

/** Где банки учёбы: `data\study` в папке Джарвиса. */
export function studyRoot(dataDir: string): string {
  return path.join(dataDir, 'study');
}
