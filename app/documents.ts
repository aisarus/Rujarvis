/**
 * Конвейер документов в приложении: очередь, строка на плашке, уведомление.
 *
 * Логика — в `jarvis/documents/pipeline.ts`. Здесь — по одному документу за
 * раз (каждый — минуты сильнейшей модели по подписке, два разом только
 * делили бы лимит) и ответ человеку: сразу — «беру», в конце — что вышло,
 * строкой на плашке и уведомлением, по щелчку открывающим заметку в Obsidian.
 */

import path from 'node:path';

import { Notification, shell } from 'electron';

import { createClaudeDocumentAgent, processDocument, withFallbackAgent } from '../jarvis/documents/pipeline';
import { lectureFolder, obsidianOpenUrl } from '../jarvis/lecture/vault';
import { tr } from '../jarvis/locale/language';

export interface DocumentsOptions {
  /** Папка результатов: «Лекции» лежат в Obsidian, а без него — в ней. */
  outputDir(): string;
  notes(): 'ru' | 'en';
  /** Сообщить человеку итог: строкой на плашке или голосом. */
  say(text: string): void;
}

let очередь: Promise<void> = Promise.resolve();
let ждут = 0;

/** Поставить документ в очередь. Возвращает, что ответить сразу. */
export function enqueueDocument(file: string, options: DocumentsOptions, course?: string | null): string {
  const имя = path.basename(file);
  ждут += 1;
  const передНим = ждут - 1;
  очередь = очередь.then(() => разобрать(file, options, course)).finally(() => {
    ждут -= 1;
  });
  return передНим > 0
    ? tr(`Беру «${имя}» — разберу после ещё ${передНим}.`, `Taking "${имя}" — it is queued after ${передНим} more.`)
    : tr(`Разбираю «${имя}». Это несколько минут — скажу, когда будет готово.`, `Reading "${имя}". It takes a few minutes — I will tell you when it is ready.`);
}

async function разобрать(file: string, options: DocumentsOptions, course?: string | null): Promise<void> {
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
      // Opus — разбор документа один, и он должен быть лучшим; лимит — Sonnet.
      agent: withFallbackAgent(createClaudeDocumentAgent({ model: 'opus', log }), createClaudeDocumentAgent({ model: 'sonnet', log }), log),
      log,
    });
    log(`«${имя}» за ${Math.round((Date.now() - t0) / 1000)} с`);
    const куда = filed.course ?? tr('без курса', 'no course');
    const итог = tr(
      `Готово: «${имя}» → ${куда}, заметок ${filed.notes.length}. ${manifest.summary}`,
      `Done: "${имя}" → ${куда}, ${filed.notes.length} notes. ${manifest.summary}`,
    ).trim();
    options.say(итог);
    показать(tr('Документ разобран', 'Document ready'), итог, () => {
      void (vault ? shell.openExternal(obsidianOpenUrl(filed.main)) : shell.openPath(filed.main));
    });
  } catch (error) {
    const причина = error instanceof Error ? error.message : String(error);
    console.error(`[jarvis:docs] «${имя}» не разобран: ${причина}`);
    const текст = tr(`Не разобрал «${имя}»: ${причина}`, `Could not read "${имя}": ${причина}`);
    options.say(текст);
    показать(tr('Документ не разобран', 'Document failed'), текст);
  }
}

function показать(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body.slice(0, 250), silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}
