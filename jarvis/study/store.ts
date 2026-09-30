/**
 * Где лежит учёба: в папке данных Джарвиса, по курсу на папку.
 *
 *     data\study\
 *       Введение в микроэкономику\
 *         2026-10-20 — Дефицит и выбор.json    банк лекции
 *         progress.json                        ответы, карточки, экзамены
 *
 * Конспекты — в Obsidian, это вещь человека. Банк и прогресс — служебное,
 * и в хранилище им не место. Пишется через временный файл и переименование:
 * оборванная запись не должна съесть прогресс семестра.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { safeName } from '../lecture/courses';
import { emptyProgress, type CourseProgress, type LectureBank } from './types';

const ПРОГРЕСС = 'progress.json';

function записать(файл: string, данные: unknown): void {
  mkdirSync(path.dirname(файл), { recursive: true });
  const временный = `${файл}.${process.pid}.tmp`;
  writeFileSync(временный, JSON.stringify(данные, null, 1), 'utf8');
  renameSync(временный, файл);
}

function прочитать<T>(файл: string): T | null {
  try {
    return JSON.parse(readFileSync(файл, 'utf8')) as T;
  } catch {
    return null;
  }
}

export class StudyStore {
  constructor(readonly root: string) {}

  private папка(course: string): string {
    return path.join(this.root, safeName(course, 80));
  }

  /** Курсы, у которых есть хоть что-то заготовленное. */
  courses(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  }

  saveBank(bank: LectureBank): void {
    записать(path.join(this.папка(bank.course), `${safeName(bank.lecture, 120)}.json`), bank);
  }

  hasBank(course: string, lecture: string): boolean {
    return existsSync(path.join(this.папка(course), `${safeName(lecture, 120)}.json`));
  }

  /** Банки курса по порядку лекций. Испорченный файл пропускается, а не роняет окно. */
  banks(course: string): LectureBank[] {
    const папка = this.папка(course);
    if (!existsSync(папка)) return [];
    return readdirSync(папка)
      .filter((f) => f.endsWith('.json') && f !== ПРОГРЕСС)
      .map((f) => прочитать<LectureBank>(path.join(папка, f)))
      .filter((b): b is LectureBank => Boolean(b) && b?.version === 1 && Array.isArray(b.questions))
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.date.localeCompare(b.date));
  }

  progress(course: string): CourseProgress {
    const p = прочитать<CourseProgress>(path.join(this.папка(course), ПРОГРЕСС));
    if (!p || p.version !== 1) return emptyProgress();
    return { ...emptyProgress(), ...p };
  }

  saveProgress(course: string, progress: CourseProgress): void {
    записать(path.join(this.папка(course), ПРОГРЕСС), progress);
  }

  /** Прочитать, поменять и сохранить прогресс курса одним шагом. */
  updateProgress<T>(course: string, change: (p: CourseProgress) => T): T {
    const p = this.progress(course);
    const итог = change(p);
    this.saveProgress(course, p);
    return итог;
  }
}
