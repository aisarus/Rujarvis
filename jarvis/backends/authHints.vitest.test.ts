import { describe, expect, it } from 'vitest';
import {
  hasClaudeEnvironmentAuth,
  hasCodexEnvironmentAuth,
  isUsable,
  resolveAuthState,
} from './authHints';

describe('environment auth detection', () => {
  it('sees an API key or OAuth token supplied through the environment', () => {
    expect(hasClaudeEnvironmentAuth({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
    expect(hasClaudeEnvironmentAuth({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' })).toBe(true);
    expect(hasClaudeEnvironmentAuth({ ANTHROPIC_AUTH_TOKEN: 'tok' })).toBe(true);
  });

  it('sees host-managed and gateway deployments', () => {
    expect(hasClaudeEnvironmentAuth({ CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' })).toBe(true);
    expect(hasClaudeEnvironmentAuth({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe(true);
    expect(hasClaudeEnvironmentAuth({ ANTHROPIC_BASE_URL: 'https://gateway.internal' })).toBe(true);
  });

  it('ignores empty values, which are the same as unset', () => {
    expect(hasClaudeEnvironmentAuth({ ANTHROPIC_API_KEY: '' })).toBe(false);
    expect(hasClaudeEnvironmentAuth({ ANTHROPIC_API_KEY: '   ' })).toBe(false);
    expect(hasClaudeEnvironmentAuth({})).toBe(false);
  });

  it('does the same for Codex', () => {
    expect(hasCodexEnvironmentAuth({ OPENAI_API_KEY: 'sk-test' })).toBe(true);
    expect(hasCodexEnvironmentAuth({ OPENAI_BASE_URL: 'https://gateway' })).toBe(true);
    expect(hasCodexEnvironmentAuth({})).toBe(false);
  });

  it('does not confuse the two vendors', () => {
    expect(hasClaudeEnvironmentAuth({ OPENAI_API_KEY: 'sk-test' })).toBe(false);
    expect(hasCodexEnvironmentAuth({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(false);
  });
});

describe('resolveAuthState', () => {
  it('trusts a positive credential check', () => {
    expect(resolveAuthState(true, false)).toBe(true);
  });

  it('accepts environment credentials when the file check found nothing', () => {
    expect(resolveAuthState(false, true)).toBe(true);
  });

  it('answers "unknown" rather than "no" when nothing proves either way', () => {
    // This is the case that mattered: a real installed CLI, no credential
    // file, and it worked. Reporting "not signed in" would have blocked it.
    expect(resolveAuthState(false, false)).toBe('unknown');
  });

  it('lets an unknown state run, and only a definite no block', () => {
    expect(isUsable(true)).toBe(true);
    expect(isUsable('unknown')).toBe(true);
    expect(isUsable(false)).toBe(false);
  });
});
