/**
 * Прогон настоящей задачи мимо голоса.
 *
 * Отвечает на вопрос, на который лог не отвечает: что происходит после
 * «Работаю». Печатает каждое событие задачи с отметкой времени, включая выбор
 * backend и причину отказа.
 */

import { createJarvis } from '../server/jarvis/createJarvis';

const utterance = process.argv.slice(2).join(' ') || 'Создай в блендере красную сферу';
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

  const availability = await jarvis.backends.availability(true);
  console.log(`[${at()}] доступность backend:`);
  for (const item of availability) {
    console.log(
      `   ${item.id}: установлен=${item.installed} вход=${item.authenticated} готов=${item.ready}` +
        (item.reason ? ` — ${item.reason}` : ''),
    );
  }

  jarvis.tasks.subscribe((event) => {
    if (event.type === 'task-event') {
      const step = event.event;
      if (step.type === 'tool') console.log(`[${at()}] инструмент: ${step.name}`);
      else if (step.type === 'command') console.log(`[${at()}] команда: ${step.command.slice(0, 90)}`);
      else if (step.type === 'started') console.log(`[${at()}] backend начал работу`);
      else if (step.type === 'error') console.log(`[${at()}] ошибка: ${step.message.slice(0, 120)}`);
      return;
    }
    if (event.type !== 'task-finished') return;
    if (event.type === 'task-finished') {
      const result = event.task.result;
      console.log(`[${at()}] backend: ${result?.backend}`);
      console.log(`[${at()}] ok=${result?.ok} ошибка=${result?.error ?? 'нет'}`);
      console.log(`[${at()}] ответ: ${(result?.text ?? '').slice(0, 400)}`);
      process.exit(0);
    }
  });

  console.log(`[${at()}] отправляю: «${utterance}»`);
  const turn = await jarvis.core.handleUtterance(utterance);
  console.log(`[${at()}] ход: ${turn.kind}`);
  if (turn.kind === 'task') {
    console.log(`[${at()}] план: ${turn.task.title}`);
  } else if (turn.kind === 'clarify' || turn.kind === 'refused') {
    console.log(`[${at()}] сказал: ${turn.spoken}`);
    process.exit(0);
  }

  setTimeout(() => {
    console.log(`[${at()}] за отведённое время ничего не завершилось`);
    process.exit(1);
  }, 240_000);
}

main().catch((error: unknown) => {
  console.error('сорвалось:', error);
  process.exit(1);
});
