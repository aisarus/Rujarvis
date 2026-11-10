/**
 * Дописать конспект по сохранённой расшифровке.
 *
 * Джарвиса закрыли посреди лекции — расшифровка и звук на диске, а
 * разделов и итога нет: на них нужна минута модели, а закрытие ждать не
 * может. Живой прогон 29.09.2026 кончился ровно так: шесть с половиной
 * минут лекции, двадцать восемь кусков расшифровки и пустой конспект.
 *
 * Разделы режутся так же, как в живой сессии, — по пять минут и не меньше
 * 120 слов, по меткам времени расшифровки; итог встаёт над разделами.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { fromSummary, hasSummary, tidyNoteMarkdown, type NotesStyle } from '../notes/style';
import { writeFileAtomic } from './atomicWrite';
import { splitCourseAndTopic } from './courses';
import { FAILED_SECTION, finalPrompt, NOTES_WORDS, sectionFromReply, sectionPrompt, timedTranscript, withRange, type NotesLanguage } from './session';

export interface TranscriptChunk {
  /** Секунды от начала лекции. */
  at: number;
  text: string;
}

/** Куски расшифровки: строки вида «**[12:40]** текст» (и «**[1:02:03]** текст»). */
export function parseTranscript(markdown: string): TranscriptChunk[] {
  const куски: TranscriptChunk[] = [];
  for (const строка of markdown.split(/\r?\n/u)) {
    const найдено = /^\*\*\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\*\*\s+(.+)$/u.exec(строка.trim());
    if (!найдено) continue;
    const [, часы, минуты, секунды, текст] = найдено;
    куски.push({
      at: Number(часы ?? 0) * 3600 + Number(минуты) * 60 + Number(секунды),
      text: (текст ?? '').trim(),
    });
  }
  return куски;
}

function слов(текст: string): number {
  return текст.split(/\s+/u).filter(Boolean).length;
}

export interface TranscriptSection {
  text: string;
  /** Тот же текст по кускам, с минутой каждого — для модели: по ней она подписывает слова лектора и пометки. */
  stamped: string;
  /** Секунды от начала лекции: первый кусок раздела и начало следующего. */
  from: number;
  to: number;
}

/**
 * Разделы: не чаще раза в `everySec` и не меньше `minWords` слов; остаток — последним.
 * Слова считаются без меток: режется ровно так же, как в живой сессии.
 */
export function groupSections(куски: readonly TranscriptChunk[], everySec = 300, minWords = 120): TranscriptSection[] {
  const разделы: TranscriptSection[] = [];
  let копится: TranscriptChunk[] = [];
  let начало = куски[0]?.at ?? 0;
  let от = начало;
  const раздел = (до: number): TranscriptSection => ({
    text: копится.map((к) => к.text).join(' '),
    stamped: сМетками(копится),
    from: от,
    to: до,
  });
  for (const [i, кусок] of куски.entries()) {
    копится.push(кусок);
    if (кусок.at - начало >= everySec && слов(копится.map((к) => к.text).join(' ')) >= minWords) {
      const до = куски[i + 1]?.at ?? кусок.at;
      разделы.push(раздел(до));
      копится = [];
      начало = кусок.at;
      от = до;
    }
  }
  if (копится.map((к) => к.text).join(' ').trim()) разделы.push(раздел(куски[куски.length - 1]?.at ?? от));
  return разделы;
}

function сМетками(куски: readonly TranscriptChunk[]): string {
  return timedTranscript(куски.map((к) => ({ текст: к.text, от: к.at * 1000 })));
}

export interface FinishFromTranscriptOptions {
  notesFile: string;
  summarize(prompt: string): Promise<string>;
  /** Итог — сильнейшей моделью; нет — тем же `summarize`. */
  summarizeFinal?(prompt: string): Promise<string>;
  lectureLanguage: string;
  notesLanguage: NotesLanguage;
  /** Вид конспекта в Obsidian; нет — «Разбор». */
  notesStyle?: NotesStyle;
  /** Курсы человека: модель выбирает из них, к какому относится лекция. */
  courses?: readonly string[];
  /**
   * Куски, которые добрали из записи уже после того, как их минуты прошли в
   * конспекте (дыра посреди лекции): им тоже нужен раздел.
   */
  fresh?: readonly TranscriptChunk[];
  /** Предмет для модели; не задан — заголовок заметки (у брошенной лекции он и есть предмет). */
  subject?: string;
  log?(line: string): void;
}

