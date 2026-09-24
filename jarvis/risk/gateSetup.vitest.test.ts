import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { prepareGate } from './gateSetup';

describe('prepareGate', () => {
  const temp = () => mkdtempSync(path.join(os.tmpdir(), 'gate-setup-'));

  it('writes Claude Code settings that run the gate role of the built bundle with node', () => {
    const root = temp();
    const result = prepareGate({
      appRoot: 'C:\\Rujarvis\\src',
      dataDir: path.join(root, 'data'),
      outputDir: 'C:\\Users\\user\\Desktop\\Джарвис',
      exists: () => true,
      nodeAvailable: () => true,
      tempRoot: root,
    });
    if (!result.ok) throw new Error(result.reason);

    const settings = JSON.parse(readFileSync(result.settings, 'utf8'));
    const hook = settings.hooks.PreToolUse[0];
    expect(hook.matcher).toBe('*');
    expect(hook.hooks[0].command).toMatch(/^node "C:\/Rujarvis\/src\/dist\/jarvis\/desktop\/mcp\.cjs" gate ".+gate\.json"$/u);
    expect(hook.hooks[0].command).not.toContain('\\');
    expect(result.bridgeDir).toBe(path.join(root, 'data', 'gate'));
  });

  it('refuses to set up a gate that could not run', () => {
    const root = temp();
    const base = { appRoot: '/app', dataDir: path.join(root, 'data'), tempRoot: root };
    expect(prepareGate({ ...base, exists: () => false, nodeAvailable: () => true }).ok).toBe(false);
    expect(prepareGate({ ...base, exists: () => true, nodeAvailable: () => false }).ok).toBe(false);
  });
});
