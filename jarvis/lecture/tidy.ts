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
 * когда настройки перечитаны с диска.
 *
 * Формулы — единственное, что кнопка меняет в заметках (`formulaLines.ts`).
 * Обработанная заметка получает пометку, и повторное нажатие ничего не стоит; не
 * вышло — заметка без изменений и без пометки. Копии — в папке данных Джарвиса.
 *
 * Ничего не удаляется: файл, который отмена убирает с дороги, уходит в копии.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { tr } from '../locale/language';
import { mergeGraphSettings, type GraphSettings } from '../notes/graphSettings';
import { COURSE_WORDS, listCourses, listLectures, withFormulasMark } from './courses';
import { convertNoteFormulas, formulaCalls, formulaCandidates } from './formulaLines';
import { vaultOfFolder, type ObsidianState } from './vault';

/**
 * Окружение для вызовов модели: без размышлений. Замена записи формул — механика,
 * а размышления съедают лимит: на заметке по математике (59 строк, 04.11.2026) с ними
 * 170 с и 18 562 токена ответа, без них 51 с и 4 937 токенов при том же итоге. Подмена
 * числа размышлениями тоже не защищена: её ловит проверка в коде.
 */
export const FORMULA_MODEL_ENV = { MAX_THINKING_TOKENS: '0' } as const;

/** Модель подряд не отвечает — лимит или нет сети: дальше тратить время незачем. */
const ОТКАЗОВ_ПОДРЯД = 2;
/** Obsidian закрывается не мгновенно: «закрыт» считается со второй проверки подряд. */
const ПРОВЕРОК_ЗАКРЫТ = 2;

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
  /** Заметок, где модель формул не нашла: помечены, больше не спрашиваем. */
  noFormulas: number;
  /** Строк, которые модель изменила не только в формуле: остались как были. */
  rejected: number;
  failed: string[];
  skipped: string[];
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
  lines: string[];
}

interface Шаг {
  file: string;
  backup: string;
  after: string;
}

interface Журнал {
  version: 1;
  at: number;
  steps: Шаг[];
  undoneAt?: number;
}

interface КопияГрафа {
  vault: string;
  /** Что лежало в файле до первого нажатия; null — файла не было. */
  raw: string | null;
  at: number;
}

function отпечаток(текст: string): string {
  return createHash('sha256').update(текст).digest('hex');
}

function разобрать(текст: string): GraphSettings {
  const данные: unknown = JSON.parse(текст);
  if (!данные || typeof данные !== 'object' || Array.isArray(данные)) throw new Error('не объект');
  return данные as GraphSettings;
}

/** Записать через временный файл: оборванная запись не должна оставить пол-настроек. */
function записать(файл: string, текст: string): void {
  mkdirSync(path.dirname(файл), { recursive: true });
  const временный = `${файл}.${process.pid}.tmp`;
  writeFileSync(временный, текст, 'utf8');
  renameSync(временный, файл);
}

/** Все заметки лекций: и в курсах, и «Без курса». */
function заметкиЛекций(root: string): Array<{ course: string; file: string; formulas: boolean }> {
  const папки = [...listCourses(root), COURSE_WORDS.ru.unsorted, COURSE_WORDS.en.unsorted];
  return папки.flatMap((курс) => listLectures(root, курс).map((л) => ({ course: курс, file: л.file, formulas: Boolean(л.meta.formulas) })));
}

/** Необработанные заметки, в которых есть что показать модели. */
function заметкиСФормулами(root: string): Array<{ course: string; file: string }> {
  return заметкиЛекций(root).filter((з) => !з.formulas && formulaCandidates(readFileSync(з.file, 'utf8')).length > 0);
}

