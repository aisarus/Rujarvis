import { describe, expect, it } from 'vitest';

import { buildReport, безСекретов, имяОтчёта, хвост } from './report';

describe('отчёт для разработчика', () => {
  it('похожее на секрет не выносится даже в отчёт', () => {
    expect(безСекретов({ language: 'ru', cloudSpeechKey: 'sk-123', apiToken: '', whisperModel: 'small' })).toEqual({
      language: 'ru',
      cloudSpeechKey: '(скрыто)',
      apiToken: '',
      whisperModel: 'small',
    });
  });

  it('из журнала — только хвост', () => {
    expect(хвост('1\n2\n3\n4\n', 2)).toBe('3\n4');
    expect(хвост('', 5)).toBe('');
  });

  it('имя файла латиницей и со временем', () => {
    expect(имяОтчёта(new Date(2026, 9, 20, 9, 5))).toBe('rujarvis-report-2026-10-20-0905.txt');
  });

  it('в отчёте версия, итог проверки обновления, система и журнал', () => {
    const текст = buildReport({
      when: new Date('2026-10-20T10:00:00Z'),
      version: { sha: 'abc', short: '20f9527', date: '2026-10-20', subject: 'Распознавание на видеокарте' },
      installedCopy: true,
      update: { state: 'available', branch: 'main', latest: 'def', changes: ['a', 'b'], more: false },
      platform: 'win32',
      osRelease: '10.0.26200',
      arch: 'x64',
      totalRamMb: 32768,
      versions: { electron: '42.0.0', node: undefined },
      settings: { language: 'ru' },
      agents: { claude: { installed: true } },
      log: 'строка 1\n[jarvis:lecture] сервер лекции не поднялся\n',
    });
    expect(текст).toContain('20f9527 от 2026-10-20: Распознавание на видеокарте');
    expect(текст).toContain('есть новая версия (изменений: 2)');
    expect(текст).toContain('win32 10.0.26200 x64, память 32 ГБ');
    expect(текст).toContain('electron: 42.0.0');
    expect(текст).not.toContain('node:');
    expect(текст).toContain('сервер лекции не поднялся');
  });
});
