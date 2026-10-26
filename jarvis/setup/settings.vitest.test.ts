import { describe, expect, it } from 'vitest';

import { normaliseSettings } from './settings';

describe('вариант установки', () => {
  it('без записи и с мусором — Джарвис целиком', () => {
    // Старые настройки варианта не знают: до разделения был только полный.
    expect(normaliseSettings({}).edition).toBe('full');
    expect(normaliseSettings({ edition: 'всё' }).edition).toBe('full');
    expect(normaliseSettings({ edition: 1 }).edition).toBe('full');
  });

  it('«только конспекты» переживает чтение с диска', () => {
    expect(normaliseSettings({ edition: 'notes' }).edition).toBe('notes');
    expect(normaliseSettings({ edition: 'full' }).edition).toBe('full');
  });
});
