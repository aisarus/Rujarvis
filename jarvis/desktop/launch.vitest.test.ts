import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { desktopMcpBundle, resolveDesktopMcpLaunch } from './launch';

const ROOT = path.join('/opt', 'rujarvis');
const BUNDLE = desktopMcpBundle(ROOT);

describe('resolveDesktopMcpLaunch', () => {
  it('runs the built bundle with the app executable in node mode under Electron', () => {
    const result = resolveDesktopMcpLaunch({
      appRoot: ROOT,
      env: {},
      runtime: '/opt/rujarvis/electron',
      electron: true,
      exists: (file) => file === BUNDLE,
    });
    expect(result).toEqual({
      ok: true,
      launch: { command: '/opt/rujarvis/electron', args: [BUNDLE], env: { ELECTRON_RUN_AS_NODE: '1' } },
    });
  });

  it('does not set the Electron flag under plain node', () => {
    const result = resolveDesktopMcpLaunch({
      appRoot: ROOT,
      env: {},
      runtime: 'node',
      electron: false,
      exists: () => true,
    });
    expect(result.ok && result.launch.env).toEqual({});
  });

  it('names the missing bundle instead of failing silently', () => {
    const result = resolveDesktopMcpLaunch({ appRoot: ROOT, env: {}, exists: () => false });
    expect(result).toEqual({ ok: false, missing: BUNDLE });
  });

  it('prefers an explicit server and reports it when it is missing', () => {
    const env = { JARVIS_DESKTOP_MCP: 'C:\\srv\\desktop-mcp.cmd' };
    expect(resolveDesktopMcpLaunch({ appRoot: ROOT, env, exists: () => true })).toEqual({
      ok: true,
      launch: { command: 'C:\\srv\\desktop-mcp.cmd', args: [], env: {} },
    });
    expect(resolveDesktopMcpLaunch({ appRoot: ROOT, env, exists: () => false })).toEqual({
      ok: false,
      missing: 'C:\\srv\\desktop-mcp.cmd',
    });
  });
});
