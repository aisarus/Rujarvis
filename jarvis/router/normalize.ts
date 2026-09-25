/**
 * Prompt normalisation.
 *
 * Turning «посмотри там в аегисе почему билд опять отъебнулся, только сначала
 * не ломай ничего» into a goal, constraints and a permission envelope makes a
 * coding agent's life easier. It also introduces the one way this layer could
 * do real damage: a normaliser that quietly widens permissions or invents a
 * goal the user never asked for.
 *
 * So two invariants hold here, and they are enforced in code rather than
 * requested in a prompt:
 *
 *  1. Normalisation may only ever *narrow* the permission envelope.
 *  2. The original utterance is always carried through to the strong backend.
 *
 * Both hold whether the normalisation came from these rules or from a model.
 */

import {
  narrowPermissions,
  permissionsWithin,
  type TaskPermissions,
} from '../types';
import { LEADING_FILLER_STEMS } from './lexicon';
import { normalizeForMatching, tokenize } from './text';
import type { RoutingDecision } from './router';

export interface NormalizedTask {
  /** The user's own words. Never rewritten, never dropped. */
  utterance: string;
  /** A tidied statement of what to do. Supporting context, not a replacement. */
  goal: string;
  constraints: string[];
  acceptanceCriteria: string[];
  permissions: TaskPermissions;
  project?: string;
  projectPath?: string;
}

/**
 * What a normalising model is allowed to return.
 *
 * Note what is absent: it cannot name a backend, cannot set a risk level and
 * cannot grant a permission. Those are decisions the deterministic layer owns.
 */
export interface ModelNormalization {
  goal?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  /** Only ever used to take permissions away. */
  permissions?: Partial<TaskPermissions>;
  project?: string;
}

/** Strips leading filler without touching the sense of the sentence. */
export function stripLeadingFiller(utterance: string): string {
  const original = utterance.trim();
  const tokens = tokenize(original);
  let skip = 0;
  while (skip < tokens.length) {
    const token = tokens[skip] as string;
    const isFiller = LEADING_FILLER_STEMS.some((stem) =>
      stem.length <= 2 ? token === stem : token.startsWith(stem),
    );
    if (!isFiller) break;
    skip += 1;
  }
  if (skip === 0) return original;
  // Everything was filler — there is no instruction to keep, so keep it all.
  if (skip >= tokens.length) return original;

  // Walk the original string to the start of the first kept token, so casing,
  // punctuation and the user's own wording survive intact.
  const normalized = normalizeForMatching(original);
  const keptTail = tokens.slice(skip).join(' ');
  const tailStart = normalized.lastIndexOf(keptTail);
  if (tailStart <= 0) return original;

  let normalizedSeen = 0;
  for (let index = 0; index < original.length; index += 1) {
    const slice = normalizeForMatching(original.slice(0, index + 1));
    if (slice.length > normalizedSeen) {
      normalizedSeen = slice.length;
      if (normalizedSeen > tailStart) {
        return original.slice(index).replace(/^[\s,.!?;:—-]+/, '').trim() || original;
      }
    }
  }
  return original;
}

/**
 * Rule-based normalisation.
 *
 * Deliberately conservative: it tidies the goal and records the constraints
 * the user actually stated. It does not translate, does not summarise and does
 * not sanitise how the user talks — «эта хуйня не собирается» reaches the
 * backend as written, because that is the request.
 */
export function normalizeRuleBased(
  utterance: string,
  decision: RoutingDecision,
): NormalizedTask {
  const constraints = [...decision.constraints];
  if (!decision.permissions.edit && !constraints.some((line) => line.includes('не менять'))) {
    constraints.push('Не изменять файлы');
  }

  return {
    utterance,
    goal: stripLeadingFiller(utterance),
    constraints,
    acceptanceCriteria: [],
    permissions: decision.permissions,
    project: decision.project,
    projectPath: decision.projectPath,
  };
}

function cleanList(values: readonly string[] | undefined, limit: number): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed.slice(0, 300));
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Folds a model's normalisation into the rule-based one.
 *
 * Permissions are intersected, so the result can never exceed what the rules
 * already allowed. Everything else is merged. The utterance is untouchable.
 */
export function applyModelNormalization(
  base: NormalizedTask,
  model: ModelNormalization | null | undefined,
): NormalizedTask {
  if (!model) return base;

  const permissions = narrowPermissions(base.permissions, model.permissions);
  const goal = typeof model.goal === 'string' && model.goal.trim() ? model.goal.trim() : base.goal;

  return {
    utterance: base.utterance,
    goal: goal.slice(0, 1000),
    constraints: cleanList([...base.constraints, ...(model.constraints ?? [])], 12),
    acceptanceCriteria: cleanList(
      [...base.acceptanceCriteria, ...(model.acceptanceCriteria ?? [])],
      8,
    ),
    permissions,
    // A model may name the project, but only when the rules found none: it
    // must not redirect work at a different codebase.
    project: base.project ?? (typeof model.project === 'string' ? model.project.trim() : undefined),
    projectPath: base.projectPath,
  };
}

/**
 * The invariant, as an assertion.
 *
 * Callers use it at the boundary where normalisation meets execution, so a
 * future change that breaks the rule fails loudly instead of silently handing
 * a coding agent more access than the user allowed.
 */
export function assertNormalizationIsSafe(
  base: NormalizedTask,
  candidate: NormalizedTask,
): void {
  if (!permissionsWithin(candidate.permissions, base.permissions)) {
    throw new Error(
      'Нормализация попыталась расширить разрешения. Это запрещено политикой Jarvis.',
    );
  }
  if (candidate.utterance !== base.utterance) {
    throw new Error('Нормализация не имеет права изменять исходную реплику пользователя.');
  }
}
