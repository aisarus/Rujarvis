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
  const settings = new SettingsStore(paths.settings).get();
  const language = (process.argv.slice(2).find((a) => !a.startsWith('-')) ?? (settings.lectureLanguage || settings.language)).toLowerCase();
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
