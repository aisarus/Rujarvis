/**
 * Одна команда — план — работа. Проверка всего слоя разом.
 *
 * Всё было построено по частям и по частям проверено: план, ящик правок,
 * приборы, окно. Ни разу не проверено главное — что оно работает вместе.
 * Здесь Джарвису даётся одна фраза, и видно каждый его шаг: составил ли план,
 * отмечал ли шаги, звал ли приборы, чем кончил.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createJarvis } from '../server/jarvis/createJarvis';
import { describeEvent } from '../jarvis/observe/storyline';
import { renderPlan } from '../jarvis/agent/plan';
import { PlanStore } from '../jarvis/agent/planStore';

// Прямые слэши намеренно: Windows их принимает, а обратные не переживают ни
// одной перезаписи файла — heredoc и python съедают их молча, и путь
// превращается в «C:UsersarielAppData…». Так уже трижды за день.
const ROOT = 'C:/Users/ariel/AppData/Local/Rujarvis';
const DATA = path.join(ROOT, 'data');
const started = Date.now();
const at = (): string => `${((Date.now() - started) / 1000).toFixed(0)}с`;

const TASK = process.argv.slice(2).join(' ') ||
  'Сделай одностраничный набросок моего портфолио в духе Бруно Симон: ' +
  'тёмный фон, имя по центру, одна крупная фигура. Положи в папку результатов, ' +
  'открой в браузере и проверь приборами, что страница не пустая.';

async function main(): Promise<void> {
  const plans = new PlanStore(path.join(DATA, 'план-проверки.json'));
  plans.clear();

  const jarvis = createJarvis({
    workspace: path.join(ROOT, 'src'),
    outputDir: 'C:/Users/ariel/Desktop/Джарвис',
    homeDir: ROOT,
    desktopMcpConfig: process.env.JARVIS_MCP_CONFIG,
    speak: (text: string) => console.log(`[${at()}] ГОЛОС: ${text}`),
  });
  await jarvis.ready();

  let finished = false;
  jarvis.tasks.subscribe((event: any) => {
    if (event.type === 'task-event') {
      const line = describeEvent(event.event, Date.now());
      if (line) console.log(`[${at()}] ${line.text}${line.detail ? ` — ${line.detail}` : ''}`);
      return;
    }
    if (event.type === 'task-finished') {
      finished = true;
      const result = event.task.result;
      console.log('');
      console.log(`[${at()}] КОНЕЦ: ok=${result?.ok}`);
      console.log((result?.text ?? '').slice(0, 1200));
    }
  });

  console.log(`[${at()}] говорю: ${TASK}`);
  const turn = await jarvis.core.handleUtterance(TASK);
  console.log(`[${at()}] ход: ${turn.kind}` +
    (turn.kind === 'task' ? ` → ${turn.decision.target} (${turn.decision.needs.join(', ')})` : ''));

  const until = Date.now() + 15 * 60_000;
  while (!finished && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log('');
  console.log('=== ПЛАН, КОТОРЫЙ ОН СОСТАВИЛ ===');
  console.log(renderPlan(new PlanStore(path.join(DATA, 'plan.json')).read()));
  process.exit(finished ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('сорвалось:', error instanceof Error ? error.message : error);
  process.exit(1);
});
