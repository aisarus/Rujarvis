/**
 * «Упорядочить хранилище»: граф Obsidian и старые формулы. Файлы никуда не
 * переезжают и не переименовываются.
 *
 * Граф — настройка в `.obsidian/graph.json`, и писать её можно только при закрытом
 * Obsidian. Замер на настоящем приложении 04.11.2026: открытый вид графа держит
 * настройки в памяти и при первом сохранении (хватает зума) затирает файл своими,
 * неизвестные ключи тоже пропадают; при закрытом виде работающий Obsidian файл
 * подхватывает, но снаружи разницы не видно. Поэтому кнопка не закрывает Obsidian и
 * не обещает успеха: просит закрыть, ждёт и пишет сама, а успех называет, только
 * когда настройки перечитаны с диска. Заметки Obsidian подхватывает и открытый,
 * даже если человек в этот миг печатает: сохраняется и то и другое (тот же замер).
 *
 * Формулы — единственное, что кнопка меняет в заметках (`formulaLines.ts`).
 * Заметка, где всё доказано и на всё отвечено, получает пометку, и нажимать снова
 * незачем. Строки, которые не прошли проверку, остаются текстом, а заметка без
 * пометки: следующее нажатие спросит только их, и план назовёт цену заранее.
 *
 * Отмена не упирается в первую беду и не закрывается раньше времени: по заметке
 * помнит, какие строки поменяла, поэтому правки человека, недельная уборка звука и
 * перенос лекции ей не мешают, а занятый файл остаётся на следующее нажатие.
 *
 * Ничего не удаляется: файл, который отмена убирает с дороги, уходит в копии.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { tr } from '../locale/language';
import { mergeGraphSettings, type GraphSettings } from '../notes/graphSettings';
import { COURSE_WORDS, listCourses, listLectures, parseFrontmatter, withFormulasMark, withoutFormulasMark } from './courses';
import { convertNoteFormulas, formulaCalls, formulaCandidates, FormulaStopped, type FormulaChange } from './formulaLines';
import { vaultOfFolder, type ObsidianState } from './vault';

/**
 * Окружение для вызовов модели: без размышлений. Замена записи формул — механика, а
 * размышления съедают лимит: на заметке по математике (59 строк, 04.11.2026) с ними
 * 170 с и 18 562 токена ответа, без них 51 с и 4 937 токенов при том же итоге.
 * Ошибок модели это не прибавляет безнаказанно: всё, что она написала, доказывается
 * равным исходной строке в `formulaLines.ts`, недоказанное остаётся текстом.
 */
export const FORMULA_MODEL_ENV = { MAX_THINKING_TOKENS: '0' } as const;

/** Модель подряд не отвечает — лимит или нет сети: дальше тратить время незачем. */
const ОТКАЗОВ_ПОДРЯД = 2;
/** Obsidian закрывается не мгновенно: «закрыт» считается со второй проверки подряд. */
const ПРОВЕРОК_ЗАКРЫТ = 2;
/** Имя своего временного файла: оборвалось посреди записи — следующее нажатие уберёт. */
const ВРЕМЕННЫЙ = '.jarvis-tidy.tmp';

export interface TidyDeps {
  /** Папка «Лекции». */
  root: string;
  /** Папка копий — внутри папки данных Джарвиса. */
  dir: string;
  summarize?: (prompt: string) => Promise<string>;
  /** Почему сейчас нельзя: идёт или дописывается лекция. Можно — null. */
  busy?: () => string | null;
  obsidian: () => Promise<ObsidianState>;
  now?: () => number;
  pollMs?: number;
}

export type GraphOutcome =
  | { state: 'applied'; newGroups: number; courses: number }
  | { state: 'unchanged' }
  | { state: 'waiting' }
  | { state: 'no-vault' }
  | { state: 'unknown' }
  | { state: 'cancelled' }
  | { state: 'failed'; reason: string };

export interface TidyReport {
  graph: GraphOutcome;
  /** Заметок и строк с формулами в LaTeX. */
  notes: number;
  lines: number;
  /** Заметок, где модель формул не нашла и всё проверено: помечены, больше не спрашиваем. */
  noFormulas: number;
  /** Строк, равенство которых проверка не смогла доказать: остались как были. */
  rejected: number;
  /** Строк, на которые модель не ответила. */
  missing: number;
  failed: string[];
  skipped: string[];
  /** Файл со строками, которые остались текстом, и ответами модели на них. */
  rejectedFile?: string;
  /** Почему остановились на полпути. */
  stopped?: string;
}

export interface TidyPlan {
  busy: string | null;
  lines: string[];
  nothing: boolean;
}

