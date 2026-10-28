import { Script } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: class {}, ipcMain: { on: () => {} }, screen: {} }));

const { buildOverlayHtml, fitOnScreen, isLectureSource, isOverlaySize, STATUS_OVERLAY_CHANNEL } = await import('./statusOverlay');

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
    expect(html).toMatch(/#bar button, #row button \{[^}]*-webkit-app-region: no-drag/u);
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

  it('обычная, уменьшенная и свёрнутая в панель задач (тестер 21.10, владелец 28.10.2026)', () => {
    // Кнопки — в углу плашки и вне области перетаскивания, иначе нажатие тащило бы окно.
    expect(html).toContain('<button id="smaller"');
    expect(html).toContain('<button id="mini"');
    expect(html).toMatch(/#corner \{[^}]*-webkit-app-region: no-drag/u);
    expect(тело).toContain(`const SIZE = ${JSON.stringify(`${STATUS_OVERLAY_CHANNEL}:size`)}`);
    expect(тело).toContain(`ipcRenderer.send(SIZE, вид === 'compact' ? 'full' : 'compact')`);
    // «–» — свернуть окно, а не ещё один размер: значка в углу больше нет.
    expect(тело).toContain(`ipcRenderer.send(${JSON.stringify(`${STATUS_OVERLAY_CHANNEL}:minimize`)})`);
    expect(html).not.toContain('body.mini');
    expect(html).toMatch(/<button id="mini"[^>]*title="Свернуть в (панель задач|Dock)"/u);
  });

  it('уменьшенная — только запись и готовый конспект', () => {
    expect(html).toMatch(/<div id="row">\s*<button id="rec"[^>]*>[^<]*<\/button>\s*<button id="open"/u);
    expect(html).toMatch(/body\.compact #text, body\.compact #bar, body\.compact #courses \{ display: none/u);
    // Запись на уменьшенной ведёт себя как большая кнопка: начать — через выбор источника.
    expect(тело).toContain("recButton.addEventListener('click', нажатьКонспект)");
    expect(тело).toContain("lectureButton.addEventListener('click', нажатьКонспект)");
    // Открыть нечего — говорит сама кнопка: строка «услышал…» на уменьшенной не видна.
    expect(тело).toContain(`await ipcRenderer.invoke(${JSON.stringify(`${STATUS_OVERLAY_CHANNEL}:open`)})`);
  });

  it('развёрнутая плашка встаёт, где её оставили, но целиком на экране', () => {
    const экран = { x: 0, y: 0, width: 1920, height: 1040 };
    // Не двигали — в правый нижний угол с отступом.
    expect(fitOnScreen(null, { width: 320, height: 84 }, экран)).toEqual({ x: 1576, y: 932, width: 320, height: 84 });
    // Уменьшенную поставили к правому краю — обычная, она шире, не уходит за него.
    expect(fitOnScreen({ x: 1640, y: 990 }, { width: 320, height: 84 }, экран)).toEqual({ x: 1600, y: 956, width: 320, height: 84 });
    expect(fitOnScreen({ x: 100, y: 200 }, { width: 270, height: 44 }, экран)).toEqual({ x: 100, y: 200, width: 270, height: 44 });
  });

  it('размер из страницы принимается только из двух известных', () => {
    expect(['full', 'compact'].every(isOverlaySize)).toBe(true);
    // Значок в углу был до 28.10.2026; запомненный — открывается обычной.
    expect(isOverlaySize('icon')).toBe(false);
    expect(isOverlaySize('huge')).toBe(false);
    expect(isOverlaySize(true)).toBe(false);
  });

  it('источник из страницы принимается только из двух известных', () => {
    expect(isLectureSource('mic')).toBe(true);
    expect(isLectureSource('system')).toBe(true);
    expect(isLectureSource('loopback')).toBe(false);
    expect(isLectureSource(undefined)).toBe(false);
  });
});
