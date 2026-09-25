/**
 * Core vocabulary of the Jarvis layer.
 *
 * Jarvis sits on top of Interpreter Workstation: the Workstation owns the
 * agent runtime, computer-use, browser, filesystem, shell, skills and
 * permissions. Jarvis owns routing, subscription-backed coding agents, the
 * Russian voice UX and the orchestration between them.
 *
 * Everything in this file is plain data so the deterministic parts of Jarvis
 * (risk policy, task state, routing) can be unit tested without a runtime.
 */

/**
 * What a task needs in order to be carried out.
 *
 * Capabilities are additive, never mutually exclusive: "посмотри ошибку в
 * браузере, найди проект и исправь код" legitimately needs `browser`,
 * `memory`, `coding`, `files` and `shell` at once.
 */
export const JARVIS_CAPABILITIES = [
  'reasoning',
  'coding',
  'files',
  'shell',
  'computer',
  'browser',
  'vision',
  'web',
  'memory',
  'communication',
  'system',
  'creative',
] as const;

export type JarvisCapability = (typeof JARVIS_CAPABILITIES)[number];

/**
 * Risk classes. The policy that maps an action onto one of these lives in
 * `jarvis/risk` and is enforced by code; no model output can lower a class.
 */
export const RISK_LEVELS = ['safe', 'normal', 'sensitive', 'dangerous'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_ORDER: Record<RiskLevel, number> = {
  safe: 0,
  normal: 1,
  sensitive: 2,
  dangerous: 3,
};

export function riskRank(level: RiskLevel): number {
  return RISK_ORDER[level];
}

/** Returns the stricter of two risk levels. */
export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

/**
 * The permission envelope a task may act within.
 *
 * These are ceilings, not requests: the normaliser and the router may only
 * ever narrow them (see `jarvis/router/normalize.ts`).
 */
export interface TaskPermissions {
  read: boolean;
  edit: boolean;
  execute: boolean;
  network: boolean;
}

export const READ_ONLY_PERMISSIONS: TaskPermissions = {
  read: true,
  edit: false,
  execute: false,
  network: false,
};

export const DEFAULT_PERMISSIONS: TaskPermissions = {
  read: true,
  edit: true,
  execute: true,
  network: true,
};

/** Intersection of two envelopes — the result never exceeds either input. */
export function narrowPermissions(
  base: TaskPermissions,
  requested: Partial<TaskPermissions> | undefined,
): TaskPermissions {
  if (!requested) return { ...base };
  return {
    read: base.read && requested.read !== false,
    edit: base.edit && requested.edit !== false,
    execute: base.execute && requested.execute !== false,
    network: base.network && requested.network !== false,
  };
}

/** True when `candidate` grants nothing that `base` does not already grant. */
export function permissionsWithin(
  candidate: TaskPermissions,
  base: TaskPermissions,
): boolean {
  return (
    (!candidate.read || base.read) &&
    (!candidate.edit || base.edit) &&
    (!candidate.execute || base.execute) &&
    (!candidate.network || base.network)
  );
}