function имяЗаметки(root: string, файл: string): string {
  return path.relative(root, файл).replace(/\.md$/u, '').split(path.sep).join('/');
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
    const report: TidyReport = { graph: { state: 'unchanged' }, notes: 0, lines: 0, noFormulas: 0, rejected: 0, failed: [], skipped: [] };
    this.report = report;
    this.lines = [];
    try {
      if (this.vault) {
        report.graph = await this.шагГрафа();
        await this.шагФормул(report);
      } else {
        report.graph = { state: 'no-vault' };
      }
    } finally {
      this.running = false;
      this.progress = '';
      this.lines = reportLines(report);
    }
    return this.state();
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
      const { restored, skipped } = this.вернутьЗаметки();
      if (restored > 0) lines.push(tr(`Заметки: вернул прежний текст в ${restored}.`, `Notes: restored the earlier text in ${restored}.`));
      for (const с of skipped) lines.push(с);
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
    return { running: this.running, progress: this.progress, waiting: this.waiting, canUndo: this.естьЧтоВернуть(), lines: this.lines };
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
      const копия = this.копияГрафа();
      if (!existsSync(копия)) {
        const запись: КопияГрафа = { vault: this.vault as string, raw: existsSync(файл) ? readFileSync(файл, 'utf8') : null, at: this.now };
        записать(копия, JSON.stringify(запись, null, 1));
      }
      const текст = `${JSON.stringify(слито.settings, null, 2)}\n`;
      записать(файл, текст);
      if (readFileSync(файл, 'utf8') !== текст) return { state: 'failed', reason: tr('файл не совпал с записанным', 'the file does not match what was written') };
      return { state: 'applied', newGroups: слито.newGroups, courses: слито.courses };
    } catch (error) {
      return { state: 'failed', reason: this.причина(error) };
    }
  }

  private вернутьГраф(): string {
    const файл = this.файлГрафа;
    const копия = this.копияГрафа();
    if (!файл || !existsSync(копия)) return tr('Граф: возвращать нечего.', 'Graph: nothing to undo.');
    try {
      const запись = JSON.parse(readFileSync(копия, 'utf8')) as КопияГрафа;
      const снято = copyAside(копия, this.now);
      if (existsSync(файл)) copyFileSync(файл, `${снято}.replaced.json`);
      if (запись.raw === null) {
        // Файла не было: убираем наш в копии, а не удаляем.
        if (existsSync(файл)) renameSync(файл, `${снято}.created.json`);
      } else {
        записать(файл, запись.raw);
      }
      return tr('Граф: настройки как до первого нажатия.', 'Graph: settings as they were before the first press.');
    } catch (error) {
      return tr(`Граф вернуть не вышло: ${this.причина(error)}`, `Could not restore the graph: ${this.причина(error)}`);
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
      try {
        const текст = readFileSync(file, 'utf8');
        if (formulaCandidates(текст).length === 0) continue;
        const итог = await convertNoteFormulas(текст, this.o.summarize);
        // Пока модель думала, заметку могли поправить: её правка важнее.
        if (readFileSync(file, 'utf8') !== текст) {
          report.skipped.push(tr(`${имя}: заметка изменилась, пока шла работа — не трогаю.`, `${имя}: the note changed meanwhile — left alone.`));
          continue;
        }
        const стало = withFormulasMark(итог.text);
        журнал ??= this.новыйЖурнал();
        const backup = path.join(журнал.папка, `${String(журнал.данные.steps.length + 1).padStart(3, '0')} ${path.basename(file)}`);
        copyFileSync(file, backup);
        журнал.данные.steps.push({ file, backup, after: отпечаток(стало) });
        записать(журнал.файл, JSON.stringify(журнал.данные, null, 1));
        записать(file, стало);
        отказовПодряд = 0;
        if (итог.lines > 0) report.notes += 1;
        else report.noFormulas += 1;
        report.lines += итог.lines;
        report.rejected += итог.rejected;
      } catch (error) {
        отказовПодряд += 1;
        report.failed.push(tr(`${имя}: ${this.причина(error)} — заметка без изменений.`, `${имя}: ${this.причина(error)} — note unchanged.`));
        if (отказовПодряд >= ОТКАЗОВ_ПОДРЯД && номер + 1 < заметки.length) {
          report.stopped = tr(`модель не отвечает подряд, осталось заметок: ${заметки.length - номер - 1}. Их можно обработать следующим нажатием.`, `the model keeps failing, ${заметки.length - номер - 1} notes left. Press again to process them.`);
          return;
        }
      }
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

  private естьЧтоВернуть(): boolean {
    return existsSync(this.копияГрафа()) || this.журналы().some((ж) => !ж.данные.undoneAt && ж.данные.steps.length > 0);
  }

  /** Заметки — с новых нажатий к старым. Заметку правили после обработки — её правка остаётся. */
  private вернутьЗаметки(): { restored: number; skipped: string[] } {
    let restored = 0;
    const skipped: string[] = [];
    for (const журнал of this.журналы()) {
      if (журнал.данные.undoneAt) continue;
      for (const шаг of [...журнал.данные.steps].reverse()) {
        const имя = имяЗаметки(this.o.root, шаг.file);
        if (!existsSync(шаг.file)) {
          skipped.push(tr(`${имя}: заметки уже нет на этом месте — копия в ${шаг.backup}.`, `${имя}: the note is no longer there — backup at ${шаг.backup}.`));
          continue;
        }
        if (отпечаток(readFileSync(шаг.file, 'utf8')) !== шаг.after) {
          skipped.push(tr(`${имя}: заметку меняли после этого — оставляю; копия в ${шаг.backup}.`, `${имя}: the note was edited since — left alone; backup at ${шаг.backup}.`));
          continue;
        }
        копироватьВ(шаг.backup, шаг.file);
        restored += 1;
      }
      журнал.данные.undoneAt = this.now;
      записать(журнал.файл, JSON.stringify(журнал.данные, null, 1));
    }
    return { restored, skipped };
  }
}

/** Заменить содержимое файла копией — через временный файл рядом. */
function копироватьВ(копия: string, файл: string): void {
  записать(файл, readFileSync(копия, 'utf8'));
}

/** Убрать использованную копию графа: следующее нажатие снимет новую. Возвращает её новое имя без расширения. */
function copyAside(копия: string, now: number): string {
  const база = `${копия.replace(/\.json$/u, '')}.${new Date(now).toISOString().replace(/[:.]/gu, '-')}`;
  renameSync(копия, `${база}.original.json`);
  return база;
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
  if (r.rejected > 0) lines.push(tr(`Строк не принято: ${r.rejected} — модель меняла в них не только формулу, они остались как были.`, `Lines rejected: ${r.rejected} — the model changed more than the formula, they stay as they were.`));
  lines.push(...r.skipped, ...r.failed);
  if (r.stopped) lines.push(tr(`Остановился: ${r.stopped}`, `Stopped: ${r.stopped}`));
  return lines;
}
