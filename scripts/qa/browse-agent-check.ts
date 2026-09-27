/**
 * Браузер по делу, агент целиком: «найди и сложи в таблицу».
 *
 * Вторая часть проверки пункта «Браузер по делу». `browse-check` гоняет в CI
 * цепочку инструментов без агента; здесь — сам агент тем же путём, что в
 * приложении: `handleUtterance`, MCP-сервер рабочего стола, хук красных линий.
 * Страница-магазин та же (`shopPage.ts`).
 *
 * Прошло — если задача удалась, агент работал инструментами браузера
 * Джарвиса и не брал страницу мимо них (оболочкой по её адресу), а в папке
 * результатов лежит CSV ровно с тремя ноутбуками и их ценами и без лишних
 * товаров.
 *
 * Нужна подписка Claude Code, и открывается окно браузера — поэтому только у
 * владельца и только когда он не за машиной (правило 5 в autopilot.md).
 * Данные, память, результаты и профиль браузера — во временных папках:
 * ни его память, ни его браузер, ни его работающий Джарвис не задеваются.
 * Вопросы хука отклоняются и попадают в отчёт.
 *
 * Три ответа: прошло, не прошло, нечем мерить (нет входа или сборки).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJarvis } from '../../jarvis/createJarvis';
import { writeDesktopMcpConfig } from '../../jarvis/desktop/mcpConfig';
import { GateBridge } from '../../jarvis/risk/gateBridge';
import { prepareGate } from '../../jarvis/risk/gateSetup';
import { jarvisPaths } from '../../jarvis/setup/paths';
import { ЛИШНЕЕ, НОУТБУКИ, поднятьМагазин } from './shopPage';

type Итог = { вид: 'прошло' | 'не прошло' | 'нечем мерить'; что: string };

/** Все CSV в папке результатов: агент раскладывает их по разделам. */
function таблицы(корень: string): string[] {
  const найдено: string[] = [];
  const обойти = (папка: string): void => {
    for (const имя of readdirSync(папка)) {
      const путь = path.join(папка, имя);
      if (statSync(путь).isDirectory()) обойти(путь);
      else if (/\.csv$/iu.test(имя)) найдено.push(путь);
    }
  };
  обойти(корень);
  return найдено;
}

/** Цена в строке таблицы — как бы агент её ни записал: 54990, 54 990, 54990.00. */
function естьЦена(строка: string, цена: number): boolean {
  return строка.replace(/[\s ]/gu, '').includes(String(цена));
}

/**
 * Штатно закрыть окна, открывшие файлы из папки проверки (только Windows).
 *
 * Своё — это процесс, в чьей командной строке наша временная папка и который
 * запущен после начала проверки. Закрывается окно (как крестиком), не
 * убийством: несохранённого там быть не должно, а если есть — программа
 * спросит, и это видно.
 */
function закрытьОткрытоеИз(папка: string, после: Date): void {
  const скрипт = [
    `$dir = '${папка.replace(/'/gu, "''")}'`,
    `$since = [datetime]::Parse('${после.toISOString()}').ToLocalTime()`,
    'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) -and $_.CreationDate -gt $since } |',
    '  ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow(); "закрыл окно: $($p.ProcessName) $($p.Id)" } }',
  ].join('\n');
  const ответ = spawnSync('powershell', ['-NoProfile', '-Command', скрипт], { encoding: 'utf8', timeout: 30_000 });
  for (const строка of (ответ.stdout ?? '').split(/\r?\n/u).filter(Boolean)) console.log(`    ${строка}`);
}

