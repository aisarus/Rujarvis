/**
 * Поставить модель для конспекта лекций: `pnpm jarvis:lecture-model [-- язык]`.
 *
 * Язык — из аргумента, иначе из настроек (`lectureLanguage`, пусто — язык
 * интерфейса). По умолчанию ставится large-v3-turbo q5_0 (574 МБ); языку со
 * своей дообученной моделью — она (см. `LECTURE_MODELS` в
 * jarvis/voice/gpuWhisper.ts). Нужно уже поставленное распознавание на
 * видеокарте (`pnpm jarvis:gpu-stt`): модель слушает его сервер.
 */
import path from 'node:path';

import { jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore } from '../jarvis/setup/settings';
import { gpuWhisperDir, installLectureModel, lectureModelFor } from '../jarvis/voice/gpuWhisper';

async function main(): Promise<void> {
  const paths = jarvisPaths();
  const store = new SettingsStore(paths.settings);
  const settings = store.get();
  const названный = process.argv.slice(2).find((a) => !a.startsWith('-'))?.toLowerCase();
  const language = (названный ?? (settings.lectureLanguage || settings.language)).toLowerCase();
  // Язык назван явно — это и есть язык лекций: модель для иврита ставят под
  // лекции на иврите. Установщик (`-LectureLanguage he`) больше ничего не
  // делает, и без этой строки Джарвис слушал бы лекцию на языке интерфейса.
  if (названный && /^[a-z]{2,3}$/u.test(названный) && settings.lectureLanguage !== названный) {
    store.update({ lectureLanguage: названный });
    console.log(`Язык лекций в настройках: «${названный}»`);
  }
  const dir = gpuWhisperDir(paths.home);
  const source = lectureModelFor(language);
  console.log(`Модель для лекций (язык «${language}»): ${path.basename(source.file)} → ${dir}`);
  let последняя = '';
  const файл = await installLectureModel({
    dir,
    language,
    onProgress: (_что, p) => {
      const строка =
        p.stage === 'downloading' && typeof p.ratio === 'number'
          ? `загрузка: ${Math.floor(p.ratio * 10) * 10}%`
          : `${p.message ?? p.stage}`;
      if (строка !== последняя) console.log(`  ${строка}`);
      последняя = строка;
    },
  });
  console.log(`Готово: ${файл}`);
}

main().catch((error: unknown) => {
  console.error(`Не поставилось: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
