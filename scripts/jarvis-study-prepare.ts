/**
 * Заготовить учёбу по лекциям: `pnpm jarvis:study-prepare [-- заметка.md] [--again]`.
 *
 * Без аргумента — все лекции в папке лекций, у которых банка ещё нет
 * (`--again` — заново и те, у которых есть). Вопросы, карточки и задачи
 * пишет Claude Code по подписке; банк ложится в папку данных Джарвиса
 * (`data\study\<курс>\`), в хранилище Obsidian ничего не пишется.
 */

import path from 'node:path';

import { listCourses, listLectures } from '../jarvis/lecture/courses';
import { createClaudeSummarizer } from '../jarvis/lecture/summarize';
import { lectureFolder } from '../jarvis/lecture/vault';
import { jarvisOutputDir, jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore } from '../jarvis/setup/settings';
import { prepareLecture } from '../jarvis/study/prepare';
import { studyRoot } from '../jarvis/study/service';
import { StudyStore } from '../jarvis/study/store';

async function main(): Promise<void> {
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings).get();
  const notes = settings.language;
  const lectureLanguage = settings.lectureLanguage || settings.language;
  const store = new StudyStore(studyRoot(paths.data));
  const заново = process.argv.includes('--again');

  let заметки = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (заметки.length === 0) {
    const результаты = settings.outputDir || jarvisOutputDir(process.env, undefined, notes === 'en' ? 'Jarvis' : 'Джарвис');
    const { folder } = lectureFolder(результаты, notes);
    заметки = listCourses(folder)
      .flatMap((курс) => listLectures(folder, курс))
      .filter((л) => заново || !store.hasBank(л.meta.course, path.basename(л.file, '.md')))
      .map((л) => л.file);
    if (заметки.length === 0) {
      console.log(`Все лекции в ${folder} уже заготовлены (заново — --again).`);
      return;
    }
  }

  let провалов = 0;
  for (const заметка of заметки) {
    const t0 = Date.now();
    console.log(`Заготавливаю: ${path.basename(заметка)}`);
    try {
      const итог = await prepareLecture(заметка, store, {
        summarize: createClaudeSummarizer(),
        lectureLanguage,
        notes,
        log: (строка) => console.log(`  ${строка}`),
      });
      if (!итог) {
        console.log('  в конспекте нет разделов с материалом — заготавливать нечего');
        continue;
      }
      console.log(`  ${итог.course}: вопросов ${итог.questions}, карточек ${итог.cards}, задач ${итог.tasks} — за ${Math.round((Date.now() - t0) / 1000)} с`);
      for (const w of итог.warnings) console.log(`  отброшено: ${w}`);
    } catch (error) {
      провалов += 1;
      console.log(`  не вышло: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exitCode = провалов > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(`Не вышло: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
