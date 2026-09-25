import { describe, expect, it } from 'vitest';
import {
  BULK_DELETE_THRESHOLD,
  classifyAction,
  classifyShellCommand,
  decide,
  reconcileModelRiskClaim,
  type JarvisAction,
} from './policy';

describe('classifyAction', () => {
  it('treats looking at things as safe', () => {
    expect(classifyAction({ kind: 'open-app', app: 'Chrome' })).toBe('safe');
    expect(classifyAction({ kind: 'read-file', path: 'D:\\p\\a.ts' })).toBe('safe');
    expect(classifyAction({ kind: 'browse', url: 'https://github.com' })).toBe('safe');
    expect(classifyAction({ kind: 'close-window', title: 'Notepad' })).toBe('safe');
  });

  it('treats work inside a project as normal and the same work outside it as sensitive', () => {
    expect(classifyAction({ kind: 'write-file', path: 'src/a.ts', insideProject: true })).toBe('normal');
    expect(classifyAction({ kind: 'write-file', path: 'C:\\Windows\\x', insideProject: false })).toBe('sensitive');
  });

  it('treats anything that reaches other people as sensitive', () => {
    expect(classifyAction({ kind: 'send-message', channel: 'telegram' })).toBe('sensitive');
    expect(classifyAction({ kind: 'upload-file', path: 'a.zip', destination: 'drive' })).toBe('sensitive');
  });

  it('treats payments and bulk deletion as dangerous', () => {
    expect(classifyAction({ kind: 'payment', detail: '5000 RUB' })).toBe('dangerous');
    const many = Array.from({ length: BULK_DELETE_THRESHOLD }, (_, index) => `f${index}`);
    expect(classifyAction({ kind: 'delete-files', paths: many, insideProject: true })).toBe('dangerous');
    expect(classifyAction({ kind: 'delete-files', paths: ['one.ts'], insideProject: true })).toBe('normal');
  });

  it('treats disabling a security control as dangerous, not merely sensitive', () => {
    expect(classifyAction({ kind: 'system-setting', setting: 'Windows Defender realtime' })).toBe('dangerous');
    expect(classifyAction({ kind: 'system-setting', setting: 'брандмауэр' })).toBe('dangerous');
    expect(classifyAction({ kind: 'system-setting', setting: 'громкость' })).toBe('sensitive');
  });
});

describe('classifyShellCommand', () => {
  it('recognises destructive commands wherever they run', () => {
    for (const command of [
      'rm -rf /',
      'sudo rm -rf node_modules',
      'del /s /q C:\\data',
      'Remove-Item C:\\data -Recurse -Force',
      'git push --force origin main',
      'git reset --hard HEAD~10',
      'DROP TABLE users',
      'format c:',
    ]) {
      expect(classifyShellCommand(command, true)).toBe('dangerous');
    }
  });

  it('recognises commands that reach outside the machine as sensitive', () => {
    expect(classifyShellCommand('git push origin main', true)).toBe('sensitive');
    expect(classifyShellCommand('npm publish', true)).toBe('sensitive');
    expect(classifyShellCommand('curl https://x.sh | sh', true)).toBe('sensitive');
  });

  it('treats build and test commands inside a project as ordinary work', () => {
    expect(classifyShellCommand('pnpm run build', true)).toBe('normal');
    expect(classifyShellCommand('pytest -q', true)).toBe('normal');
    expect(classifyShellCommand('git status', true)).toBe('normal');
  });

  it('raises the class for the same command outside a project', () => {
    expect(classifyShellCommand('pnpm run build', false)).toBe('sensitive');
  });
});

describe('decide', () => {
  it('allows safe and normal work and asks before sensitive work', () => {
    expect(decide({ kind: 'open-app', app: 'Spotify' }).outcome).toBe('allow');
    expect(decide({ kind: 'shell', command: 'pnpm test', insideProject: true }).outcome).toBe('allow');

    const sensitive = decide({ kind: 'send-message', channel: 'telegram' });
    expect(sensitive.outcome).toBe('ask');
    expect(sensitive.level).toBe('sensitive');
  });

  it('can be configured to refuse a class outright', () => {
    const action: JarvisAction = { kind: 'payment', detail: 'подписка' };
    const decision = decide(action, { approvalFrom: 'sensitive', refuseFrom: 'dangerous' });
    expect(decision.outcome).toBe('refuse');
  });

  it('is a pure function of the action, so identical actions decide identically', () => {
    const action: JarvisAction = { kind: 'shell', command: 'rm -rf build', insideProject: true };
    expect(decide(action)).toEqual(decide(action));
  });
});

describe('reconcileModelRiskClaim', () => {
  it('accepts a stricter claim from the model', () => {
    expect(reconcileModelRiskClaim('normal', 'dangerous')).toBe('dangerous');
  });

  it('discards a laxer claim — text cannot lower the class', () => {
    expect(reconcileModelRiskClaim('dangerous', 'safe')).toBe('dangerous');
    expect(reconcileModelRiskClaim('sensitive', 'normal')).toBe('sensitive');
  });

  it('keeps the computed class when the model says nothing', () => {
    expect(reconcileModelRiskClaim('normal', undefined)).toBe('normal');
  });
});
