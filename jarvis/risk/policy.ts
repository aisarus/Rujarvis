/**
 * Risk policy.
 *
 * The Workstation already owns per-agent file permissions and the approval
 * flow. This module adds the classification Jarvis needs in front of them:
 * given a concrete action, which risk class is it, and does that class need
 * the user to say yes.
 *
 * The rule that makes this worth having: classification is a pure function of
 * the action. A model can describe an action, it cannot reclassify one. Any
 * risk level a model proposes is only ever allowed to make the class stricter
 * (see {@link reconcileModelRiskClaim}).
 */

import { maxRisk, riskRank, type RiskLevel } from '../types';

export type JarvisAction =
  | { kind: 'open-app'; app: string }
  | { kind: 'close-window'; title?: string }
  | { kind: 'read-file'; path: string }
  | { kind: 'write-file'; path: string; insideProject: boolean }
  | { kind: 'delete-files'; paths: string[]; insideProject: boolean }
  | { kind: 'shell'; command: string; insideProject: boolean }
  | { kind: 'browse'; url: string }
  | { kind: 'upload-file'; path: string; destination: string }
  | { kind: 'send-message'; channel: string }
  | { kind: 'system-setting'; setting: string }
  | { kind: 'payment'; detail: string }
  | { kind: 'computer-input'; detail: string };

/** Shell patterns that are destructive regardless of where they run. */
const DESTRUCTIVE_SHELL = [
  /\brm\s+(-[a-z]*\s+)*-?[a-z]*r[a-z]*f?\b/i,
  /\brm\s+-rf?\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\brd\s+\/s\b/i,
  /remove-item[^|]*-recurse/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\bdiskpart\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}/,
  /\bshutdown\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdrop\s+(database|table)\b/i,
  /\bsudo\s+rm\b/i,
];

/** Shell patterns that reach outside this machine or change global state. */
const SENSITIVE_SHELL = [
  /\bgit\s+push\b/i,
  /\bnpm\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\bdocker\s+push\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,
  /\bInvoke-WebRequest\b/i,
  /\bnetsh\b/i,
  /\breg\s+(add|delete)\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /\bchmod\s+777\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
];

/** Commands that only build, test or inspect. */
const BUILD_SHELL = [
  /^\s*(pnpm|npm|yarn|bun)\s+(run\s+)?(build|test|lint|typecheck|check|dev)\b/i,
  /^\s*(cargo|go|make|gradle|mvn)\s+(build|test|check|run)\b/i,
  /^\s*(pytest|jest|vitest|tsc|eslint)\b/i,
  /^\s*git\s+(status|log|diff|show|branch|fetch)\b/i,
  /^\s*(ls|dir|cat|type|head|tail|grep|rg|find|where|which)\b/i,
];

/** Security controls that must never be turned off on a model's say-so. */
const SECURITY_SETTINGS = [
  /defender/i,
  /firewall/i,
  /брандмауэр/i,
  /антивирус/i,
  /smartscreen/i,
  /uac/i,
  /bitlocker/i,
  /gatekeeper/i,
  /sip\b/i,
];

/** How many files at once counts as a bulk deletion. */
export const BULK_DELETE_THRESHOLD = 10;

export function classifyShellCommand(command: string, insideProject: boolean): RiskLevel {
  if (DESTRUCTIVE_SHELL.some((pattern) => pattern.test(command))) return 'dangerous';
  if (SENSITIVE_SHELL.some((pattern) => pattern.test(command))) return 'sensitive';
  if (BUILD_SHELL.some((pattern) => pattern.test(command))) return insideProject ? 'normal' : 'sensitive';
  // An unrecognised command inside a project is ordinary work; the same
  // command loose on the machine is not.
  return insideProject ? 'normal' : 'sensitive';
}

/** The risk class of one concrete action. Pure, and the only source of truth. */
export function classifyAction(action: JarvisAction): RiskLevel {
  switch (action.kind) {
    case 'open-app':
    case 'read-file':
    case 'browse':
    case 'close-window':
      return 'safe';

    case 'computer-input':
      return 'safe';

    case 'write-file':
      return action.insideProject ? 'normal' : 'sensitive';

    case 'delete-files':
      if (action.paths.length >= BULK_DELETE_THRESHOLD) return 'dangerous';
      return action.insideProject ? 'normal' : 'sensitive';

    case 'shell':
      return classifyShellCommand(action.command, action.insideProject);

    case 'upload-file':
    case 'send-message':
      return 'sensitive';

    case 'system-setting':
      return SECURITY_SETTINGS.some((pattern) => pattern.test(action.setting))
        ? 'dangerous'
        : 'sensitive';

    case 'payment':
      return 'dangerous';
  }
}

export interface RiskPolicy {
  /** Classes at or above this level need an explicit yes from the user. */
  approvalFrom: RiskLevel;
  /** Classes at or above this level are refused outright. */
  refuseFrom?: RiskLevel;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  approvalFrom: 'sensitive',
};

export type RiskDecision =
  | { outcome: 'allow'; level: RiskLevel }
  | { outcome: 'ask'; level: RiskLevel; reason: string }
  | { outcome: 'refuse'; level: RiskLevel; reason: string };

const RUSSIAN_LEVEL: Record<RiskLevel, string> = {
  safe: 'безопасное',
  normal: 'обычное',
  sensitive: 'чувствительное',
  dangerous: 'опасное',
};

export function decide(
  action: JarvisAction,
  policy: RiskPolicy = DEFAULT_RISK_POLICY,
): RiskDecision {
  const level = classifyAction(action);
  if (policy.refuseFrom && riskRank(level) >= riskRank(policy.refuseFrom)) {
    return {
      outcome: 'refuse',
      level,
      reason: `Действие ${RUSSIAN_LEVEL[level]} и запрещено политикой.`,
    };
  }
  if (riskRank(level) >= riskRank(policy.approvalFrom)) {
    return {
      outcome: 'ask',
      level,
      reason: `Действие ${RUSSIAN_LEVEL[level]}, нужно подтверждение.`,
    };
  }
  return { outcome: 'allow', level };
}

/**
 * Folds a model's own risk assessment into the computed one.
 *
 * A model may notice something the rules do not — an unfamiliar destructive
 * tool, a command whose effect depends on context it can see. So its claim is
 * accepted when it is stricter, and discarded when it is laxer. Text can raise
 * the bar; it can never lower it.
 */
export function reconcileModelRiskClaim(
  computed: RiskLevel,
  claimed: RiskLevel | undefined,
): RiskLevel {
  if (!claimed) return computed;
  return maxRisk(computed, claimed);
}
