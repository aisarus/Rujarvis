/**
 * Одна команда — план — работа. Проверка всего слоя разом.
 *
 * Всё было построено по частям и по частям проверено: план, ящик правок,
 * приборы, окно. Ни разу не проверено главное — что оно работает вместе.
 * Здесь Джарвису даётся одна фраза, и видно каждый его шаг: составил ли план,
 * отмечал ли шаги, звал ли приборы, чем кончил.
 */


import path from 'node:path';

import { createJarvis } from '../jarvis/createJarvis';
import { describeEvent } from '../jarvis/observe/storyline';
import { renderPlan } from '../jarvis/agent/plan';
import { PlanStore } from '../jarvis/agent/planStore';
import { jarvisDataRoot, jarvisInstallRoot, jarvisOutputDir } from '../jarvis/setup/paths';

const ROOT = jarvisInstallRoot();
const DATA = jarvisDataRoot();
const started = Date.now();
const at = (): string => `${((Date.now() - started) / 1000).toFixed(0)}с`;

const TASK = process.argv.slice(2).join(' ') ||
  'Сделай одностраничный набросок моего портфолио в духе Бруно Симон: ' +
  'тёмный фон, имя по центру, одна крупная фигура. Положи в папку результатов, ' +
  'открой в браузере и проверь приборами, что страница не пустая.';

// Тот же файл, в который пишет агент, — иначе проба показывает чужой план.
//
// Чистился `план-проверки.json`, а читался `plan.json`: в разделе «ПЛАН,
// КОТОРЫЙ ОН СОСТАВИЛ» мог оказаться план прошлого прогона или живой работы
// Джарвиса, выданный за результат этого. Путь берём тот же, что у сервера
// инструментов (`jarvis/desktop/mcpServer.ts`).
const ФАЙЛ_ПЛАНА = process.env.JARVIS_PLAN?.trim() || path.join(DATA, 'plan.json');

async function main(): Promise<void> {
  const plans = new PlanStore(ФАЙЛ_ПЛАНА);
  plans.clear();

  const jarvis = createJarvis({
    workspace: path.join(ROOT, 'src'),
    outputDir: jarvisOutputDir(),
    homeDir: ROOT,
    desktopMcpConfig: process.env.JARVIS_MCP_CONFIG,
    speak: (text: string) => console.log(`[${at()}] ГОЛОС: ${text}`),
  });
  await jarvis.ready();

  let finished = false;
  let вышло: boolean | undefined;
  // Чей это конец — важно: любая чужая задача ставила `finished`, и проба
  // отчитывалась об успехе чужой работы.
  let моя: string | undefined;
  jarvis.tasks.subscribe((event: any) => {
    if (моя && event.task?.id !== моя) return;
    if (event.type === 'task-event') {
      const line = describeEvent(event.event, Date.now());
      if (line) console.log(`[${at()}] ${line.text}${line.detail ? ` — ${line.detail}` : ''}`);
      return;
    }
    if (event.type === 'task-finished') {
      finished = true;
      const result = event.task.result;
      вышло = result?.ok === true;
      console.log('');
      console.log(`[${at()}] КОНЕЦ: ok=${result?.ok}`);
      console.log((result?.text ?? '').slice(0, 1200));
    }
  });

  console.log(`[${at()}] говорю: ${TASK}`);
  const turn = await jarvis.core.handleUtterance(TASK);
  if (turn.kind === 'task') моя = turn.task.id;
  console.log(`[${at()}] ход: ${turn.kind}` +
    (turn.kind === 'task' ? ` → ${turn.decision.target} (${turn.decision.needs.join(', ')})` : ''));

  const until = Date.now() + 15 * 60_000;
  while (!finished && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log('');
  console.log('=== ПЛАН, КОТОРЫЙ ОН СОСТАВИЛ ===');
  console.log(renderPlan(new PlanStore(ФАЙЛ_ПЛАНА).read()));
  // Конец работы — ещё не успех: код возврата смотрит на её итог.
  if (!finished) console.log('НЕ ДОЖДАЛИСЬ: задача не закончилась за отведённое время.');
  else if (!вышло) console.log('ЗАДАЧА ПРОВАЛИЛАСЬ: ok=false.');
  process.exit(finished && вышло ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('сорвалось:', error instanceof Error ? error.message : error);
  process.exit(1);
});
