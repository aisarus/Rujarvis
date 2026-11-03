/**
 * Разбор документа через Codex — для тех, у кого ChatGPT, а не Claude
 * (первые тестеры на маке, 26.10.2026).
 *
 * Claude Code разбирает документ сам: читает `in/` своим инструментом и
 * пишет заметки в `out/` под правилом `Edit(./out/**)`. У Codex такого
 * правила нет: писать файлы он может только с оболочкой в песочнице, а
 * оболочка читает весь диск. Поэтому здесь Codex работает как раздел
 * конспекта — без рук: документ целиком в промпте (текст — текстом, картинки и
 * страницы-сканы — изображениями `-i`), заметки — блоками в ответе, а в
 * `out/` их раскладывает уже код. Дальше всё как у Claude Code: тот же
 * `manifest.json`, та же раскладка.
 *
 * PDF Codex сам не читает. На маке текст и страницы достаёт PDFKit — он есть
 * в каждой macOS, через `osascript -l JavaScript`, без сторонних программ.
 * На Windows PDF через Codex пока не разбирается — и так и сказано.
 *
 * Модуль не знает про Электрон.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCodexArgs, codexOwnerChoices, readCodexUserConfig, WORK_DISABLED_FEATURES } from '../backends/codex';
import { resolveCli } from '../backends/cliProbes';
import { codexFailure, runCli } from '../lecture/summarize';
import { agentEnv } from '../backends/subscriptionEnv';
import { tr } from '../locale/language';
import type { DocumentAgent } from './pipeline';

/** Сколько картинок отдать Codex за раз: больше — промпт тяжелеет, а ответ не лучше. */
export const MAX_IMAGES = 24;

/** Страница, на которой меньше стольких знаков, считается сканом: её отдают картинкой. */
const МАЛО_ТЕКСТА = 40;

const КАРТИНКИ = new Set(['png', 'jpg', 'jpeg', 'webp']);

export interface PdfContent {
  /** Текст каждой страницы; у скана — пусто. */
  pages: string[];
  /** Картинки страниц без текста, по порядку. */
  images: string[];
}

export type PdfReader = (file: string, imagesDir: string) => Promise<PdfContent>;

/**
 * Сценарий JXA для PDFKit: текст всех страниц и картинки страниц без текста.
 * Аргументы: файл, папка для картинок, порог «мало текста», сколько картинок
 * не больше. Ответ — JSON.
 */
export const PDFKIT_SCRIPT = `
ObjC.import('PDFKit');
ObjC.import('AppKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) throw new Error('PDF не открылся');
  const мало = Number(argv[2]);
  const предел = Number(argv[3]);
  const pages = [];
  const images = [];
  for (let i = 0; i < doc.pageCount; i++) {
    const page = doc.pageAtIndex(i);
    const s = page.string;
    const text = s && !s.isNil() ? s.js : '';
    pages.push(text);
    if (text.trim().length >= мало || images.length >= предел) continue;
    const box = page.boundsForBox(0);
    const k = 1600 / Math.max(box.size.width, box.size.height);
    const img = page.thumbnailOfSizeForBox({ width: box.size.width * k, height: box.size.height * k }, 0);
    const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation);
    const png = rep.representationUsingTypeProperties(4, $.NSDictionary.dictionary);
    const file = argv[1] + '/page-' + String(i + 1).padStart(3, '0') + '.png';
    png.writeToFileAtomically(file, true);
    images.push(file);
  }
  return JSON.stringify({ pages: pages, images: images });
}
`;

/** PDF через PDFKit (только мак). */
export const readPdfMac: PdfReader = (file, imagesDir) =>
  new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new Error(tr('PDF через Codex разбирается пока только на маке — здесь нужен Claude Code', 'PDF files go through Codex only on a Mac for now; here it needs Claude Code')));
      return;
    }
    mkdirSync(imagesDir, { recursive: true });
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', PDFKIT_SCRIPT, file, imagesDir, String(МАЛО_ТЕКСТА), String(MAX_IMAGES)],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(tr(`PDF не прочитался: ${(stderr || error.message).trim().slice(0, 200)}`, `could not read the PDF: ${(stderr || error.message).trim().slice(0, 200)}`)));
          return;
        }
        try {
          const ответ = JSON.parse(stdout) as PdfContent;
          resolve({ pages: Array.isArray(ответ.pages) ? ответ.pages : [], images: Array.isArray(ответ.images) ? ответ.images : [] });
        } catch {
          reject(new Error(tr('PDF не прочитался: PDFKit ответил не JSON', 'could not read the PDF: PDFKit did not answer with JSON')));
        }
      },
    );
  });

export interface Входы {
  /** Текстовые файлы: имя в `in/` → текст. */
  texts: Array<{ name: string; text: string }>;
  /** Картинки для `-i`. */
  images: string[];
}

