import { describe, expect, it } from 'vitest';

import type { BackendEvent } from '../backends/types';
import { StartupTiming } from './timing';

const tool = (name: string): BackendEvent => ({ type: 'tool', backend: 'claude-code', name });

describe('StartupTiming', () => {
  it('считает время до первого действия, меняющего мир', () => {
    // ToolSearch, Skill и recall мир не меняют: это ориентация агента, и мерить
    // надо именно её отдельно от дела.
    const timing = new StartupTiming(1_000);
    timing.saw(tool('ToolSearch'), 1_500);
    timing.saw(tool('Skill'), 2_000);
    timing.saw(tool('mcp__jarvis-desktop__recall'), 3_000);
    timing.saw(tool('mcp__jarvis-desktop__blender_live'), 13_000);

    expect(timing.firstUsefulMs).toBe(12_000);
  });

  it('называет, на что ушла ориентация', () => {
    const timing = new StartupTiming(0);
    timing.saw(tool('ToolSearch'), 1_000);
    timing.saw(tool('ToolSearch'), 2_000);
    timing.saw(tool('Skill'), 3_000);
    timing.saw(tool('mcp__jarvis-desktop__blender_live'), 12_000);

    const report = timing.report() ?? '';
    expect(report).toContain('12.0 с до первого дела');
    expect(report).toContain('ToolSearch 2');
    expect(report).toContain('Skill 1');
  });

  it('молчит, пока дела не было', () => {
    const timing = new StartupTiming(0);
    timing.saw(tool('ToolSearch'), 1_000);

    expect(timing.firstUsefulMs).toBeNull();
    expect(timing.report()).toBeNull();
  });

  it('считает первое дело один раз', () => {
    const timing = new StartupTiming(0);
    timing.saw(tool('Write'), 5_000);
    timing.saw(tool('Write'), 9_000);

    expect(timing.firstUsefulMs).toBe(5_000);
  });

  it('не спотыкается об оборванное событие', () => {
    // В ленту приходят и неполные события — на этом уже падал пересказ.
    const timing = new StartupTiming(0);

    expect(() => timing.saw({ type: 'tool', backend: 'claude-code' } as BackendEvent, 1)).not.toThrow();
    expect(timing.firstUsefulMs).toBeNull();
  });
});
