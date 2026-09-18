import { describe, expect, it } from 'vitest';
import { createJarvis } from './createJarvis';
import { DEFAULT_JARVIS_SETTINGS } from '../../jarvis/core';

describe('createJarvis', () => {
  it('registers the runtime and both subscription backends', () => {
    const jarvis = createJarvis({ workspace: '/work' });
    expect(jarvis.backends.list().map((backend) => backend.id).sort()).toEqual([
      'claude-code',
      'codex',
      'interpreter',
    ]);
  });

  it('adds a local reasoning fallback only when one is configured', () => {
    const withFallback = createJarvis({
      workspace: '/work',
      fallbackModel: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b' },
    });
    expect(withFallback.backends.list().map((backend) => backend.id)).toContain('local');
    expect(createJarvis({}).backends.list().map((backend) => backend.id)).not.toContain('local');
  });

  it('keeps the world state in step with running tasks', async () => {
    const jarvis = createJarvis({ workspace: '/work' });
    await jarvis.ready();

    // No desktop observer here, so the snapshot is whatever tasks put there.
    expect(jarvis.world.snapshot().runningTaskIds).toEqual([]);
    expect(jarvis.world.snapshot().currentProjectPath).toBe('/work');
  });

  it('reports availability for every backend without throwing, even with no CLI', async () => {
    const jarvis = createJarvis({ workspace: '/work' });
    const availability = await jarvis.backends.availability(true);

    expect(availability.map((entry) => entry.id).sort()).toEqual([
      'claude-code',
      'codex',
      'interpreter',
    ]);
    for (const entry of availability) {
      // Whatever the machine has, an unavailable backend explains itself in
      // Russian rather than failing the probe.
      if (!entry.ready) expect(entry.reason).toBeTruthy();
    }
  });

  it('refuses sensitive work when no approval callback was supplied', async () => {
    const jarvis = createJarvis({ workspace: '/work', settings: () => DEFAULT_JARVIS_SETTINGS });
    await jarvis.ready();

    const turn = await jarvis.core.handleUtterance('отправь это сообщение в телеграм');
    expect(turn.kind).toBe('refused');
    expect(jarvis.tasks.list()).toHaveLength(0);
  });

  it('handles a control word without any backend being reachable', async () => {
    const jarvis = createJarvis({ workspace: '/work' });
    await jarvis.ready();

    const turn = await jarvis.core.handleUtterance('Стоп');
    expect(turn.kind).toBe('control');
  });
});
