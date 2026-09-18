/**
 * The router.
 *
 * Its job is emphatically *not* to solve the user's task. It decides which
 * capabilities a request implies, which backend should get it, what the
 * permission ceiling is, and whether the current world state is needed to make
 * sense of it. The task itself is solved by whichever backend it picks.
 *
 * It is rule-based and deterministic, so it works with no model loaded at all.
 * An optional small local model can refine the result (see `localModel.ts`),
 * and everything it returns is filtered through the same invariants.
 */

import type { BackendId } from '../backends/types';
import type { BackendPreference } from '../backends/manager';
import {
  DEFAULT_PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  maxRisk,
  narrowPermissions,
  type JarvisCapability,
  type RiskLevel,
  type TaskPermissions,
} from '../types';
import {
  BACKEND_MENTIONS,
  CAPABILITY_RULES,
  CONTINUATION_PHRASES,
  INSPECT_ONLY_PHRASES,
  NO_EXECUTE_PHRASES,
  REFERENTIAL_STEMS,
} from './lexicon.ru';
import {
  hasAnyPhrase,
  hasAnyStem,
  hasPhrase,
  hasStem,
  indexOfStem,
  isNegatedBefore,
  tokenize,
} from './text';

export type JarvisIntent =
  | 'open_app'
  | 'control_window'
  | 'modify_project'
  | 'inspect_project'
  | 'query_screen'
  | 'browse'
  | 'file_task'
  | 'communicate'
  | 'system'
  | 'continue'
  | 'chat';

export interface KnownProject {
  /** Canonical name, e.g. "aegis". */
  name: string;
  /** Absolute path, e.g. "D:\\Projects\\aegis". */
  path: string;
  /** How the user says it out loud: "аегис", "эгида". */
  aliases?: string[];
}

export interface RouterContext {
  knownProjects?: KnownProject[];
  /** Project the user is currently working in, from world state. */
  currentProject?: string;
  /** Whether a task is running right now — «продолжай» refers to it. */
  hasRunningTask?: boolean;
  /** Settings selectors. */
  codingPreference?: 'auto' | BackendId;
  mainPreference?: 'auto' | BackendId;
}

export interface RoutingDecision {
  intent: JarvisIntent;
  /** Every capability the request implies; never mutually exclusive. */
  needs: JarvisCapability[];
  /** The backend the plan will start with. */
  target: BackendId;
  project?: string;
  projectPath?: string;
  risk: RiskLevel;
  permissions: TaskPermissions;
  /** Backend the user named out loud. */
  requestedBackend?: BackendId;
  /** Backends the user ruled out out loud. */
  excludedBackends: BackendId[];
  /** The utterance leans on «это», «туда», «продолжай» and needs world state. */
  needsWorldState: boolean;
  /** Explicit constraints heard in the utterance, in the user's own terms. */
  constraints: string[];
  /** 0..1 — how confident the rules are. Low values are worth a confirmation. */
  confidence: number;
}

/** Finds a backend the user named, and any they ruled out. */
export function detectBackendMentions(utterance: string): {
  requested?: BackendId;
  excluded: BackendId[];
} {
  const tokens = tokenize(utterance);
  const excluded: BackendId[] = [];
  let requested: BackendId | undefined;

  for (const mention of BACKEND_MENTIONS) {
    for (const stem of mention.stems) {
      const index = indexOfStem(tokens, stem);
      if (index === -1) continue;
      if (isNegatedBefore(tokens, index)) {
        if (!excluded.includes(mention.backend)) excluded.push(mention.backend);
      } else if (!requested) {
        requested = mention.backend;
      }
      break;
    }
  }

  // «не используй клод» must not also read as a request for Claude.
  if (requested && excluded.includes(requested)) {
    requested = undefined;
  }
  return { requested, excluded };
}

function detectCapabilities(tokens: string[]): Set<JarvisCapability> {
  const found = new Set<JarvisCapability>();
  for (const rule of CAPABILITY_RULES) {
    if (hasAnyStem(tokens, rule.stems) || hasAnyPhrase(tokens, rule.phrases ?? [])) {
      found.add(rule.capability);
    }
  }
  // Every request goes through a model, so reasoning is always in play.
  found.add('reasoning');
  return found;
}