export interface TidyState {
  running: boolean;
  progress: string;
  /** Ждём, пока закроют Obsidian: чтобы настроить граф или вернуть прежний. */
  waiting: 'apply' | 'undo' | null;
  canUndo: boolean;
  /** Копии уже есть: их можно открыть. */
  hasBackups: boolean;
  lines: string[];
}

interface Шаг {
  file: string;
  backup: string;
  after: string;
  /** Что поменялось: по этому отмена работает и в заметке, которую потом правили. */
  changes: FormulaChange[];
  /** Отмена с этой заметкой уже разобралась. */
  done?: boolean;
}

interface Журнал {
  version: 1;
  at: number;
  steps: Шаг[];
}

interface КопияГрафа {
  vault: string;
  /** Что лежало в файле до первого нажатия; null — файла не было. */
  raw: string | null;
  /** Отпечаток того, что записала кнопка: не совпал — настройки потом меняли. */
  after?: string;
  at: number;
}

function отпечаток(данные: string | Buffer): string {
  return createHash('sha256').update(данные).digest('hex');
}

function разобрать(текст: string): GraphSettings {
  const данные: unknown = JSON.parse(текст);
  if (!данные || typeof данные !== 'object' || Array.isArray(данные)) throw new Error('не объект');
  return данные as GraphSettings;
}

/** Записать через временный файл: оборванная запись не должна оставить пол-файла, а отказ — мусор рядом. */
function записать(файл: string, данные: string | Buffer): void {
  mkdirSync(path.dirname(файл), { recursive: true });
  const временный = `${файл}${ВРЕМЕННЫЙ}`;
  try {
    writeFileSync(временный, данные);
    renameSync(временный, файл);
  } catch (error) {
    rmSync(временный, { force: true });
    throw error;
  }
}

/** Папки с лекциями: курсы и «Без курса». */
function папкиЛекций(root: string): string[] {
  return [...listCourses(root), COURSE_WORDS.ru.unsorted, COURSE_WORDS.en.unsorted];
}

/** Все заметки лекций: и в курсах, и «Без курса». */
function заметкиЛекций(root: string): Array<{ course: string; file: string; formulas: boolean }> {
  return папкиЛекций(root).flatMap((курс) => listLectures(root, курс).map((л) => ({ course: курс, file: л.file, formulas: Boolean(л.meta.formulas) })));
}

/** Необработанные заметки, в которых есть что показать модели. */
function заметкиСФормулами(root: string): Array<{ course: string; file: string }> {
  return заметкиЛекций(root).filter((з) => !з.formulas && formulaCandidates(readFileSync(з.file, 'utf8')).length > 0);
}

function имяЗаметки(root: string, файл: string): string {
  return path.relative(root, файл).replace(/\.md$/u, '').split(path.sep).join('/');
}

/** Заметка, в которой есть хоть что-то от этого шага: иначе это другая лекция с тем же именем. */
function нашаЗаметка(файл: string, шаг: Шаг): boolean {
  try {
    const данные = readFileSync(файл);
    if (отпечаток(данные) === шаг.after) return true;
    const строки = данные.toString('utf8').split('\n').map((с) => с.replace(/\r$/u, ''));
    if (шаг.changes.length === 0) return Boolean(parseFrontmatter(строки.join('\n'))?.formulas);
    return шаг.changes.some((п) => строки.includes(п.after));
  } catch {
    return false;
  }
}

export class VaultTidier {
  private running = false;
  private progress = '';
  private waiting: 'apply' | 'undo' | null = null;
  private таймер: ReturnType<typeof setInterval> | null = null;
  private закрытПодряд = 0;
  private проверяю = false;
  private lines: string[] = [];
  private report: TidyReport | null = null;
  private непринятые: Array<{ имя: string; line: string; reply: string }> = [];

  constructor(private readonly o: TidyDeps) {}

  private get now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private get vault(): string | null {
    return vaultOfFolder(this.o.root);
  }

  private get файлГрафа(): string | null {
    const vault = this.vault;
    return vault ? path.join(vault, '.obsidian', 'graph.json') : null;
  }

  private get папкаЛекцийВХранилище(): string {
    return path.relative(this.vault ?? this.o.root, this.o.root).split(path.sep).join('/');
  }

  /** Копия графа лежит по хранилищу: одна на хранилище, первая и единственная. */
  private копияГрафа(): string {
    const id = createHash('sha256').update(path.resolve(this.vault ?? this.o.root)).digest('hex').slice(0, 12);
    return path.join(this.o.dir, 'graph', `${id}.json`);
  }

