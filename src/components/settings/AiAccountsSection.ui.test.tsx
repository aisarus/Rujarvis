import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { AiAccountsSection } from './AiAccountsSection';

const providersMocks = vi.hoisted(() => ({
  getClaudeCodeStatus: vi.fn(),
  getCodexStatus: vi.fn(),
  runClaudeLogin: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/ipc', () => ({ providers: providersMocks }));

function rowFor(name: string): HTMLElement {
  const label = screen.getByText(name);
  const row = label.closest('[data-help-title]');
  if (!(row instanceof HTMLElement)) throw new Error(`row not found for ${name}`);
  return row;
}

describe('AiAccountsSection', () => {
  beforeEach(() => {
    providersMocks.getClaudeCodeStatus.mockResolvedValue({
      installed: true,
      loggedIn: true,
      version: '2.1.276 (Claude Code)',
      path: '/opt/node22/bin/claude',
    });
    providersMocks.getCodexStatus.mockResolvedValue({ installed: false, loggedIn: false });
  });

  test('shows each account as ready, missing, or not confirmed', async () => {
    render(<AiAccountsSection />);

    await waitFor(() => {
      expect(within(rowFor('Claude Code')).getByText('Готов')).toBeInTheDocument();
    });
    expect(within(rowFor('Codex')).getByText('Не установлен')).toBeInTheDocument();
  });

  test('shows the version and path, which are not secrets', async () => {
    render(<AiAccountsSection />);
    await waitFor(() => {
      expect(screen.getByText('2.1.276 (Claude Code)')).toBeInTheDocument();
    });
    expect(screen.getByText('/opt/node22/bin/claude')).toBeInTheDocument();
  });

  test('never renders a token or a key', async () => {
    providersMocks.getClaudeCodeStatus.mockResolvedValue({
      installed: true,
      loggedIn: true,
      version: '2.1.276',
      path: '/opt/node22/bin/claude',
      // Even if a status ever carried one, the section must not show it.
      token: 'sk-ant-secret-value',
    });

    const { container } = render(<AiAccountsSection />);
    await waitFor(() => {
      expect(screen.getByText('2.1.276')).toBeInTheDocument();
    });
    expect(container.textContent).not.toContain('sk-ant-secret-value');
  });

  test('says "вход не подтверждён" rather than asserting the user is signed out', async () => {
    // A CLI can be authenticated by the environment with no credential file to
    // find, so the wording states what is known.
    providersMocks.getClaudeCodeStatus.mockResolvedValue({
      installed: true,
      loggedIn: false,
      version: '2.1.276',
    });

    render(<AiAccountsSection />);
    await waitFor(() => {
      expect(within(rowFor('Claude Code')).getByText('Вход не подтверждён')).toBeInTheDocument();
    });
    expect(screen.getByText(/запустите claude в терминале/i)).toBeInTheDocument();
  });

  test('the test button re-probes and reports the outcome', async () => {
    const user = userEvent.setup();
    render(<AiAccountsSection />);
    await waitFor(() => {
      expect(within(rowFor('Claude Code')).getByText('Готов')).toBeInTheDocument();
    });

    providersMocks.getClaudeCodeStatus.mockClear();
    await user.click(within(rowFor('Claude Code')).getByRole('button', { name: /проверить/i }));

    await waitFor(() => {
      expect(providersMocks.getClaudeCodeStatus).toHaveBeenCalledTimes(1);
    });
    expect(await within(rowFor('Claude Code')).findByRole('status')).toHaveTextContent(
      /Готов, версия 2\.1\.276/,
    );
  });

  test('a failing probe is reported, not swallowed', async () => {
    const user = userEvent.setup();
    render(<AiAccountsSection />);
    await waitFor(() => {
      expect(within(rowFor('Codex')).getByText('Не установлен')).toBeInTheDocument();
    });

    providersMocks.getCodexStatus.mockRejectedValueOnce(new Error('связь с сервером потеряна'));
    await user.click(within(rowFor('Codex')).getByRole('button', { name: /проверить/i }));

    expect(await within(rowFor('Codex')).findByRole('status')).toHaveTextContent(
      /связь с сервером потеряна/,
    );
  });

  test('offers the login button only when signing in would actually help', async () => {
    render(<AiAccountsSection />);
    await waitFor(() => {
      expect(within(rowFor('Claude Code')).getByText('Готов')).toBeInTheDocument();
    });
    expect(
      within(rowFor('Claude Code')).queryByRole('button', { name: /войти в claude/i }),
    ).not.toBeInTheDocument();
  });

  test('runs the vendor login flow and re-checks afterwards', async () => {
    const user = userEvent.setup();
    providersMocks.getClaudeCodeStatus.mockResolvedValue({
      installed: true,
      loggedIn: false,
      version: '2.1.276',
    });

    render(<AiAccountsSection />);
    const loginButton = await within(rowFor('Claude Code')).findByRole('button', {
      name: /войти в claude/i,
    });

    providersMocks.getClaudeCodeStatus.mockClear();
    await user.click(loginButton);

    await waitFor(() => {
      expect(providersMocks.runClaudeLogin).toHaveBeenCalledTimes(1);
    });
    // The status is re-read afterwards, so the panel reflects the new state.
    await waitFor(() => {
      expect(providersMocks.getClaudeCodeStatus).toHaveBeenCalled();
    });
  });

  test('survives a status call that rejects on first load', async () => {
    providersMocks.getClaudeCodeStatus.mockRejectedValue(new Error('IPC недоступен'));
    render(<AiAccountsSection />);

    await waitFor(() => {
      expect(within(rowFor('Claude Code')).getByText('Не установлен')).toBeInTheDocument();
    });
    expect(within(rowFor('Claude Code')).getByRole('status')).toHaveTextContent(/IPC недоступен/);
  });
});
