/**
 * Дописать конспект лекции, которую не закончили: `pnpm jarvis:lecture-finish [-- заметка.md]`.
 *
 * Приложение делает это само через минуту после запуска (`app/lectureMode.ts`,
 * `recoverAbandonedLectures`); команда — для того, кто хочет дописать сейчас
 * или указать заметку руками. Без аргумента — самая свежая недописанная
 * лекция в папке лекций (хранилище Obsidian или папка результатов). Разделы и
 * итог — Claude Code по подписке по сохранённой расшифровке; дальше — как у
 * законченной лекции (`jarvis/lecture/recover.ts`).
 */
import { settingsLanguages } from '../jarvis/lecture/courses';
import { findAbandonedLectures, recoverLecture } from '../jarvis/lecture/recover';
import { brainFromArgs, createFinalSummarizer, createSummarizer, setBrain } from '../jarvis/lecture/summarize';
import { lectureFolder } from '../jarvis/lecture/vault';
import { jarvisOutputDir, jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore } from '../jarvis/setup/settings';

async function main(): Promise<void> {
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings).get();
  setBrain(() => brainFromArgs(process.argv, settings.brain));
  const notes = settings.language;
  // Папка результатов — как у приложения: «Jarvis» у английского интерфейса.
  // Рабочий стол, перенесённый в OneDrive, скрипт без Electron не знает —
  // тогда путь к заметке передаётся аргументом.
  const результаты = settings.outputDir || jarvisOutputDir(process.env, undefined, notes === 'en' ? 'Jarvis' : 'Джарвис');
  const { folder: root } = lectureFolder(результаты, notes);

  const заметка = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? findAbandonedLectures(root).at(-1);
  if (!заметка) {
    console.log(`Недописанных лекций в ${root} нет.`);
    return;
  }
  console.log(`Дописываю: ${заметка}`);
  const место = await recoverLecture(заметка, {
    root,
    languages: settingsLanguages(settings),
    notesStyle: settings.notesStyle,
    summarize: createSummarizer(),
    summarizeFinal: createFinalSummarizer({ log: (строка) => console.log(`  ${строка}`) }),
    log: (строка) => console.log(`  ${строка}`),
  });
  console.log(`Готово: курс «${место.course}», лекция ${место.number}, разделов — ${место.sections}, итог — ${место.summary ? 'есть' : 'нет'}: ${место.notesFile}`);
}

main().catch((error: unknown) => {
  console.error(`Не вышло: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
