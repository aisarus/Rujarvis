import { describe, expect, it } from 'vitest';

import { ProgressVoice, describeStep } from './progress';

function voice(quietMs = 20_000, gapMs = 25_000) {
  let clock = 1_000_000;
  return {
    voice: new ProgressVoice({ quietMs, gapMs, now: () => clock }),
    advance(ms: number) {
      clock += ms;
    },
  };
}

const tool = (name: string) => ({ type: 'tool' as const, backend: 'claude-code' as const, name });

describe('describeStep', () => {
  it.each([
    ['mcp__jarvis-desktop__blender_python', 'блендер'],
    ['mcp__jarvis-desktop__screenshot', 'экран'],
    ['mcp__jarvis-desktop__browser_open', 'браузер'],
    ['Bash', 'команд'],
    ['Write', 'файл'],
    ['WebSearch', 'интернет'],
  ])('превращает «%s» в понятное человеку', (name, expected) => {
    expect(describeStep(tool(name))?.toLowerCase()).toContain(expected);
  });

  it('молчит про то, что человеку ничего не скажет', () => {
    expect(describeStep({ type: 'status', backend: 'claude-code', text: 'thinking' })).toBe(null);
  });
});

describe('ProgressVoice', () => {
  it('молчит, пока задача короткая', () => {
    // Задача на десять секунд не нуждается в докладе о ходе.
    const { voice: progress, advance } = voice();
    progress.saw(tool('Bash'));
    advance(10_000);
    expect(progress.due()).toBe(null);
  });

  it('заговаривает, когда молчание затянулось', () => {
    const { voice: progress, advance } = voice();
    progress.saw(tool('mcp__jarvis-desktop__blender_python'));
    advance(21_000);

    const line = progress.due();
    expect(line).toBeTruthy();
    expect(line?.toLowerCase()).toContain('блендер');
  });

  it('не тараторит: между докладами держит паузу', () => {
    const { voice: progress, advance } = voice();
    progress.saw(tool('Bash'));
    advance(21_000);
    expect(progress.due()).toBeTruthy();

    advance(5_000);
    expect(progress.due()).toBe(null);

    advance(21_000);
    expect(progress.due()).toBeTruthy();
  });

  it('говорит о последнем шаге, а не о первом', () => {
    const { voice: progress, advance } = voice();
    progress.saw(tool('Bash'));
    progress.saw(tool('mcp__jarvis-desktop__blender_python'));
    advance(21_000);

    expect(progress.due()?.toLowerCase()).toContain('блендер');
  });

  it('когда сказать нечего, всё равно подаёт голос', () => {
    // Двухминутная тишина читается как поломка, даже если всё идёт хорошо.
    const { voice: progress, advance } = voice();
    advance(21_000);
    expect(progress.due()).toBeTruthy();
  });

  it('не повторяет одно и то же дважды подряд', () => {
    const { voice: progress, advance } = voice();
    progress.saw(tool('mcp__jarvis-desktop__blender_python'));
    advance(21_000);
    const first = progress.due();

    advance(26_000);
    const second = progress.due();
    expect(second).not.toBe(first);
  });

  it('после сброса начинает отсчёт заново', () => {
    const { voice: progress, advance } = voice();
    advance(21_000);
    progress.reset();
    expect(progress.due()).toBe(null);
  });
});