/** Что лежит в `in/` — текстом и картинками. Word и PowerPoint уже рядом текстом. */
export async function gatherInputs(inDir: string, workDir: string, readPdf: PdfReader = readPdfMac): Promise<Входы> {
  const texts: Входы['texts'] = [];
  const images: string[] = [];
  for (const имя of readdirSync(inDir).sort()) {
    const файл = path.join(inDir, имя);
    const расширение = path.extname(имя).slice(1).toLowerCase();
    if (расширение === 'txt' || расширение === 'md') {
      texts.push({ name: имя, text: readFileSync(файл, 'utf8') });
    } else if (КАРТИНКИ.has(расширение)) {
      images.push(файл);
    } else if (расширение === 'pdf') {
      const pdf = await readPdf(файл, path.join(workDir, 'pages'));
      const текст = pdf.pages.map((страница, i) => `[${tr('Страница', 'Page')} ${i + 1}]\n${страница.trim() || tr('(текста нет — страница приложена картинкой)', '(no text: the page is attached as an image)')}`).join('\n\n');
      texts.push({ name: имя, text: текст });
      images.push(...pdf.images);
    }
    // .docx и .pptx пропускаем: конвейер положил их текст рядом файлом .txt.
  }
  return { texts, images: images.slice(0, MAX_IMAGES) };
}

/**
 * Промпт для Codex: как работать без рук — и тот же промпт, что у Claude
 * Code, и содержимое `in/`.
 */
export function codexDocumentPrompt(prompt: string, inputs: Входы): string {
  const тексты = inputs.texts.map((т) => `----- in/${т.name} -----\n${т.text}`).join('\n\n');
  return `КАК ТЫ РАБОТАЕШЬ ЗДЕСЬ. Инструментов чтения и записи файлов у тебя нет, и ничего запускать не нужно. Всё содержимое папки in/ — в конце этого сообщения${inputs.images.length ? `; картинки и страницы-сканы приложены изображениями (${inputs.images.length})` : ''}. Где ниже сказано прочитать документ инструментом — читай его здесь. Где сказано записать файл в out/ — не пиши файлы, а верни каждый файл в ответе блоком:
===FILE out/имя-файла.md===
содержимое файла
===END===
manifest.json — тоже блоком (===FILE out/manifest.json===), последним. Графики — блоками в out/graphs/. Кроме блоков, ничего не пиши.

${prompt}

СОДЕРЖИМОЕ in/:

${тексты || '(текстовых файлов нет — документ приложен изображениями)'}`;
}

/** Файлы из ответа: только внутри `out/`, только текст. Остальное отбрасывается. */
export function parseFileBlocks(answer: string): Array<{ path: string; content: string }> {
  const файлы: Array<{ path: string; content: string }> = [];
  const блок = /^===FILE (out\/[^\r\n]+?)===[ \t]*\r?\n([\s\S]*?)\r?\n===END===[ \t]*$/gmu;
  for (const m of answer.matchAll(блок)) {
    const путь = (m[1] ?? '').trim();
    const части = путь.split('/');
    // Ни выхода наверх, ни пустых частей: модель пишет только в out/.
    if (части.some((ч) => ч === '..' || ч === '.' || ч === '') || /[<>:"\\|?*]/u.test(части.slice(1).join('/'))) continue;
    файлы.push({ path: путь, content: m[2] ?? '' });
  }
  return файлы;
}

export interface CodexDocumentOptions {
  command?: string;
  /** Аргументы по файлу ответа и картинкам — подменяются в проверках. */
  args?(outFile: string, images: string[]): string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  readPdf?: PdfReader;
  log?(line: string): void;
}

/** Аргументы: как у раздела конспекта, плюс картинки. */
export function codexDocumentArgs(outFile: string, images: string[]): string[] {
  const args = buildCodexArgs({}, { sandbox: 'read-only', ownerChoices: codexOwnerChoices(readCodexUserConfig()), disabledFeatures: WORK_DISABLED_FEATURES });
  const свои = ['--ephemeral', '-o', outFile];
  for (const картинка of images) свои.push('-i', картинка);
  args.splice(args.length - 1, 0, ...свои);
  return args;
}

export function createCodexDocumentAgent(options: CodexDocumentOptions = {}): DocumentAgent {
  return async (job) => {
    const command = options.command ?? resolveCli('codex');
    if (!command) throw new Error(tr('Codex не найден — документ разобрать нечем', 'Codex was not found — nothing to read the document with'));
    const работа = mkdtempSync(path.join(os.tmpdir(), 'jarvis-codex-doc-'));
    try {
      const входы = await gatherInputs(path.join(job.cwd, 'in'), работа, options.readPdf);
      const ответФайл = path.join(работа, 'answer.md');
      const { code, stdout, stderr } = await runCli(command, options.args?.(ответФайл, входы.images) ?? codexDocumentArgs(ответФайл, входы.images), codexDocumentPrompt(job.prompt, входы), {
        cwd: работа,
        timeoutMs: options.timeoutMs ?? 45 * 60_000,
        env: options.env ?? agentEnv(),
        имя: 'Codex',
      });
      const ответ = existsSync(ответФайл) ? readFileSync(ответФайл, 'utf8') : '';
      if (code !== 0 || !ответ.trim()) throw new Error(`Codex ${tr('вышел с кодом', 'exited with code')} ${code}: ${codexFailure(stdout, stderr)}`);
      const файлы = parseFileBlocks(ответ);
      options.log?.(`Codex вернул ${файлы.length} файлов: ${файлы.map((ф) => ф.path).join(', ').slice(0, 300)}`);
      for (const файл of файлы) {
        const куда = path.join(job.cwd, ...файл.path.split('/'));
        mkdirSync(path.dirname(куда), { recursive: true });
        writeFileSync(куда, файл.content, 'utf8');
      }
    } finally {
      rmSync(работа, { recursive: true, force: true });
    }
  };
}
