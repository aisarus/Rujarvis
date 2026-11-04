/**
 * «Упорядочить хранилище» настоящим Электроном, скрытым — на КОПИИ хранилища:
 *
 *   pnpm jarvis:tidy-check -- --vault="путь" --live="Курс/имя заметки;…" --out=папка
 *
 * Настоящее хранилище только читается. Заметки копируются, звук заменяется заглушкой.
 * Обрабатывать вживую — только заметки из `--live` (по подстроке пути): остальные в
 * копии заранее помечены обработанными, чтобы не тратить лимит. Без `--live` модели нет.
 * Открытый Obsidian здесь изображается: настоящий владельца не закрыть, а проверить
 * надо и ожидание, и запись после закрытия. Настоящий ответ системы только печатается.
 *
 * Проверяется то, чего не видно из тестов:
 * - кнопка в настоящем окне при его защите (CSP) и мост до службы;
 * - Obsidian открыт — файл настроек не тронут, успеха нет; закрыли — записано само;
 * - вне строк с формулами заметки побайтно те же, чужие файлы не изменились;
 * - второе нажатие без единого вызова модели;
 * - отмена возвращает всё дерево к исходному.
 *
 * Отвечает: прошло / не прошло / нечем мерить (нет хранилища Obsidian).
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import { openStudyWindow, studyWindowForCheck } from '../../app/studyWindow';
import { listCourses, listLectures, withFormulasMark, COURSE_WORDS } from '../../jarvis/lecture/courses';
import { agentEnv } from '../../jarvis/backends/subscriptionEnv';
import { createSummarizer, setBrain, brainFromArgs } from '../../jarvis/lecture/summarize';
import { FORMULA_MODEL_ENV } from '../../jarvis/lecture/tidy';
import { lectureFolder, obsidianState, type ObsidianState } from '../../jarvis/lecture/vault';
import { setLanguage } from '../../jarvis/locale/language';
import { jarvisOutputDir, jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';
import { StudyService } from '../../jarvis/study/service';
import { StudyStore } from '../../jarvis/study/store';

const ждать = (мс: number): Promise<void> => new Promise((r) => setTimeout(r, мс));
const ключ = (имя: string): string | undefined => process.argv.find((a) => a.startsWith(`--${имя}=`))?.slice(имя.length + 3);
const en = process.argv.includes('--en');

app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'jarvis-tidy-check-')));

function скопировать(от: string, куда: string): void {
  mkdirSync(куда, { recursive: true });
  for (const e of readdirSync(от, { withFileTypes: true })) {
    if (e.name === '.trash' || e.name === '.git') continue;
    const а = path.join(от, e.name);
    const б = path.join(куда, e.name);
    if (e.isDirectory()) скопировать(а, б);
    // Звук — заглушкой: хранилище весит гигабайты, а содержимое звука кнопке не нужно.
    else if (/\.wav$/iu.test(e.name)) writeFileSync(б, Buffer.alloc(44));
    else copyFileSync(а, б);
  }
}

function снимок(папка: string, база = папка, out: Map<string, string> = new Map()): Map<string, string> {
  for (const имя of readdirSync(папка)) {
    const полный = path.join(папка, имя);
    if (statSync(полный).isDirectory()) снимок(полный, база, out);
    else out.set(path.relative(база, полный), createHash('sha256').update(readFileSync(полный)).digest('hex'));
  }
  return out;
}

/** Разница двух снимков — списком путей. */
function разница(а: Map<string, string>, б: Map<string, string>): string[] {
  return [...new Set([...а.keys(), ...б.keys()])].filter((к) => а.get(к) !== б.get(к));
}

