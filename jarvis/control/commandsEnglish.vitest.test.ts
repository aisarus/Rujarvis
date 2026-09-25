import { describe, expect, it } from 'vitest';

import { matchVoiceControl } from '../voice/interrupts';
import { readConfirmation } from '../voice/confirm';
import { isSilenceRequest } from '../voice/noise';
import { findWakeWord } from '../voice/wakeWord';
import { parseDirectCommand } from './commands';

describe('English direct commands', () => {
  it.each([
    ['scroll down', { kind: 'scroll', amount: -3 }],
    ['Scroll the page up, please', { kind: 'scroll', amount: 3 }],
    ['copy', { kind: 'key', keys: 'ctrl+c' }],
    ['press enter', { kind: 'key', keys: 'enter' }],
    ['open a new tab', { kind: 'key', keys: 'ctrl+t' }],
    ['close this tab', { kind: 'key', keys: 'ctrl+w' }],
    ['go to the next tab', { kind: 'key', keys: 'ctrl+tab' }],
    ['minimize the window', { kind: 'key', keys: 'win+down' }],
    ['close the window', { kind: 'key', keys: 'alt+f4' }],
    ['switch to chrome', { kind: 'focus', title: 'chrome' }],
    ['Jarvis, switch to telegram', { kind: 'focus', title: 'telegram' }],
    ['right click', { kind: 'click', button: 'right' }],
    ['double click', { kind: 'click', button: 'left', double: true }],
    ['click on the sign in button', { kind: 'clickNamed', query: 'sign in' }],
    ['type hello world', { kind: 'type', text: 'hello world' }],
    ['what can you do', { kind: 'help', on: true }],
    ['what are you doing', { kind: 'log', on: true }],
    ['show grid', { kind: 'grid', on: true }],
    ['emergency stop', { kind: 'selfDestruct' }],
  ])('%s', (phrase, expected) => {
    expect(parseDirectCommand(phrase)).toEqual(expected);
  });

  it('repeats a command a spoken number of times', () => {
    expect(parseDirectCommand('scroll down three times')).toEqual({
      kind: 'repeat',
      times: 3,
      command: { kind: 'scroll', amount: -3 },
    });
    expect(parseDirectCommand('scroll down twice')).toEqual({
      kind: 'repeat',
      times: 2,
      command: { kind: 'scroll', amount: -3 },
    });
    expect(parseDirectCommand('scroll down again')).toEqual({ kind: 'scroll', amount: -3 });
  });

  it('leaves real work to the agent', () => {
    expect(parseDirectCommand('find the report from march and email it to anna')).toBeNull();
    expect(parseDirectCommand('type a letter to my landlord')).toBeNull();
  });
});

describe('English red lines work in every mode', () => {
  it.each(['stop', 'Stop it!', 'cancel', 'never mind', 'jarvis stop'])('%s stops', (phrase) => {
    expect(matchVoiceControl(phrase)?.control).toMatch(/stop|cancel/);
  });

  it.each(['silence', 'be quiet', 'shut up', 'stop talking'])('%s silences', (phrase) => {
    const control = matchVoiceControl(phrase)?.control;
    expect(control === 'mute' || isSilenceRequest(phrase)).toBe(true);
  });

  it('no English command steals a stop or silence word', () => {
    for (const phrase of ['stop', 'pause', 'wait', 'cancel', 'silence', 'quiet', 'mute']) {
      expect(parseDirectCommand(phrase)).toBeNull();
    }
  });

  it('reads English answers to a red-line question, and a mixed one as a refusal', () => {
    expect(readConfirmation('yes')).toBe('yes');
    expect(readConfirmation('Sure, go ahead')).toBe('yes');
    expect(readConfirmation("no, don't")).toBe('no');
    expect(readConfirmation('yeah no')).toBe('no');
    expect(readConfirmation('sure, wait')).toBe('no');
    expect(readConfirmation('hmm let me think')).toBe('unclear');
  });
});

describe('English wake word', () => {
  it('hears Jarvis and its usual mishearings, but not other names', () => {
    expect(findWakeWord('Jarvis, open chrome')?.command).toBe('open chrome');
    expect(findWakeWord('jervis open chrome')?.command).toBe('open chrome');
    expect(findWakeWord('hey travis how are you')).toBeNull();
    expect(findWakeWord('harvey called')).toBeNull();
  });
});

import { matchAppLaunch, spokenCloseTarget, spokenTarget } from '../apps/launch';

describe('English app launching and closing', () => {
  it('opens known apps by their English names', () => {
    expect(matchAppLaunch('open chrome')).toEqual({ target: 'chrome', spokenName: 'chrome' });
    expect(matchAppLaunch('launch the calculator')).toEqual({ target: 'calc', spokenName: 'calculator' });
    expect(matchAppLaunch('can you open telegram please')?.target).toBe('telegram');
  });

  it('finds the spoken target for unknown apps and closing', () => {
    expect(spokenTarget('open blender')).toBe('blender');
    expect(spokenCloseTarget('close spotify')).toBe('spotify');
    expect(spokenCloseTarget('close it')).toBeNull();
  });
});

import { route } from '../router/router';

describe('English routing and phrase-level red lines', () => {
  const risk = (phrase: string) => route(phrase).risk;

  it('asks before money, messages and pushes', () => {
    expect(risk('buy the cheapest flight to Berlin')).not.toMatch(/safe|normal/);
    expect(risk('send this file to Anna by email')).not.toMatch(/safe|normal/);
    expect(risk('push the changes to github')).not.toMatch(/safe|normal/);
    expect(risk('transfer 100 dollars to my card')).not.toMatch(/safe|normal/);
  });

  it('treats destroying system places as dangerous', () => {
    expect(risk('delete everything in system32')).toBe('dangerous');
    expect(risk('turn off the firewall')).toBe('dangerous');
  });

  it('does not treat a question or a translation as a red line', () => {
    expect(risk('who wrote war and peace')).toMatch(/safe|normal/);
    expect(risk('translate this text into russian')).toMatch(/safe|normal/);
    expect(risk('make the button look better')).toMatch(/safe|normal/);
  });

  it('respects "don\'t change anything"', () => {
    const decision = route("look at why the build fails but don't change anything");
    expect(decision.permissions.edit).toBe(false);
  });

  it('honours a negated backend', () => {
    const decision = route("fix the failing test, don't use claude");
    expect(decision.target).not.toBe('claude-code');
  });
});
