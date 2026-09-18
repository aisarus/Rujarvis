/**
 * Composes the text handed to a subscription coding agent.
 *
 * The rule that matters: the user's own words go in verbatim and first. The
 * router's normalisation is supporting context, so a mis-normalisation can
 * never hide what was actually asked.
 */

import type { BackendRequest } from './types';

function section(title: string, lines: readonly string[]): string | null {
  const kept = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (kept.length === 0) return null;
  return `${title}\n${kept.map((line) => `- ${line}`).join('\n')}`;
}

function permissionLines(request: BackendRequest): string[] {
  const { permissions } = request;
  const lines = [
    permissions.read ? 'Reading files is allowed.' : 'Do not read files.',
    permissions.edit
      ? 'Editing files is allowed.'
      : 'Do NOT modify, create or delete any file. Inspect and report only.',
    permissions.execute
      ? 'Running commands (build, tests) is allowed.'
      : 'Do NOT run commands that change state.',
  ];
  if (!permissions.network) {
    lines.push('Do not make network requests.');
  }
  if (request.risk === 'sensitive' || request.risk === 'dangerous') {
    lines.push(
      'Do not push, publish, send messages, or take any other outward-facing action without being asked for it explicitly in the request above.',
    );
  }
  return lines;
}

export function buildBackendPrompt(request: BackendRequest): string {
  const language = request.language ?? 'ru';
  const parts: string[] = [];

  parts.push(`USER REQUEST (verbatim, this is the source of truth):\n"""\n${request.utterance.trim()}\n"""`);

  if (request.goal && request.goal.trim()) {
    parts.push(
      `INTERPRETED GOAL (produced by a router, may be imprecise — the verbatim request above wins):\n${request.goal.trim()}`,
    );
  }

  const constraints = section('CONSTRAINTS', request.constraints ?? []);
  if (constraints) parts.push(constraints);

  const acceptance = section('ACCEPTANCE CRITERIA', request.acceptanceCriteria ?? []);
  if (acceptance) parts.push(acceptance);

  const context = section('CONTEXT', request.context ?? []);
  if (context) parts.push(context);

  if (request.project) {
    parts.push(`PROJECT: ${request.project}${request.cwd ? ` (${request.cwd})` : ''}`);
  }

  const permissions = section('PERMISSIONS', permissionLines(request));
  if (permissions) parts.push(permissions);

  parts.push(
    language === 'ru'
      ? [
          'ANSWER FORMAT',
          '- Write the final answer in Russian.',
          '- Start with one short sentence stating the outcome.',
          '- Then give the details: what you found, what you changed, what you ran.',
          '- Do not narrate your reasoning; report the actions and the result.',
        ].join('\n')
      : [
          'ANSWER FORMAT',
          '- Start with one short sentence stating the outcome.',
          '- Then give the details: what you found, what you changed, what you ran.',
        ].join('\n'),
  );

  return parts.join('\n\n');
}
