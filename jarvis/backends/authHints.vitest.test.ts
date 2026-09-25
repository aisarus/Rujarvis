import { describe, expect, it } from 'vitest';
import {
  hasClaudeEnvironmentAuth,
  hasCodexEnvironmentAuth,
  isUsable,
  resolveAuthState,
} from './authHints';
import { agentEnv } from './subscriptionEnv';

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

  /**
   * Проба обязана смотреть на то окружение, которое получит сам CLI.
   *
   * Ключ в системе означал «вход выполнен», но `agentEnv()` его снимает
   * нарочно: Джарвис живёт на подписке и чужими ключами не платит. Выходило
   * «готов» — и отказ авторизации на первой же задаче.
   */
  it('чужой ключ не считается входом: CLI его не получит', () => {
    const вСистеме = { ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test' };
    expect(hasClaudeEnvironmentAuth(вСистеме)).toBe(true);
    expect(hasClaudeEnvironmentAuth(agentEnv(вСистеме))).toBe(false);
    expect(hasCodexEnvironmentAuth(agentEnv(вСистеме))).toBe(false);
  });

  it('размещение у хозяина машины входом остаётся: его не снимают', () => {
    // Bedrock и Vertex — не ключ и не трата денег из кармана человека, их
    // agentEnv не трогает, и проба про них не должна врать в другую сторону.
    const хозяйский = { CLAUDE_CODE_USE_BEDROCK: '1' };
    expect(hasClaudeEnvironmentAuth(agentEnv(хозяйский))).toBe(true);
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
