/**
 * Строки интерфейса приложения: трей, настройки, онбординг.
 *
 * Два языка, один набор ключей. Контракт проверяется тестом: ключ, которого
 * нет в одном из языков, — это пустая кнопка, которую никто не заметит.
 */

import type { Language } from '../../jarvis/setup/settings';

const ru = {
  trayListening: 'слушаю',
  trayNotListening: 'не слушаю — пройдите настройку',
  trayVoiceFailed: 'голос не запустился',
  trayEvents: 'Окно событий',
  traySettings: 'Настройки…',
  trayOpenLog: 'Открыть лог',
  trayOpenData: 'Открыть папку Джарвиса',
  trayRestartVoice: 'Перезапустить голос',
  trayQuit: 'Выйти',

  windowTitle: 'Rujarvis — настройки',
  onboardingTitle: 'Добро пожаловать',
  onboardingIntro:
    'Джарвис — голосовой помощник для Windows. Он слушает, понимает обычную речь и работает руками Claude Code по вашей подписке. Настройка займёт пару минут.',
  next: 'Далее',
  back: 'Назад',
  finish: 'Начать',
  skip: 'Пропустить',
  done: 'Готово',
  retry: 'Повторить',
  check: 'Проверить',
  open: 'Открыть',
  change: 'Изменить',
  reset: 'По умолчанию',

  stepLanguage: 'Язык',
  stepLanguageHint: 'На каком языке вы будете говорить с Джарвисом. Сменить можно в любой момент.',
  stepAgent: 'Claude Code',
  stepAgentHint:
    'Работу — код, файлы, экран, браузер — делает Claude Code по вашей подписке. Джарвис не хранит ключей и не читает токены: вход выполняется в самом Claude Code.',
  stepModels: 'Слух и голос',
  stepModelsHint: 'Распознавание и синтез речи работают на вашем компьютере. Модели скачиваются один раз.',
  stepMic: 'Микрофон',
  stepMicHint: 'Скажите что-нибудь: полоска должна двигаться.',
  stepReady: 'Всё готово',
  stepReadyHint: 'Нажмите Ctrl + Space, скажите, нажмите ещё раз — или просто скажите «Джарвис». «Стоп» останавливает работу, «тишина» — речь.',

  agentInstalled: 'установлен',
  agentMissing: 'не найден',
  agentSignedIn: 'вход выполнен',
  agentSignedOut: 'вход не выполнен',
  agentUnknown: 'вход не подтверждён',
  agentInstallHint: 'Установите Claude Code: https://claude.ai/code — затем нажмите «Проверить».',
  agentSignIn: 'Войти',
  agentSignInHint: 'Откроется окно терминала. Войдите в аккаунт и вернитесь сюда.',
  codexOptional: 'Codex (необязательно)',

  whisperModel: 'Модель распознавания',
  voice: 'Голос',
  download: 'Скачать',
  downloading: 'Скачиваю',
  extracting: 'Распаковываю',
  installed: 'установлена',
  notInstalled: 'не установлена',
  voiceTest: 'Послушать',
  micDenied: 'Нет доступа к микрофону. Разрешите его в параметрах Windows → Конфиденциальность → Микрофон.',
  micLevel: 'Уровень',

  tabGeneral: 'Общие',
  tabVoice: 'Речь',
  tabAgents: 'Агенты',
  tabFolders: 'Папки и лог',
  tabKeys: 'Команды',

  language: 'Язык',
  claudeModel: 'Модель Claude Code',
  claudeModelHint: 'Пусто — модель по умолчанию в самом Claude Code. Например: opus, sonnet.',
  workspace: 'Рабочая папка',
  workspaceHint: 'Где агент работает по умолчанию. Пусто — папка результатов.',
  outputDir: 'Папка результатов',
  outputDirHint: 'Сюда Джарвис кладёт готовые файлы.',
  dataDir: 'Папка Джарвиса',
  dataDirHint: 'Настройки, журнал, память, модели и лог.',
  logFile: 'Лог',
  speechLogging: 'Что из речи писать в лог',
  speechLoggingOff: 'Ничего из сказанного',
  speechLoggingCommands: 'Только команды Джарвису',
  speechLoggingAll: 'Всё, включая фон и диктовку',
  speechLoggingHint: '«Всё» полезно, когда Джарвис не слышит: видно, что именно распознано. В лог попадут и разговоры рядом, и продиктованное.',

  keysTitle: 'Горячие клавиши и главные слова',
  keyPushToTalk: 'Нажать, сказать, нажать ещё раз',
  keyMute: 'Выключить / включить микрофон',
  wordWake: 'Обращение',
  wordStop: 'Остановить работу',
  wordSilence: 'Замолчать и перестать слушать',
  redLinesTitle: 'Что Джарвис всегда спрашивает',
  redLines:
    'Трата денег, сообщения другим людям, изменение системных файлов и опасные команды — перед каждым таким действием агента Джарвис спрашивает вас голосом. Без ответа — не делает.',

  saved: 'Сохранено',
  restartNote: 'Голос перезапустится с новыми настройками.',
} as const;

