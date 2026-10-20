/**
 * Конвейер документов в приложении: очередь, строка на плашке, уведомление.
 *
 * Логика — в `jarvis/documents/pipeline.ts`. Здесь — по одному документу за
 * раз (каждый — минуты сильнейшей модели по подписке, два разом только
 * делили бы лимит) и ответ человеку: сразу — «беру», в конце — что вышло,
 * строкой на плашке и уведомлением, по щелчку открывающим заметку в Obsidian.
 */

import { mkdirSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

import { Notification, shell } from 'electron';

import type { AgentChoice } from '../jarvis/backends/types';
import { createAgentDocumentAgent } from '../jarvis/documents/agents';
import { isDocument, processDocument } from '../jarvis/documents/pipeline';
import { COURSE_WORDS } from '../jarvis/lecture/courses';
import { lectureFolder, obsidianOpenUrl } from '../jarvis/lecture/vault';
import { tr } from '../jarvis/locale/language';
import { prepareStudyFor } from './study';

export interface DocumentsOptions {
  /** Папка результатов: «Лекции» лежат в Obsidian, а без него — в ней. */
  outputDir(): string;
  notes(): 'ru' | 'en';
  /** Сообщить человеку итог: строкой на плашке или голосом. */
  say(text: string): void;
  /** Кто разбирает — выбор во вкладке «Агенты»; нет — первый готовый. */
  agent?(): AgentChoice;
}

let очередь: Promise<void> = Promise.resolve();
let ждут = 0;

/** Поставить документ в очередь. Возвращает, что ответить сразу; `after` — разобран ли он. */
export function enqueueDocument(file: string, options: DocumentsOptions, course?: string | null, after?: (ok: boolean) => void): string {
  const имя = path.basename(file);
  ждут += 1;
  const передНим = ждут - 1;
  очередь = очередь
    .then(() => разобрать(file, options, course))
    .then((ok) => after?.(ok))
    .finally(() => {
      ждут -= 1;
    });
  return передНим > 0
    ? tr(`Беру «${имя}» — разберу после ещё ${передНим}.`, `Taking "${имя}" — it is queued after ${передНим} more.`)
    : tr(`Разбираю «${имя}». Это несколько минут — скажу, когда будет готово.`, `Reading "${имя}". It takes a few minutes — I will tell you when it is ready.`);
}

async function разобрать(file: string, options: DocumentsOptions, course?: string | null): Promise<boolean> {
  const имя = path.basename(file);
  const notes = options.notes();
  const { folder: root, vault } = lectureFolder(options.outputDir(), notes);
  const log = (строка: string) => console.log(`[jarvis:docs] ${строка}`);
  const t0 = Date.now();
  try {
    const { filed, manifest } = await processDocument({
      file,
      root,
      notes,
      course,
      // Сильнейшая модель выбранного агента — разбор документа один, и он
      // должен быть лучшим; лимит — быстрая (Opus → Sonnet, Gemini Pro → Flash).
      agent: createAgentDocumentAgent({ prefer: options.agent, log }),
      log,
    });
    log(`«${имя}» за ${Math.round((Date.now() - t0) / 1000)} с`);
    // Материал к экзамену — ещё и вопросы с карточками в «Учёбе». Силлабус и
    // задание — нет: оценка и сроки не материал, а подготовка к защите уже
    // в путеводителе.
    if (filed.course && (manifest.kind === 'reading' || manifest.kind === 'slides' || manifest.kind === 'other')) {
      prepareStudyFor(filed.main, { course: filed.course, sourceLanguage: manifest.sourceLanguage, notes });
    }
    const куда = filed.course ?? tr('без курса', 'no course');
    const итог = tr(
      `Готово: «${имя}» → ${куда}, заметок ${filed.notes.length}. ${manifest.summary}`,
      `Done: "${имя}" → ${куда}, ${filed.notes.length} notes. ${manifest.summary}`,
    ).trim();
    options.say(итог);
    показать(tr('Документ разобран', 'Document ready'), итог, () => {
      void (vault ? shell.openExternal(obsidianOpenUrl(filed.main)) : shell.openPath(filed.main));
    });
    return true;
  } catch (error) {
    const причина = error instanceof Error ? error.message : String(error);
    console.error(`[jarvis:docs] «${имя}» не разобран: ${причина}`);
    const текст = tr(`Не разобрал «${имя}»: ${причина}`, `Could not read "${имя}": ${причина}`);
    options.say(текст);
    показать(tr('Документ не разобран', 'Document failed'), текст);
    return false;
  }
}

/**
 * Папка «Входящие» в «Лекциях»: положил туда файлы — Джарвис разбирает их
 * сам, по одному. Удобно, когда из портала скачана пачка: не нужно носить
 * каждый на плашку.
 *
 * Разобранный файл уходит из «Входящих» в Корзину: его копия уже лежит
 * рядом с заметками в материалах курса. Не вышло — файл остаётся, и второй
 * раз до перезапуска его не берут: иначе сломанный файл крутился бы по
 * кругу, тратя лимит подписки.
 *
 * Файл, который ещё пишется (браузер качает, Word сохраняет), берётся, только
 * когда его размер перестал меняться. Временные файлы Office (`~$…`) и
 * недокачанные (`.crdownload`, `.part`) — мимо: их расширения не документы.
 */
export function watchInbox(options: DocumentsOptions): () => void {
  const notes = options.notes();
  const папка = path.join(lectureFolder(options.outputDir(), notes).folder, COURSE_WORDS[notes].inbox);
  try {
    mkdirSync(папка, { recursive: true });
  } catch (error) {
    console.error(`[jarvis:docs] папку «Входящие» не завести: ${error instanceof Error ? error.message : String(error)}`);
    return () => undefined;
  }
  const взяты = new Set<string>();
  let таймер: NodeJS.Timeout | null = null;
  // Один осмотр за раз: события папки сыплются пачкой, и два осмотра разом
  // поставили бы один файл в очередь дважды.
  let идёт = false;
  let ещёРаз = false;

  const осмотреть = async (): Promise<void> => {
    if (идёт) {
      ещёРаз = true;
      return;
    }
    идёт = true;
    try {
      await пройти();
    } finally {
      идёт = false;
      if (ещёРаз) {
        ещёРаз = false;
        позже();
      }
    }
  };

  const пройти = async (): Promise<void> => {
    let имена: string[];
    try {
      имена = readdirSync(папка);
    } catch {
      return;
    }
    for (const имя of имена) {
      const файл = path.join(папка, имя);
      if (взяты.has(файл) || имя.startsWith('~$') || имя.startsWith('.') || !isDocument(имя)) continue;
      let размер: number;
      try {
        const st = statSync(файл);
        if (!st.isFile()) continue;
        размер = st.size;
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (statSync(файл).size !== размер || размер === 0) continue;
      } catch {
        continue;
      }
      взяты.add(файл);
      console.log(`[jarvis:docs] во «Входящих»: ${имя}`);
      options.say(
        enqueueDocument(файл, options, null, (ok) => {
          if (ok) void shell.trashItem(файл).catch(() => undefined).finally(() => взяты.delete(файл));
        }),
      );
    }
  };
  const позже = (): void => {
    if (таймер) clearTimeout(таймер);
    таймер = setTimeout(() => void осмотреть(), 2000);
  };
  let смотритель: FSWatcher | null = null;
  try {
    смотритель = watch(папка, позже);
  } catch (error) {
    console.error(`[jarvis:docs] за «Входящими» не уследить: ${error instanceof Error ? error.message : String(error)}`);
  }
  позже();
  return () => {
    смотритель?.close();
    if (таймер) clearTimeout(таймер);
  };
}

function показать(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body.slice(0, 250), silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}
