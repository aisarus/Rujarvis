/**
 * Дописать конспект лекции, которую не закончили: `pnpm jarvis:lecture-finish [-- заметка.md]`.
 *
 * Без аргумента — последняя недописанная лекция в папке лекций (хранилище
 * Obsidian или папка результатов). Разделы и итог — Claude Code по подписке
 * по сохранённой расшифровке; заголовок звука — по настоящему размеру файла.
 */
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

import { finishFromTranscript } from '../jarvis/lecture/finishFromTranscript';
import { createClaudeSummarizer } from '../jarvis/lecture/summarize';
import { lectureFolder } from '../jarvis/lecture/vault';
import { jarvisOutputDir, jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore } from '../jarvis/setup/settings';

/** Заголовок WAV по размеру файла: 16 бит, моно, 16 кГц — как пишет сессия. */
function починитьЗвук(файл: string): void {
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
  } catch {
    // Звука нет — конспект дописывается и без него.
  }
}

async function main(): Promise<void> {
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings).get();
  const notes = settings.language;
  const lectureLanguage = settings.lectureLanguage || settings.language;
  const итогЗаголовок = notes === 'en' ? '## Summary' : '## Кратко';

  let заметка = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!заметка) {
    const { folder } = lectureFolder(settings.outputDir || jarvisOutputDir(), notes);
    const кандидаты = readdirSync(folder)
      .filter((f) => f.endsWith('.md') && !/ — (расшифровка|transcript)\.md$/u.test(f))
      .map((f) => path.join(folder, f))
      .filter((f) => !readFileSync(f, 'utf8').includes(итогЗаголовок))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    заметка = кандидаты[0];
    if (!заметка) {
      console.log(`Недописанных лекций в ${folder} нет.`);
      return;
    }
  }

  console.log(`Дописываю: ${заметка} (лекция на «${lectureLanguage}», конспект на «${notes}»)`);
  починитьЗвук(заметка.replace(/\.md$/u, '.wav'));
  const итог = await finishFromTranscript({
    notesFile: заметка,
    summarize: createClaudeSummarizer(),
    lectureLanguage,
    notesLanguage: notes,
    log: (строка) => console.log(`  ${строка}`),
  });
  console.log(
    итог.skipped ? `Ничего не сделано: ${итог.skipped}.` : `Готово: разделов — ${итог.sections}, итог — ${итог.summary ? 'есть' : 'нет'}.`,
  );
}

main().catch((error: unknown) => {
  console.error(`Не вышло: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
