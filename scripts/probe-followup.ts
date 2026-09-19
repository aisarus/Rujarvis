/**
 * Две фразы подряд: сделать и переделать.
 *
 * Отвечает на вопрос, который голосом проверяется долго: понимает ли Джарвис
 * короткую просьбу как продолжение только что сделанного. Раньше на «поменяй
 * цвет сферы на зелёный» он отвечал «не понял».
 */

import { createJarvis } from '../server/jarvis/createJarvis';

const started = Date.now();
const at = (): string => `${((Date.now() - started) / 1000).toFixed(1)}с`;

async function main(): Promise<void> {
  const jarvis = createJarvis({
    workspace: 'C:\\Users\\ariel\\AppData\\Local\\Rujarvis\\src',
    outputDir: 'C:\\Users\\ariel\\Desktop\\Джарвис',
    desktopMcpConfig:
      'C:\\Users\\ariel\\AppData\\Local\\Temp\\claude\\C--Users-ariel-AppData-Local-Rujarvis-src\\96a28a1d-301e-453a-8ca1-8fd5306364a6\\scratchpad\\desktop-mcp.json',
    speak: (text) => console.log(`[${at()}] говорит: ${text}`),
  });

  await jarvis.ready();

  // Первая задача — как будто уже выполнена: нас интересует вторая фраза.
  await jarvis.memory.recordTask({
    id: 'первая',
    utterance: 'Создай в блендере красную сферу',
    outcome: 'Готово, сфера сделана',
    ok: true,
    backend: 'claude-code',
    sessionId: 'сессия-проверки',
  });

  const turn = await jarvis.core.handleUtterance('Поменяй цвет сферы на зелёный');
  console.log(`[${at()}] ход: ${turn.kind}`);

  if (turn.kind === 'clarify') {
    console.log(`[${at()}] ПЕРЕСПРОСИЛ: ${turn.spoken}`);
    process.exit(1);
  }
  if (turn.kind !== 'task') {
    console.log(`[${at()}] неожиданный ход`);
    process.exit(1);
  }

  console.log(`[${at()}] принял как задачу: ${turn.task.title}`);
  console.log(`[${at()}] capabilities: ${turn.decision.needs.join(', ')}`);

  jarvis.tasks.cancelForeground();
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error('сорвалось:', error);
  process.exit(1);
});
