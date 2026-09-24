import { describe, expect, it } from 'vitest';

import { shouldStartJarvis } from './startup';

describe('shouldStartJarvis', () => {
  it('starts by default on Windows only', () => {
    expect(shouldStartJarvis('win32', undefined)).toBe(true);
    expect(shouldStartJarvis('darwin', undefined)).toBe(false);
    expect(shouldStartJarvis('linux', '')).toBe(false);
  });

  it('obeys an explicit setting on every platform', () => {
    expect(shouldStartJarvis('win32', 'off')).toBe(false);
    expect(shouldStartJarvis('linux', 'on')).toBe(true);
    expect(shouldStartJarvis('darwin', ' ON ')).toBe(true);
  });
});
