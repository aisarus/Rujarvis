import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { providers } from '@/ipc';
import type { ClaudeCodeStatus, CodexStatus } from '../../../shared/types/provider';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { SettingsRow, SettingsSection } from './SettingsSection';

/**
 * AI Accounts.
 *
 * Shows whether each subscription coding agent is installed, signed in and
 * ready. It deliberately shows nothing else: Jarvis never holds an API key,
 * never reads an OAuth token and has nothing secret to display. The account
 * itself is managed by the vendor's own CLI, which is where the buttons lead.
 */

type AccountId = 'claude-code' | 'codex';

interface AccountState {
  status: ClaudeCodeStatus | CodexStatus | null;
  loading: boolean;
  /** Result of the last "Проверить" run. */
  probe?: { ok: boolean; message: string };
}

const EMPTY_STATE: AccountState = { status: null, loading: true };

/**
 * How a status reads to the user.
 *
 * "Готов" and "Не установлен" are certain. The middle case is not: a CLI can
 * be authenticated by the environment or by a managed deployment with no
 * credential file to find, so the wording says what is known rather than
 * asserting the user is signed out.
 */
function describeStatus(status: ClaudeCodeStatus | CodexStatus | null): {
  label: string;
  tone: 'ready' | 'attention' | 'missing';
} {
  if (!status) return { label: 'Проверяю…', tone: 'attention' };
  if (!status.installed) return { label: 'Не установлен', tone: 'missing' };
  if (!status.loggedIn) return { label: 'Вход не подтверждён', tone: 'attention' };
  return { label: 'Готов', tone: 'ready' };
}

const ACCOUNTS: Array<{
  id: AccountId;
  name: string;
  hint: string;
  signInHint: string;
}> = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    hint: 'Используется для задач по коду: разбор репозитория, багфиксы, рефакторинг, тесты.',
    signInHint: 'Вход выполняется штатно: запустите claude в терминале.',
  },
  {
    id: 'codex',
    name: 'Codex',
    hint: 'Альтернатива Claude Code и запасной вариант, когда лимит исчерпан.',
    signInHint: 'Вход через ChatGPT: выполните codex login.',
  },
];

export function AiAccountsSection() {
  const [accounts, setAccounts] = useState<Record<AccountId, AccountState>>({
    'claude-code': EMPTY_STATE,
    codex: EMPTY_STATE,
  });

  const refresh = useCallback(async (id: AccountId) => {
    setAccounts((current) => ({ ...current, [id]: { ...current[id], loading: true } }));
    try {
      const status = id === 'claude-code'
        ? await providers.getClaudeCodeStatus()
        : await providers.getCodexStatus();
      setAccounts((current) => ({ ...current, [id]: { status, loading: false } }));
    } catch (error) {
      setAccounts((current) => ({
        ...current,
        [id]: {
          status: { installed: false, loggedIn: false },
          loading: false,
          probe: {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          },
        },
      }));
    }
  }, []);

  useEffect(() => {
    void refresh('claude-code');
    void refresh('codex');
  }, [refresh]);

  const test = useCallback(async (id: AccountId) => {
    setAccounts((current) => ({ ...current, [id]: { ...current[id], loading: true } }));
    try {
      const status = id === 'claude-code'
        ? await providers.getClaudeCodeStatus()
        : await providers.getCodexStatus();
      const ready = status.installed && status.loggedIn;
      setAccounts((current) => ({
        ...current,
        [id]: {
          status,
          loading: false,
          probe: {
            ok: ready,
            message: ready
              ? `Готов${status.version ? `, версия ${status.version}` : ''}`
              : (status.error ?? 'CLI найден, но к работе не готов'),
          },
        },
      }));
    } catch (error) {
      setAccounts((current) => ({
        ...current,
        [id]: {
          ...current[id],
          loading: false,
          probe: {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          },
        },
      }));
    }
  }, []);

  const openLogin = useCallback(async () => {
    try {
      await providers.runClaudeLogin();
    } finally {
      void refresh('claude-code');
    }
  }, [refresh]);

  return (
    <SettingsSection
      title="AI-аккаунты"
      description="Подписочные агенты запускаются через свои официальные CLI. Jarvis не хранит ключи и не читает токены — вход выполняется штатным способом поставщика."
      sectionId="ai-accounts"
    >
      {ACCOUNTS.map((account) => {
        const state = accounts[account.id];
        const status = state.status;
        const described = describeStatus(status);

        return (
          <SettingsRow
            key={account.id}
            label={account.name}
            description={account.hint}
            align="start"
          >
            <div className="flex w-full flex-col items-start gap-2 sm:items-end">
              <div className="flex items-center gap-2">
                {state.loading ? (
                  <Loader2
                    aria-label="Проверяю"
                    className="size-4 animate-spin text-muted-foreground"
                  />
                ) : described.tone === 'ready' ? (
                  <CheckCircle2 aria-hidden className="size-4 text-emerald-500" />
                ) : (
                  <XCircle aria-hidden className="size-4 text-muted-foreground" />
                )}
                <Badge variant={described.tone === 'ready' ? 'default' : 'secondary'}>
                  {described.label}
                </Badge>
              </div>

              {status?.version ? (
                <span className="text-xs text-muted-foreground">{status.version}</span>
              ) : null}
              {status?.path ? (
                <span className="max-w-[320px] truncate text-xs text-muted-foreground" title={status.path}>
                  {status.path}
                </span>
              ) : null}

              {status && status.installed && !status.loggedIn ? (
                <span className="max-w-[320px] text-xs text-muted-foreground">
                  {account.signInHint}
                </span>
              ) : null}

              {state.probe ? (
                <span
                  role="status"
                  className={`max-w-[320px] text-xs ${state.probe.ok ? 'text-emerald-600' : 'text-destructive'}`}
                >
                  {state.probe.message}
                </span>
              ) : null}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={state.loading}
                  onClick={() => void test(account.id)}
                >
                  <RefreshCw aria-hidden className="size-3.5" />
                  Проверить
                </Button>
                {account.id === 'claude-code' && status?.installed && !status.loggedIn ? (
                  <Button size="sm" variant="outline" onClick={() => void openLogin()}>
                    Войти в Claude
                  </Button>
                ) : null}
              </div>
            </div>
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