  private слитьГраф(): ReturnType<typeof mergeGraphSettings> {
    const файл = this.файлГрафа as string;
    const было = existsSync(файл) ? разобрать(readFileSync(файл, 'utf8')) : null;
    return mergeGraphSettings(было, this.папкаЛекцийВХранилище, listCourses(this.o.root));
  }

  /** Прошлый запуск оборвался посреди записи: его временный файл — наш, и в хранилище ему не место. */
  private убратьВременные(): void {
    const папки = [path.join(this.vault ?? this.o.root, '.obsidian'), ...папкиЛекций(this.o.root).map((к) => path.join(this.o.root, к))];
    for (const папка of папки) {
      if (!existsSync(папка)) continue;
      for (const имя of readdirSync(папка)) {
        if (имя.endsWith(ВРЕМЕННЫЙ)) rmSync(path.join(папка, имя), { force: true });
      }
    }
  }

  async plan(): Promise<TidyPlan> {
    const busy = this.o.busy?.() ?? null;
    if (!this.vault) {
      return { busy, nothing: true, lines: [tr('Здесь нет хранилища Obsidian: в папке лекций и выше нет папки .obsidian. Упорядочивать нечего.', 'There is no Obsidian vault here: no .obsidian folder in or above the lectures folder. Nothing to tidy.')] };
    }
    const lines: string[] = [];
    let граф = false;
    try {
      const слито = this.слитьГраф();
      граф = слито.changed;
      if (граф) {
        const открыт = await this.o.obsidian();
        lines.push(tr(`Граф: цвета курсов (новых — ${слито.newGroups}), расшифровки и одиночные точки скрыты, кучки плотнее.`, `Graph: course colours (${слито.newGroups} new), transcripts and lone dots hidden, tighter clusters.`));
        if (открыт === 'running') lines.push(tr('Obsidian сейчас открыт: настройки запишутся, когда вы его закроете.', 'Obsidian is open now: the settings are written once you close it.'));
        if (открыт === 'unknown') lines.push(tr('Не удалось проверить, открыт ли Obsidian: граф не трону, пока это не станет ясно.', 'Could not check whether Obsidian is open: the graph stays untouched until that is clear.'));
      }
    } catch (error) {
      lines.push(tr(`Граф: не разобрать настройки — ${this.причина(error)}. Файл не трогаю.`, `Graph: cannot read the settings — ${this.причина(error)}. The file stays as it is.`));
    }
    const заметки = заметкиСФормулами(this.o.root);
    if (заметки.length > 0) {
      const тексты = заметки.map((з) => readFileSync(з.file, 'utf8'));
      const строк = тексты.reduce((всего, т) => всего + formulaCandidates(т).length, 0);
      const вызовов = тексты.reduce((всего, т) => всего + formulaCalls(т), 0);
      lines.push(
        tr(
          `Формулы: заметок ${заметки.length}, строк ${строк} — вызовов модели по вашей подписке: ${вызовов}. Меняются только сами формулы, остальной текст модель не видит; копии сохраняются.`,
          `Formulas: ${заметки.length} notes, ${строк} lines — model calls on your subscription: ${вызовов}. Only the formulas change, the model never sees the rest of the text; originals are backed up.`,
        ),
      );
    }
    if (!граф && заметки.length === 0 && lines.length === 0) {
      return { busy, nothing: true, lines: [tr('Всё уже в порядке: граф настроен, старых формул не осталось.', 'Everything is already tidy: the graph is set up and no old formulas are left.')] };
    }
    return { busy, nothing: false, lines };
  }

  /** Навести порядок. Модель зовётся только для необработанных заметок с формулами. */
  async run(): Promise<TidyState> {
    if (this.running) throw new Error(tr('Порядок уже наводится.', 'Tidying is already running.'));
    const занято = this.o.busy?.();
    if (занято) throw new Error(занято);
    this.перестатьЖдать();
    this.running = true;
    const report: TidyReport = { graph: { state: 'unchanged' }, notes: 0, lines: 0, noFormulas: 0, rejected: 0, missing: 0, failed: [], skipped: [] };
    this.report = report;
    this.lines = [];
    this.непринятые = [];
    try {
      this.убратьВременные();
      if (this.vault) {
        report.graph = await this.шагГрафа();
        await this.шагФормул(report);
      } else {
        report.graph = { state: 'no-vault' };
      }
    } finally {
      this.записатьНепринятые(report);
      this.running = false;
      this.progress = '';
      this.lines = reportLines(report);
    }
    return this.state();
  }

