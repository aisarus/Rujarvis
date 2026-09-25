/**
 * Прогон настоящей задачи мимо голоса.
 *
 * Отвечает на вопрос, на который лог не отвечает: что происходит после
 * «Работаю». Печатает каждое событие задачи с отметкой времени, включая выбор
 * backend и причину отказа.
 */

import { createJarvis } from '../jarvis/createJarvis';
import { jarvisOutputDir } from '../jarvis/setup/paths';

const utterance = process.argv.slice(2).join(' ') || 'Создай в блендере красную сферу';
const started = Date.now();
const at = (): string => `${((Date.now() - started) / 1000).toFixed(1)}с`;

async function main(): Promise<void> {
  const jarvis = createJarvis({
    workspace: process.cwd(),
    outputDir: jarvisOutputDir(),
    desktopMcpConfig: process.env.JARVIS_MCP_CONFIG,
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

  let моя: string | undefined;
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
    // Чужую задачу за свою не принимаем.
    if (моя && event.task.id !== моя) return;
    const result = event.task.result;
    console.log(`[${at()}] backend: ${result?.backend}`);
    console.log(`[${at()}] ok=${result?.ok} ошибка=${result?.error ?? 'нет'}`);
    console.log(`[${at()}] ответ: ${(result?.text ?? '').slice(0, 400)}`);
    // Конец работы — не то же самое, что её успех. Код возврата смотрел
    // только на то, что задача закончилась: упавшая работа давала ноль, и
    // скрипт, запущенный из другого скрипта, считал её сделанной.
    process.exit(result?.ok === true ? 0 : 1);
  });

  console.log(`[${at()}] отправляю: «${utterance}»`);
  const turn = await jarvis.core.handleUtterance(utterance);
  console.log(`[${at()}] ход: ${turn.kind}`);
  if (turn.kind === 'task') {
    моя = turn.task.id;
    console.log(`[${at()}] план: ${turn.task.title}`);
  } else {
    // Переспрос и отказ — отдельный исход, а не успех. И ждать четыре минуты
    // «завершения», которого не будет, незачем.
    if (turn.kind === 'clarify' || turn.kind === 'refused') {
      console.log(`[${at()}] сказал: ${turn.spoken}`);
    } else {
      console.log(`[${at()}] задачи не вышло: ход ${turn.kind}`);
    }
    process.exit(2);
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