/** Locates a known project named in the utterance. */
export function detectProject(
  utterance: string,
  projects: readonly KnownProject[] = [],
): KnownProject | undefined {
  const tokens = tokenize(utterance);
  for (const project of projects) {
    const names = [project.name, ...(project.aliases ?? [])];
    for (const name of names) {
      const stem = tokenize(name)[0];
      if (!stem) continue;
      // Only match on a stem long enough to be distinctive.
      const probe = stem.length > 4 ? stem.slice(0, Math.max(4, stem.length - 1)) : stem;
      if (hasStem(tokens, probe)) return project;
    }
  }
  return undefined;
}

function detectIntent(
  capabilities: ReadonlySet<JarvisCapability>,
  tokens: string[],
  editing: boolean,
): JarvisIntent {
  if (hasAnyPhrase(tokens, CONTINUATION_PHRASES) && tokens.length <= 4) return 'continue';
  if (capabilities.has('communication')) return 'communicate';
  if (capabilities.has('vision')) return 'query_screen';
  if (capabilities.has('coding')) return editing ? 'modify_project' : 'inspect_project';
  if (capabilities.has('browser')) return 'browse';
  if (capabilities.has('system')) return 'system';
  if (capabilities.has('files')) return 'file_task';
  if (capabilities.has('computer')) {
    return hasAnyStem(tokens, ['закро', 'сверн', 'разверн', 'переключ']) ? 'control_window' : 'open_app';
  }
  return 'chat';
}

/** Words that promise wide destruction — enough to start at the top class. */
const DESTRUCTIVE_HINT_PHRASES: string[][] = [
  ['удал', 'все'],
  ['удал', 'всё'],
  ['снеси', 'все'],
  ['снеси', 'всё'],
  ['очист', 'диск'],
  ['форматир'],
  ['сброс', 'настройк'],
  ['отключ', 'защит'],
  ['отключ', 'антивирус'],
  ['отключ', 'брандмауэр'],
];

function aprioriRisk(
  capabilities: ReadonlySet<JarvisCapability>,
  tokens: string[],
  editing: boolean,
): RiskLevel {
  if (hasAnyPhrase(tokens, DESTRUCTIVE_HINT_PHRASES)) return 'dangerous';
  let level: RiskLevel = 'safe';
  if (capabilities.has('communication')) level = maxRisk(level, 'sensitive');
  if (capabilities.has('system')) level = maxRisk(level, 'sensitive');
  if (hasAnyStem(tokens, ['push', 'запуш', 'запушь', 'опублик', 'оплат', 'куп'])) {
    level = maxRisk(level, 'sensitive');
  }
  if (editing && (capabilities.has('coding') || capabilities.has('files'))) {
    level = maxRisk(level, 'normal');
  }
  if (capabilities.has('shell')) level = maxRisk(level, 'normal');
  return level;
}

/**
 * Reads the permission ceiling out of the utterance.
 *
 * Only ever narrows: the base envelope comes from settings, and an explicit
 * «только посмотри» takes permissions away. Nothing in an utterance can add
 * a permission the base envelope does not already carry.
 */
export function derivePermissions(
  utterance: string,
  base: TaskPermissions = DEFAULT_PERMISSIONS,
): { permissions: TaskPermissions; constraints: string[] } {
  const tokens = tokenize(utterance);
  const constraints: string[] = [];
  let permissions = { ...base };

  if (hasAnyPhrase(tokens, INSPECT_ONLY_PHRASES)) {
    permissions = narrowPermissions(permissions, { edit: false });
    constraints.push('Сначала осмотреть, не менять');
  }
  if (hasAnyPhrase(tokens, NO_EXECUTE_PHRASES)) {
    permissions = narrowPermissions(permissions, { execute: false });
    constraints.push('Ничего не запускать');
  }
  if (hasPhrase(tokens, ['без', 'лишн']) || hasPhrase(tokens, ['ничего', 'лишн'])) {
    constraints.push('Не трогать несвязанное');
  }
  return { permissions, constraints };
}

