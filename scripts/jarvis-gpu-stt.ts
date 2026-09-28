/**
 * Поставить распознавание на видеокарте: `pnpm jarvis:gpu-stt`.
 *
 * Windows — сборка whisper.cpp с CUDA (около 260 МБ) и модель small
 * (около 250 МБ); мак — `brew install whisper-cpp` и та же модель. Всё — в
 * папку Джарвиса (`models/whisper-gpu`), скачанное сверяется по контрольной
 * сумме. Мост поднимает сервер сам, когда найдёт установленное.
 */
import { jarvisPaths } from '../jarvis/setup/paths';
import { GPU_WHISPER_MODEL, gpuWhisperDir, installGpuWhisper } from '../jarvis/voice/gpuWhisper';

async function main(): Promise<void> {
  const dir = gpuWhisperDir(jarvisPaths().home);
  console.log(`Распознавание на видеокарте: whisper.cpp и модель ${GPU_WHISPER_MODEL.name} → ${dir}`);
  let последняя = '';
  const files = await installGpuWhisper({
    dir,
    onProgress: (что, p) => {
      const строка =
        p.stage === 'downloading' && typeof p.ratio === 'number'
          ? `${что}: ${Math.floor(p.ratio * 10) * 10}%`
          : `${что}: ${p.message ?? p.stage}`;
      if (строка !== последняя) console.log(`  ${строка}`);
      последняя = строка;
    },
  });
  console.log(`Готово. Сервер: ${files.server}`);
  console.log(`Модель: ${files.model}`);
}

main().catch((error: unknown) => {
  console.error(`Не поставилось: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
