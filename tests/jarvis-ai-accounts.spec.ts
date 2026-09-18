import { test, expect } from './fixtures';
import { waitForAppReady } from './helpers';
import { sel } from './selectors';

/**
 * The AI Accounts panel, in the real application.
 *
 * The jsdom tests cover how the component behaves; this one answers a
 * different question — does it actually reach the user. It opens the built
 * app, navigates to the settings tab it lives in, and reads the status that
 * the real provider detection produced on this machine.
 *
 * It asserts nothing about which CLIs happen to be installed here, only that
 * the panel renders, reports a definite state for both agents, and shows no
 * secret.
 */
test('AI accounts panel reports real CLI status and never shows a secret', async ({ page }) => {
  // Probing two CLIs on a cold app is genuinely slow: each status call shells
  // out to the binary. The default 30s left no headroom at all.
  test.setTimeout(120_000);

  await waitForAppReady(page);

  // Reached the way a user reaches it, through the settings popover.
  await page.locator(sel('agentSettingsButton')).click();
  await expect(page.locator(sel('settingsPopover'))).toBeVisible({ timeout: 10_000 });
  await page.locator(sel('settingsPopover')).getByText('Settings').click();

  await expect(page.locator(sel('settingsView'))).toBeVisible({ timeout: 20_000 });
  await page.locator(sel.settingsTab('models')).click();

  const panel = page.locator('[data-settings-section="ai-accounts"]');
  await expect(panel).toBeVisible({ timeout: 20_000 });

  // Both agents are listed.
  await expect(panel.getByText('Claude Code', { exact: true })).toBeVisible();
  await expect(panel.getByText('Codex', { exact: true })).toBeVisible();

  // Each one settles on a definite state rather than spinning forever.
  const settled = panel.getByText(/^(Готов|Не установлен|Вход не подтверждён)$/);
  await expect(settled.first()).toBeVisible({ timeout: 20_000 });
  await expect(settled).toHaveCount(2, { timeout: 20_000 });

  // Nothing secret is on screen. Jarvis holds no key and reads no token, and
  // the panel must never become the place one leaks.
  const text = (await panel.innerText()).toLowerCase();
  expect(text).not.toContain('sk-ant');
  expect(text).not.toContain('sk-proj');
  expect(text).not.toMatch(/bearer\s+\S/);
  expect(text).not.toContain('credentials.json');
});
