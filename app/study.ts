/**
 * Учёба в приложении: служба, очередь заготовок и окно.
 *
 * Окно учёбы открывается из трея, кнопкой «Учёба» на плашке и голосом
 * («Джарвис, учёба»). Заготовки — по одной лекции за раз, в фоне: каждая —
 * несколько вызовов Claude Code по подписке, и две разом только делили бы
 * лимит.
 */

import path from 'node:path';

import { app, shell } from 'electron';

import { lectureLanguagesFor, settingsLanguages } from '../jarvis/lecture/courses';
import { deleteRecordings, expiredRecordings, listRecordings, RECORDING_KEEP_DAYS } from '../jarvis/lecture/recordings';
import { lectureFolder } from '../jarvis/lecture/vault';
import { createClaudeSummarizer } from '../jarvis/lecture/summarize';
import { tr } from '../jarvis/locale/language';
import type { JarvisPaths } from '../jarvis/setup/paths';
import { jarvisOutputDir } from '../jarvis/setup/paths';
import type { AppSettings } from '../jarvis/setup/settings';
import { prepareLecture, prepareMaterial } from '../jarvis/study/prepare';
import { StudyService, studyRoot } from '../jarvis/study/service';
import { StudyStore } from '../jarvis/study/store';
import { lectureState } from './lectureMode';
import { openStudyWindow, sendStudyUpdate } from './studyWindow';

interface Настройка {
  settings: () => AppSettings;
  paths: JarvisPaths;
}

let настройка: Настройка | null = null;
let служба: StudyService | null = null;
let очередь: Promise<void> = Promise.resolve();
/** Лекция или материал → курс: что в очереди заготовки и чей курс сейчас не трогать. */
const готовятся = new Map<string, string>();

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
    const { settings } = настройка;
    служба = new StudyService({
      store: хранилище(),
      vaultRoot: папкаЛекций,
      summarize: createClaudeSummarizer(),
      notes: settings().language,
      languages: () => settingsLanguages(settings()),
      trash: (file) => shell.trashItem(file),
      busy: курсЗанят,
      audioBusy: звукЗанят,
      recordingsAutoDays: () => (settings().recordingsKeep === 'week' ? RECORDING_KEEP_DAYS : null),
    });
  }
  return служба;
}

/**
 * Курс сейчас не переименовать и не удалить: конспект пишет в папку курса
 * (или решит курс только в конце), заготовка читает его лекции и кладёт банк
 * под его именем.
 */
function курсЗанят(course: string): string | null {
  if (lectureState() !== 'off') {
    return tr('Сейчас идёт конспект — курсы можно менять, когда он закончится.', 'Lecture notes are in progress. Courses can be changed once they finish.');
  }
  if ([...готовятся.values()].includes(course)) {
    return tr(`Готовлю вопросы к лекциям курса «${course}» — подождите, пока закончу.`, `Preparing questions for "${course}". Wait until it finishes.`);
  }
  return null;
}

/**
 * Звук лекций сейчас не трогать: лекция поднимается или дописывается (файлы
 * переезжают в папку курса), конспект по файлу читает звук прежней лекции.
 * Пока лекция просто идёт — можно: её звук ещё без свойств лекции и в списке
 * записей не виден.
 */
function звукЗанят(): string | null {
  const состояние = lectureState();
  if (состояние === 'off' || состояние === 'on') return null;
  return tr('Сейчас дописывается конспект — звук можно удалить, когда он закончится.', 'Lecture notes are being finished. Audio can be deleted once they are done.');
}

/**
 * Записи старше недели — прочь, если так оставлено в настройках: через две
 * минуты после запуска и потом раз в шесть часов. Возвращает, как остановить.
 */
export function startRecordingsCleanup(): () => void {
  const раз = async (): Promise<void> => {
    if (!настройка || настройка.settings().recordingsKeep !== 'week' || звукЗанят()) return;
    try {
      const старые = expiredRecordings(listRecordings(папкаЛекций()), Date.now());
      if (!старые.length) return;
      const итог = await deleteRecordings(старые);
      console.log(
        `[jarvis:study] звук лекций старше ${RECORDING_KEEP_DAYS} дней удалён: ${итог.deleted}, освобождено ${Math.round(итог.bytes / 1_000_000)} МБ` +
          (итог.failed ? `; не удалились (заняты): ${итог.failed}` : ''),
      );
      sendStudyUpdate();
    } catch (error) {
      console.error(`[jarvis:study] старые записи не удалились: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const первый = setTimeout(() => void раз(), 2 * 60 * 1000);
  const потом = setInterval(() => void раз(), 6 * 60 * 60 * 1000);
  первый.unref?.();
  потом.unref?.();
  return () => {
    clearTimeout(первый);
    clearInterval(потом);
  };
}

/** Что сейчас заготавливается — окно показывает «готовлю вопросы…». */
export function preparingLectures(): string[] {
  return [...готовятся.keys()];
}

/** Разбор документа из конвейера: его курс, язык документа и язык заметок. */
export interface MaterialStudy {
  course: string;
  /** Язык документа — на нём будут вопросы, как на экзамене. */
  sourceLanguage?: string;
  notes: 'ru' | 'en';
}

/** Заготовить учёбу по лекции или разбору документа — в очередь, по одной. */
export function prepareStudyFor(notesFile: string, material?: MaterialStudy): void {
  if (!настройка) return;
  const лекция = path.basename(notesFile, '.md');
  if (готовятся.has(лекция)) return;
  готовятся.set(лекция, material?.course ?? path.basename(path.dirname(notesFile)));
  sendStudyUpdate();
  const s = настройка.settings();
  очередь = очередь.then(async () => {
    const t0 = Date.now();
    try {
      // Вопросы — на языке лекции курса (у материала — на языке документа),
      // разбор — на языке конспекта.
      const языки = material
        ? { lecture: material.sourceLanguage || settingsLanguages(s).lecture, notes: material.notes }
        : lectureLanguagesFor(notesFile, settingsLanguages(s));
      const итог = await (material ? prepareMaterial : prepareLecture)(notesFile, хранилище(), {
        summarize: createClaudeSummarizer(),
        lectureLanguage: языки.lecture,
        notes: языки.notes,
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