  /** Какие строки остались текстом и что предлагала модель: файл в копиях, кнопка их открывает. */
  private записатьНепринятые(report: TidyReport): void {
    if (this.непринятые.length === 0) return;
    const файл = path.join(this.o.dir, 'rejected-lines.md');
    try {
      записать(файл, this.непринятые.map((н) => `### ${н.имя}\n- было: ${н.line}\n- модель: ${н.reply}\n`).join('\n'));
      report.rejectedFile = файл;
    } catch {
      // Список — подсказка человеку: без него счёт в отчёте всё равно есть.
    }
  }

  /** Вернуть всё как было: заметки сразу, граф — когда Obsidian закрыт. */
  async undo(): Promise<TidyState> {
    if (this.running) throw new Error(tr('Порядок ещё наводится.', 'Tidying is still running.'));
    const занято = this.o.busy?.();
    if (занято) throw new Error(занято);
    this.перестатьЖдать();
    this.report = null;
    this.running = true;
    const lines: string[] = [];
    try {
      this.убратьВременные();
      const { restored, messages } = this.вернутьЗаметки();
      if (restored > 0) lines.push(tr(`Заметки: вернул прежний текст в ${restored}.`, `Notes: restored the earlier text in ${restored}.`));
      lines.push(...messages);
      if (existsSync(this.копияГрафа())) {
        const открыт = await this.o.obsidian();
        if (открыт === 'closed') lines.push(this.вернутьГраф());
        else if (открыт === 'running') {
          this.ждать('undo');
          lines.push(this.строкаОжидания());
        } else lines.push(tr('Граф не тронут: не удалось проверить, открыт ли Obsidian. Закройте его и нажмите ещё раз.', 'The graph is untouched: could not check whether Obsidian is open. Close it and press again.'));
      }
      if (lines.length === 0) lines.push(tr('Возвращать нечего.', 'Nothing to undo.'));
      this.lines = lines;
    } finally {
      this.running = false;
    }
    return this.state();
  }

  /** Передумали ждать, пока закроют Obsidian. */
  cancelWait(): TidyState {
    if (this.waiting) {
      this.перестатьЖдать();
      if (this.report) {
        this.report.graph = { state: 'cancelled' };
        this.lines = reportLines(this.report);
      } else {
        this.lines = [tr('Граф не тронут.', 'The graph is untouched.')];
      }
    }
    return this.state();
  }

  state(): TidyState {
    return { running: this.running, progress: this.progress, waiting: this.waiting, canUndo: this.естьЧтоВернуть(), hasBackups: existsSync(this.o.dir), lines: this.lines };
  }

  /** Для окна: перестать проверять Obsidian, когда служба больше не нужна. */
  dispose(): void {
    this.перестатьЖдать();
  }

