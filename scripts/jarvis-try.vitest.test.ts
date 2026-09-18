import { describe, expect, it } from 'vitest';
import { parseArgs } from './jarvis-try';

describe('jarvis:try arguments', () => {
  it('defaults to interactive mode in the current directory', () => {
    expect(parseArgs([], '/work')).toEqual({
      dry: false,
      utterance: undefined,
      workspace: '/work',
    });
  });

  it('takes a single utterance from the rest of the command line', () => {
    expect(parseArgs(['открой', 'хром'], '/work').utterance).toBe('открой хром');
  });

  it('keeps a quoted Russian sentence intact', () => {
    const args = parseArgs(['Закрой это окно, только ничего не ломай'], '/work');
    expect(args.utterance).toBe('Закрой это окно, только ничего не ломай');
  });

  it('parses the dry flag without swallowing it into the utterance', () => {
    const args = parseArgs(['--dry', 'почини', 'билд'], '/work');
    expect(args.dry).toBe(true);
    expect(args.utterance).toBe('почини билд');
  });

  it('takes a workspace and leaves it out of the utterance', () => {
    const args = parseArgs(['--workspace', 'D:\\Projects\\aegis', 'почини', 'билд'], '/work');
    expect(args.workspace).toBe('D:\\Projects\\aegis');
    expect(args.utterance).toBe('почини билд');
  });

  it('falls back to the current directory when --workspace has no value', () => {
    expect(parseArgs(['--workspace'], '/work').workspace).toBe('/work');
  });
});
