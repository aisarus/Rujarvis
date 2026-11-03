import { afterEach, describe, expect, it } from 'vitest';

import { brainFromArgs, brainOrder, codexFailure, codexSummaryArgs, createCodexSummarizer, forgetBrainOutcomes, looksSignedOut, rememberBrainOutcome, withFallback } from './summarize';

afterEach(() => forgetBrainOutcomes());

describe('кто пишет конспект', () => {
  it('«сам» — установленные, Claude Code первым', () => {
    expect(brainOrder('auto', () => true)).toEqual(['claude', 'codex']);
    // У тестерши ChatGPT, а не Claude: конспект пишет Codex.
    expect(brainOrder('auto', (cli) => cli === 'codex')).toEqual(['codex']);
    expect(brainOrder('auto', () => false)).toEqual([]);
  });

  it('выбранный руками — только он, даже если второй установлен', () => {
    expect(brainOrder('codex', () => true)).toEqual(['codex']);
    expect(brainOrder('claude', () => true)).toEqual(['claude']);
  });

  it('«не вошли» — в автоматическом выборе последним на четверть часа; ответил — снова первым', () => {
    const t = 1_000_000;
    rememberBrainOutcome('claude', new Error('Claude Code вышел с кодом 1: Failed to authenticate: OAuth session expired'), t);
    expect(brainOrder('auto', () => true, t + 60_000)).toEqual(['codex', 'claude']);
    expect(brainOrder('auto', () => true, t + 16 * 60_000)).toEqual(['claude', 'codex']);
    // Выбор руками это не трогает.
    expect(brainOrder('claude', () => true, t + 60_000)).toEqual(['claude']);
    rememberBrainOutcome('claude', null, t + 2 * 60_000);
    expect(brainOrder('auto', () => true, t + 3 * 60_000)).toEqual(['claude', 'codex']);
    // Лимит или сбой сети — не «не вошли»: порядок прежний.
    rememberBrainOutcome('claude', new Error('usage limit reached'), t);
    expect(brainOrder('auto', () => true, t + 60_000)).toEqual(['claude', 'codex']);
  });

  it('итог: не вошли в Opus — Sonnet не спрашиваем, вход у них один', async () => {
    const спросили: string[] = [];
    const итог = withFallback(
      async () => {
        спросили.push('opus');
        throw new Error('Invalid API key · Please run /login');
      },
      async () => {
        спросили.push('sonnet');
        return 'x';
      },
      undefined,
      (error) => !looksSignedOut(String(error)),
    );
    await expect(итог('p')).rejects.toThrow(/login/u);
    expect(спросили).toEqual(['opus']);
  });

  it('--brain= в командной строке — поверх настроек, мусор — нет', () => {
    expect(brainFromArgs(['node', 'x', '--brain=codex'], 'auto')).toBe('codex');
    expect(brainFromArgs(['node', 'x', '--brain=gpt'], 'claude')).toBe('claude');
    expect(brainFromArgs(['node', 'x'], 'auto')).toBe('auto');
  });
});

describe('Codex для раздела', () => {
  it('только чтение, без своих рук и истории, ответ — в файл, промпт — из stdin', () => {
    const args = codexSummaryArgs('/tmp/answer.md', { effort: 'low', choices: { ignoreUserConfig: true, values: { model: 'gpt-x' } } });
    expect(args[0]).toBe('exec');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config']));
    expect(args).toContain('model="gpt-x"');
    expect(args).toContain('features.computer_use=false');
    expect(args).toContain('model_reasoning_effort="low"');
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/answer.md');
    expect(args.at(-1)).toBe('-');
  });

  it('уровень рассуждений не навязывается, если не задан', () => {
    const args = codexSummaryArgs('/tmp/a.md', { choices: { ignoreUserConfig: true, values: {} } });
    expect(args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
  });

  it('причина отказа — из события, а не из хода работы в stderr', () => {
    const поток = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"error","message":"The \'gpt-x\' model is not supported when using Codex with a ChatGPT account."}',
      '{"type":"turn.failed","error":{"message":"usage limit reached"}}',
    ].join('\n');
    expect(codexFailure(поток, 'OpenAI Codex v0.153.4\nworkdir: /tmp')).toBe('usage limit reached');
    expect(codexFailure('', 'строка 1\nстрока 2')).toContain('строка 2');
  });

  it('ответ берётся из файла последнего сообщения', async () => {
    const summarize = createCodexSummarizer({
      command: process.execPath,
      args: (файл) => [
        '-e',
        "let t='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>t+=d);process.stdin.on('end',()=>{require('fs').writeFileSync(process.argv[1],'### '+t.length);process.stdout.write('{\"type\":\"turn.completed\"}\\n')})",
        файл,
      ],
      env: process.env,
    });
    const промпт = 'кусок лекции '.repeat(5000);
    expect(await summarize(промпт)).toBe(`### ${промпт.length}`);
  });

  it('отказ Codex — ошибка с его причиной, а не пустой раздел', async () => {
    const summarize = createCodexSummarizer({
      command: process.execPath,
      args: () => ['-e', "process.stdout.write('{\"type\":\"error\",\"message\":\"usage limit reached\"}\\n');process.exit(1)"],
      env: process.env,
    });
    await expect(summarize('x')).rejects.toThrow(/кодом 1: usage limit reached/u);
  });
});