  private причина(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async шагГрафа(): Promise<GraphOutcome> {
    let слито;
    try {
      слито = this.слитьГраф();
    } catch (error) {
      return { state: 'failed', reason: tr(`не разобрать настройки графа (${this.причина(error)}), файл не трогаю`, `cannot read the graph settings (${this.причина(error)}), the file stays as it is`) };
    }
    if (!слито.changed) return { state: 'unchanged' };
    const открыт = await this.o.obsidian();
    if (открыт === 'unknown') return { state: 'unknown' };
    if (открыт === 'running') {
      this.ждать('apply');
      return { state: 'waiting' };
    }
    return this.записатьГраф();
  }

  /** Obsidian закрыт: сливаем заново — он мог сохранить своё при выходе — и проверяем по диску. */
  private записатьГраф(): GraphOutcome {
    const файл = this.файлГрафа;
    if (!файл) return { state: 'no-vault' };
    try {
      const слито = this.слитьГраф();
      if (!слито.changed) return { state: 'unchanged' };
      const текст = `${JSON.stringify(слито.settings, null, 2)}\n`;
      const копия = this.копияГрафа();
      const запись: КопияГрафа = existsSync(копия)
        ? (JSON.parse(readFileSync(копия, 'utf8')) as КопияГрафа)
        : { vault: this.vault as string, raw: existsSync(файл) ? readFileSync(файл, 'utf8') : null, at: this.now };
      записать(копия, JSON.stringify({ ...запись, after: отпечаток(текст) }, null, 1));
      записать(файл, текст);
      if (readFileSync(файл, 'utf8') !== текст) return { state: 'failed', reason: tr('файл не совпал с записанным', 'the file does not match what was written') };
      return { state: 'applied', newGroups: слито.newGroups, courses: слито.courses };
    } catch (error) {
      return { state: 'failed', reason: this.причина(error) };
    }
  }

  /**
   * Вернуть настройки графа. Копия уходит в сторону только после записи: не вышло
   * или оборвалось — следующее нажатие начнёт заново.
   */
  private вернутьГраф(): string {
    const файл = this.файлГрафа;
    const копия = this.копияГрафа();
    if (!файл || !existsSync(копия)) return tr('Граф: возвращать нечего.', 'Graph: nothing to undo.');
    try {
      const запись = JSON.parse(readFileSync(копия, 'utf8')) as КопияГрафа;
      const база = `${копия.replace(/\.json$/u, '')}.${new Date(this.now).toISOString().replace(/[:.]/gu, '-')}`;
      const сейчас = existsSync(файл) ? readFileSync(файл, 'utf8') : null;
      // Менялось ли что-то после кнопки: масштаб, свои цвета. Это остаётся в копии, и человек узнаёт где.
      const менялось = сейчас !== null && сейчас !== запись.raw && запись.after !== undefined && отпечаток(сейчас) !== запись.after;
      if (сейчас !== null && сейчас !== запись.raw) copyFileSync(файл, `${база}.replaced.json`);
      if (запись.raw === null) {
        // Файла не было: наш уходит в копии, а не удаляется.
        if (сейчас !== null) renameSync(файл, `${база}.created.json`);
      } else if (сейчас !== запись.raw) {
        записать(файл, запись.raw);
      }
      renameSync(копия, `${база}.original.json`);
      return менялось
        ? tr(`Граф: настройки как до первого нажатия. То, что менялось после (масштаб, свои цвета), лежит в копии: ${база}.replaced.json`, `Graph: settings as they were before the first press. What changed since (zoom, your own colours) is kept in a copy: ${база}.replaced.json`)
        : tr('Граф: настройки как до первого нажатия.', 'Graph: settings as they were before the first press.');
    } catch (error) {
      return tr(`Граф вернуть не вышло: ${this.причина(error)}. Копия цела — нажмите ещё раз.`, `Could not restore the graph: ${this.причина(error)}. The copy is intact — press again.`);
    }
  }

  private ждать(что: 'apply' | 'undo'): void {
    this.waiting = что;
    this.закрытПодряд = 0;
    if (!this.таймер) {
      this.таймер = setInterval(() => void this.проверитьОбсидиан(), this.o.pollMs ?? 3000);
      this.таймер.unref?.();
    }
  }

  private перестатьЖдать(): void {
    this.waiting = null;
    this.закрытПодряд = 0;
    if (this.таймер) clearInterval(this.таймер);
    this.таймер = null;
  }

  private async проверитьОбсидиан(): Promise<void> {
    if (this.проверяю || !this.waiting) return;
    this.проверяю = true;
    try {
      // Лекция пошла, пока ждали: подождём ещё, во время записи ничего не пишем.
      if (this.o.busy?.()) return;
      const открыт = await this.o.obsidian();
      this.закрытПодряд = открыт === 'closed' ? this.закрытПодряд + 1 : 0;
      if (this.закрытПодряд < ПРОВЕРОК_ЗАКРЫТ || !this.waiting) return;
      const что = this.waiting;
      this.перестатьЖдать();
      if (что === 'apply') {
        const итог = this.записатьГраф();
        if (this.report) {
          this.report.graph = итог;
          this.lines = reportLines(this.report);
        }
      } else {
        this.lines = [...this.lines.filter((с) => с !== this.строкаОжидания()), this.вернутьГраф()];
      }
    } finally {
      this.проверяю = false;
    }
  }

  private строкаОжидания(): string {
    return tr(
      'Граф: Obsidian открыт, а открытый он затирает настройки своими. Закройте его — Джарвис запишет настройки сам и скажет здесь. Сам он Obsidian не закрывает.',
      'Graph: Obsidian is open, and while open it overwrites the settings with its own. Close it and Jarvis writes them by itself and says so here. Jarvis does not close Obsidian.',
    );
  }

  private async шагФормул(report: TidyReport): Promise<void> {
    const заметки = заметкиСФормулами(this.o.root);
    if (заметки.length === 0) return;
    if (!this.o.summarize) {
      report.skipped.push(tr('Формулы: модели нет — заметки не тронуты.', 'Formulas: no model available — notes untouched.'));
      return;
    }
    let журнал: { файл: string; папка: string; данные: Журнал } | null = null;
    let отказовПодряд = 0;
    for (const [номер, { file }] of заметки.entries()) {
      const занято = this.o.busy?.();
      if (занято) {
        report.stopped = занято;
        return;
      }
      const имя = имяЗаметки(this.o.root, file);
      this.progress = tr(`Формулы: ${номер + 1} из ${заметки.length} — ${имя}`, `Formulas: ${номер + 1} of ${заметки.length} — ${имя}`);
      let исходные: Buffer;
      let текст: string;
      try {
        исходные = readFileSync(file);
        текст = исходные.toString('utf8');
      } catch (error) {
        report.failed.push(tr(`${имя}: ${this.причина(error)} — заметка без изменений.`, `${имя}: ${this.причина(error)} — note unchanged.`));
        continue;
      }
      // Битый байт текстом не пережил бы запись: такую заметку не трогаем совсем.
      if (!Buffer.from(текст, 'utf8').equals(исходные)) {
        report.skipped.push(tr(`${имя}: в заметке есть байты не в UTF-8 — не трогаю.`, `${имя}: the note has bytes that are not UTF-8 — left alone.`));
        continue;
      }
      if (formulaCandidates(текст).length === 0) continue;

      let итог;
      try {
        итог = await convertNoteFormulas(текст, this.o.summarize, this.o.busy);
        отказовПодряд = 0;
      } catch (error) {
        if (error instanceof FormulaStopped) {
          report.stopped = error.message;
          return;
        }
        отказовПодряд += 1;
        report.failed.push(tr(`${имя}: ${this.причина(error)} — заметка без изменений.`, `${имя}: ${this.причина(error)} — note unchanged.`));
        if (отказовПодряд >= ОТКАЗОВ_ПОДРЯД && номер + 1 < заметки.length) {
          report.stopped = tr(`модель не отвечает подряд, осталось заметок: ${заметки.length - номер - 1}. Их можно обработать следующим нажатием.`, `the model keeps failing, ${заметки.length - номер - 1} notes left. Press again to process them.`);
          return;
        }
        continue;
      }
      // Запись пошла, пока модель думала: не пишем ничего.
      const идёт = this.o.busy?.();
      if (идёт) {
        report.stopped = идёт;
        return;
      }
      report.rejected += итог.rejected;
      report.missing += итог.missing;
      this.непринятые.push(...итог.refused.map((о) => ({ имя, ...о })));
      // Что-то не доказано или без ответа — пометки нет: следующее нажатие спросит снова.
      const всёПроверено = итог.rejected === 0 && итог.missing === 0;
      const стало = всёПроверено ? withFormulasMark(итог.text) : итог.text;
      if (стало === текст) continue;

      let шаг: Шаг | null = null;
      try {
        // Пока модель думала, заметку могли поправить: её правка важнее.
        if (!readFileSync(file).equals(исходные)) {
          report.skipped.push(tr(`${имя}: заметка изменилась, пока шла работа — не трогаю.`, `${имя}: the note changed meanwhile — left alone.`));
          continue;
        }
        журнал ??= this.новыйЖурнал();
        const backup = path.join(журнал.папка, `${String(журнал.данные.steps.length + 1).padStart(3, '0')} ${path.basename(file)}`);
        copyFileSync(file, backup);
        шаг = { file, backup, after: отпечаток(стало), changes: итог.changes };
        журнал.данные.steps.push(шаг);
        записать(журнал.файл, JSON.stringify(журнал.данные, null, 1));
        записать(file, стало);
      } catch (error) {
        // Заметка цела, и отмене тут делать нечего. Это файл, модель ни при чём: подряд не считаем.
        if (журнал && шаг) {
          журнал.данные.steps = журнал.данные.steps.filter((с) => с !== шаг);
          try {
            записать(журнал.файл, JSON.stringify(журнал.данные, null, 1));
          } catch {
            // Журнал не записался — отмена увидит, что заметка равна копии, и молча пройдёт мимо.
          }
        }
        report.failed.push(tr(`${имя}: ${this.причина(error)} — заметка без изменений.`, `${имя}: ${this.причина(error)} — note unchanged.`));
        continue;
      }
      if (итог.lines > 0) report.notes += 1;
      else if (всёПроверено) report.noFormulas += 1;
      report.lines += итог.lines;
    }
  }

  private новыйЖурнал(): { файл: string; папка: string; данные: Журнал } {
    const имя = new Date(this.now).toISOString().replace(/[:.]/gu, '-');
    let папка = path.join(this.o.dir, 'notes', имя);
    for (let n = 2; existsSync(папка); n += 1) папка = path.join(this.o.dir, 'notes', `${имя}-${n}`);
    mkdirSync(папка, { recursive: true });
    return { файл: path.join(папка, 'journal.json'), папка, данные: { version: 1, at: this.now, steps: [] } };
  }

  private журналы(): Array<{ файл: string; данные: Журнал }> {
    const корень = path.join(this.o.dir, 'notes');
    if (!existsSync(корень)) return [];
    return readdirSync(корень)
      .sort()
      .reverse()
      .flatMap((имя) => {
        const файл = path.join(корень, имя, 'journal.json');
        try {
          return [{ файл, данные: JSON.parse(readFileSync(файл, 'utf8')) as Журнал }];
        } catch {
          return [];
        }
      });
  }

  /** Где заметка сейчас: на месте или, если лекцию перенесли или курс переименовали, в другой папке курса. */
  private гдеЗаметка(шаг: Шаг): string | null {
    if (existsSync(шаг.file) && нашаЗаметка(шаг.file, шаг)) return шаг.file;
    for (const папка of папкиЛекций(this.o.root)) {
      const файл = path.join(this.o.root, папка, path.basename(шаг.file));
      if (existsSync(файл) && statSync(файл).isFile() && нашаЗаметка(файл, шаг)) return файл;
    }
    return existsSync(шаг.file) ? шаг.file : null;
  }

  private естьЧтоВернуть(): boolean {
    if (existsSync(this.копияГрафа())) return true;
    return this.журналы().some((ж) =>
      ж.данные.steps.some((шаг) => {
        if (!шаг.done) return true;
        // Разобрались, но заметка снова как после кнопки: отмена снова имеет смысл.
        try {
          return отпечаток(readFileSync(шаг.file)) === шаг.after;
        } catch {
          return false;
        }
      }),
    );
  }

  /** Заметки — с новых нажатий к старым. Сбой в одной не мешает остальным, и она остаётся на следующий раз. */
  private вернутьЗаметки(): { restored: number; messages: string[] } {
    let restored = 0;
    const messages: string[] = [];
    for (const журнал of this.журналы()) {
      let менялся = false;
      for (const шаг of [...журнал.данные.steps].reverse()) {
        const занято = this.o.busy?.();
        if (занято) {
          messages.push(tr(`Остановился: ${занято} Остальное вернётся следующим нажатием.`, `Stopped: ${занято} The rest is undone by the next press.`));
          this.сохранитьЖурнал(журнал, менялся, messages);
          return { restored, messages };
        }
        const имя = имяЗаметки(this.o.root, шаг.file);
        try {
          const итог = this.вернутьЗаметку(шаг, имя);
          if (итог.restored) restored += 1;
          if (итог.message) messages.push(итог.message);
          if (итог.done && !шаг.done) {
            шаг.done = true;
            менялся = true;
          }
        } catch (error) {
          messages.push(tr(`${имя}: не вышло вернуть (${this.причина(error)}). Заметка цела — нажмите ещё раз.`, `${имя}: could not restore (${this.причина(error)}). The note is intact — press again.`));
        }
      }
      this.сохранитьЖурнал(журнал, менялся, messages);
    }
    return { restored, messages };
  }

  private сохранитьЖурнал(журнал: { файл: string; данные: Журнал }, менялся: boolean, messages: string[]): void {
    if (!менялся) return;
    try {
      записать(журнал.файл, JSON.stringify(журнал.данные, null, 1));
    } catch (error) {
      messages.push(tr(`Журнал отмены не записался: ${this.причина(error)}.`, `The undo journal was not saved: ${this.причина(error)}.`));
    }
  }

  private вернутьЗаметку(шаг: Шаг, имя: string): { restored: boolean; done: boolean; message?: string } {
    const файл = this.гдеЗаметка(шаг);
    if (!файл) {
      if (шаг.done) return { restored: false, done: true };
      return { restored: false, done: true, message: tr(`${имя}: заметки больше нет — копия в ${шаг.backup}.`, `${имя}: the note is gone — backup at ${шаг.backup}.`) };
    }
    const сейчас = readFileSync(файл);
    if (отпечаток(сейчас) === шаг.after) {
      // Побайтно из копии: и битые байты, и переводы строк вернутся какими были.
      записать(файл, readFileSync(шаг.backup));
      return { restored: true, done: true };
    }
    // Уже как в копии: запись оборвалась до заметки или это повторное нажатие.
    if (сейчас.equals(readFileSync(шаг.backup))) return { restored: false, done: true };
    if (шаг.done) return { restored: false, done: true };

    // Заметку потом меняли: возвращаем только наши строки, остальное её.
    const текст = сейчас.toString('utf8');
    if (!Buffer.from(текст, 'utf8').equals(сейчас)) {
      return { restored: false, done: true, message: tr(`${имя}: в заметке есть байты не в UTF-8 — оставляю; копия в ${шаг.backup}.`, `${имя}: the note has bytes that are not UTF-8 — left alone; backup at ${шаг.backup}.`) };
    }
    const строки = текст.split('\n');
    let вернул = 0;
    let осталось = 0;
    for (const замена of шаг.changes) {
      const где = строки.findIndex((с) => с.replace(/\r$/u, '') === замена.after);
      if (где < 0) {
        осталось += 1;
        continue;
      }
      строки[где] = `${замена.before}${(строки[где] as string).endsWith('\r') ? '\r' : ''}`;
      вернул += 1;
    }
    const стало = withoutFormulasMark(строки.join('\n'));
    if (стало !== текст) записать(файл, стало);
    const message =
      осталось > 0
        ? tr(`${имя}: строк, которые вы правили сами, осталось ${осталось} — их не трогаю; копия в ${шаг.backup}.`, `${имя}: ${осталось} lines you edited yourself stay as they are; backup at ${шаг.backup}.`)
        : undefined;
    return { restored: вернул > 0 || стало !== текст, done: true, message };
  }
}

/** Что сказать человеку: что изменилось, что пропущено и что не вышло. */
export function reportLines(r: TidyReport): string[] {
  const lines: string[] = [];
  switch (r.graph.state) {
    case 'applied':
      lines.push(
        tr(
          `Граф: настройки на диске, Obsidian был закрыт. Курсов с цветом: ${r.graph.courses}, новых: ${r.graph.newGroups}; расшифровки и одиночные точки скрыты. Откройте Obsidian — граф уже такой.`,
          `Graph: settings are on disk, Obsidian was closed. Courses with a colour: ${r.graph.courses}, new: ${r.graph.newGroups}; transcripts and lone dots hidden. Open Obsidian and the graph is already like this.`,
        ),
      );
      break;
    case 'unchanged':
      lines.push(tr('Граф уже настроен.', 'The graph is already set up.'));
      break;
    case 'waiting':
      lines.push(
        tr(
          'Граф ещё не настроен: Obsidian открыт, а открытый он затирает настройки своими. Закройте его — Джарвис запишет настройки сам и скажет здесь. Сам он Obsidian не закрывает.',
          'The graph is not set up yet: Obsidian is open, and while open it overwrites the settings with its own. Close it and Jarvis writes them by itself and says so here. Jarvis does not close Obsidian.',
        ),
      );
      break;
    case 'no-vault':
      lines.push(tr('Здесь нет хранилища Obsidian: в папке лекций и выше нет папки .obsidian. Ничего не менял.', 'There is no Obsidian vault here: no .obsidian folder in or above the lectures folder. Nothing changed.'));
      break;
    case 'unknown':
      lines.push(tr('Граф не тронут: не удалось проверить, открыт ли Obsidian. Закройте его и нажмите ещё раз.', 'The graph is untouched: could not check whether Obsidian is open. Close it and press again.'));
      break;
    case 'cancelled':
      lines.push(tr('Граф не тронут: вы отменили ожидание.', 'The graph is untouched: you cancelled the wait.'));
      break;
    case 'failed':
      lines.push(tr(`Граф не вышел: ${r.graph.reason}`, `Graph failed: ${r.graph.reason}`));
      break;
  }
  if (r.notes > 0) lines.push(tr(`Формулы в LaTeX: заметок ${r.notes}, строк ${r.lines}.`, `Formulas in LaTeX: ${r.notes} notes, ${r.lines} lines.`));
  if (r.noFormulas > 0) lines.push(tr(`Формул не нашлось в заметках: ${r.noFormulas} — они помечены, модель больше не спросим.`, `No formulas found in ${r.noFormulas} notes — marked, the model will not be asked again.`));
  if (r.rejected > 0) lines.push(tr(`Строк не принято: ${r.rejected} — равенство исходной строке не доказано, они остались как были. Следующее нажатие спросит их снова.`, `Lines rejected: ${r.rejected} — not proven equal to the original, they stay as they were. The next press asks about them again.`));
  if (r.rejectedFile) lines.push(tr(`Какие именно: ${r.rejectedFile}`, `Which ones: ${r.rejectedFile}`));
  if (r.missing > 0) lines.push(tr(`Модель не ответила на строк: ${r.missing} — они остались как были. Следующее нажатие спросит их снова.`, `The model did not answer ${r.missing} lines — they stay as they were. The next press asks about them again.`));
  lines.push(...r.skipped, ...r.failed);
  if (r.stopped) lines.push(tr(`Остановился: ${r.stopped}`, `Stopped: ${r.stopped}`));
  return lines;
}
