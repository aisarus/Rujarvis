/**
 * Насколько тема знакома — честно, без процентов.
 *
 * Правила — из модели свидетельств Lamdan (concept-evidence.ts): одним
 * удачным ответом «знаю» не заработать. Пять состояний:
 *
 * - **не встречал** — к теме нет ни вопросов, ни карточек;
 * - **пройдено** — материал есть, проверки ещё не было;
 * - **шатко** — что-то отвечено, но мало, давно или однообразно;
 * - **слабо** — ошибки повторяются или свежая ошибка перевешивает;
 * - **знаю** — не меньше четырёх верных ответов, из них хотя бы два
 *   проверены машиной (квиз, экзамен, карточка, открытый ответ), за два
 *   разных дня и двумя способами, ошибок не больше трети, свежая ошибка не
 *   перевешивает, последний верный ответ — не старше трёх недель.
 *
 * Риск забыть — по времени с последнего верного ответа: неделя — низкий,
 * три недели — средний, дальше — высокий.
 */

import type { EvidenceEvent } from './types';

export type KnowledgeState = 'unseen' | 'covered' | 'fragile' | 'weak' | 'strong';
export type ForgettingRisk = 'none' | 'low' | 'medium' | 'high';

const ДЕНЬ = 24 * 60 * 60 * 1000;

export interface TopicKnowledge {
  state: KnowledgeState;
  risk: ForgettingRisk;
  successes: number;
  failures: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
}

/** Самопроверка задачи — со слов человека, машина её не видела. */
function объективно(e: EvidenceEvent): boolean {
  return e.source !== 'task';
}

function деньОт(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function topicKnowledge(events: readonly EvidenceEvent[], hasMaterial: boolean, now = Date.now()): TopicKnowledge {
  const по = [...events].sort((a, b) => a.at - b.at);
  const удачи = по.filter((e) => e.outcome === 'success');
  const ошибки = по.filter((e) => e.outcome === 'failure');
  const lastSuccessAt = удачи[удачи.length - 1]?.at;
  const lastFailureAt = ошибки[ошибки.length - 1]?.at;
  const ошибкаПоследней = Boolean(lastFailureAt && (!lastSuccessAt || lastFailureAt > lastSuccessAt));
  const доляОшибок = по.length > 0 ? ошибки.length / по.length : 0;
  const свежая = lastSuccessAt !== undefined && now - lastSuccessAt <= 21 * ДЕНЬ;

  const strong =
    удачи.length >= 4 &&
    удачи.filter(объективно).length >= 2 &&
    new Set(удачи.map((e) => деньОт(e.at))).size >= 2 &&
    new Set(удачи.map((e) => e.kind)).size >= 2 &&
    доляОшибок <= 0.34 &&
    !ошибкаПоследней &&
    свежая;
  const weak = ошибки.length >= 2 && (ошибкаПоследней || доляОшибок >= 0.5);

  const state: KnowledgeState = strong
    ? 'strong'
    : weak
      ? 'weak'
      : по.length > 0
        ? 'fragile'
        : hasMaterial
          ? 'covered'
          : 'unseen';

  let risk: ForgettingRisk = 'none';
  if (lastSuccessAt !== undefined) {
    const давно = now - lastSuccessAt;
    risk = давно > 21 * ДЕНЬ ? 'high' : давно > 7 * ДЕНЬ ? 'medium' : 'low';
  }
  return { state, risk, successes: удачи.length, failures: ошибки.length, lastSuccessAt, lastFailureAt };
}

/** Порядок «что учить первым»: слабое, шаткое, пройденное, знакомое. */
export const STATE_PRIORITY: Record<KnowledgeState, number> = { weak: 0, fragile: 1, covered: 2, unseen: 3, strong: 4 };
