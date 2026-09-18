/**
 * `pnpm run jarvis:setup`
 *
 * The onboarding step the Windows installer runs at the end, and the command a
 * user runs again when something needs re-checking. It inspects the machine,
 * prints what it is about to do, downloads the speech models and reports which
 * coding backends are available.
 *
 * It never fails because a subscription CLI is missing — that is a note, not an
 * error.
 */

import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  buildOnboardingPlan,
  formatBytes,
  readMachineFacts,
  renderGettingStarted,
  renderOnboardingPlan,
  type CliStatus,
} from '../jarvis/setup/onboarding';
import {
  WHISPER_MODEL_IDS,
  type WhisperModelId,
} from '../jarvis/voice/sttModels';
import { installWhisperModel } from '../jarvis/voice/whisperInstall';
import { isWhisperModelInstalled } from '../jarvis/voice/whisperRecognizer';

const PUSH_TO_TALK_HOTKEY = process.platform === 'darwin' ? '⌥ Space' : 'Ctrl + Space';

function userDataRoot(): string {
  if (process.env.JARVIS_DATA_ROOT) return path.resolve(process.env.JARVIS_DATA_ROOT);
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Interpreter');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Interpreter');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Interpreter');
}

async function probeCli(command: string): Promise<CliStatus> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync(command, ['--version'], {
      timeout: 10_000,
      encoding: 'utf-8',
    });
    return { installed: true, loggedIn: await probeLogin(command), version: stdout.trim() };
  } catch {
    return { installed: false, loggedIn: false };
  }
}

/**
 * Login check.
 *
 * Deliberately shallow: it looks for the vendor's own credential file and
 * never reads, parses or copies what is inside it.
 */
async function probeLogin(command: string): Promise<boolean> {
  const { existsSync, statSync } = await import('node:fs');
  if (command === 'claude') {
    if (process.platform === 'darwin') {
      // The macOS credential lives in the Keychain; assume signed in and let
      // the first real run report otherwise.
      return true;
    }
    const credentials = path.join(os.homedir(), '.claude', '.credentials.json');
    return existsSync(credentials) && statSync(credentials).size > 2;
  }
  if (command === 'codex') {
    const auth = path.join(os.homedir(), '.codex', 'auth.json');
    return existsSync(auth) && statSync(auth).size > 2;
  }
  return false;
}

function parseRequestedModel(): WhisperModelId | undefined {
  const flagIndex = process.argv.indexOf('--model');
  const value = flagIndex === -1 ? process.env.JARVIS_WHISPER_MODEL : process.argv[flagIndex + 1];
  if (value && (WHISPER_MODEL_IDS as readonly string[]).includes(value)) {
    return value as WhisperModelId;
  }
  return undefined;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const whisperRoot = path.join(userDataRoot(), 'whisper-models');

  const [claude, codex] = await Promise.all([probeCli('claude'), probeCli('codex')]);

  const installed: WhisperModelId[] = [];
  for (const id of WHISPER_MODEL_IDS) {
    if (await isWhisperModelInstalled(whisperRoot, id)) installed.push(id);
  }

  const plan = buildOnboardingPlan({
    machine: readMachineFacts(),
    claude,
    codex,
    installedWhisperModels: installed,
    // The Russian voice is installed by the app's own TTS model manager on
    // first speech; setup only reports whether it is already there.
    ttsVoiceInstalled: false,
    requestedWhisperModel: parseRequestedModel(),
  });

  console.log(renderOnboardingPlan(plan));

  if (dryRun) {
    console.log('\n(--dry-run: ничего не скачивается)');
    return;
  }

  const needsWhisper = plan.steps.some((step) => step.id.startsWith('whisper:'));
  if (needsWhisper) {
    console.log('');
    let lastPercent = -1;
    await installWhisperModel({
      installRoot: whisperRoot,
      modelId: plan.whisperModel,
      onProgress: (progress) => {
        if (progress.stage === 'downloading' && progress.ratio !== undefined) {
          const percent = Math.floor(progress.ratio * 100);
          if (percent !== lastPercent && percent % 5 === 0) {
            lastPercent = percent;
            const received = formatBytes(progress.receivedBytes ?? 0);
            process.stdout.write(`\rСкачиваю модель: ${percent}% (${received})   `);
          }
          return;
        }
        if (progress.stage === 'extracting') process.stdout.write('\rРаспаковываю модель…          ');
        if (progress.stage === 'complete') process.stdout.write('\rМодель распознавания готова.  \n');
        if (progress.stage === 'error') process.stdout.write(`\rОшибка: ${progress.message}\n`);
      },
    });
  }

  console.log(renderGettingStarted(PUSH_TO_TALK_HOTKEY));
}

main().catch((error: unknown) => {
  console.error('Настройка прервана:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
