/**
 * Режим лекции в мосте: «Джарвис, конспектируй лекцию по …» или кнопка на
 * плашке — и до «закончи конспект».
 *
 * Звук из аудитории идёт в конспект (`LectureSession`) сплошной записью, а не
 * фразами: тишина тоже пишется, и минута в расшифровке совпадает с минутой в
 * звуке. Слушает его модель для лекций (`pnpm jarvis:lecture-model`) на своём
 * сервере whisper.cpp на соседнем порту, разделы пишет Claude Code по
 * подписке, заметка — в Obsidian и открывается сразу, чтобы её было видно
 * живой.
 *
 * ## Курс
 *
 * Кнопка не спрашивает предмет: пока выбираешь, лектор уже говорит. Курс
 * угадывается по расписанию, которое складывается из прошлых лекций (две
 * истории по вторникам около десяти — и нажатие во вторник в 10:05 пишет в
 * историю), правится одним нажатием на плашке, а не угадан — его в конце
 * называет модель по содержанию. Файлы получают настоящие имена и папку
 * курса после записи (`finalizeLecture`).
 *
 * ## Слух
 *
 * Лектор далеко, микрофон у ноутбука бывает какой угодно. Сколько слышно,
 * видно по первой же минуте (`HearingMonitor`) — и об этом говорится
 * строкой на плашке, без голоса: в аудитории Джарвис молчит.
 *
 * Сервер модели поднимается секунды. Мост его не ждёт: куски звука стоят в
 * очереди сессии и распознаются, как только он ответит. Модели для лекций
 * нет — слушает общий сервер (small) с языком лекции: хуже, но лекция не
 * пропадает, и человеку об этом сказано.
 */

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { shell } from 'electron';

import { chunkLevel } from '../jarvis/lecture/audioCut';
import {
  COURSE_WORDS,
  courseLanguages,
  coursesForModel,
  guessByDeclared,
  guessBySchedule,
  listCourses,
  listLectures,
  matchCourse,
  parseFrontmatter,
  readCourseInfo,
  type LectureLanguages,
} from '../jarvis/lecture/courses';
import { finalizeLecture, moveLecture } from '../jarvis/lecture/finalize';
import { findAbandonedLectures, recoverLecture } from '../jarvis/lecture/recover';
import { HearingMonitor, isSilentChunk } from '../jarvis/lecture/hearing';
import { mediaSeconds } from '../jarvis/lecture/mediaSlices';
import { LectureRecorder } from '../jarvis/lecture/recorder';
import { LectureSession, NOTES_WORDS, type NotesLanguage } from '../jarvis/lecture/session';
import { createClaudeSummarizer, createFinalSummarizer } from '../jarvis/lecture/summarize';
import { lectureFolder, obsidianOpenUrl } from '../jarvis/lecture/vault';
import type { NotesStyle } from '../jarvis/notes/style';
import { tr } from '../jarvis/locale/language';
import { findGpuWhisper, findLectureModel, gpuWhisperDir, otherLectureModels, startGpuWhisper, type GpuWhisperServer } from '../jarvis/voice/gpuWhisper';
import { resampleTo16k } from '../jarvis/voice/wav';
import { createGpuTranscriber, isWhisperServerReady, WHISPER_SERVER_PORT, type ConfidentResult } from './gpuTranscriber';
import type { LectureSource } from './statusOverlay';

const ПОРТ_ЛЕКЦИИ = WHISPER_SERVER_PORT + 1;

interface Лекция {
  session: LectureSession;
  сервер: Promise<GpuWhisperServer | null>;
  recorder: LectureRecorder;
  root: string;
  notes: NotesLanguage;
  /** Выбранный человеком или угаданный по расписанию; null — решит модель. */
  курс: string | null;
  слух: HearingMonitor;
  /** Строка под кнопками: что со слухом. */
  строка?: string;
}

let идёт: Лекция | null = null;
/** Итог прошлой лекции ещё пишется: её сервер занимает тот же порт. */
let дописывается: Promise<string> | null = null;
/**
 * Лекция поднимается: до `идёт` — несколько ожиданий. Двойное нажатие кнопки
 * или кнопка вместе с голосом заводили две сессии и два сервера на одном
 * порту (ревью 29.09.2026).
 */
