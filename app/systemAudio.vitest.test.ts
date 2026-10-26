import { describe, expect, it } from 'vitest';

import { displayMediaGrant, macHasLoopback, systemLoopback } from './systemAudio';

describe('звук компьютера для лекции в Zoom', () => {
  it('на маке — с macOS 14.2 (Darwin 23.2), раньше — нет', () => {
    expect(macHasLoopback('23.2.0')).toBe(true);
    expect(macHasLoopback('24.6.0')).toBe(true); // macOS 15 — MacBook Pro 2019 тянет его
    expect(macHasLoopback('23.1.0')).toBe(false); // macOS 14.1
    expect(macHasLoopback('22.6.0')).toBe(false); // macOS 13
    expect(macHasLoopback('мусор')).toBe(false);
  });

  it('Windows — всегда, Linux — нет', () => {
    expect(systemLoopback('win32', '10.0.26200')).toBe(true);
    expect(systemLoopback('linux', '6.8.0')).toBe(false);
  });

  it('где петли нет — экран без звука: окно звука скажет об этом и перейдёт на микрофон', () => {
    expect(displayMediaGrant('экран', 'darwin', '24.6.0')).toEqual({ video: 'экран', audio: 'loopback' });
    expect(displayMediaGrant('экран', 'darwin', '22.6.0')).toEqual({ video: 'экран' });
  });
});