void app.whenReady().then(async () => {
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings).get();
  setLanguage(en ? 'en' : settings.language);
  setBrain(() => brainFromArgs(process.argv, settings.brain));
  const настоящее =
    ключ('vault') ??
    lectureFolder(settings.outputDir || jarvisOutputDir(process.env, app.getPath('desktop'), settings.language === 'en' ? 'Jarvis' : 'Джарвис'), settings.language).vault;
  if (!настоящее || !existsSync(path.join(настоящее, '.obsidian'))) {
    console.log('НЕЧЕМ МЕРИТЬ: хранилища Obsidian нет — --vault=путь');
    app.exit(2);
    return;
  }
  console.log(`  настоящий Obsidian сейчас: ${await obsidianState()}`);
  const корень = ключ('out') ?? mkdtempSync(path.join(os.tmpdir(), 'jarvis-tidy-copy-'));
  const копия = path.join(корень, 'vault');
  скопировать(настоящее, копия);
  const папкаЛекций = [COURSE_WORDS.ru.folder, COURSE_WORDS.en.folder].map((и) => path.join(копия, и)).find((п) => existsSync(п));
  if (!папкаЛекций) {
    console.log('НЕЧЕМ МЕРИТЬ: в хранилище нет папки лекций');
    app.exit(2);
    return;
  }
  const живые = (ключ('live') ?? '').split(';').map((с) => с.trim()).filter(Boolean);
  const дляМодели: string[] = [];
  for (const курс of [...listCourses(папкаЛекций), COURSE_WORDS.ru.unsorted, COURSE_WORDS.en.unsorted]) {
    for (const л of listLectures(папкаЛекций, курс)) {
      if (живые.some((с) => л.file.split(path.sep).join('/').includes(с))) дляМодели.push(path.relative(папкаЛекций, л.file));
      else writeFileSync(л.file, withFormulasMark(readFileSync(л.file, 'utf8')), 'utf8');
    }
  }
  console.log(`  копия: ${копия}; вживую заметок: ${дляМодели.length}`);
  for (const з of дляМодели) console.log(`    ${з}`);
  const графФайл = path.join(копия, '.obsidian', 'graph.json');
  const было = снимок(копия);
  const исходные = new Map(дляМодели.map((з) => [з, readFileSync(path.join(папкаЛекций, з), 'utf8')]));
  const графБыл = existsSync(графФайл) ? readFileSync(графФайл, 'utf8') : null;

  const открыт = { state: 'running' as ObsidianState };
  let вызовов = 0;
  const модель = createSummarizer({ env: { ...agentEnv(), ...FORMULA_MODEL_ENV }, log: (с) => console.log(`    модель: ${с}`) });
  const service = new StudyService({
    store: new StudyStore(path.join(корень, 'data', 'study')),
    vaultRoot: () => папкаЛекций,
    notes: en ? 'en' : settings.language,
    summarize: async (prompt) => {
      вызовов += 1;
      const начало = Date.now();
      const ответ = await модель(prompt);
      console.log(`    вызов модели ${вызовов}: ${Math.round((Date.now() - начало) / 1000)} с, промпт ${prompt.length} знаков`);
      return ответ;
    },
    obsidian: async () => открыт.state,
  });

  const ошибки: string[] = [];
  openStudyWindow({ service: () => service, preparing: () => [], prepare: () => undefined, language: () => (en ? 'en' : settings.language), hidden: true });
  const окно = studyWindowForCheck();
  if (!окно) {
    console.log('НЕ ПРОШЛО: окно не создалось');
    app.exit(1);
    return;
  }
  окно.webContents.on('console-message', (event) => {
    if (event.level === 'error') ошибки.push(event.message);
  });
  await new Promise<void>((r) => окно.webContents.once('did-finish-load', () => r()));
  const js = <T>(код: string): Promise<T> => окно.webContents.executeJavaScript(код) as Promise<T>;
  const текст = (): Promise<string> => js<string>("document.querySelector('main').innerText");
  const снимки = ключ('shots');
  const снять = async (имя: string): Promise<void> => {
    if (!снимки) return;
    mkdirSync(снимки, { recursive: true });
    writeFileSync(path.join(снимки, `${имя}${en ? '-en' : ''}.png`), (await окно.webContents.capturePage()).toPNG());
  };
  const кнопка = (подпись: string): string => `[...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(подпись)})`;
  const нажать = (подпись: string): Promise<void> => js<void>(`${кнопка(подпись)}?.click()`);
  const дождаться = async (условие: string, секунд = 30): Promise<boolean> => {
    for (let i = 0; i < секунд * 10; i += 1) {
      if (await js<boolean>(условие)) return true;
      await ждать(100);
    }
    return false;
  };
  const КНОПКА = en ? 'Tidy vault' : 'Упорядочить хранилище';
  const ДАЛЕЕ = en ? 'Tidy now' : 'Навести порядок';
  const ОТМЕНА = en ? 'Undo tidying' : 'Вернуть как было';
  const провалы: string[] = [];
  const проверить = (что: string, верно: boolean, подробно = ''): void => {
    console.log(`  ${верно ? 'ok ' : 'НЕТ'} ${что}${подробно ? ` — ${подробно}` : ''}`);
    if (!верно) провалы.push(что);
  };

  проверить('кнопка в окне', await дождаться(`Boolean(${кнопка(КНОПКА)})`));
  await js("document.querySelector('main').scrollTop = 1e6");
  await снять('tidy-1-кнопка');

  // План: сколько вызовов модели — до того, как они потрачены.
  await нажать(КНОПКА);
  проверить('план показан', await дождаться(`Boolean(${кнопка(ДАЛЕЕ)})`));
  console.log(`  план: ${(await текст()).split('\n').filter((с) => /Граф|Graph|Формулы|Formulas|Obsidian/u.test(с)).join(' | ')}`);
  await снять('tidy-2-план');

  // Obsidian «открыт»: формулы идут, файл настроек не тронут, успеха нет.
  await нажать(ДАЛЕЕ);
  проверить('ждёт, пока закроют Obsidian', await дождаться(`document.querySelector('main').innerText.includes(${JSON.stringify(en ? 'Waiting for you to close Obsidian' : 'Жду, пока вы закроете Obsidian')})`, 30));
  await снять('tidy-3-ждёт');
  // Формулы идут минутами: дальше — только когда работа кончилась.
  проверить('формулы обработаны', await дождаться(`!document.querySelector('main').innerText.includes(${JSON.stringify(en ? 'Tidying…' : 'Навожу порядок…')})`, 1500));
  проверить('пока Obsidian открыт, файл настроек не тронут', (existsSync(графФайл) ? readFileSync(графФайл, 'utf8') : null) === графБыл);
  проверить('пока Obsidian открыт, об успехе ни слова', !/настройки на диске|settings are on disk/u.test(await текст()));

  открыт.state = 'closed';
  проверить('закрыли — записано само', await дождаться(`document.querySelector('main').innerText.includes(${JSON.stringify(en ? 'settings are on disk' : 'настройки на диске')})`, 30));
  await снять('tidy-4-итог');
  console.log(`  итог: ${(await текст()).split('\n').filter((с) => /Граф|Graph|LaTeX|Строк не|Lines rej|Осталось|Остановился|Stopped/u.test(с)).join(' | ')}`);
  const граф = JSON.parse(readFileSync(графФайл, 'utf8')) as { colorGroups: Array<{ query: string }>; search: string; showOrphans: boolean; hideUnresolved: boolean };
  проверить('у каждого курса цвет', listCourses(папкаЛекций).every((к) => граф.colorGroups.some((г) => г.query.includes(к))), `групп ${граф.colorGroups.length}`);
  проверить('расшифровки на обоих языках скрыты', /расшифровка/u.test(граф.search) && /transcript/u.test(граф.search), граф.search);
  проверить('одиночные точки и несуществующие ссылки скрыты', граф.showOrphans === false && граф.hideUnresolved === true);

  // Что изменилось на диске: только настройки графа и заметки из --live.
  const после = снимок(копия);
  const изменились = разница(было, после);
  const ожидаемые = new Set([path.relative(копия, графФайл), ...дляМодели.map((з) => path.relative(копия, path.join(папкаЛекций, з)))]);
  проверить('изменились только настройки графа и эти заметки', изменились.every((ф) => ожидаемые.has(ф)), изменились.filter((ф) => !ожидаемые.has(ф)).join(', '));
  // Построчно: другие строки — только те, что теперь с формулами, и их текст вне формул — исходный.
  for (const з of дляМодели) {
    const файл = path.join(папкаЛекций, з);
    const до = (исходные.get(з) ?? '').split('\n');
    const сейчас = readFileSync(файл, 'utf8').split('\n');
    const безМетки = сейчас.filter((с) => !/^(формулы|formulas): LaTeX\r?$/u.test(с));
    const разные = безМетки.map((с, i) => ({ с, был: до[i] ?? '' })).filter(({ с, был }) => с !== был);
    const чисто = безМетки.length === до.length && разные.every(({ с, был }) => с.includes('$') && !был.includes('$'));
    проверить(`${з}: меняются только строки с формулами`, чисто, `строк ${разные.length} из ${до.length}`);
    for (const { с, был } of разные.slice(0, 4)) console.log(`      было:  ${был.slice(0, 150)}\n      стало: ${с.slice(0, 170)}`);
  }

  // Второе нажатие — без модели.
  const вызововБыло = вызовов;
  await нажать(КНОПКА);
  проверить('второе нажатие: всё уже в порядке', await дождаться(`document.querySelector('main').innerText.includes(${JSON.stringify(en ? 'already tidy' : 'Всё уже в порядке')})`, 20));
  проверить('второе нажатие без вызовов модели', вызовов === вызововБыло, `вызовов всего ${вызовов}`);
  проверить('второе нажатие ничего не изменило на диске', разница(после, снимок(копия)).length === 0);
  await снять('tidy-5-второе');

  // Отмена: всё дерево — как до первого нажатия.
  await нажать(ОТМЕНА);
  await дождаться(`Boolean(${кнопка(ОТМЕНА)}) && ${кнопка(ОТМЕНА)}.classList.contains('primary')`, 5);
  await нажать(ОТМЕНА);
  проверить('отмена отработала', await дождаться(`document.querySelector('main').innerText.includes(${JSON.stringify(en ? 'as they were before the first press' : 'как до первого нажатия')})`, 20));
  await снять('tidy-6-отмена');
  const остаток = разница(было, снимок(копия));
  проверить('после отмены всё дерево как было', остаток.length === 0, остаток.join(', '));

  if (ошибки.length > 0) провалы.push(`ошибки страницы: ${ошибки.join('; ').slice(0, 300)}`);
  console.log(провалы.length === 0 ? 'ПРОШЛО' : `НЕ ПРОШЛО: ${провалы.join('; ')}`);
  app.exit(провалы.length === 0 ? 0 : 1);
});
