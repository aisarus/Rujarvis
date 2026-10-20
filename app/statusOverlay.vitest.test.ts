import { Script } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: class {}, ipcMain: { on: () => {} }, screen: {} }));

const { buildOverlayHtml, isLectureSource, STATUS_OVERLAY_CHANNEL } = await import('./statusOverlay');

describe('плашка', () => {
  const html = buildOverlayHtml();
  const открывающий = html.indexOf('<script>') + '<script>'.length;
  const тело = html.slice(открывающий, html.indexOf('</script>', открывающий));

  it('скрипт страницы разбирается целиком', () => {
    expect(() => new Script(тело)).not.toThrow();
  });

  it('кнопка конспекта под плашкой: вне области перетаскивания и шлёт своё событие', () => {
    // В аудитории вслух не покомандуешь — кнопка (живой прогон 29.09.2026).
    expect(html).toContain('<button id="lecture"');
    expect(html).toMatch(/#bar button \{[^}]*-webkit-app-region: no-drag/u);
    expect(тело).toContain(JSON.stringify(`${STATUS_OVERLAY_CHANNEL}:lecture`));
    // Высота окна меряется вместе с кнопками, иначе они обрезаны.
    expect(тело).toContain("getElementById('bar').getBoundingClientRect().height");
  });

  it('начать конспект — сначала выбрать, откуда звук: аудитория или Zoom', () => {
    // Лекция в Zoom звучит из колонок — её пишет звук компьютера, не микрофон.
    expect(html).toContain('<button id="source-mic"');
    expect(html).toContain('<button id="source-system"');
    expect(тело).toContain("[['source-mic', 'mic'], ['source-system', 'system']]");
    // Ряд выбора входит в высоту окна, иначе его обрежет.
    expect(тело).toContain('sourcesBox.getBoundingClientRect().height');
    // Закончить — сразу, без выбора.
    expect(тело).toMatch(/if \(конспектИдёт\) \{\s*ipcRenderer\.send\(/u);
  });

  it('источник из страницы принимается только из двух известных', () => {
    expect(isLectureSource('mic')).toBe(true);
    expect(isLectureSource('system')).toBe(true);
    expect(isLectureSource('loopback')).toBe(false);
    expect(isLectureSource(undefined)).toBe(false);
  });
});
