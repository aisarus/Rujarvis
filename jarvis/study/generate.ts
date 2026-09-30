/**
 * Заготовка учёбы по лекции: вопросы квиза, карточки, задачи.
 *
 * Делается один раз, когда лекция легла в курс, — поэтому окно учёбы
 * открывается сразу, а модель зовётся только проверить открытый ответ. На
 * входе — разделы конспекта со своим временем, «Понятия» и расшифровка с
 * метками; на выходе — JSON, который проверяет `quality.ts`.
 *
 * Вопросы — на языке лекции (экзамен будет на нём же) с переводом на язык
 * конспекта; разбор, подсказка и эталон ответа — на языке конспекта.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parseFrontmatter } from '../lecture/courses';
import { parseTranscript } from '../lecture/finishFromTranscript';
import { NOTES_WORDS, sectionTitle, type NotesLanguage } from '../lecture/session';
import { checkGenerated, parseStamp } from './quality';
import type { LectureBank, StudyTopic } from './types';

/** Разделы, из которых вопросов не делают: формат экзамена и часы приёма — не материал. */
const НЕ_МАТЕРИАЛ = /^(организационное|course logistics)$/iu;

export interface LectureSource {
  lecture: string;
  notesFile: string;
  audioFile?: string;
  course: string;
  date: string;
  number?: number;
  topic?: string;
  topics: StudyTopic[];
  /** Пункты конспекта по разделам. */
  sectionText: string[];
  /** Строки «Понятий». */
  concepts: string[];
  /** Расшифровка по разделам: строки «[мм:сс] текст». */
  sectionTranscript: string[];
}

function метка(секунд: number): string {
  const ч = Math.floor(секунд / 3600);
  const м = Math.floor((секунд % 3600) / 60);
  const с = Math.floor(секунд % 60);
  const мс = `${String(м).padStart(2, '0')}:${String(с).padStart(2, '0')}`;
  return ч > 0 ? `${ч}:${мс}` : мс;
}

