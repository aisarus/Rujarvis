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
 * `--edition notes` — вариант «только конспекты»: модели команд и голос ему не
 * нужны и не качаются (распознавание лекций ставят `jarvis:gpu-stt` и
 * `jarvis:lecture-model`). Без ключа вариант берётся из настроек: повторный
 * запуск установщика — это обновление, и оно не должно менять выбор человека.
 *
 *     pnpm jarvis:setup
 *     pnpm jarvis:setup -- --language en --model small
 *     pnpm jarvis:setup -- --edition notes
 *     pnpm jarvis:setup -- --dry-run
 */

import { existsSync } from 'node:fs';
import process from 'node:process';

import { cliStatus } from '../jarvis/backends/cliProbes';
import type { Language } from '../jarvis/locale/language';
import { formatBytes, readMachineFacts } from '../jarvis/setup/onboarding';
import { jarvisPaths } from '../jarvis/setup/paths';
import { SettingsStore, type Edition } from '../jarvis/setup/settings';
import { getWhisperModel, recommendWhisperModel, WHISPER_MODEL_IDS, type WhisperModelId } from '../jarvis/voice/sttModels';
import type { ModelInstallProgress } from '../jarvis/voice/modelArchive';
import { getVoice, installVoice, isVoiceInstalled, voiceForLanguage } from '../jarvis/voice/tts';
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
  // Повторный запуск установщика — это и есть обновление. Раньше без `--model`
  // здесь всегда стояла рекомендованная модель, и каждое обновление молча
  // меняло распознавание, выбранное человеком в настройках. Теперь выбор из
  // настроек сохраняется; рекомендация — только для новой установки.
  const askedModel = flag('--model') ?? process.env.JARVIS_WHISPER_MODEL ?? (existsSync(paths.settings) ? settings.get().whisperModel : undefined);
  const model: WhisperModelId = (WHISPER_MODEL_IDS as readonly string[]).includes(askedModel ?? '')
    ? (askedModel as WhisperModelId)
    : recommendWhisperModel({ totalRamMb: machine.totalRamMb, hasGpu: machine.hasGpu });
  // Голос человека не трогаем, если он на нужном языке.
  //
  // Раньше здесь всегда стоял голос по умолчанию, и повторный запуск —
  // например, `pnpm jarvis:setup -- --model small` ради смены распознавания —
  // возвращал выбравшему Дмитрия обратно Ирину. Шапка файла сама предлагает
  // запускать настройку руками; она не должна отменять чужой выбор.
  const voiceId = voiceForLanguage(language, settings.get().voiceId);
  const askedEdition = flag('--edition');
  const edition: Edition = askedEdition === 'notes' || askedEdition === 'full' ? askedEdition : settings.get().edition;
  const конспекты = edition === 'notes';

  console.log(`Папка Джарвиса: ${paths.home}`);
  console.log(`Вариант: ${конспекты ? 'только конспекты' : 'Джарвис целиком'}`);
  console.log(`Язык: ${language === 'en' ? 'English' : 'русский'}`);
  if (!конспекты) {
    console.log(`Распознавание: whisper-${model} (${formatBytes(getWhisperModel(model).downloadBytes)})`);
    console.log(`Голос: ${getVoice(voiceId).label}`);
  }

  // Конспекту, «Учёбе» и разбору документов нужен один из двух: Claude Code или Codex.
  const [claude, codex] = await Promise.all([cliStatus('claude'), cliStatus('codex')]);
  const строка = (имя: string, s: typeof claude, войти: string): string =>
    s.installed ? `${имя}: ${s.version ?? 'установлен'}${s.loggedIn ? '' : ` — войдите: ${войти}`}` : `${имя}: не найден`;
  console.log(строка('Claude Code', claude, 'claude auth login'));
  console.log(строка('Codex', codex, 'codex login'));
  if (!claude.installed && !codex.installed) {
    console.log('Ни Claude Code, ни Codex не найдены — без них Джарвис только записывает. Поставьте один: https://claude.ai/code или npm i -g @openai/codex');
  }

  if (dryRun) {
    console.log('\n(--dry-run: ничего не скачивается)');
    return;
  }

  console.log('');
  if (конспекты) {
    console.log('    модели команд и голос: варианту «только конспекты» не нужны.');
  } else {
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
  }

  // Выбор — в настройки: окно настроек и мост увидят его сразу. Онбординг
  // остаётся непройденным: вход в Claude Code и микрофон человек проверит сам.
  settings.update({ language, whisperModel: model, voiceId, edition });
  console.log(`\nНастройки: ${paths.settings}`);
}

main().catch((error: unknown) => {
  console.error('Настройка прервана:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
