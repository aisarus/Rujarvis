/**
 * Заготовить учёбу по лекции и положить банк на место.
 *
 * Зовётся, когда лекция легла в курс (`lectureMode`), и скриптом
 * `pnpm jarvis:study-prepare` — для лекций, записанных раньше.
 */

import { generateLectureBank, generateMaterialBank, type GenerateOptions } from './generate';
import type { StudyStore } from './store';

export interface PrepareResult {
  lecture: string;
  course: string;
  questions: number;
  cards: number;
  tasks: number;
  warnings: string[];
}

export async function prepareLecture(notesFile: string, store: StudyStore, options: GenerateOptions): Promise<PrepareResult | null> {
  return сохранить(await generateLectureBank(notesFile, options), store);
}

/**
 * То же по разбору документа из конвейера (статья, файл лектора): вопросы и
 * карточки ложатся в курс рядом с лекциями, и окно учёбы показывает их так же.
 */
export async function prepareMaterial(notesFile: string, store: StudyStore, options: GenerateOptions): Promise<PrepareResult | null> {
  return сохранить(await generateMaterialBank(notesFile, options), store);
}

function сохранить(bank: Awaited<ReturnType<typeof generateLectureBank>>, store: StudyStore): PrepareResult | null {
  if (!bank) return null;
  store.saveBank(bank);
  return {
    lecture: bank.lecture,
    course: bank.course,
    questions: bank.questions.length,
    cards: bank.cards.length,
    tasks: bank.tasks.length,
    warnings: bank.warnings,
  };
}