export type UiStrings = { [K in keyof typeof ru]: string };

const en: UiStrings = {
  trayListening: 'listening',
  trayNotListening: 'not listening — finish setup',
  trayVoiceFailed: 'voice failed to start',
  trayEvents: 'Events window',
  traySettings: 'Settings…',
  trayOpenLog: 'Open log',
  trayOpenData: 'Open Jarvis folder',
  trayRestartVoice: 'Restart voice',
  trayQuit: 'Quit',

  windowTitle: 'Rujarvis — settings',
  onboardingTitle: 'Welcome',
  onboardingIntro:
    'Jarvis is a voice assistant for Windows. It listens, understands plain speech and gets work done with Claude Code on your own subscription. Setup takes a couple of minutes.',
  next: 'Next',
  back: 'Back',
  finish: 'Start',
  skip: 'Skip',
  done: 'Done',
  retry: 'Retry',
  check: 'Check',
  open: 'Open',
  change: 'Change',
  reset: 'Default',

  stepLanguage: 'Language',
  stepLanguageHint: 'The language you will speak to Jarvis in. You can change it any time.',
  stepAgent: 'Claude Code',
  stepAgentHint:
    'The work — code, files, screen, browser — is done by Claude Code on your subscription. Jarvis stores no keys and reads no tokens: you sign in inside Claude Code itself.',
  stepModels: 'Hearing and voice',
  stepModelsHint: 'Speech recognition and synthesis run on your computer. Models are downloaded once.',
  stepMic: 'Microphone',
  stepMicHint: 'Say something: the bar should move.',
  stepReady: 'All set',
  stepReadyHint: 'Press Ctrl + Space, speak, press it again — or just say "Jarvis". "Stop" stops the work, "silence" stops the talking.',

  agentInstalled: 'installed',
  agentMissing: 'not found',
  agentSignedIn: 'signed in',
  agentSignedOut: 'not signed in',
  agentUnknown: 'sign-in not confirmed',
  agentInstallHint: 'Install Claude Code: https://claude.ai/code — then press "Check".',
  agentSignIn: 'Sign in',
  agentSignInHint: 'A terminal window opens. Sign in there and come back.',
  codexOptional: 'Codex (optional)',

  whisperModel: 'Recognition model',
  voice: 'Voice',
  download: 'Download',
  downloading: 'Downloading',
  extracting: 'Unpacking',
  installed: 'installed',
  notInstalled: 'not installed',
  voiceTest: 'Listen',
  micDenied: 'No microphone access. Allow it in Windows Settings → Privacy → Microphone.',
  micLevel: 'Level',

  tabGeneral: 'General',
  tabVoice: 'Speech',
  tabAgents: 'Agents',
  tabFolders: 'Folders and log',
  tabKeys: 'Commands',

  language: 'Language',
  claudeModel: 'Claude Code model',
  claudeModelHint: 'Empty — Claude Code\'s own default. For example: opus, sonnet.',
  workspace: 'Working folder',
  workspaceHint: 'Where the agent works by default. Empty — the results folder.',
  outputDir: 'Results folder',
  outputDirHint: 'Where Jarvis puts finished files.',
  dataDir: 'Jarvis folder',
  dataDirHint: 'Settings, journal, memory, models and the log.',
  logFile: 'Log',
  speechLogging: 'What speech goes into the log',
  speechLoggingOff: 'Nothing that was said',
  speechLoggingCommands: 'Only commands to Jarvis',
  speechLoggingAll: 'Everything, including background and dictation',
  speechLoggingHint: '"Everything" helps when Jarvis mishears: you see exactly what was recognised. Nearby conversations and dictated text will be logged too.',

  keysTitle: 'Hotkeys and key words',
  keyPushToTalk: 'Press, speak, press again',
  keyMute: 'Mute / unmute the microphone',
  wordWake: 'Wake word',
  wordStop: 'Stop the work',
  wordSilence: 'Stop talking and listening',
  redLinesTitle: 'What Jarvis always asks about',
  redLines:
    'Spending money, messaging other people, changing system files and dangerous commands — before every such agent action Jarvis asks you by voice. No answer means no.',

  saved: 'Saved',
  restartNote: 'Voice will restart with the new settings.',
};

export function uiStrings(language: Language): UiStrings {
  return language === 'en' ? en : ru;
}

export const UI_STRINGS = { ru: ru as UiStrings, en };