export interface FinishFromTranscriptResult {
  /** Сколько разделов написано в этот раз: новых и переделанных из заглушек. */
  sections: number;
  /** Итог написан в этот раз. */
  summary: boolean;
  /** Сколько заглушек «Раздел не собрался» осталось в заметке. */
  failedSections: number;
  /** В заметке есть итог и нет заглушек: переделывать нечего. */
  complete: boolean;
  /** Почему итог не написан — словами модели или CLI. */
  summaryError?: string;
  /** Курс и тема — как их назвала модель. */
  course?: string;
  topic?: string;
  /** Почему ничего не сделано: уже дописан, нет расшифровки. */
  skipped?: string;
}

/** Время из заголовка раздела: «### Пределы (12:40–17:55)» → секунды. */
export function sectionRange(заголовок: string): { from: number; to: number } | null {
  const m = /\((\d+(?::\d\d){1,2})\s*[–-]\s*(\d+(?::\d\d){1,2})\)\s*$/u.exec(заголовок.trim());
  if (!m) return null;
  const секунды = (метка: string): number => метка.split(':').reduce((всего, часть) => всего * 60 + Number(часть), 0);
  return { from: секунды(m[1] ?? '0'), to: секунды(m[2] ?? '0') };
}

/**
 * Дописать конспект: переделать заглушки «Раздел не собрался», написать
 * разделы для того, чего в конспекте ещё нет, и итог, если его нет.
 *
 * Зовётся и для брошенной лекции, и для разложенной, которую не дописали:
 * кончился лимит подписки, пропала сеть. Сделанное не повторяется — что уже
 * есть в заметке, видно по времени в заголовках разделов.
 */
