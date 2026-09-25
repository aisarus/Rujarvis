/**
 * Помнит ли Джарвис предыдущий ход разговора.
 *
 * Два обращения подряд через настоящего агента: в первом называется число, во
 * втором спрашивается, какое. Если второй ход не продолжает сессию, агент не
 * знает ответа — и никакой «непрерывный диалог» не работает, сколько бы кода
 * под него ни написали.
 */

import { createJarvis } from '../jarvis/createJarvis';
import { jarvisOutputDir } from '../jarvis/setup/paths';

const started = Date.now();
const at = (): string => `${((Date.now() - started) / 1000).toFixed(1)}с`;

async function main(): Promise<void> {
  const jarvis = createJarvis({
    workspace: process.cwd(),
    outputDir: jarvisOutputDir(),
    speak: () => {},
  });
  await jarvis.ready();

  const answers: string[] = [];
  const сессии: Array<string | undefined> = [];
  jarvis.tasks.subscribe((event) => {
    if (event.type !== 'task-finished') return;
    const result = event.task.result;
    answers.push(result?.text ?? '');
    сессии.push(result?.sessionId);
    console.log(`[${at()}] ход ${answers.length}: сессия=${result?.sessionId ?? 'нет'}`);
    console.log(`[${at()}] ответ: ${(result?.text ?? '').slice(0, 120)}`);
  });

  const waitFor = (count: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (answers.length >= count) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
      setTimeout(() => {
        clearInterval(timer);
        reject(new Error('не дождался'));
      }, 180_000);
    });

  // Число НЕ пишем на диск.
  //
  // Первый ход просил записать 7431 в файл в рабочей папке — и второй ход мог
  // просто найти этот файл. Проверка печатала «РАЗГОВОР НЕПРЕРЫВЕН» при
  // сломанном `--resume`, а каждый прогон оставлял мусор в репозитории.
  console.log(`[${at()}] ход 1: называю число`);
  const first = await jarvis.core.handleUtterance(
    'Запомни число 7431. Ничего никуда не записывай, ответь одним словом «запомнил».',
  );
  console.log(`[${at()}] ход: ${first.kind}` +
    (first.kind === 'task' ? ` → ${first.decision.target} (${first.decision.needs.join(', ')})` : ''));
  await waitFor(1);

  console.log(`[${at()}] ход 2: спрашиваю про него`);
  await jarvis.core.handleUtterance('Какое число я просил запомнить?');
  await waitFor(2);

  const remembered = (answers[1] ?? '').includes('7431');
  // Та же сессия — второе доказательство, независимое от ответа модели.
  const одна_сессия = Boolean(сессии[0]) && сессии[0] === сессии[1];
  console.log('');
  console.log(`сессии: ${сессии[0] ?? 'нет'} → ${сессии[1] ?? 'нет'}`);
  if (!одна_сессия) console.log('СЕССИЯ НЕ ПРОДОЛЖЕНА: второй ход пошёл в новую.');
  console.log(remembered ? 'РАЗГОВОР НЕПРЕРЫВЕН' : 'ВТОРОЙ ХОД НЕ ПОМНИТ ПЕРВОГО');
  process.exit(remembered && одна_сессия ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('сорвалось:', error instanceof Error ? error.message : error);
  process.exit(1);
});
