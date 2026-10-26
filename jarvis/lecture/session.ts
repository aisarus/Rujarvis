/**
 * Конспект лекции на ходу: звук → расшифровка → разделы конспекта → итог.
 *
 * Конспект пишется на языке интерфейса (русский или английский), рядом —
 * дословная расшифровка на языке лекции и звук. Лекция на другом языке —
 * термины в конспекте идут в скобках так, как их сказал лектор: по ним потом
 * ищут в учебнике и на экзамене. Конспект пишется в Obsidian и виден, пока
 * идёт лекция.
 *
 * ## Две очереди
 *
 * Расшифровка кусок за куском дописывается сразу: это то, что человек видит
 * живым. Разделы конспекта делает модель, и каждый — десятки секунд: в одной
 * очереди с расшифровкой они задерживали бы её на всё это время. Поэтому у
 * разделов своя очередь, а расшифровка их не ждёт.
 *
 * ## Что здесь не делается
 *
 * Звук не распознаётся и модель не зовётся — это приходит снаружи
 * (`transcribe`, `summarize`): мост подставляет сервер whisper.cpp и Claude
 * Code по подписке, проверки — подделки.
 */

import { closeSync, openSync, statSync, writeSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { finalStyleRules, fromSummary, obsidianRules, sectionStyleRules, tidyNoteMarkdown, type NoteLanguages, type NotesStyle } from '../notes/style';
import { splitCourseAndTopic } from './courses';
import { lectureFileBase } from './vault';

/** На каком языке пишется конспект — язык интерфейса. */
export type NotesLanguage = 'ru' | 'en';

export interface LectureDeps {
  transcribe(samples: Float32Array, sampleRate: number): Promise<string>;
  summarize(prompt: string): Promise<string>;
  /** Итог лекции — сильнейшей моделью (`createFinalSummarizer`); нет — тем же `summarize`. */
  summarizeFinal?(prompt: string): Promise<string>;
  /** Язык лекции — код Whisper («ru», «en», «he»…). По умолчанию — язык конспекта. */
  lectureLanguage?: string;
  /** Язык конспекта. По умолчанию — русский. */
  notesLanguage?: NotesLanguage;
  /** Вид конспекта в Obsidian. По умолчанию — «Разбор». */
  notesStyle?: NotesStyle;
  /** Не чаще, чем раз в столько звука, — раздел конспекта. */
  sectionEveryMs?: number;
  /** И не меньше стольких новых слов расшифровки. */
  sectionMinWords?: number;
  log?(line: string): void;
}

export interface LectureResult {
  notesFile: string;
  transcriptFile: string;
  audioFile: string;
  words: number;
  sections: number;
  /** Сколько звука записано, секунды. */
  durationSec: number;
  /** Курс и тема — как их назвала модель в итоге; итога нет — нет и их. */
  course?: string;
  topic?: string;
}

/** Слова самой заметки: заголовки и подписи — на языке конспекта. */
export const NOTES_WORDS = {
  ru: {
    notes: '## Конспект',
    lecture: 'Лекция',
    transcript: 'Расшифровка',
    transcriptFile: 'расшифровка',
    audio: 'звук',
    notesLink: 'Конспект',
    section: 'Раздел',
    skip: 'ПРОПУСК',
    failed: (why: string) => `> Раздел не собрался (${why}). Текст — в расшифровке.`,
  },
  en: {
    notes: '## Notes',
    lecture: 'Lecture',
    transcript: 'Transcript',
    transcriptFile: 'transcript',
    audio: 'audio',
    notesLink: 'Notes',
    section: 'Section',
    skip: 'SKIP',
    failed: (why: string) => `> This section failed (${why}). The text is in the transcript.`,
  },
} as const;

/**
 * На каком языке написана заметка — по заголовку раздела конспекта; не понять
 * — null. Язык конспекта курса можно сменить, а прежние лекции остаются на
 * прежнем языке: читать заметку надо на её языке, а не на нынешнем курса.
 */
export function notesLanguageOf(text: string): NotesLanguage | null {
  for (const язык of ['ru', 'en'] as const) {
    if (new RegExp(`^${NOTES_WORDS[язык].notes}[ \\t]*$`, 'mu').test(text)) return язык;
  }
  return null;
}

/**
 * Названия языков лекции в тексте промпта. Нет в списке — код как есть:
 * модель его поймёт, а человеку в промпте он не виден.
 */
const ЯЗЫКИ: Record<string, { ru: string; en: string }> = {
  ru: { ru: 'русском', en: 'Russian' },
  en: { ru: 'английском', en: 'English' },
  he: { ru: 'иврите', en: 'Hebrew' },
  uk: { ru: 'украинском', en: 'Ukrainian' },
  de: { ru: 'немецком', en: 'German' },
  fr: { ru: 'французском', en: 'French' },
  es: { ru: 'испанском', en: 'Spanish' },
  ar: { ru: 'арабском', en: 'Arabic' },
};

function названиеЯзыка(код: string, notes: NotesLanguage): string {
  return ЯЗЫКИ[код]?.[notes] ?? (notes === 'ru' ? `языке «${код}»` : `language "${код}"`);
}

export interface PromptLanguages {
  lecture: string;
  notes: NotesLanguage;
  /** Вид конспекта (`jarvis/notes/style.ts`); нет — «Разбор». */
  style?: NotesStyle;
}

function слова(текст: string): number {
  return текст.split(/\s+/u).filter(Boolean).length;
}

export function метка(мс: number): string {
  const всего = Math.max(0, Math.floor(мс / 1000));
  const часы = Math.floor(всего / 3600);
  const минуты = Math.floor((всего % 3600) / 60);
  const секунды = всего % 60;
  const мм = `${String(минуты).padStart(2, '0')}:${String(секунды).padStart(2, '0')}`;
  return часы > 0 ? `${часы}:${мм}` : мм;
}

/**
 * Ответ — это и есть текст заметки.
 *
 * Живая проверка 20.10.2026: в промпте стояло «конспект живёт в Obsidian», и
 * Claude Code полез открывать хранилище, получил отказ и начал раздел словами
 * «Доступа к хранилищу Obsidian сейчас нет — вставьте раздел сами». Модели
 * незачем знать, куда ляжет текст: только что вернуть.
 */
const ОТВЕТ_ТЕКСТОМ = {
  ru: 'Ответь только текстом в разметке Markdown: ничего не открывай, не читай и не сохраняй — твой ответ целиком и есть текст, его вставит программа. Никаких пояснений до и после.',
  en: 'Reply with the Markdown text only: open, read or save nothing — your whole reply is the text, a program inserts it. No remarks before or after.',
} as const;

/** Языки для правил оформления: чужой язык лекции — по имени, свой — null. */
function языкиЗаметки(языки: PromptLanguages): NoteLanguages {
  return {
    notes: языки.notes,
    foreign: языки.lecture !== языки.notes ? названиеЯзыка(языки.lecture, языки.notes) : null,
  };
}

/**
 * Раздел конспекта: кусок расшифровки → один раздел.
 *
 * Метки «[мм:сс]» в куске — место в звуке лекции: по ним модель ставит минуту
 * у слов лектора. Как оформлять раздел — по виду конспекта, который выбрал
 * человек; общие правила разметки — одни на все заметки Джарвиса.
 */
export function sectionPrompt(
  кусок: string,
  subject: string,
  заголовки: readonly string[],
  языки: PromptLanguages = { lecture: 'ru', notes: 'ru' },
): string {
  const чужой = языки.lecture !== языки.notes;
  const язык = названиеЯзыка(языки.lecture, языки.notes);
  const вид = языки.style ?? 'razbor';
  const правила = [...sectionStyleRules(вид, языкиЗаметки(языки)), ...obsidianRules(языкиЗаметки(языки)).map((п) => `- ${п}`)];
  if (языки.notes === 'en') {
    return [
      `You are taking notes on a lecture${чужой ? ` in ${язык}` : ''} for a student who reads English.`,
      ОТВЕТ_ТЕКСТОМ.en,
      `Subject: ${subject || 'not given'}.`,
      'Below is a new chunk of the verbatim transcript. Recognition is automatic and has errors: restore the meaning, not the letters. The "[mm:ss]" marks are minutes of the recording; use them only to cite the lecturer, do not copy them otherwise.',
      '',
      'Write ONE section of notes in English:',
      '- the first line is a heading: "### " and the topic of this chunk in your own words (for example, "### The demand curve");',
      ...правила,
      '- no introductions, no retelling of earlier sections, nothing made up;',
      '- the chunk is cut by time and may start and end mid-sentence: leave out what is cut off at the edges, do not mark it.',
      `If the chunk has neither lecture content nor course logistics (noise, chatter, sound checks), reply with one word: ${NOTES_WORDS.en.skip}`,
      '',
      `Sections already written: ${заголовки.length > 0 ? заголовки.join('; ') : 'none yet'}.`,
      '',
      'Transcript:',
      кусок,
    ].join('\n');
  }
  return [
    `Ты конспектируешь лекцию${чужой ? ` на ${язык}` : ''} для студента, который читает по-русски.`,
    ОТВЕТ_ТЕКСТОМ.ru,
    `Предмет: ${subject || 'не назван'}.`,
    'Ниже — новый кусок дословной расшифровки. Распознавание автоматическое, в нём бывают ошибки: восстанавливай смысл, а не буквы. Метки «[мм:сс]» — минуты записи: ими только подписывай слова лектора, больше никуда не переноси.',
    '',
    'Сделай ОДИН раздел конспекта на русском:',
    '- первая строка — заголовок: «### » и тема этого куска своими словами (например, «### Кривая спроса»);',
    ...правила,
    '- без вступлений, без пересказа прошлых разделов, без выдуманного;',
    '- кусок режется по времени и может начинаться и кончаться на полуслове: оборванное по краям просто опусти, не помечай.',
    `Если в куске нет ни содержания лекции, ни организационного (шум, болтовня, проверка звука) — ответь одним словом: ${NOTES_WORDS.ru.skip}`,
    '',
    `Уже написанные разделы: ${заголовки.length > 0 ? заголовки.join('; ') : 'ещё нет'}.`,
    '',
    'Расшифровка:',
    кусок,
  ].join('\n');
}

/** Итог лекции: курс и тема двумя строками, дальше — части по виду конспекта. */
export function finalPrompt(
  расшифровка: string,
  subject: string,
  языки: PromptLanguages = { lecture: 'ru', notes: 'ru' },
  курсы: readonly string[] = [],
): string {
  const чужой = языки.lecture !== языки.notes;
  const язык = названиеЯзыка(языки.lecture, языки.notes);
  const вид = языки.style ?? 'razbor';
  const части = finalStyleRules(вид, языкиЗаметки(языки));
  const разметка = obsidianRules(языкиЗаметки(языки)).map((п) => `- ${п}`);
  if (языки.notes === 'en') {
    return [
      `Below is the whole transcript of a lecture${чужой ? ` in ${язык}` : ''} (automatic recognition, with errors). The "[mm:ss]" marks are minutes of the recording.`,
      ОТВЕТ_ТЕКСТОМ.en,
      `Subject as the student named it: ${subject || 'not given'}.`,
      `The student's courses: ${курсы.length > 0 ? курсы.join('; ') : 'none yet'}.`,
      '',
      'Start with two lines:',
      "Course: <which of the student's courses this lecture belongs to, exactly as listed; if none fits — a short name for a new course, in English>",
      'Topic: <the topic of this lecture in 3–6 words, in English>',
      '',
      'Then write these parts in English, in this order, with no introduction and nothing made up:',
      ...части,
      '',
      'Formatting:',
      ...разметка,
      '',
      'Transcript:',
      расшифровка,
    ].join('\n');
  }
  return [
    `Ниже — вся расшифровка лекции${чужой ? ` на ${язык}` : ''} (распознавание автоматическое, с ошибками). Метки «[мм:сс]» — минуты записи.`,
    ОТВЕТ_ТЕКСТОМ.ru,
    `Предмет, как его назвал студент: ${subject || 'не назван'}.`,
    `Курсы студента: ${курсы.length > 0 ? курсы.join('; ') : 'пока нет'}.`,
    '',
    'Начни с двух строк:',
    'Предмет: <к какому из курсов студента относится лекция — точно как в списке; если ни один не подходит — короткое название нового курса по-русски, в именительном падеже>',
    'Тема: <тема этой лекции в 3–6 словах, по-русски>',
    '',
    'Дальше напиши на русском эти части, по порядку, без вступлений и без выдуманного:',
    ...части,
    '',
    'Оформление:',
    ...разметка,
    '',
    'Расшифровка:',
    расшифровка,
  ].join('\n');
}

/**
 * Ответ модели → раздел: заголовок обязателен, отказ — ничего. Отказ
 * узнаётся на обоих языках: модель иногда отвечает не тем словом, что просили.
 */
export function sectionFromReply(ответ: string, номер: number, notes: NotesLanguage = 'ru'): string | null {
  let текст = tidyNoteMarkdown(ответ);
  // Слова модели до заголовка раздела — не конспект («доступа нет, вставьте сами»).
  const заголовок = текст.search(/^### /mu);
  if (заголовок > 0) текст = текст.slice(заголовок);
  const начало = текст.toUpperCase();
  if (!текст || начало.startsWith(NOTES_WORDS.ru.skip) || начало.startsWith(NOTES_WORDS.en.skip)) return null;
  return текст.startsWith('### ') ? текст : `### ${NOTES_WORDS[notes].section} ${номер}\n${текст}`;
}

/** Время раздела — в его заголовке: «### Пределы (12:40–17:55)». */
export function withRange(раздел: string, отМс: number, доМс: number): string {
  const [первая, ...остальное] = раздел.split('\n');
  return [`${первая ?? ''} (${метка(отМс)}–${метка(доМс)})`, ...остальное].join('\n');
}

/** Название раздела без «### » и без времени. */
export function sectionTitle(строка: string): string {
  return строка
    .replace(/^###\s*/u, '')
    .replace(/\s*\(\d[\d:]*–\d[\d:]*\)\s*$/u, '')
    // Прежний промпт показывал заголовок «### Тема куска», и модель
    // иногда повторяла его буквально: «Тема куска: Большая история».
    .replace(/^(тема куска|topic of the chunk)\s*[:—-]\s*/iu, '')
    .trim();
}

export class LectureSession {
  readonly notesFile: string;
  readonly transcriptFile: string;
  readonly audioFile: string;
  /** Когда лекция началась — для свойств заметки и расписания. */
  readonly startedAt: Date;

  private расшифровка: Promise<void> = Promise.resolve();
  private разделы: Promise<void> = Promise.resolve();
  private копится: Array<{ текст: string; от: number; до: number }> = [];
  private readonly вся: string[] = [];
  /** То же, с минутой каждого куска: по ней модель подписывает слова лектора. */
  private readonly сМетками: string[] = [];
  private readonly заголовки: string[] = [];
  /** Сколько звука принято, мс: запись сплошная, и это же — место в WAV. */
  private мсЗвука = 0;
  /** Сколько секунд звука ждёт распознавания. */
  private вОчереди = 0;
  /** Запись звука в файл — своей очередью, впереди распознавания. */
  private запись: Promise<void> = Promise.resolve();
  /** Где кончился прошлый раздел, мс звука. */
  private последнийРаздел = 0;
  private номерРаздела = 0;
  private байтЗвука = 0;
  private частотаЗвука = 16_000;
  private закончена = false;
  private readonly языки: PromptLanguages;
  private readonly слова: (typeof NOTES_WORDS)[NotesLanguage];

  constructor(
    private readonly folder: string,
    private readonly subject: string,
    private readonly deps: LectureDeps,
    when: Date = new Date(),
  ) {
    const notes = deps.notesLanguage ?? 'ru';
    this.языки = { lecture: deps.lectureLanguage ?? notes, notes, style: deps.notesStyle };
    this.слова = NOTES_WORDS[notes];
    const base = lectureFileBase(subject, when, notes);
    this.notesFile = path.join(folder, `${base}.md`);
    this.transcriptFile = path.join(folder, `${base} — ${this.слова.transcriptFile}.md`);
    this.audioFile = path.join(folder, `${base}.wav`);
    this.startedAt = when;
  }

  async start(): Promise<void> {
    await mkdir(this.folder, { recursive: true });
    const base = path.basename(this.notesFile, '.md');
    const с = this.слова;
    const предмет = this.subject || с.lecture;
    const расшифровка = path.basename(this.transcriptFile, '.md');
    await writeFile(
      this.notesFile,
      [
        `# ${предмет}`,
        '',
        `${с.transcript}: [[${расшифровка}]] · ${с.audio}: ${path.basename(this.audioFile)}`,
        '',
        с.notes,
        '',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(this.transcriptFile, `# ${с.transcript} — ${предмет}\n\n${с.notesLink}: [[${base}]]\n\n`, 'utf8');
    await writeFile(this.audioFile, wavHeader(0, this.частотаЗвука));
  }

  /**
   * Кусок звука лекции: в запись, в расшифровку, и — когда накопилось — в раздел.
   *
   * Запись сплошная, тишина тоже пишется: метка куска — его место в самом
   * звуке, а не время прихода. По ней потом включается звук «с той минуты»,
   * и она обязана с ним совпадать.
   */
  addAudio(samples: Float32Array, sampleRate: number): void {
    if (this.закончена) return;
    const когда = this.мсЗвука;
    const конец = когда + (samples.length / sampleRate) * 1000;
    this.мсЗвука = конец;
    const секунд = samples.length / sampleRate;
    if (когда === 0) this.частотаЗвука = sampleRate;
    // Звук — в файл сразу, своей очередью, а не когда до куска дойдёт
    // распознавание. На машине, которая распознаёт медленнее речи (мак на
    // Intel без видеокарты), очередь распознавания отстаёт на десятки минут,
    // и закрой человек Джарвис в это время — нераспознанный звук пропал бы
    // вместе с памятью. Запись от скорости распознавания не зависит.
    const pcm = pcm16(samples);
    this.запись = this.запись
      .then(async () => {
        await appendFile(this.audioFile, pcm);
        this.байтЗвука += pcm.length;
      })
      .catch((error: unknown) => this.deps.log?.(`звук куска ${метка(когда)} не записан: ${error instanceof Error ? error.message : String(error)}`));
    this.вОчереди += секунд;
    // Упавший кусок не должен останавливать очередь: цепочка обещаний после
    // отказа пропускала бы все следующие куски до конца лекции.
    this.расшифровка = this.расшифровка.then(async () => {
      try {
        await this.кусок(samples, sampleRate, когда, конец);
      } catch (error) {
        this.deps.log?.(`кусок ${метка(когда)} не записан: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.вОчереди -= секунд;
      }
    });
  }

  private async кусок(samples: Float32Array, sampleRate: number, когда: number, конец: number): Promise<void> {
    let текст = '';
    try {
      текст = (await this.deps.transcribe(samples, sampleRate)).trim();
    } catch (error) {
      this.deps.log?.(`кусок не распознан: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!текст) return;
    await appendFile(this.transcriptFile, `**[${метка(когда)}]** ${текст}\n\n`, 'utf8');
    this.копится.push({ текст, от: когда, до: конец });
    this.вся.push(текст);
    this.сМетками.push(`[${метка(когда)}] ${текст}`);
    this.deps.log?.(`кусок ${метка(когда)}: ${слова(текст)} слов`);
    this.maybeSection(false);
  }

  /** Раздел, когда накопилось достаточно и прошло достаточно; `всё` — при завершении. */
  private maybeSection(всё: boolean): void {
    const накоплено = this.копится.map((к) => к.текст).join(' ');
    if (!накоплено.trim()) return;
    const порогСлов = this.deps.sectionMinWords ?? 120;
    const порогВремени = this.deps.sectionEveryMs ?? 5 * 60_000;
    const от = this.копится[0]?.от ?? 0;
    const до = this.копится[this.копится.length - 1]?.до ?? от;
    if (!всё && (слова(накоплено) < порогСлов || до - this.последнийРаздел < порогВремени)) return;
    const дляМодели = this.копится.map((к) => `[${метка(к.от)}] ${к.текст}`).join('\n');

    this.копится = [];
    this.последнийРаздел = до;
    const номер = ++this.номерРаздела;
    const заголовки = [...this.заголовки];
    this.разделы = this.разделы.then(async () => {
      let раздел: string | null;
      try {
        раздел = sectionFromReply(await this.deps.summarize(sectionPrompt(дляМодели, this.subject, заголовки, this.языки)), номер, this.языки.notes);
      } catch (error) {
        const причина = error instanceof Error ? error.message : String(error);
        this.deps.log?.(`раздел ${номер} не собрался: ${причина}`);
        раздел = `### ${this.слова.section} ${номер}\n${this.слова.failed(причина.slice(0, 120))}`;
      }
      if (!раздел) return;
      this.заголовки.push(sectionTitle(раздел.split('\n')[0] ?? '') || `${this.слова.section} ${номер}`);
      await appendFile(this.notesFile, `${withRange(раздел, от, до)}\n\n`, 'utf8');
    });
  }

  /**
   * Джарвис закрывается посреди лекции: итога не будет, а звук должен
   * остаться целым.
   *
   * Размер в заголовке WAV дописывался только в `finish`, и после выхода
   * посреди лекции (живой прогон 29.09.2026) файл на 11 МБ плеер показывал
   * пустым. Здесь — синхронно и по настоящему размеру файла: ждать очередь
   * закрытие не может.
   */
  abandon(): void {
    this.закончена = true;
    this.заголовокПоРазмеру();
    // И ещё раз, когда очередь допишет уже принятые куски: иначе их звук
    // оказался бы за объявленным размером и не проигрывался бы.
    void this.запись.finally(() => this.заголовокПоРазмеру());
  }

  /**
   * Дождаться, пока в очереди распознавания останется не больше `maxSec`
   * звука. Файл раскрывается быстрее, чем распознаётся (полтора часа — за
   * полминуты против десяти минут), и без этого весь звук лежал бы в памяти
   * очередью.
   */
  /** Сколько секунд звука ещё ждёт распознавания: столько распознавание отстаёт от лекции. */
  get lagSeconds(): number {
    return this.вОчереди;
  }

  async backlog(maxSec: number): Promise<void> {
    while (this.вОчереди > maxSec) await new Promise((готово) => setTimeout(готово, 200));
  }

  private заголовокПоРазмеру(): void {
    try {
      const данные = Math.max(0, statSync(this.audioFile).size - 44);
      const файл = openSync(this.audioFile, 'r+');
      try {
        writeSync(файл, wavHeader(данные, this.частотаЗвука), 0, 44, 0);
      } finally {
        closeSync(файл);
      }
    } catch {
      // Файла нет — беречь нечего.
    }
  }

  /**
   * Дописать последний раздел, итог — над разделами, и закрыть запись звука.
   * `курсы` — курсы человека: модель выбирает из них, к какому относится лекция.
   */
  async finish(курсы: readonly string[] = []): Promise<LectureResult> {
    this.закончена = true;
    await this.расшифровка;
    this.maybeSection(true);
    await this.разделы;

    const расшифровка = this.вся.join('\n');
    let course: string | undefined;
    let topic: string | undefined;
    if (расшифровка.trim()) {
      try {
        const итогом = this.deps.summarizeFinal ?? this.deps.summarize;
        const ответ = splitCourseAndTopic(await итогом(finalPrompt(this.сМетками.join('\n'), this.subject, this.языки, курсы)));
        ({ course, topic } = ответ);
        const итог = ответ.rest ? tidyNoteMarkdown(fromSummary(ответ.rest)) : '';
        if (итог) {
          const заметка = await readFile(this.notesFile, 'utf8');
          const место = заметка.indexOf(this.слова.notes);
          const новая = место >= 0 ? `${заметка.slice(0, место)}${итог}\n\n${заметка.slice(место)}` : `${заметка}\n${итог}\n`;
          await writeFile(this.notesFile, новая, 'utf8');
        }
      } catch (error) {
        this.deps.log?.(`итог не собрался: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.запись;
    const файл = await open(this.audioFile, 'r+');
    try {
      await файл.write(wavHeader(this.байтЗвука, this.частотаЗвука), 0, 44, 0);
    } finally {
      await файл.close();
    }
    return {
      notesFile: this.notesFile,
      transcriptFile: this.transcriptFile,
      audioFile: this.audioFile,
      words: слова(расшифровка),
      sections: this.заголовки.length,
      durationSec: this.мсЗвука / 1000,
      course,
      topic,
    };
  }
}

function pcm16(samples: Float32Array): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(s * 0x7fff), i * 2);
  }
  return buffer;
}

/** Заголовок WAV: 16 бит, моно. Размеры дописываются в конце лекции. */
function wavHeader(dataBytes: number, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