export interface RouteOptions {
  context?: RouterContext;
  /** The permission ceiling from settings. Rules can only narrow it. */
  basePermissions?: TaskPermissions;
}

export function route(utterance: string, options: RouteOptions = {}): RoutingDecision {
  const context = options.context ?? {};
  const tokens = tokenize(utterance);
  const capabilities = detectCapabilities(tokens);

  const { permissions, constraints } = derivePermissions(
    utterance,
    options.basePermissions ?? DEFAULT_PERMISSIONS,
  );
  const editing = permissions.edit;

  const { requested, excluded } = detectBackendMentions(utterance);
  const project = detectProject(utterance, context.knownProjects ?? []);

  // A coding backend was named out loud, so this is coding work even if the
  // words did not say so: «сделай это через Клод Код».
  if (requested === 'claude-code' || requested === 'codex') {
    capabilities.add('coding');
  }

  const needsWorldState =
    hasAnyStem(tokens, REFERENTIAL_STEMS) || hasAnyPhrase(tokens, CONTINUATION_PHRASES);
  if (needsWorldState) capabilities.add('memory');

  const intent = detectIntent(capabilities, tokens, editing);
  const risk = aprioriRisk(capabilities, tokens, editing);

  const resolvedProject = project?.name ?? context.currentProject;
  const target = pickTarget({
    capabilities,
    requested,
    excluded,
    codingPreference: context.codingPreference,
    mainPreference: context.mainPreference,
  });

  return {
    intent,
    needs: [...capabilities],
    target,
    project: resolvedProject,
    projectPath: project?.path,
    risk,
    permissions: permissions.edit ? permissions : narrowPermissions(permissions, READ_ONLY_PERMISSIONS),
    requestedBackend: requested,
    excludedBackends: excluded,
    needsWorldState,
    constraints,
    confidence: scoreConfidence(capabilities, tokens, needsWorldState),
  };
}

function pickTarget(input: {
  capabilities: ReadonlySet<JarvisCapability>;
  requested?: BackendId;
  excluded: BackendId[];
  codingPreference?: 'auto' | BackendId;
  mainPreference?: 'auto' | BackendId;
}): BackendId {
  if (input.requested) return input.requested;

  const needsComputer =
    input.capabilities.has('computer') ||
    input.capabilities.has('browser') ||
    input.capabilities.has('vision') ||
    input.capabilities.has('communication') ||
    input.capabilities.has('system');
  if (needsComputer) return 'interpreter';

  if (input.capabilities.has('coding')) {
    const preferred = input.codingPreference;
    if (preferred && preferred !== 'auto' && !input.excluded.includes(preferred)) {
      return preferred;
    }
    if (!input.excluded.includes('claude-code')) return 'claude-code';
    if (!input.excluded.includes('codex')) return 'codex';
  }

  const main = input.mainPreference;
  if (main && main !== 'auto' && !input.excluded.includes(main)) return main;
  return 'interpreter';
}

/**
 * How much the rules actually recognised.
 *
 * A short utterance full of pronouns is not low-quality input — it is normal
 * speech — but it does mean the decision rests on world state rather than on
 * the words, and the caller may want to confirm before doing something
 * irreversible.
 */
function scoreConfidence(
  capabilities: ReadonlySet<JarvisCapability>,
  tokens: string[],
  needsWorldState: boolean,
): number {
  // 'reasoning' is always present and says nothing about recognition.
  const recognised = capabilities.size - 1;
  if (tokens.length === 0) return 0;
  let score = Math.min(1, 0.35 + recognised * 0.2);
  if (needsWorldState && recognised === 0) score = Math.min(score, 0.4);
  if (tokens.length <= 2 && recognised === 0) score = Math.min(score, 0.3);
  return Number(score.toFixed(2));
}

/** Turns a decision into the preference the BackendManager consumes. */
export function toBackendPreference(
  decision: RoutingDecision,
  context: RouterContext = {},
): BackendPreference {
  return {
    codingPreference: context.codingPreference ?? 'auto',
    mainPreference: context.mainPreference ?? 'auto',
    requested: decision.requestedBackend,
    excluded: decision.excludedBackends,
  };
}