export async function finishFromTranscript(options: FinishFromTranscriptOptions): Promise<FinishFromTranscriptResult> {
  const с = NOTES_WORDS[options.notesLanguage];
  const заметка = await readFile(options.notesFile, 'utf8');
  const заглушек = (текст: string): number => текст.match(new RegExp(FAILED_SECTION.source, 'gmu'))?.length ?? 0;
  if (hasSummary(заметка) && заглушек(заметка) === 0 && !options.fresh?.length) {
    return { sections: 0, summary: false, failedSections: 0, complete: true, skipped: 'конспект уже дописан' };
  }

  const база = path.basename(options.notesFile, '.md');
  const расшифровкаФайл = path.join(path.dirname(options.notesFile), `${база} — ${с.transcriptFile}.md`);
  const расшифровка = await readFile(расшифровкаФайл, 'utf8').catch(() => null);
  const куски = расшифровка ? parseTranscript(расшифровка) : [];
  if (куски.length === 0) {
    return { sections: 0, summary: false, failedSections: заглушек(заметка), complete: false, skipped: 'расшифровки нет' };
  }

  // У разложенной лекции заголовок — уже тема, а не предмет: предмет — её курс.
  const предмет = /^#\s+(.+)$/mu.exec(заметка)?.[1]?.trim() ?? '';
  const subject = options.subject ?? (предмет === с.lecture ? '' : предмет);
  const языки = { lecture: options.lectureLanguage, notes: options.notesLanguage, style: options.notesStyle };

  // Что в конспекте уже есть — по времени в заголовках разделов, а не по
  // счёту: кусок, на который модель ответила «ПРОПУСК», раздела не оставил, и
  // счёт съезжал — следующие разделы писались второй раз.
  const место0 = заметка.indexOf(с.notes);
  const доКонспекта = место0 >= 0 ? заметка.slice(0, место0 + с.notes.length) : заметка;
  const части = место0 >= 0 ? заметка.slice(место0 + с.notes.length).split(/^(?=###\s)/mu) : [];
  const прежние: string[] = части.map((ч) => ч.trim()).filter((ч) => ч.startsWith('###') && !FAILED_SECTION.test(ч));
  let покрыто = 0;
  for (const часть of части) {
    const время = часть.startsWith('###') ? sectionRange(часть.split('\n')[0] ?? '') : null;
    if (время) покрыто = Math.max(покрыто, время.to);
  }

  let написано = 0;
  const раздел = async (текст: string, номер: number): Promise<{ текст: string | null; ошибка?: string }> => {
    try {
      return { текст: sectionFromReply(await options.summarize(sectionPrompt(текст, subject, прежние, языки)), номер, options.notesLanguage) };
    } catch (error) {
      const причина = error instanceof Error ? error.message : String(error);
      options.log?.(`раздел ${номер} не собрался: ${причина}`);
      return { текст: null, ошибка: причина.replace(/\s+/gu, ' ').slice(0, 120) };
    }
  };

  // Заглушки — на своих местах: тот же отрезок расшифровки, новая попытка.
  for (const [i, часть] of части.entries()) {
    if (!часть.startsWith('###') || !FAILED_SECTION.test(часть)) continue;
    const время = sectionRange(часть.split('\n')[0] ?? '');
    if (!время) continue;
    const свои = куски.filter((к) => к.at >= время.from && к.at < время.to);
    if (свои.length === 0) continue;
    const ответ = await раздел(сМетками(свои), i);
    if (ответ.ошибка) continue;
    // Заглушка — заголовок и строка причины до пустой строки; что человек дописал ниже, остаётся.
    const заглушка = /^### .*\r?\n> (?:Раздел не собрался|This section failed) \([\s\S]*?(?=\r?\n\r?\n|$(?![\s\S]))/mu;
    const новый = ответ.текст ? withRange(ответ.текст, время.from * 1000, время.to * 1000) : '';
    части[i] = часть.replace(заглушка, новый);
    if (новый) {
      прежние.push(новый);
      написано += 1;
    }
  }

  // Новые разделы — для того, что после написанного, и для добранного из дыр.
  const добранные = new Set((options.fresh ?? []).map((к) => к.at));
  const новыеКуски = куски.filter((к) => к.at >= покрыто || добранные.has(к.at));
  const последний = куски[куски.length - 1]?.at ?? 0;
  const разделы: string[] = [];
  const написанные = части.filter((ч) => ч.startsWith('###'));
  const номер0 = написанные.length;
  // Раздел без времени в заголовке — заметка старого вида или правленая руками:
  // тогда, как раньше, по счёту — живая сессия режет по тому же правилу.
  const поВремени = написанные.every((ч) => sectionRange(ч.split('\n')[0] ?? '') !== null);
  const группы = поВремени ? groupSections(новыеКуски) : groupSections(куски).slice(номер0);
  for (const [номер, { stamped: текст, from, to }] of группы.entries()) {
    const ответ = await раздел(текст, номер0 + номер + 1);
    const готовый = ответ.ошибка ? `### ${с.section} ${номер0 + номер + 1}\n${с.failed(ответ.ошибка)}` : ответ.текст;
    if (!готовый) continue;
    // Последний раздел кончается за последним куском: по его времени потом
    // видно, что кусок уже в конспекте, и раздел не пишется второй раз.
    const сВременем = withRange(готовый, from * 1000, (to >= последний ? последний + 1 : to) * 1000);
    if (!ответ.ошибка) {
      прежние.push(сВременем);
      написано += 1;
    }
    разделы.push(сВременем);
  }

  let итог = '';
  let course: string | undefined;
  let topic: string | undefined;
  let summaryError: string | undefined;
  if (!hasSummary(заметка)) {
    try {
      const ответ = splitCourseAndTopic(
        await (options.summarizeFinal ?? options.summarize)(finalPrompt(сМетками(куски), subject, языки, options.courses ?? [])),
      );
      ({ course, topic } = ответ);
      итог = ответ.rest ? tidyNoteMarkdown(fromSummary(ответ.rest)) : '';
      if (!итог) summaryError = 'модель ответила пусто';
    } catch (error) {
      summaryError = (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 200);
      options.log?.(`итог не собрался: ${summaryError}`);
    }
  }

  // Разделы — после заголовка конспекта, итог — над ним. Чего-то нет в
  // заметке — дописываем в конец, но не теряем.
  const тело = разделы.map((р) => `${р}\n\n`).join('');
  const новая =
    место0 >= 0
      ? `${заметка.slice(0, место0)}${итог ? `${итог}\n\n` : ''}${с.notes}${части.join('').trimEnd()}\n\n${тело}`
      : `${доКонспекта.trimEnd()}\n\n${итог ? `${итог}\n\n` : ''}${с.notes}\n\n${тело}`;
  if (новая !== заметка) await writeFileAtomic(options.notesFile, новая);
  const осталось = заглушек(новая);
  return {
    sections: написано,
    summary: Boolean(итог),
    failedSections: осталось,
    complete: hasSummary(новая) && осталось === 0,
    ...(summaryError ? { summaryError } : {}),
    course,
    topic,
  };
}