async function main(): Promise<void> {
  const началоПроверки = new Date();
  console.log('');
  console.log('Браузер по делу: агент ищет на странице и складывает в таблицу');

  const времянки: string[] = [];
  const новая = (имя: string): string => {
    const путь = mkdtempSync(path.join(os.tmpdir(), `jarvis-browse-agent-${имя}-`));
    времянки.push(путь);
    return путь;
  };
  const данные = новая('data');
  const результаты = новая('out');
  const домБраузера = новая('home');
  const paths = jarvisPaths();

  const mcp = writeDesktopMcpConfig({
    appRoot: process.cwd(),
    dataDir: данные,
    outputDir: результаты,
    language: 'ru',
    // Браузер агента — во временном профиле: профиль человека может держать
    // его работающий Джарвис, и трогать его ради проверки незачем.
    extraEnv: { JARVIS_HOME: домБраузера },
  });
  if (!mcp.ok) {
    console.log(`НЕЧЕМ МЕРИТЬ: ${'missing' in mcp ? `не найден ${mcp.missing} — сначала pnpm build` : String(mcp.error)}`);
    process.exit(2);
  }
  const gate = prepareGate({ appRoot: process.cwd(), dataDir: данные, outputDir: результаты, homeDir: paths.home, language: 'ru' });
  if (!gate.ok) {
    console.log(`НЕЧЕМ МЕРИТЬ: хук красных линий не собрался: ${gate.reason}`);
    process.exit(2);
  }
  const вопросы: string[] = [];
  const гасиМост = new GateBridge(gate.bridgeDir).serve((вопрос) => {
    вопросы.push(вопрос.summary);
    return false;
  });

  const магазин = await поднятьМагазин();
  const jarvis = createJarvis({
    workspace: результаты,
    memoryFile: path.join(данные, 'memory.json'),
    desktopMcpConfig: mcp.file,
    gateSettings: gate.settings,
    gateConfig: gate.config,
    homeDir: paths.home,
    outputDir: результаты,
    speak: () => undefined,
  });

  let итог: Итог;
  try {
    await jarvis.ready();
    const готов = (await jarvis.backends.availability(true)).find((b) => b.id === 'claude-code')?.ready;
    if (!готов) {
      итог = { вид: 'нечем мерить', что: 'Claude Code не готов: нет входа или не установлен' };
    } else {
      const turn = await jarvis.core.handleUtterance(
        `Открой в браузере страницу ${магазин.адрес}, найди там через поиск все ноутбуки ` +
          'и сложи их с ценами в таблицу CSV в папке результатов. Сделай это через Claude Code.',
      );
      if (turn.kind !== 'task') {
        итог = { вид: 'не прошло', что: `фраза не стала задачей, а стала «${turn.kind}»` };
      } else {
        const task = turn.task;
        const закончилась = await new Promise<boolean>((resolve) => {
          if (task.state !== 'running' && task.state !== 'queued') return resolve(true);
          const таймер = setTimeout(() => {
            стоп();
            jarvis.tasks.cancel(task.id);
            resolve(false);
          }, 300_000);
          const стоп = jarvis.tasks.subscribe((событие) => {
            if (событие.type === 'task-finished' && событие.task.id === task.id) {
              clearTimeout(таймер);
              стоп();
              resolve(true);
            }
          });
        });
        const инструменты = [...new Set(task.events.flatMap((с) => (с.type === 'tool' ? [с.name] : [])))];
        // Оболочка сама по себе не провал: второй прогон 27.09.2026 писал ею
        // файл таблицы, а страницу читал браузером. Провал — если страницу
        // брали мимо браузера: команда обращается к её адресу.
        const порт = new URL(магазин.адрес).port;
        const вОбходБраузера = task.events.flatMap((с) =>
          (с.type === 'tool' && /^(Bash|PowerShell)$/u.test(с.name) && (с.detail ?? '').includes(порт)) ||
          (с.type === 'command' && с.command.includes(порт))
            ? [с.type === 'tool' ? (с.detail ?? '') : с.command]
            : [],
        );
        console.log(`    инструменты: ${инструменты.join(', ') || 'нет'}`);
        const csv = таблицы(результаты);
        const текст = csv.map((ф) => readFileSync(ф, 'utf8')).join('\n');
        const строки = текст.split(/\r?\n/u);
        const нетТовара = НОУТБУКИ.filter(([имя, цена]) => !строки.some((с) => с.includes(имя) && естьЦена(с, цена)));
        const лишнее = ЛИШНЕЕ.filter(([имя]) => текст.includes(имя));
        итог = !закончилась
          ? { вид: 'не прошло', что: 'задача не кончилась за 5 минут' }
          : task.result?.ok !== true
            ? { вид: 'не прошло', что: `задача не удалась: ${task.result?.error ?? task.result?.text?.slice(0, 200) ?? ''}` }
            : !инструменты.some((и) => /browser_/u.test(и))
              ? { вид: 'не прошло', что: 'агент не звал инструментов браузера Джарвиса' }
              : вОбходБраузера.length > 0
                ? { вид: 'не прошло', что: `страницу брали мимо браузера: ${вОбходБраузера[0]?.slice(0, 120)}` }
                : csv.length === 0
                  ? { вид: 'не прошло', что: 'в папке результатов нет CSV' }
                  : нетТовара.length > 0 || лишнее.length > 0
                    ? {
                        вид: 'не прошло',
                        что: `в таблице нет: ${нетТовара.map(([и]) => и).join(', ') || '—'}; лишнее: ${лишнее.map(([и]) => и).join(', ') || '—'}`,
                      }
                    : {
                        вид: 'прошло',
                        что: `${path.relative(результаты, csv[0] ?? '')}: три ноутбука с ценами, ничего лишнего${вопросы.length ? `; хук спрашивал: ${вопросы.join(' | ')}` : ''}`,
                      };
      }
    }
  } catch (беда) {
    итог = { вид: 'не прошло', что: беда instanceof Error ? беда.message : String(беда) };
  } finally {
    гасиМост();
    jarvis.dispose();
    магазин.закрыть();
  }

  // Итог — раньше уборки: первый прогон 27.09.2026 упал на ней и итог потерял.
  const метка = итог.вид === 'прошло' ? 'прошло      ' : итог.вид === 'не прошло' ? 'НЕ ПРОШЛО   ' : 'нечем мерить';
  console.log(`  ${метка} найти и сложить в таблицу — ${итог.что}`);
  console.log(`Всего 1: ${итог.вид}`);

  // Джарвис показывает готовый файл человеку — открывает его. В первом прогоне
  // таблицу открыл Excel и держал папку. Закрываем штатно (окно, а не
  // убийство) только то, что смотрит в НАШУ временную папку и запущено после
  // начала проверки: чужие окна человека не наши.
  if (process.platform === 'win32') закрытьОткрытоеИз(результаты, началоПроверки);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  for (const путь of времянки) {
    try {
      rmSync(путь, { recursive: true, force: true, maxRetries: 3 });
    } catch (беда) {
      console.log(`    не убрал ${путь}: ${беда instanceof Error ? беда.message : String(беда)}`);
    }
  }
  process.exit(итог.вид === 'прошло' ? 0 : итог.вид === 'не прошло' ? 1 : 2);
}

void main();