/** Заметка и расшифровка лекции → разделы-темы и текст для модели. */
export async function readLectureSource(notesFile: string, notes: NotesLanguage): Promise<LectureSource | null> {
  const текст = await readFile(notesFile, 'utf8');
  const meta = parseFrontmatter(текст);
  if (!meta) return null;
  const с = NOTES_WORDS[notes];
  const lecture = path.basename(notesFile, '.md');
  const база = notesFile.replace(/\.md$/u, '');

  const место = текст.indexOf(с.notes);
  const тело = место >= 0 ? текст.slice(место + с.notes.length) : '';
  const topics: StudyTopic[] = [];
  const sectionText: string[] = [];
  for (const блок of тело.split(/^###[ \t]+/mu).slice(1)) {
    const [заголовок = '', ...строки] = блок.split(/\r?\n/u);
    const title = sectionTitle(заголовок);
    if (!title || НЕ_МАТЕРИАЛ.test(title)) continue;
    const время = /\((\d[\d:]*)–(\d[\d:]*)\)\s*$/u.exec(заголовок);
    topics.push({
      id: `${lecture}#${topics.length + 1}`,
      lecture,
      title,
      from: время ? parseStamp(время[1]) : undefined,
      to: время ? parseStamp(время[2]) : undefined,
    });
    sectionText.push(строки.join('\n').trim());
  }

  const понятия = /^## (Понятия|Concepts)\s*$([\s\S]*?)(?=^## |(?![\s\S]))/mu.exec(текст);
  const concepts = (понятия?.[2] ?? '')
    .split(/\r?\n/u)
    .map((s) => s.replace(/^\s*[-*]\s*/u, '').trim())
    .filter(Boolean);

  const расшифровка = await readFile(`${база} — ${с.transcriptFile}.md`, 'utf8').catch(() => '');
  const куски = parseTranscript(расшифровка);
  const sectionTranscript = topics.map((т, i) => {
    const от = т.from ?? 0;
    const до = т.to ?? topics[i + 1]?.from ?? Infinity;
    return куски
      .filter((к) => к.at >= от - 5 && к.at < до)
      .map((к) => `[${метка(к.at)}] ${к.text}`)
      .join('\n');
  });

  return {
    lecture,
    notesFile,
    audioFile: `${база}.wav`,
    course: meta.course,
    date: meta.date,
    number: meta.number,
    topic: meta.topic,
    topics,
    sectionText,
    concepts,
    sectionTranscript,
  };
}

const ЯЗЫК: Record<string, { ru: string; en: string }> = {
  ru: { ru: 'русском', en: 'Russian' },
  en: { ru: 'английском', en: 'English' },
  he: { ru: 'иврите', en: 'Hebrew' },
};

function язык(код: string, notes: NotesLanguage): string {
  return ЯЗЫК[код]?.[notes] ?? код;
}

/**
 * Разделы — пачками: вся полуторачасовая лекция в один вызов не влезает по
 * ответу (тридцать вопросов с разбором каждого варианта — десятки тысяч
 * знаков). Пачка — пока расшифровка не превысила `budget` знаков.
 */
export function sectionBatches(src: LectureSource, budget = 14_000): number[][] {
  const пачки: number[][] = [];
  let текущая: number[] = [];
  let размер = 0;
  for (let i = 0; i < src.topics.length; i += 1) {
    const знаков = (src.sectionTranscript[i]?.length ?? 0) + (src.sectionText[i]?.length ?? 0);
    if (текущая.length > 0 && размер + знаков > budget) {
      пачки.push(текущая);
      текущая = [];
      размер = 0;
    }
    текущая.push(i);
    размер += знаков;
  }
  if (текущая.length > 0) пачки.push(текущая);
  return пачки;
}

export function studyPrompt(
  src: LectureSource,
  lectureLanguage: string,
  notes: NotesLanguage,
  sections: readonly number[] = src.topics.map((_, i) => i),
): string {
  const перевод = lectureLanguage !== notes;
  const разделы = sections
    .map((i) => ({ т: src.topics[i] as StudyTopic, i }))
    .map(({ т, i }) =>
      [
        `РАЗДЕЛ ${i + 1}: ${т.title}${т.from !== undefined && т.to !== undefined ? ` (${метка(т.from)}–${метка(т.to)})` : ''}`,
        'Конспект:',
        src.sectionText[i] || '—',
        'Расшифровка:',
        src.sectionTranscript[i] || '—',
      ].join('\n'),
    )
    .join('\n\n');
  const лекция = язык(lectureLanguage, 'ru');
  const конспект = язык(notes, 'ru');
  return [
    `Ты готовишь студента к экзамену по курсу «${src.course}». Ниже — одна лекция: разделы конспекта и дословная расшифровка с метками времени (распознавание автоматическое, с ошибками).`,
    '',
    'ПРАВИЛА ДОВЕРИЯ:',
    '- только то, что есть в этой лекции; чего в лекции нет — не спрашивай и не досочиняй из своих знаний;',
    '- у каждого вопроса, карточки и задачи — номер раздела (section) и метка времени (at, «мм:сс»), где это прозвучало;',
    '- организационное (экзамен, часы приёма) — не материал, по нему не спрашивай.',
    '',
    'СДЕЛАЙ:',
    `1. questions — по 3–5 вопросов на раздел с содержанием. Вопрос с выбором: ровно четыре варианта, у верного — "correct": true, у трёх остальных — "correct": false; ловушки правдоподобные, из той же категории (не шуточные, не «все ответы верны»). Верный вариант ставь на разные места, не всегда первым. ${
      перевод
        ? `Вопрос и варианты — на ${лекция} (так будет на экзамене), с переводом на ${конспект}: promptRu и у каждого варианта ru.`
        : `Вопрос и варианты — на ${конспект}.`
    } У каждого варианта why — почему он верен или неверен, по существу этого варианта. explanation — разбор верного ответа, hint — короткая подсказка для памяти, answer — эталонный ответ в одну-две фразы для открытого ответа; всё это на ${конспект}.`,
    `2. cards — карточка на каждое важное понятие этих разделов (только тех, что в них звучат): front — термин${перевод ? ` на ${лекция} и в скобках на ${конспект}` : ''}, back — объяснение в одну-две фразы на ${конспект}.`,
    `3. tasks — только если в лекции есть расчёты, формулы, код или разбор задач: 1–4 задачи в духе лекции. problem — условие, hint — подсказка, steps — решение по шагам, answer — ответ; на ${конспект}, термины как у лектора. Нет такого материала — пустой список.`,
    '',
    'Ответь ОДНИМ блоком JSON, без текста вокруг:',
    '```json',
    '{"questions":[{"section":1,"at":"14:05","prompt":"…","promptRu":"…","options":[{"text":"…","ru":"…","why":"…","correct":false},{"text":"…","ru":"…","why":"…","correct":true},{"text":"…","ru":"…","why":"…","correct":false},{"text":"…","ru":"…","why":"…","correct":false}],"explanation":"…","hint":"…","answer":"…"}],',
    ' "cards":[{"section":1,"at":"12:40","front":"…","back":"…"}],',
    ' "tasks":[{"section":2,"at":"20:10","problem":"…","hint":"…","steps":["…"],"answer":"…"}]}',
    '```',
    '',
    src.concepts.length > 0 ? `Понятия из итога лекции:\n${src.concepts.map((п) => `- ${п}`).join('\n')}\n` : '',
    разделы,
  ].join('\n');
}

/** Первый объект JSON в ответе модели — в блоке ```json или без него. */
export function jsonFromReply(ответ: string): unknown {
  const блок = /```(?:json)?\s*([\s\S]*?)```/u.exec(ответ)?.[1] ?? ответ;
  const от = блок.indexOf('{');
  const до = блок.lastIndexOf('}');
  if (от < 0 || до <= от) throw new Error('в ответе модели нет JSON');
  return JSON.parse(блок.slice(от, до + 1));
}

export interface GenerateOptions {
  summarize(prompt: string): Promise<string>;
  lectureLanguage: string;
  notes: NotesLanguage;
  now?: number;
  log?(line: string): void;
}

/** Лекция → банк учёбы. Разделов с материалом нет — null. */
export async function generateLectureBank(notesFile: string, options: GenerateOptions): Promise<LectureBank | null> {
  const src = await readLectureSource(notesFile, options.notes);
  if (!src || src.topics.length === 0) return null;
  // Пачка не собралась — остальные идут дальше, а причина — в предупреждения.
  const собрано: Record<'questions' | 'cards' | 'tasks', unknown[]> = { questions: [], cards: [], tasks: [] };
  const сбои: string[] = [];
  for (const пачка of sectionBatches(src)) {
    try {
      const raw = jsonFromReply(await options.summarize(studyPrompt(src, options.lectureLanguage, options.notes, пачка))) as Record<string, unknown>;
      for (const ключ of ['questions', 'cards', 'tasks'] as const) if (Array.isArray(raw[ключ])) собрано[ключ].push(...(raw[ключ] as unknown[]));
    } catch (error) {
      сбои.push(`разделы ${пачка.map((i) => i + 1).join(', ')}: ${error instanceof Error ? error.message : String(error)}`);
      options.log?.(`заготовка разделов ${пачка.map((i) => i + 1).join(', ')} не вышла: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (сбои.length > 0 && собрано.questions.length === 0 && собрано.cards.length === 0) {
    throw new Error(`заготовка не вышла: ${сбои.join('; ')}`);
  }
  const checked = checkGenerated(собрано, {
    lecture: src.lecture,
    topics: src.topics,
    translate: options.lectureLanguage !== options.notes,
  });
  return {
    version: 1,
    lecture: src.lecture,
    notesFile: src.notesFile,
    audioFile: src.audioFile,
    course: src.course,
    date: src.date,
    number: src.number,
    topic: src.topic,
    generatedAt: options.now ?? Date.now(),
    topics: src.topics,
    ...checked,
    warnings: [...сбои, ...checked.warnings],
  };
}