let запускается = false;
/** Идёт конспект по файлу: тот же порт, тот же сервер. */
let файлом: { строка: string } | null = null;
/** Последняя законченная лекция — её переносят «в другой курс». */
let последняя: { notesFile: string; root: string; notes: NotesLanguage } | null = null;

export function lectureActive(): boolean {
  return идёт !== null;
}

/** Итог законченной лекции ещё пишется — его и ждать перед выходом; нет — null. */
export function lectureFinishing(): Promise<string> | null {
  return дописывается;
}

/**
 * Какой конспект открыть кнопкой на уменьшенной плашке: идущей лекции, только
 * что законченной или самый свежий в «Лекциях» — после перезапуска Джарвис
 * последнюю не помнит, а конспект на диске есть.
 */
export function latestNotesFile(options: Pick<LectureStartOptions, 'outputDir' | 'notesLanguage'>): string | null {
  if (идёт) return идёт.session.notesFile;
  if (последняя && existsSync(последняя.notesFile)) return последняя.notesFile;
  const { folder: root } = lectureFolder(options.outputDir, options.notesLanguage);
  // «Без курса» — тоже лекции: курс им не нашёлся, а конспект есть.
  const лекции = [...listLectures(root), ...listLectures(root, COURSE_WORDS.ru.unsorted), ...listLectures(root, COURSE_WORDS.en.unsorted)];
  const свежая = лекции.sort((a, b) => a.meta.date.localeCompare(b.meta.date) || (a.meta.start ?? '').localeCompare(b.meta.start ?? '')).at(-1);
  return свежая?.file ?? null;
}

/** Открыть конспект — в Obsidian, если «Лекции» в его хранилище, иначе программой по умолчанию. */
export async function openNotes(file: string, options: Pick<LectureStartOptions, 'outputDir' | 'notesLanguage'>): Promise<void> {
  const { vault } = lectureFolder(options.outputDir, options.notesLanguage);
  if (vault) await shell.openExternal(obsidianOpenUrl(file));
  else await shell.openPath(file);
}

/** Что с конспектом сейчас — для кнопки на плашке. */
export type LectureState = 'off' | 'starting' | 'on' | 'finishing' | 'importing';

export function lectureState(): LectureState {
  return идёт ? 'on' : запускается ? 'starting' : файлом ? 'importing' : дописывается ? 'finishing' : 'off';
}

/** Что показать под кнопками: курс, список курсов, строка о слухе или о файле. */
export interface LectureInfo {
  course: string | null;
  courses: string[];
  line?: string;
}

export function lectureInfo(): LectureInfo | null {
  if (идёт) return { course: идёт.курс, courses: listCourses(идёт.root), line: идёт.строка };
  if (файлом) return { course: null, courses: [], line: файлом.строка };
  return null;
}

const слушатели = new Set<(state: LectureState, info: LectureInfo | null) => void>();

/** Подписка на смену состояния и сведений. Возвращает отписку. */
export function onLectureState(listener: (state: LectureState, info: LectureInfo | null) => void): () => void {
  слушатели.add(listener);
  return () => слушатели.delete(listener);
}

function оповестить(): void {
  const state = lectureState();
  const info = lectureInfo();
  for (const слушатель of слушатели) {
    try {
      слушатель(state, info);
    } catch {
      // Упавший слушатель — не повод ронять конспект.
    }
  }
}

export interface LectureStartOptions {
  home: string;
  outputDir: string;
  /**
   * Язык лекции из настроек — код Whisper. У курса со своим языком (страница
   * курса, окно «Учёба») слушается его язык.
   */
  lectureLanguage: string;
  /** Язык интерфейса: папка «Лекции» и конспект, если у курса свой не задан. */
  notesLanguage: NotesLanguage;
  /** Вид конспекта в Obsidian — из настроек. */
  notesStyle?: NotesStyle;
  /** Адрес общего сервера распознавания — запасной, когда модели для лекций нет. */
  mainEndpoint(): string | null;
  /** Откуда звук: микрофон (аудитория) или звук компьютера (Zoom). По умолчанию — микрофон. */
  source?: LectureSource;
}

