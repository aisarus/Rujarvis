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

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { splitCourseAndTopic } from './courses';
import { finalPrompt, NOTES_WORDS, sectionFromReply, sectionPrompt, sectionTitle, withRange, type NotesLanguage } from './session';

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
  /** Секунды от начала лекции: первый кусок раздела и начало следующего. */
  from: number;
  to: number;
}

/** Разделы: не чаще раза в `everySec` и не меньше `minWords` слов; остаток — последним. */
export function groupSections(куски: readonly TranscriptChunk[], everySec = 300, minWords = 120): TranscriptSection[] {
  const разделы: TranscriptSection[] = [];
  let копится: string[] = [];
  let начало = куски[0]?.at ?? 0;
  let от = начало;
  for (const [i, кусок] of куски.entries()) {
    копится.push(кусок.text);
    const текст = копится.join(' ');
    if (кусок.at - начало >= everySec && слов(текст) >= minWords) {
      const до = куски[i + 1]?.at ?? кусок.at;
      разделы.push({ text: текст, from: от, to: до });
      копится = [];
      начало = кусок.at;
      от = до;
    }
  }
  if (копится.join(' ').trim()) разделы.push({ text: копится.join(' '), from: от, to: куски[куски.length - 1]?.at ?? от });
  return разделы;
}

export interface FinishFromTranscriptOptions {
  notesFile: string;
  summarize(prompt: string): Promise<string>;
  lectureLanguage: string;
  notesLanguage: NotesLanguage;
  /** Курсы человека: модель выбирает из них, к какому относится лекция. */
  courses?: readonly string[];
  log?(line: string): void;
}

export interface FinishFromTranscriptResult {
  sections: number;
  summary: boolean;
  /** Курс и тема — как их назвала модель. */
  course?: string;
  topic?: string;
  /** Почему ничего не сделано: уже дописан, нет расшифровки. */
  skipped?: string;
}

export async function finishFromTranscript(options: FinishFromTranscriptOptions): Promise<FinishFromTranscriptResult> {
  const с = NOTES_WORDS[options.notesLanguage];
  const заметка = await readFile(options.notesFile, 'utf8');
  const заголовокИтога = options.notesLanguage === 'en' ? '## Summary' : '## Кратко';
  if (заметка.includes(заголовокИтога)) return { sections: 0, summary: false, skipped: 'конспект уже дописан' };

  const база = path.basename(options.notesFile, '.md');
  const расшифровкаФайл = path.join(path.dirname(options.notesFile), `${база} — ${с.transcriptFile}.md`);
  const расшифровка = await readFile(расшифровкаФайл, 'utf8').catch(() => null);
  const куски = расшифровка ? parseTranscript(расшифровка) : [];
  if (куски.length === 0) return { sections: 0, summary: false, skipped: 'расшифровки нет' };

  const предмет = /^#\s+(.+)$/mu.exec(заметка)?.[1]?.trim() ?? '';
  const subject = предмет === с.lecture ? '' : предмет;
  const языки = { lecture: options.lectureLanguage, notes: options.notesLanguage };

  // Разделы, написанные вживую, не повторяются: живая сессия режет по тому
  // же правилу, так что первые из них уже в заметке (ревью 29.09.2026 —
  // лекция, закрытая на тридцатой минуте, получала шесть разделов дважды).
  const место0 = заметка.indexOf(с.notes);
  const живые = место0 >= 0
    ? [...заметка.slice(место0).matchAll(/^###\s+(.+)$/gmu)].map((m) => sectionTitle(m[1] ?? ''))
    : [];
  const заголовки: string[] = [...живые];
  const разделы: string[] = [];
  for (const [номер, { text: текст, from, to }] of groupSections(куски).entries()) {
    if (номер < живые.length) continue;
    let раздел: string | null;
    try {
      раздел = sectionFromReply(await options.summarize(sectionPrompt(текст, subject, заголовки, языки)), номер + 1, options.notesLanguage);
    } catch (error) {
      const причина = error instanceof Error ? error.message : String(error);
      options.log?.(`раздел ${номер + 1} не собрался: ${причина}`);
      раздел = `### ${с.section} ${номер + 1}\n${с.failed(причина.slice(0, 120))}`;
    }
    if (!раздел) continue;
    заголовки.push(sectionTitle(раздел.split('\n')[0] ?? '') || `${с.section} ${номер + 1}`);
    разделы.push(withRange(раздел, from * 1000, to * 1000));
  }

  let итог = '';
  let course: string | undefined;
  let topic: string | undefined;
  try {
    const ответ = splitCourseAndTopic(
      await options.summarize(finalPrompt(куски.map((к) => к.text).join('\n'), subject, языки, options.courses ?? [])),
    );
    ({ course, topic } = ответ);
    итог = ответ.rest;
  } catch (error) {
    options.log?.(`итог не собрался: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Разделы — после заголовка конспекта, итог — над ним. Чего-то нет в
  // заметке — дописываем в конец, но не теряем.
  const место = заметка.indexOf(с.notes);
  const тело = разделы.map((р) => `${р}\n\n`).join('');
  const новая =
    место >= 0
      ? `${заметка.slice(0, место)}${итог ? `${итог}\n\n` : ''}${заметка.slice(место).trimEnd()}\n\n${тело}`
      : `${заметка.trimEnd()}\n\n${итог ? `${итог}\n\n` : ''}${с.notes}\n\n${тело}`;
  await writeFile(options.notesFile, новая, 'utf8');
  return { sections: разделы.length, summary: Boolean(итог), course, topic };
}
