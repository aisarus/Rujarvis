/**
 * Bridges the Jarvis adapters to the Workstation's own CLI detection.
 *
 * The Workstation already resolves and probes `claude` and `codex`
 * (`server/handlers/providers.ts`): configured path, the usual install
 * locations, then PATH, plus a login check that reads no tokens. Jarvis
 * reuses that instead of keeping a second copy of the search list.
 *
 * The import is lazy so the Jarvis layer stays unit-testable without pulling
 * in the whole server module graph.
 */

import {
  hasClaudeEnvironmentAuth,
  hasCodexEnvironmentAuth,
  resolveAuthState,
} from './authHints';
import type { ClaudeCliProbe } from './claudeCode';
import type { CodexCliProbe } from './codex';

type ProviderStatus = {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  path?: string;
  error?: string;
};

type ProvidersModule = {
  getClaudeCodeStatus(): Promise<ProviderStatus>;
  getCodexStatus(): Promise<ProviderStatus>;
};

async function loadProviders(): Promise<ProvidersModule> {
  return (await import('../../server/handlers/providers')) as unknown as ProvidersModule;
}

export function createWorkstationClaudeProbe(
  env: NodeJS.ProcessEnv = process.env,
): ClaudeCliProbe {
  return {
    async status() {
      const providers = await loadProviders();
      const status = await providers.getClaudeCodeStatus();
      return {
        ...status,
        loggedIn: resolveAuthState(status.loggedIn, hasClaudeEnvironmentAuth(env)),
      };
    },
  };
}

export function createWorkstationCodexProbe(
  env: NodeJS.ProcessEnv = process.env,
): CodexCliProbe {
  return {
    async status() {
      const providers = await loadProviders();
      const status = await providers.getCodexStatus();
      return {
        ...status,
        loggedIn: resolveAuthState(status.loggedIn, hasCodexEnvironmentAuth(env)),
      };
    },
  };
}
