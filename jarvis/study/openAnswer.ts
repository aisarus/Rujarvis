/**
 * Открытый ответ: человек сказал или написал своими словами — верно ли.
 *
 * Проверяет модель, но только по эталону и тексту лекции: чего в лекции нет,
 * того она не засчитывает и не требует (правило Lamdan: оценка по
 * источнику, без знаний модели). Вердикт — «верно», «почти» или «неверно» и
 * пара фраз почему.
 */

import type { QuizQuestion } from './types';

export type OpenVerdict = 'correct' | 'partial' | 'wrong';

export function openAnswerPrompt(question: QuizQuestion, answer: string, lectureText: string): string {
  return [
    'Ты проверяешь ответ студента на вопрос по лекции. Суди только по эталону и тексту лекции ниже — не своими знаниями: чего в лекции нет, того не требуй и не засчитывай сверх эталона.',
    'Смысл важнее формулировки: верный ответ своими словами — верный. Опечатки и оговорки распознавания речи не считаются ошибкой.',
    '',
    `Вопрос: ${question.prompt}`,
    question.promptTranslation ? `Перевод вопроса: ${question.promptTranslation}` : '',
    `Эталон: ${question.answer}`,
    `Разбор: ${question.explanation}`,
    '',
    'Текст лекции по теме:',
    lectureText || '—',
    '',
    `Ответ студента: ${answer}`,
    '',
    'Ответь ОДНИМ блоком JSON на русском: {"verdict":"correct|partial|wrong","feedback":"одна-две фразы: что верно, чего не хватает или где ошибка"}',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

export function parseOpenVerdict(reply: string): { verdict: OpenVerdict; feedback: string } {
  const блок = /```(?:json)?\s*([\s\S]*?)```/u.exec(reply)?.[1] ?? reply;
  const от = блок.indexOf('{');
  const до = блок.lastIndexOf('}');
  if (от < 0 || до <= от) throw new Error('модель не дала вердикта');
  const raw = JSON.parse(блок.slice(от, до + 1)) as { verdict?: unknown; feedback?: unknown };
  const verdict = raw.verdict === 'correct' || raw.verdict === 'partial' || raw.verdict === 'wrong' ? raw.verdict : null;
  if (!verdict) throw new Error(`непонятный вердикт: ${String(raw.verdict)}`);
  return { verdict, feedback: typeof raw.feedback === 'string' ? raw.feedback.trim() : '' };
}
