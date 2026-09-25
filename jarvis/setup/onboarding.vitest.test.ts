import { describe, expect, it } from 'vitest';
import {
  RUSSIAN_VOICE_BYTES,
  buildOnboardingPlan,
  formatBytes,
  renderGettingStarted,
  renderOnboardingPlan,
  type OnboardingInput,
} from './onboarding';

function input(overrides: Partial<OnboardingInput> = {}): OnboardingInput {
  return {
    machine: { platform: 'win32', totalRamMb: 16_000 },
    claude: { installed: true, loggedIn: true },
    codex: { installed: true, loggedIn: true },
    installedWhisperModels: [],
    ttsVoiceInstalled: false,
    ...overrides,
  };
}

describe('onboarding plan', () => {
  it('picks a speech model that fits the machine', () => {
    expect(buildOnboardingPlan(input({ machine: { platform: 'win32', totalRamMb: 4_000 } })).whisperModel).toBe('tiny');
    expect(buildOnboardingPlan(input({ machine: { platform: 'win32', totalRamMb: 8_000 } })).whisperModel).toBe('base');
    expect(buildOnboardingPlan(input()).whisperModel).toBe('small');
  });

  it('lets an explicit choice win over the recommendation', () => {
    expect(buildOnboardingPlan(input({ requestedWhisperModel: 'tiny' })).whisperModel).toBe('tiny');
  });

  it('says how much it is about to download before downloading it', () => {
    const plan = buildOnboardingPlan(input({ requestedWhisperModel: 'base' }));
    expect(plan.totalDownloadBytes).toBe(207_557_382 + RUSSIAN_VOICE_BYTES);
    expect(renderOnboardingPlan(plan)).toContain('Всего будет скачано');
  });

  it('skips what is already installed', () => {
    const plan = buildOnboardingPlan(
      input({
        requestedWhisperModel: 'base',
        installedWhisperModels: ['base'],
        ttsVoiceInstalled: true,
      }),
    );
    expect(plan.steps).toHaveLength(0);
    expect(plan.totalDownloadBytes).toBe(0);
    expect(renderOnboardingPlan(plan)).toContain('Всё уже готово');
  });

  it('treats a missing subscription CLI as optional, not fatal', () => {
    const plan = buildOnboardingPlan(
      input({
        claude: { installed: false, loggedIn: false },
        codex: { installed: false, loggedIn: false },
      }),
    );
    const optional = plan.steps.filter((step) => !step.required);
    expect(optional.map((step) => step.id)).toEqual(['claude:install', 'codex:install']);
    expect(plan.notes.join(' ')).toContain('Interpreter runtime');
  });

  it('distinguishes "not installed" from "installed but not signed in"', () => {
    const plan = buildOnboardingPlan(
      input({
        claude: { installed: true, loggedIn: false },
        codex: { installed: false, loggedIn: false },
      }),
    );
    expect(plan.steps.map((step) => step.id)).toContain('claude:login');
    expect(plan.steps.map((step) => step.id)).toContain('codex:install');
  });

  it('never asks the user to hand Jarvis a key or a token', () => {
    const text = renderOnboardingPlan(
      buildOnboardingPlan(
        input({
          claude: { installed: false, loggedIn: false },
          codex: { installed: false, loggedIn: false },
        }),
      ),
    ).toLowerCase();

    // Sign-in is the vendor's own flow; nothing here should ask for a secret.
    expect(text).not.toMatch(/(введите|вставьте|укажите)[^.]*(ключ|токен|key|token)/);
    expect(text).not.toContain('api key');
    expect(text).not.toContain('api-ключ');
    // It should say so out loud, because that is the reassurance people want.
    expect(text).toContain('не хранит ключи и не читает токены');
    expect(text).toContain('sign in with chatgpt');
  });

  it('says plainly when it is running somewhere other than Windows', () => {
    const plan = buildOnboardingPlan(input({ machine: { platform: 'linux', totalRamMb: 16_000 } }));
    expect(plan.notes.join(' ')).toContain('Windows 11');
  });

  it('stays quiet about the platform on Windows', () => {
    expect(buildOnboardingPlan(input()).notes.join(' ')).not.toContain('Windows 11');
  });
});

describe('formatting', () => {
  it('reports sizes the way a person reads them', () => {
    expect(formatBytes(207_557_382)).toBe('198 МБ');
    expect(formatBytes(1_931_372_882)).toBe('1.8 ГБ');
    expect(formatBytes(2_048)).toBe('2 КБ');
  });

  it('tells the user how to actually start talking', () => {
    const text = renderGettingStarted('Ctrl + Space');
    expect(text).toContain('Ctrl + Space');
    expect(text).toContain('«Джарвис»');
    expect(text).toContain('«Стоп»');
  });
});
