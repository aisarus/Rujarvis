/**
 * Учёба в приложении: служба, очередь заготовок и окно.
 *
 * Окно учёбы открывается из трея, кнопкой «Учёба» на плашке и голосом
 * («Джарвис, учёба»). Заготовки — по одной лекции за раз, в фоне: каждая —
 * несколько вызовов Claude Code по подписке, и две разом только делили бы
 * лимит.
 */

import path from 'node:path';

import { app } from 'electron';

import { lectureFolder } from '../jarvis/lecture/vault';
import { createClaudeSummarizer } from '../jarvis/lecture/summarize';
import type { JarvisPaths } from '../jarvis/setup/paths';
import { jarvisOutputDir } from '../jarvis/setup/paths';
import type { AppSettings } from '../jarvis/setup/settings';
import { prepareLecture } from '../jarvis/study/prepare';
import { StudyService, studyRoot } from '../jarvis/study/service';
import { StudyStore } from '../jarvis/study/store';
import { openStudyWindow, sendStudyUpdate } from './studyWindow';

interface Настройка {
  settings: () => AppSettings;
  paths: JarvisPaths;
}

let настройка: Настройка | null = null;
let служба: StudyService | null = null;
let очередь: Promise<void> = Promise.resolve();
const готовятся = new Set<string>();

export function configureStudy(options: Настройка): void {
  настройка = options;
  служба = null;
}

/** Папка «Лекции» — там же, куда пишет конспект. */
function папкаЛекций(): string {
  if (!настройка) throw new Error('учёба не настроена');
  const s = настройка.settings();
  const результаты = s.outputDir || jarvisOutputDir(process.env, app.getPath('desktop'), s.language === 'en' ? 'Jarvis' : 'Джарвис');
  return lectureFolder(результаты, s.language).folder;
}

function хранилище(): StudyStore {
  if (!настройка) throw new Error('учёба не настроена');
  return new StudyStore(studyRoot(настройка.paths.data));
}

export function studyService(): StudyService {
  if (!настройка) throw new Error('учёба не настроена');
  if (!служба) {
    служба = new StudyService({
      store: хранилище(),
      vaultRoot: папкаЛекций,
      summarize: createClaudeSummarizer(),
      notes: настройка.settings().language,
    });
  }
  return служба;
}

/** Что сейчас заготавливается — окно показывает «готовлю вопросы…». */
export function preparingLectures(): string[] {
  return [...готовятся];
}

/** Заготовить учёбу по лекции — в очередь, по одной. */
export function prepareStudyFor(notesFile: string): void {
  if (!настройка) return;
  const лекция = path.basename(notesFile, '.md');
  if (готовятся.has(лекция)) return;
  готовятся.add(лекция);
  sendStudyUpdate();
  const s = настройка.settings();
  очередь = очередь.then(async () => {
    const t0 = Date.now();
    try {
      const итог = await prepareLecture(notesFile, хранилище(), {
        summarize: createClaudeSummarizer(),
        lectureLanguage: s.lectureLanguage || s.language,
        notes: s.language,
        log: (строка) => console.log(`[jarvis:study] ${строка}`),
      });
      console.log(
        итог
          ? `[jarvis:study] заготовлено «${итог.lecture}» за ${Math.round((Date.now() - t0) / 1000)} с: вопросов ${итог.questions}, карточек ${итог.cards}, задач ${итог.tasks}, отброшено ${итог.warnings.length}`
          : `[jarvis:study] «${лекция}»: в конспекте нет разделов с материалом — заготавливать нечего`,
      );
    } catch (error) {
      console.error(`[jarvis:study] «${лекция}» не заготовлена: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      готовятся.delete(лекция);
      sendStudyUpdate();
    }
  });
}

/** Все лекции хранилища, у которых банка ещё нет, а материал есть, — в очередь. Сколько поставлено. */
export function prepareAllStudy(): number {
  const s = studyService();
  let поставлено = 0;
  for (const курс of s.today().courses.map((c) => c.name)) {
    for (const л of s.course(курс).unprepared) {
      if (л.empty) continue;
      prepareStudyFor(л.notesFile);
      поставлено += 1;
    }
  }
  return поставлено;
}

type Слух = (samples: Float32Array, sampleRate: number) => Promise<string>;

let слух: Слух | null = null;
let приЗаписи: ((on: boolean) => void) | null = null;

/**
 * Слух Джарвиса для ответа голосом в окне учёбы — его даёт голосовой мост,
 * когда поднят. `onRecording` — мост на время записи не принимает
 * услышанное за команды: ответ на вопрос — не просьба к Джарвису.
 */
export function setStudyHearing(transcribe: Слух | null, onRecording: ((on: boolean) => void) | null): void {
  слух = transcribe;
  приЗаписи = onRecording;
}

export function showStudy(): void {
  if (!настройка) return;
  openStudyWindow({
    service: studyService,
    preparing: preparingLectures,
    prepare: prepareStudyFor,
    prepareAll: prepareAllStudy,
    transcribe: async (samples, sampleRate) => {
      if (!слух) throw new Error('слух Джарвиса не запущен — ответ голосом недоступен, напишите текстом');
      return слух(samples, sampleRate);
    },
    recording: (on) => приЗаписи?.(on),
    language: () => настройка?.settings().language ?? 'ru',
  });
}