function занято(): string | null {
  if (идёт || запускается) return tr('Конспект уже пишется.', 'Already taking notes.');
  if (файлом) return tr('Сейчас конспектирую файл — дождитесь конца.', 'Taking notes from a file right now. Wait for it to finish.');
  if (дописывается) return tr('Ещё дописываю прошлый конспект — через минуту.', 'Still finishing the previous notes. Give me a minute.');
  return null;
}

export async function startLecture(subject: string | undefined, options: LectureStartOptions): Promise<string> {
  const нельзя = занято();
  if (нельзя) return нельзя;
  запускается = true;
  оповестить();
  try {
    return await начатьЛекцию(subject, options);
  } finally {
    запускается = false;
    оповестить();
  }
}

interface Слух {
  сервер: Promise<GpuWhisperServer | null>;
  модель: string | null;
  распознать(samples: Float32Array, sampleRate: number): Promise<ConfidentResult>;
}

/**
 * Сервер модели для лекций на этом языке — поднимается в фоне; куски ждут его
 * в очереди. Своей модели языка нет — общая, нет и её — общий сервер с
 * языком лекции: модель другого языка не берётся никогда.
 */
async function поднятьСлух(options: LectureStartOptions, язык: string): Promise<Слух> {
  const dir = gpuWhisperDir(options.home);
  const files = await findGpuWhisper(dir).catch(() => null);
  const модель = files ? await findLectureModel(dir, язык).catch(() => null) : null;
  if (files && !модель) {
    const чужие = await otherLectureModels(dir, язык).catch(() => []);
    if (чужие.length > 0) {
      console.log(`[jarvis:lecture] для языка «${язык}» модели для лекций нет, а модель для «${чужие.join('», «')}» чужому языку не годится — слушает общий сервер`);
    }
  }
  const сервер: Promise<GpuWhisperServer | null> =
    files && модель
      ? startGpuWhisper(
          { server: files.server, model: модель },
          {
            port: ПОРТ_ЛЕКЦИИ,
            isReady: isWhisperServerReady,
            readyMs: 180_000,
            log: (строка) => console.log(`[jarvis:lecture] сервер лекции: ${строка.slice(0, 200)}`),
          },
        ).catch((error: unknown) => {
          console.error(`[jarvis:lecture] сервер лекции не поднялся: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
      : Promise.resolve(null);
  return {
    сервер,
    модель,
    распознать: async (samples, sampleRate) => {
      const свой = await сервер;
      const endpoint = свой?.endpoint ?? options.mainEndpoint();
      if (!endpoint) throw new Error('распознавать нечем: нет сервера на видеокарте (pnpm jarvis:gpu-stt)');
      return createGpuTranscriber({ endpoint, language: язык, timeoutMs: 120_000, withConfidence: true }).transcribe(samples, sampleRate);
    },
  };
}

/**
 * Курс по времени: сначала расписание со страниц курсов (оно известно с
 * первой пары), затем — выученное по прошлым лекциям.
 */
function угадатьКурс(root: string, когда: Date): string | null {
  return (
    guessByDeclared(когда, listCourses(root).map((курс) => readCourseInfo(root, курс))) ??
    guessBySchedule(когда, listLectures(root).map((л) => л.meta))
  );
}

/**
 * На каком языке слушать и писать: курс известен с начала — его языки со
 * страницы курса, нет — настройки. Курс, названный моделью в конце, языка уже
 * не меняет: лекция расшифрована.
 */
function языкиКурса(root: string, курс: string | null, options: LectureStartOptions): LectureLanguages {
  const настройки = { lecture: options.lectureLanguage, notes: options.notesLanguage };
  return курс ? courseLanguages(readCourseInfo(root, курс), настройки) : настройки;
}

async function начатьЛекцию(subject: string | undefined, options: LectureStartOptions): Promise<string> {
  const { folder: root, vault } = lectureFolder(options.outputDir, options.notesLanguage);
  const курсы = listCourses(root);
  const когда = new Date();
  // Назван голосом — ищем среди своих курсов (падеж не важен); не назван —
  // по расписанию. Названный, но новый курс называет в конце модель: «по
  // социологии» — это ещё не имя папки.
  const курс = subject ? matchCourse(subject, курсы) : угадатьКурс(root, когда);
  const языки = языкиКурса(root, курс, options);
  const слух = await поднятьСлух(options, языки.lecture);

  const монитор = new HearingMonitor();
  const zoom = options.source === 'system';
  const лекция: { value: Лекция | null } = { value: null };
  const transcribe = async (samples: Float32Array, sampleRate: number): Promise<string> => {
    const уровень = chunkLevel(samples, sampleRate);
    const секунд = samples.length / sampleRate;
    // Тишину не распознаём: на ней Whisper выдумывает субтитры. В запись она
    // всё равно легла — сессия пишет звук раньше распознавания.
    if (isSilentChunk(уровень)) {
      слышно(монитор.observe({ seconds: секунд, level: уровень, text: null }));
      return '';
    }
    const { text, confidence } = await слух.распознать(samples, sampleRate);
    слышно(монитор.observe({ seconds: секунд, level: уровень, text, confidence }));
    return text;
  };
  const слышно = (вердикт: ReturnType<HearingMonitor['observe']>): void => {
    const л = лекция.value;
    if (!вердикт || !л || идёт !== л) return;
    л.строка =
      вердикт === 'bad'
        ? zoom
          ? tr(
              'Звук из компьютера плохо разбирается. Проверьте, что Zoom играет через устройство по умолчанию и звук не на нуле.',
              'The computer sound is hard to make out. Check that Zoom plays through the default device and the volume is up.',
            )
          : tr(
              'Лектора слышно плохо. Придвиньте ноутбук ближе или включите запись на телефоне — потом отдайте её мне кнопкой «Из файла…».',
              'The lecturer is hard to hear. Move the laptop closer or record on your phone — then give me the file with "From a file…".',
            )
        : tr('Теперь лектора слышно.', 'The lecturer is audible now.');
    console.log(`[jarvis:lecture] слух: ${вердикт === 'bad' ? 'плохо' : 'наладился'} (${монитор.describe()})`);
    оповестить();
  };

  const folder = курс ? path.join(root, курс) : root;
  const session = new LectureSession(
    folder,
    subject ?? '',
    {
      transcribe,
      summarize: createClaudeSummarizer(),
      summarizeFinal: createFinalSummarizer({ log: (строка) => console.log(`[jarvis:lecture] ${строка}`) }),
      lectureLanguage: языки.lecture,
      notesLanguage: языки.notes,
      notesStyle: options.notesStyle,
      // Только счёт и события: сама лекция в журнал Джарвиса не пишется.
      log: (строка) => console.log(`[jarvis:lecture] ${строка}`),
    },
    когда,
  );
  await session.start();
  const recorder = new LectureRecorder((samples, sampleRate) => session.addAudio(samples, sampleRate));
  // Нет ни модели для лекций, ни общего сервера — звук пишется, а расшифровать
  // его нечем. Так и сказать: «конспектирую» здесь было бы ложью, и человек
  // узнал бы об этом вечером над пустой заметкой.
  const нечем = !слух.модель && !options.mainEndpoint();
  лекция.value = {
    session,
    сервер: слух.сервер,
    recorder,
    root,
    notes: языки.notes,
    курс,
    слух: монитор,
    ...(нечем
      ? {
          строка: tr(
            'Только запись: расшифровать нечем (нет распознавания на видеокарте). Конспект — потом из файла.',
            'Recording only: nothing to transcribe with (no GPU recognition). Notes later from the file.',
          ),
        }
      : {}),
  };
  идёт = лекция.value;
  оповестить();
  console.log(
    `[jarvis:lecture] конспект начат${vault ? ' в хранилище Obsidian' : ' в папке результатов (Obsidian не найден)'}; ` +
      `курс: ${курс ?? 'решит модель'}; звук: ${zoom ? 'компьютер (Zoom)' : 'микрофон'}; язык лекции: ${языки.lecture}, конспекта: ${языки.notes}${курс && (языки.lecture !== options.lectureLanguage || языки.notes !== options.notesLanguage) ? ' (свои у курса)' : ''}; ` +
      `модель: ${слух.модель ? path.basename(слух.модель) : 'для лекций нет — общий сервер'}`,
  );
  if (vault) await shell.openExternal(obsidianOpenUrl(session.notesFile)).catch(() => undefined);

  const гдеКурс = курс
    ? tr(`Курс — «${курс}».`, `Course: "${курс}".`)
    : tr('Курс определю по лекции.', 'I will work out the course from the lecture.');
  if (нечем) {
    return tr(
      'Записываю звук лекции, но расшифровать его нечем: не установлено распознавание на видеокарте (pnpm jarvis:gpu-stt). Конспект сделаю потом из этой записи.',
      'Recording the lecture, but there is nothing to transcribe it with: GPU recognition is not installed (pnpm jarvis:gpu-stt). I will make the notes from this recording later.',
    );
  }
  const откуда = zoom ? tr('Пишу звук компьютера (Zoom). ', 'Recording the computer sound (Zoom). ') : '';
  return слух.модель
    ? tr(`Конспектирую. ${откуда}${гдеКурс} Закончить — «Джарвис, закончи конспект».`, `Taking notes. ${откуда}${гдеКурс} Say "Jarvis, stop lecture notes" to finish.`)
    : tr(
        `Конспектирую общим распознаванием. ${гдеКурс} Точнее будет с моделью для лекций: pnpm jarvis:lecture-model.`,
        `Taking notes with the general recognition. ${гдеКурс} The lecture model is more accurate: pnpm jarvis:lecture-model.`,
      );
}

/** Звук из аудитории — в конспект, сплошь. */
export function feedLecture(samples: Float32Array, sampleRate: number): void {
  идёт?.recorder.push(samples, sampleRate);
}

/**
 * Курс лекции: выбран на плашке или назван голосом. Пусто — пусть решит
 * модель. Лекции нет — переносится последняя законченная.
 */
export async function setLectureCourse(course: string): Promise<string> {
  const л = идёт;
  if (л) {
    const курсы = listCourses(л.root);
    л.курс = course ? matchCourse(course, курсы) ?? course : null;
    оповестить();
    return л.курс
      ? tr(`Пишу в курс «${л.курс}».`, `Writing to the course "${л.курс}".`)
      : tr('Курс определю по лекции.', 'I will work out the course from the lecture.');
  }
  if (!последняя || !existsSync(последняя.notesFile)) return tr('Переносить нечего: законченной лекции нет.', 'Nothing to move: no finished lecture.');
  if (!course) return tr('Назовите курс.', 'Name the course.');
  const итог = await moveLecture(последняя.root, последняя.notesFile, course, последняя.notes);
  последняя = { ...последняя, notesFile: итог.notesFile };
  return tr(`Перенёс в курс «${итог.course}», лекция ${итог.number}.`, `Moved to the course "${итог.course}", lecture ${итог.number}.`);
}

let приРазложенной: ((notesFile: string) => void) | null = null;

/** Кто узнаёт о лекции, легшей в курс, — заготовка учёбы. */
export function onLectureFiled(handler: ((notesFile: string) => void) | null): void {
  приРазложенной = handler;
}

/** Разложить по курсу и сказать, что вышло. */
async function разложить(
  л: { root: string; notes: NotesLanguage; курс: string | null; when: Date },
  итог: Awaited<ReturnType<LectureSession['finish']>>,
  extra: { replaceSameDay?: boolean; trash?(file: string): Promise<void>; number?: number } = {},
): Promise<string> {
  try {
    const место = await finalizeLecture({
      root: л.root,
      notesFile: итог.notesFile,
      transcriptFile: итог.transcriptFile,
      audioFile: итог.audioFile,
      notes: л.notes,
      when: л.when,
      durationSec: итог.durationSec,
      course: л.курс,
      modelCourse: итог.course,
      topic: итог.topic,
      ...extra,
    });
    последняя = { notesFile: место.notesFile, root: л.root, notes: л.notes };
    // Учёба по лекции — в фоне: заготовка — минуты модели, а конспект уже готов.
    try {
      приРазложенной?.(место.notesFile);
    } catch (error) {
      console.error(`[jarvis:lecture] заготовка учёбы не запустилась: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`[jarvis:lecture] конспект готов: курс «${место.course}», лекция ${место.number}, ${итог.sections} разделов, ${итог.words} слов`);
    const тема = итог.topic ? tr(`«${итог.topic}» — `, `"${итог.topic}" — `) : '';
    return tr(
      `Конспект готов: ${тема}${место.course}, лекция ${место.number}, разделов — ${итог.sections}.`,
      `Notes are ready: ${тема}${место.course}, lecture ${место.number}, ${итог.sections} sections.`,
    );
  } catch (error) {
    последняя = null;
    console.error(`[jarvis:lecture] не разложил по курсу: ${error instanceof Error ? error.message : String(error)}`);
    return tr(
      `Конспект готов, разделов — ${итог.sections}, но в папку курса не разложен — причина в журнале.`,
      `Notes are ready (${итог.sections} sections), but not filed into the course folder — see the log.`,
    );
  }
}

/**
 * Дописать итог, разложить по курсу и погасить сервер лекции.
 *
 * Итог — минута-другая модели. Мост поэтому не ждёт его внутри команды:
 * реплики разбираются по одной, и «стоп» простоял бы за итогом всё это время.
 * Лекция перестаёт быть активной сразу — следующая фраза уже разговор.
 */
export function finishLecture(): Promise<string> | null {
  const была = идёт;
  if (!была) return null;
  идёт = null;
  // Хвост записи — последним куском, пока сессия ещё принимает звук.
  была.recorder.flush();
  const работа = (async (): Promise<string> => {
    try {
      const итог = await была.session.finish(coursesForModel(была.root));
      return await разложить({ ...была, when: была.session.startedAt }, итог);
    } finally {
      (await была.сервер)?.stop();
      дописывается = null;
      оповестить();
    }
  })();
  дописывается = работа;
  оповестить();
  return работа;
}

let восстанавливаю = false;

/**
 * Брошенные лекции — дописать и разложить по курсу (`jarvis/lecture/recover.ts`).
 * Мост зовёт это через минуту после запуска: лекцию, оборванную обновлением,
 * перезапуском или выходом, человек находит готовой, без команды в терминале
 * (тестер 21.10.2026 обновился посреди лекции, и она осталась без итога).
 *
 * Пока лекция поднимается, дописывается или делается по файлу, её заметка
 * тоже без свойств — ждём, пока закончится.
 */
export async function recoverAbandonedLectures(options: LectureStartOptions, сообщить: (текст: string) => void): Promise<void> {
  if (восстанавливаю) return;
  восстанавливаю = true;
  try {
    for (let попытка = 0; lectureState() !== 'off' && lectureState() !== 'on'; попытка += 1) {
      if (попытка >= 15) return;
      await new Promise((r) => setTimeout(r, 120_000).unref?.());
    }
    const { folder: root } = lectureFolder(options.outputDir, options.notesLanguage);
    const брошенные = findAbandonedLectures(root, new Set(идёт ? [идёт.session.notesFile] : []));
    if (!брошенные.length) return;
    console.log(`[jarvis:lecture] брошенных лекций: ${брошенные.length} — дописываю`);
    for (const заметка of брошенные) {
      try {
        const место = await recoverLecture(заметка, {
          root,
          languages: { lecture: options.lectureLanguage, notes: options.notesLanguage },
          notesStyle: options.notesStyle,
          summarize: createClaudeSummarizer(),
          summarizeFinal: createFinalSummarizer({ log: (строка) => console.log(`[jarvis:lecture] ${строка}`) }),
          log: (строка) => console.log(`[jarvis:lecture] ${строка}`),
        });
        последняя = { notesFile: место.notesFile, root, notes: options.notesLanguage };
        try {
          приРазложенной?.(место.notesFile);
        } catch (error) {
          console.error(`[jarvis:lecture] заготовка учёбы не запустилась: ${error instanceof Error ? error.message : String(error)}`);
        }
        console.log(`[jarvis:lecture] брошенная лекция дописана: курс «${место.course}», лекция ${место.number}, разделов ${место.sections}`);
        сообщить(
          tr(
            `Дописал лекцию, которую прервали: ${место.course}, лекция ${место.number}.`,
            `Finished a lecture that was interrupted: ${место.course}, lecture ${место.number}.`,
          ),
        );
      } catch (error) {
        console.error(`[jarvis:lecture] брошенная лекция не дописалась (${path.basename(заметка)}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    восстанавливаю = false;
  }
}

/**
 * Мост закрывается посреди лекции: сервер — погасить (свой pid), записанное
 * остаётся на диске как есть. Итога нет — на него нужна минута модели, а
 * закрытие ждать не может; допишет `recoverAbandonedLectures` при запуске.
 */
export function abandonLecture(): void {
  const была = идёт;
  идёт = null;
  была?.recorder.flush();
  была?.session.abandon();
  void была?.сервер.then((сервер) => сервер?.stop());
  if (была) оповестить();
}

/** Что умеет раскрыть конспект по файлу: звук и видео, которые декодирует Chromium. */
export const LECTURE_FILE_EXTENSIONS = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'webm', 'flac', 'mp4', 'mov', 'mkv', 'weba'];

export interface LectureFileOptions extends LectureStartOptions {
  /**
   * Файл → звук одним каналом, кусками по мере раскрытия. Полуторачасовая
   * лекция целиком — сотни мегабайт, и держать её в памяти незачем: куски
   * сразу уходят в запись и распознавание.
   */
  decode(file: string, onPart: (samples: Float32Array, sampleRate: number) => void, между?: () => Promise<void>): Promise<void>;
  /** В Корзину, а не насовсем. */
  trash(file: string): Promise<void>;
}

/**
 * Конспект по файлу: запасной диктофон, официальная запись курса или звук
 * своей же лекции — перерасшифровать.
 *
 * Файл режется по паузам, а не вслепую: слова на стыках не рвутся. Дальше
 * — как у живой лекции: разделы, итог, курс, тема. Лекция того же курса за
 * тот же день уже есть — эта её заменяет, прежняя уходит в Корзину.
 */
export async function lectureFromFile(file: string, options: LectureFileOptions): Promise<string> {
  const нельзя = занято();
  if (нельзя) return нельзя;
  const расширение = path.extname(file).slice(1).toLowerCase();
  if (!LECTURE_FILE_EXTENSIONS.includes(расширение)) {
    return tr(`Это не звук и не видео: ${path.basename(file)}.`, `That is not audio or video: ${path.basename(file)}.`);
  }
  const имя = path.basename(file);
  файлом = { строка: tr(`Раскрываю ${имя}…`, `Opening ${имя}…`) };
  оповестить();
  let слух: Слух | null = null;
  try {
    const { folder: root } = lectureFolder(options.outputDir, options.notesLanguage);
    // Звук своей же лекции — перерасшифровать её: тот же курс, прежние файлы
    // — в Корзину, когда новые готовы.
    const база = path.join(path.dirname(file), path.basename(file, path.extname(file)));
    const своя = расширение === 'wav' && existsSync(`${база}.md`) ? `${база}.md` : null;
    const папкаКурса = path.relative(root, path.dirname(file));
    const курсСвоей =
      своя && папкаКурса && !папкаКурса.startsWith('..') && !path.isAbsolute(папкаКурса) && !папкаКурса.includes(path.sep)
        ? папкаКурса
        : null;
    const метаСвоей = своя ? parseFrontmatter(await readFile(своя, 'utf8')) : null;
    const времяФайла = statSync(file).mtimeMs;
    // Курс, известный до расшифровки, задаёт её язык: своя лекция лежит в
    // папке курса, а чужую запись видно по расписанию, если длина файла
    // известна без раскрытия (WAV, MP4, M4A, MOV; телефон пишет время конца).
    const заранее = курсСвоей ? null : await mediaSeconds(file).catch(() => null);
    const курсСразу = курсСвоей ?? (заранее ? угадатьКурс(root, new Date(времяФайла - заранее * 1000)) : null);
    const языки = языкиКурса(root, курсСразу, options);
    console.log(`[jarvis:lecture] файл: курс ${курсСразу ? `«${курсСразу}»` : 'решится в конце'}; язык лекции: ${языки.lecture}, конспекта: ${языки.notes}`);

    слух = await поднятьСлух(options, языки.lecture);
    const распознать = слух.распознать;
    let раскрыто = 0;
    let распознано = 0;
    const показать = (): void => {
      if (!файлом) return;
      файлом.строка = tr(
        `${имя}: раскрыто ${Math.round(раскрыто / 60)} мин, расшифровано ${Math.round(распознано / 60)} мин`,
        `${имя}: opened ${Math.round(раскрыто / 60)} min, transcribed ${Math.round(распознано / 60)} min`,
      );
      оповестить();
    };
    const session = new LectureSession(
      root,
      '',
      {
        transcribe: async (samples, rate) => {
          const уровень = chunkLevel(samples, rate);
          const текст = isSilentChunk(уровень) ? '' : (await распознать(samples, rate)).text;
          распознано += samples.length / rate;
          показать();
          return текст;
        },
        summarize: createClaudeSummarizer(),
        summarizeFinal: createFinalSummarizer({ log: (строка) => console.log(`[jarvis:lecture] файл: ${строка}`) }),
        lectureLanguage: языки.lecture,
        notesLanguage: языки.notes,
        notesStyle: options.notesStyle,
        log: (строка) => console.log(`[jarvis:lecture] файл: ${строка}`),
      },
      new Date(времяФайла),
    );
    await session.start();
    const запись = new LectureRecorder((samples, rate) => session.addAudio(samples, rate));
    let сломалось: string | null = null;
    try {
      await options.decode(
        file,
        (samples, rate) => {
          const звук = resampleTo16k(samples, rate);
          раскрыто += звук.length / 16_000;
          запись.push(звук, 16_000);
          показать();
        },
        // Не больше десяти минут звука в очереди распознавания.
        () => session.backlog(600),
      );
    } catch (error) {
      сломалось = error instanceof Error ? error.message : String(error);
      console.error(`[jarvis:lecture] файл раскрылся не весь: ${сломалось}`);
    }
    запись.flush();
    if (раскрыто < 5) {
      // Звука нет — и конспекта нет: заготовки — в Корзину, а не мусором в папке лекций.
      session.abandon();
      for (const пустой of [session.notesFile, session.transcriptFile, session.audioFile]) {
        if (existsSync(пустой)) await options.trash(пустой).catch(() => undefined);
      }
      return сломалось
        ? tr(`Не раскрыл ${имя}: ${сломалось}`, `Could not open ${имя}: ${сломалось}`)
        : tr('В файле почти нет звука.', 'The file has almost no audio.');
    }

    // Когда шла лекция: у своей — из свойств, у чужого файла — время файла
    // минус длительность (телефон пишет время конца записи).
    const когда = метаСвоей?.start ? new Date(`${метаСвоей.date}T${метаСвоей.start}:00`) : new Date(времяФайла - раскрыто * 1000);
    const курс = курсСразу ?? угадатьКурс(root, когда);
    const итог = await session.finish(coursesForModel(root));
    if (файлом) {
      файлом.строка = tr('Раскладываю по курсу…', 'Filing into the course…');
      оповестить();
    }
    if (своя) {
      // Расшифровка — на языке прежнего конспекта, а он мог быть и другим.
      const расшифровки = (['ru', 'en'] as const).map((я) => `${база} — ${NOTES_WORDS[я].transcriptFile}.md`);
      for (const старый of [своя, ...расшифровки, file]) {
        if (existsSync(старый)) await options.trash(старый);
      }
    }
    const ответ = await разложить(
      { root, notes: языки.notes, курс, when: когда },
      итог,
      своя ? { number: метаСвоей?.number } : { replaceSameDay: true, trash: options.trash },
    );
    return сломалось
      ? `${ответ} ${tr(`Файл раскрылся не весь (${Math.round(раскрыто / 60)} мин): ${сломалось}`, `Only part of the file opened (${Math.round(раскрыто / 60)} min): ${сломалось}`)}`
      : ответ;
  } finally {
    (await слух?.сервер)?.stop();
    файлом = null;
    оповестить();
  }
}
