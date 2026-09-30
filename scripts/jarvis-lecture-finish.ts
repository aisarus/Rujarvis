/**
 * Дописать конспект лекции, которую не закончили: `pnpm jarvis:lecture-finish [-- заметка.md]`.
 *
 * Без аргумента — последняя недописанная лекция в папке лекций (хранилище
 * Obsidian или папка результатов) — в самой папке или в папке курса. Разделы
 * и итог — Claude Code по подписке по сохранённой расшифровке; заголовок
 * звука — по настоящему размеру файла. Дальше — как у законченной лекции:
 * курс, тема в имени, свойства, страница курса (`finalizeLecture`).
 */
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

import { listCourses } from '../jarvis/lecture/courses';
import { finalizeLecture } from '../jarvis/lecture/finalize';
import { finishFromTranscript } from '../jarvis/lecture/finishFromTranscript';
import { createClaudeSummarizer } from '../jarvis/lecture/summarize';
import { lectureFolder } from '../jarvis/lecture/vault';
import { jarvisOutputDir, jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore } from '../jarvis/setup/settings';

/** Заголовок WAV по размеру файла: 16 бит, моно, 16 кГц — как пишет сессия. Возвращает секунды звука. */
function починитьЗвук(файл: string): number {
  try {
    const данные = Math.max(0, statSync(файл).size - 44);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0, 'ascii');
    h.writeUInt32LE(36 + данные, 4);
    h.write('WAVE', 8, 'ascii');
    h.write('fmt ', 12, 'ascii');
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(16_000, 24);
    h.writeUInt32LE(32_000, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36, 'ascii');
    h.writeUInt32LE(данные, 40);
    const fd = openSync(файл, 'r+');
    try {
      writeSync(fd, h, 0, 44, 0);
    } finally {
      closeSync(fd);
    }
    console.log(`  звук: ${path.basename(файл)}, ${(данные / 32_000 / 60).toFixed(1)} мин`);
    return данные / 32_000;
  } catch {
    // Звука нет — конспект дописывается и без него.
    return 0;
  }
}

/** Когда шла лекция: из временного имени «2026-09-29 1005 …», иначе — время файла. */
function когдаБыла(заметка: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2})(\d{2}))?/u.exec(path.basename(заметка));
  if (m && m[4]) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return new Date(statSync(заметка).birthtimeMs || statSync(заметка).mtimeMs);
}

async function main(): Promise<void> {
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings).get();
  const notes = settings.language;
  const lectureLanguage = settings.lectureLanguage || settings.language;
  const итогЗаголовок = notes === 'en' ? '## Summary' : '## Кратко';

  let заметка = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!заметка) {
    // Папка результатов — как у приложения: «Jarvis» у английского интерфейса.
    // Рабочий стол, перенесённый в OneDrive, скрипт без Electron не знает —
    // тогда путь к заметке передаётся аргументом.
    const результаты =
      settings.outputDir || jarvisOutputDir(process.env, undefined, notes === 'en' ? 'Jarvis' : 'Джарвис');
    const { folder } = lectureFolder(результаты, notes);
    // Недописанная лежит в самой папке лекций или в папке своего курса.
    const папки = [folder, ...listCourses(folder).map((курс) => path.join(folder, курс))];
    const кандидаты = папки
      .flatMap((папка) =>
        readdirSync(папка)
          .filter((f) => f.endsWith('.md') && !/ — (расшифровка|transcript)\.md$/u.test(f) && f !== `${path.basename(папка)}.md`)
          .map((f) => path.join(папка, f)),
      )
      .filter((f) => !readFileSync(f, 'utf8').includes(итогЗаголовок))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    заметка = кандидаты[0];
    if (!заметка) {
      console.log(`Недописанных лекций в ${folder} нет.`);
      return;
    }
  }

  console.log(`Дописываю: ${заметка} (лекция на «${lectureLanguage}», конспект на «${notes}»)`);
  const секунд = починитьЗвук(заметка.replace(/\.md$/u, '.wav'));
  const результаты = settings.outputDir || jarvisOutputDir(process.env, undefined, notes === 'en' ? 'Jarvis' : 'Джарвис');
  const { folder: root } = lectureFolder(результаты, notes);
  const итог = await finishFromTranscript({
    notesFile: заметка,
    summarize: createClaudeSummarizer(),
    lectureLanguage,
    notesLanguage: notes,
    courses: listCourses(root),
    log: (строка) => console.log(`  ${строка}`),
  });
  if (итог.skipped) {
    console.log(`Ничего не сделано: ${итог.skipped}.`);
    return;
  }
  console.log(`Дописано: разделов — ${итог.sections}, итог — ${итог.summary ? 'есть' : 'нет'}.`);
  // Лежит в папке курса — этот курс и есть выбранный; в самой папке лекций — решает модель.
  const папка = path.relative(root, path.dirname(заметка));
  const курс = папка && !папка.startsWith('..') && !path.isAbsolute(папка) ? папка : null;
  const база = заметка.replace(/\.md$/u, '');
  const место = await finalizeLecture({
    root,
    notesFile: заметка,
    transcriptFile: `${база} — ${notes === 'en' ? 'transcript' : 'расшифровка'}.md`,
    audioFile: `${база}.wav`,
    notes,
    when: когдаБыла(заметка),
    durationSec: секунд,
    course: курс,
    modelCourse: итог.course,
    topic: итог.topic,
  });
  console.log(`Готово: курс «${место.course}», лекция ${место.number} — ${место.notesFile}`);
}

main().catch((error: unknown) => {
  console.error(`Не вышло: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
