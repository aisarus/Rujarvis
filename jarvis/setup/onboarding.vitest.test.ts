import { describe, expect, it } from 'vitest';

import { formatBytes, readMachineFacts } from './onboarding';

describe('formatting', () => {
  it('reports sizes the way a person reads them', () => {
    expect(formatBytes(207_557_382)).toBe('198 МБ');
    expect(formatBytes(1_931_372_882)).toBe('1.8 ГБ');
    expect(formatBytes(2_048)).toBe('2 КБ');
  });
});

describe('machine facts', () => {
  it('names the platform and the memory in megabytes', () => {
    const facts = readMachineFacts();
    expect(facts.platform).toBe(process.platform);
    expect(facts.totalRamMb).toBeGreaterThan(256);
  });
});
