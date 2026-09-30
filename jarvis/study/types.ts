/**
 * Учёба по конспектам: что лежит в банке лекции и что знает прогресс.
 *
 * Банк лекции — вопросы, карточки и задачи, заготовленные моделью после
 * лекции (`generate.ts`). Он не меняется, пока лекцию не заготовят заново.
 * Прогресс курса — что человек отвечал, когда и с каким итогом; из него
 * считается, насколько тема знакома (`knowledge.ts`).
 *
 * Формат вопроса и правила шкалы знания взяты из Lamdan
 * (github.com/aisarus/syllabus-to-os: golden quiz, concept evidence).
 */

/** Где это прозвучало: заметка лекции и секунда звука. */
export interface SourceRef {
  /** Имя заметки лекции без `.md`. */
  lecture: string;
  /** Секунда от начала записи; нет — только лекция. */
  at?: number;
}

/** Тема — раздел конспекта лекции. */
export interface StudyTopic {
  /** `<лекция>#<номер раздела>` — стабилен, пока лекцию не переписали. */
  id: string;
  lecture: string;
  title: string;
  /** Отрезок звука раздела, секунды. */
  from?: number;
  to?: number;
}

export interface QuizOption {
  /** На языке лекции. */
  text: string;
  /** Перевод на язык конспекта, если лекция на другом. */
  translation?: string;
  /** Почему этот вариант верен или неверен. */
  rationale: string;
}

export interface QuizQuestion {
  id: string;
  topicId: string;
  prompt: string;
  promptTranslation?: string;
  /** Ровно четыре. */
  options: QuizOption[];
  correctIndex: number;
  /** Разбор верного ответа — на языке конспекта. */
  explanation: string;
  /** Подсказка для памяти. */
  memoryHint: string;
  /** Короткий эталон для открытого ответа. */
  answer: string;
  source: SourceRef;
}

export type CardOrigin = 'concept' | 'mistake' | 'manual';

export interface StudyCard {
  id: string;
  topicId: string;
  front: string;
  back: string;
  source: SourceRef;
  origin: CardOrigin;
}

export interface StudyTask {
  id: string;
  topicId: string;
  problem: string;
  hint: string;
  steps: string[];
  answer: string;
  source: SourceRef;
}

export interface LectureBank {
  version: 1;
  lecture: string;
  notesFile: string;
  audioFile?: string;
  course: string;
  /** YYYY-MM-DD. */
  date: string;
  number?: number;
  topic?: string;
  generatedAt: number;
  topics: StudyTopic[];
  questions: QuizQuestion[];
  cards: StudyCard[];
  tasks: StudyTask[];
  /** Что отброшено проверкой качества и почему. */
  warnings: string[];
}

/** Вид свидетельства знания — как в Lamdan. */
export type EvidenceKind = 'recognition' | 'recall' | 'explanation' | 'application';
export type EvidenceSource = 'quiz' | 'exam' | 'card' | 'open' | 'task';

export interface EvidenceEvent {
  id: string;
  topicId: string;
  itemId: string;
  kind: EvidenceKind;
  source: EvidenceSource;
  outcome: 'success' | 'failure';
  at: number;
}

export interface CardState {
  /** Когда показать снова, мс. */
  due: number;
  /** Интервал, дни; 0 — учится. */
  interval: number;
  lapses: number;
}

export interface ExamRecord {
  id: string;
  startedAt: number;
  finishedAt: number;
  total: number;
  correct: number;
  answered: number;
  timedOut: boolean;
}

export interface CourseProgress {
  version: 1;
  events: EvidenceEvent[];
  cards: Record<string, CardState>;
  /** Карточки из ошибок и добавленные руками — банк лекции их не знает. */
  extraCards: StudyCard[];
  /** Решённые задачи: id → когда. */
  solvedTasks: Record<string, number>;
  exams: ExamRecord[];
}

export function emptyProgress(): CourseProgress {
  return { version: 1, events: [], cards: {}, extraCards: [], solvedTasks: {}, exams: [] };
}
