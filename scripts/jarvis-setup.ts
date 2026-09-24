/**
 * `pnpm jarvis:setup` — скачать модели заранее.
 *
 * Установщик зовёт его в конце, чтобы после первого запуска всё уже было на
 * месте и онбординг не ждал загрузки. Можно звать и руками, чтобы сменить
 * модель. Ставит модель распознавания (по объёму памяти или `--model`) и голос
 * для языка (`--language ru|en`), и записывает выбор в настройки — окно
 * настроек увидит его сразу.
 *
 * Не падает из-за отсутствующего Claude Code: это заметка, а не ошибка.
 *
 *     pnpm jarvis:setup
 *     pnpm jarvis:setup -- --language en --model small
 *     pnpm jarvis:setup -- --dry-run
 */

import process from 'node:process';

import { cliStatus } from '../jarvis/backends/cliProbes';
import type { Language } from '../jarvis/locale/language';
import { formatBytes, readMachineFacts } from '../jarvis/setup/onboarding';
import { jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore } from '../jarvis/setup/settings';
import { getWhisperModel, recommendWhisperModel, WHISPER_MODEL_IDS, type WhisperModelId } from '../jarvis/voice/sttModels';
import type { ModelInstallProgress } from '../jarvis/voice/modelArchive';
import { DEFAULT_VOICE, getVoice, installVoice, isVoiceInstalled } from '../jarvis/voice/tts';
import { installWhisperModel } from '../jarvis/voice/whisperInstall';
import { isWhisperModelInstalled } from '../jarvis/voice/whisperRecognizer';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function progressPrinter(what: string): (progress: ModelInstallProgress) => void {
  let last = -1;
  return (progress) => {
    if (progress.stage === 'downloading' && progress.ratio !== undefined) {
      const percent = Math.floor(progress.ratio * 100);
      if (percent !== last && percent % 5 === 0) {
        last = percent;
        process.stdout.write(`\r    ${what}: ${percent}% (${formatBytes(progress.receivedBytes ?? 0)})   `);
      }
    } else if (progress.stage === 'extracting') {
      process.stdout.write(`\r    ${what}: распаковываю…            `);
    } else if (progress.stage === 'complete') {
      process.stdout.write(`\r    ${what}: готово.                  \n`);
    } else if (progress.stage === 'error') {
      process.stdout.write(`\r    ${what}: ошибка — ${progress.message}\n`);
    }
  };
}

async function main(): Promise<void> {
  const paths = jarvisPaths();
  const settings = new SettingsStore(paths.settings);
  const dryRun = process.argv.includes('--dry-run');

  const language: Language = (flag('--language') ?? settings.get().language) === 'en' ? 'en' : 'ru';
  const machine = readMachineFacts();
  const askedModel = flag('--model') ?? process.env.JARVIS_WHISPER_MODEL;
  const model: WhisperModelId = (WHISPER_MODEL_IDS as readonly string[]).includes(askedModel ?? '')
    ? (askedModel as WhisperModelId)
    : recommendWhisperModel({ totalRamMb: machine.totalRamMb, hasGpu: machine.hasGpu });
  const voiceId = DEFAULT_VOICE[language];

  console.log(`Папка Джарвиса: ${paths.home}`);
  console.log(`Язык: ${language === 'en' ? 'English' : 'русский'}`);
  console.log(`Распознавание: whisper-${model} (${formatBytes(getWhisperModel(model).downloadBytes)})`);
  console.log(`Голос: ${getVoice(voiceId).label}`);

  const claude = await cliStatus('claude');
  console.log(
    claude.installed
      ? `Claude Code: ${claude.version ?? 'установлен'}${claude.loggedIn ? '' : ' — войдите: claude auth login'}`
      : 'Claude Code не найден — установите его с https://claude.ai/code, без него Джарвис только слушает.',
  );

  if (dryRun) {
    console.log('\n(--dry-run: ничего не скачивается)');
    return;
  }

  console.log('');
  if (!(await isWhisperModelInstalled(paths.whisperModels, model))) {
    await installWhisperModel({ installRoot: paths.whisperModels, modelId: model, onProgress: progressPrinter('распознавание') });
  } else {
    console.log('    распознавание: уже установлено.');
  }
  if (!isVoiceInstalled(paths.voiceModels, voiceId)) {
    await installVoice(paths.voiceModels, voiceId, progressPrinter('голос'));
  } else {
    console.log('    голос: уже установлен.');
  }

  // Выбор — в настройки: окно настроек и мост увидят его сразу. Онбординг
  // остаётся непройденным: вход в Claude Code и микрофон человек проверит сам.
  settings.update({ language, whisperModel: model, voiceId });
  console.log(`\nНастройки: ${paths.settings}`);
}

main().catch((error: unknown) => {
  console.error('Настройка прервана:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
