/**
 * Что Джарвис решает, услышав фразу.
 *
 * Отладочный запуск: показывает capabilities, backend и то, получит ли агент
 * инструменты рабочего стола. Нужен потому, что по голосу этого не видно —
 * задача либо делается, либо нет, а почему именно, сказать нечем.
 */

import { buildClaudeArgs } from '../jarvis/backends/claudeCode';
import { route } from '../jarvis/router/router';
import { DEFAULT_PERMISSIONS } from '../jarvis/types';

const phrases = process.argv.slice(2);
if (phrases.length === 0) {
  console.error('Скажи, какие фразы проверить.');
  process.exit(1);
}

for (const phrase of phrases) {
  const decision = route(phrase);
  const args = buildClaudeArgs(
    {
      utterance: phrase,
      capabilities: decision.needs,
      risk: decision.risk,
      permissions: DEFAULT_PERMISSIONS,
      context: [],
      language: 'ru',
    },
    { permissionMode: 'acceptEdits', desktopMcpConfig: 'C:/mcp.json' },
  );

  const hasTools = args.includes('--mcp-config');
  const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';

  console.log(`\n«${phrase}»`);
  console.log(`  намерение:     ${decision.intent}`);
  console.log(`  capabilities:  ${decision.needs.join(', ') || '(ничего)'}`);
  console.log(`  backend:       ${decision.target}`);
  console.log(`  инструменты:   ${hasTools ? 'да' : 'НЕТ'}`);
  console.log(`  blender:       ${allowed.includes('blender_python') ? 'да' : 'НЕТ'}`);
  console.log(`  уверенность:   ${decision.confidence.toFixed(2)}`);
}
