/**
 * Разбор документа настоящей моделью: `pnpm jarvis:document-check -- файл [--brain=codex]`.
 *
 * Тот же конвейер, что у «Входящих» (`processDocument`), и тот же выбор
 * модели, что в настройках (`--brain=` — поверх них). Пишет во временную
 * папку «Лекции» с курсами из настоящего хранилища — заметки среди лекций не
 * остаются, — печатает, что модель решила и что написала.
 *
 * Отвечает: прошло — заметки и manifest есть; не прошло — модель упала или
 * ничего не написала; нечем мерить — нет файла или ни Claude Code, ни Codex.
 * Окон не открывает.
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCodexDocumentAgent } from '../../jarvis/documents/codexAgent';
import { createClaudeDocumentAgent, processDocument, withFallbackAgent } from '../../jarvis/documents/pipeline';
import { listCourses, readCourseInfo, writeCourseInfo } from '../../jarvis/lecture/courses';
import { brainFromArgs, brainOrder } from '../../jarvis/lecture/summarize';
import { lectureFolder } from '../../jarvis/lecture/vault';
import { jarvisOutputDir, jarvisPaths } from '../../jarvis/setup/paths';
import { SettingsStore } from '../../jarvis/setup/settings';

async function main(): Promise<number> {
  const файл = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!файл || !existsSync(файл)) {
    console.log('НЕЧЕМ МЕРИТЬ: нужен документ — pnpm jarvis:document-check -- файл');
    return 2;
  }
  const settings = new SettingsStore(jarvisPaths().settings).get();
  const порядок = brainOrder(brainFromArgs(process.argv, settings.brain));
  if (порядок.length === 0) {
    console.log('НЕЧЕМ МЕРИТЬ: ни Claude Code, ни Codex не найдены');
    return 2;
  }
  // Курсы — из настоящего хранилища, чтобы модели было из чего выбирать; пишем — во временную.
  const настоящие = lectureFolder(settings.outputDir || jarvisOutputDir(process.env, undefined, settings.language === 'en' ? 'Jarvis' : 'Джарвис'), settings.language).folder;
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'jarvis-doc-check-')), settings.language === 'en' ? 'Lectures' : 'Лекции');
  for (const курс of existsSync(настоящие) ? listCourses(настоящие) : []) {
    const инфо = readCourseInfo(настоящие, курс);
    writeCourseInfo(root, курс, { hebrew: инфо.hebrew ?? '' });
  }
  const log = (строка: string) => console.log(`  ${строка}`);
  const агенты = порядок.map((мозг) =>
    мозг === 'codex'
      ? createCodexDocumentAgent({ log })
      : withFallbackAgent(createClaudeDocumentAgent({ model: 'opus', log }), createClaudeDocumentAgent({ model: 'sonnet', log }), log),
  );
  console.log(`Документ: ${path.basename(файл)}; разбирает ${порядок.join(', затем ')}; курсов для выбора: ${listCourses(root).length}`);
  const t0 = Date.now();
  try {
    const { filed, manifest } = await processDocument({
      file: файл,
      root,
      notes: settings.language,
      agent: агенты.reduce((первый, второй) => withFallbackAgent(первый, второй, log)),
      log,
    });
    console.log(`  за ${Math.round((Date.now() - t0) / 1000)} с: ${manifest.kind}, курс «${filed.course ?? '—'}», «${manifest.title}»`);
    console.log(`  заметки (${filed.notes.length}): ${filed.notes.map((з) => path.basename(з)).join(', ')}`);
    console.log(`  итог модели: ${manifest.summary}`);
    const главная = readFileSync(filed.main, 'utf8');
    console.log(`  главная заметка: ${главная.length} знаков; начало:\n${главная.slice(0, 600)}`);
    console.log(`  папка: ${filed.folder}`);
    console.log('ПРОШЛО');
    return 0;
  } catch (беда) {
    console.log(`НЕ ПРОШЛО: ${беда instanceof Error ? беда.message : String(беда)}`);
    return 1;
  }
}

main().then(
  (код) => {
    process.exitCode = код;
  },
  (беда: unknown) => {
    console.log(`НЕ ПРОШЛО: ${беда instanceof Error ? беда.message : String(беда)}`);
    process.exitCode = 1;
  },
);
