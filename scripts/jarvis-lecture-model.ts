/**
 * Поставить модель для конспектов лекций на иврите: `pnpm jarvis:lecture-model`.
 *
 * ivrit.ai large-v3-turbo (1,6 ГБ, Apache-2.0) — скачать, сверить по sha256,
 * сжать у себя до q5_0 (около полугигабайта видеопамяти), исходник стереть. Нужно
 * уже поставленное распознавание на видеокарте (`pnpm jarvis:gpu-stt`): модель
 * сжимает его утилита и слушает его сервер.
 */
import { jarvisPaths } from '../jarvis/setup/paths';
import { gpuWhisperDir, installHebrewWhisper } from '../jarvis/voice/gpuWhisper';

async function main(): Promise<void> {
  const dir = gpuWhisperDir(jarvisPaths().home);
  console.log(`Модель для лекций на иврите (ivrit.ai large-v3-turbo) → ${dir}`);
  let последняя = '';
  const файл = await installHebrewWhisper({
    dir,
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
