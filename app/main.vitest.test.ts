import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Второй запуск при работающем первом.
 *
 * `app.quit()` не прерывает загрузку модуля: `whenReady` всё равно
 * срабатывает, и второй экземпляр успевает сделать то, ради чего лок и
 * брался. Замер 25.09.2026 на Windows, второй запуск при живом первом: в
 * трее появился второй значок, в общий `jarvis.log` дописался заголовок
 * запуска, открылось окно звука — то есть второй полез за микрофоном, пока
 * первый уже слушал. Остановило его только то, что профиль Electron оказался
 * занят («Unable to move the cache: Отказано в доступе»), а это случайность.
 */

const стенд = vi.hoisted(() => ({
  лок: true,
  трееПоявилось: 0,
  голосЗапущен: 0,
  микрофонПереключен: 0,
  готово: null as null | (() => void),
  подсказка: '',
  настройкиОкна: null as null | { settings: { update(patch: { language: 'ru' | 'en' }): unknown }; onSettingsChanged(changed: string[]): void },
  меню: [] as Array<{ label?: string; click?: () => void }>,
  вышел: 0,
  лекция: 'off' as string,
  ответ: 0,
  вопросов: 0,
  законченоЛекций: 0,
  слушательЛекции: null as null | ((state: string) => void),
}));

/**
 * Чтение в обход сужения типов.
 *
 * Поля стенда заполняет уже загруженный `main`, а вывод типов этого не видит:
 * после `стенд.готово = null` он считает поле навсегда пустым и отказывается
 * вызывать его даже через `?.()`. Функция возвращает объявленный тип.
 */
const взять = <K extends keyof typeof стенд>(ключ: K): (typeof стенд)[K] => стенд[ключ];

vi.mock('electron', () => {
  class Tray {
    constructor() {
      стенд.трееПоявилось += 1;
    }
    setToolTip(текст: string): void {
      стенд.подсказка = текст;
    }
    setContextMenu(меню: Array<{ label?: string; click?: () => void }>): void {
      стенд.меню = меню;
    }
    on(): void {}
  }
  return {
    app: {
      setName: () => {},
      setPath: () => {},
      setAppLogsPath: () => {},
      setAppUserModelId: () => {},
      getPath: () => os.tmpdir(),
      requestSingleInstanceLock: () => стенд.лок,
      quit: () => {
        стенд.вышел += 1;
      },
      on: () => {},
      whenReady: () =>
        new Promise<void>((resolve) => {
          стенд.готово = resolve;
        }),
    },
    Menu: { buildFromTemplate: (шаблон: unknown[]) => шаблон },
    Tray,
    nativeImage: { createFromPath: () => ({}) },
    shell: { openPath: () => Promise.resolve('') },
    dialog: {
      showMessageBox: async () => {
        стенд.вопросов += 1;
        return { response: стенд.ответ };
      },
    },
  };
});

vi.mock('./lectureMode', () => ({
  lectureState: () => стенд.лекция,
  finishLecture: () => {
    стенд.законченоЛекций += 1;
    return Promise.resolve('Конспект готов');
  },
  lectureFinishing: () => null,
  onLectureState: (слушатель: (state: string) => void) => {
    стенд.слушательЛекции = слушатель;
    return () => {
      стенд.слушательЛекции = null;
    };
  },
}));

vi.mock('./voiceBridge', () => ({
  startJarvisVoiceBridge: async () => {
    стенд.голосЗапущен += 1;
    // Подделка обязана уметь всё, чем пользуется `main`.
    //
    // Неполная роняла построение меню значка необработанной ошибкой
    // «bridge?.muteState is not a function». Набор при этом оставался
    // зелёным, но vitest предупреждал прямо: такая ошибка может дать ложно
    // пройденные проверки — их и стало на восемьдесят меньше.
    return {
      showEvents: () => {},
      dispose: () => {},
      toggleMute: () => {
        стенд.микрофонПереключен += 1;
      },
      muteState: () => ({ muted: false, secondsLeft: 0 }),
    };
  },
}));

vi.mock('./settingsWindow', () => ({
  openSettingsWindow: (параметры: { settings: { update(patch: { language: 'ru' | 'en' }): unknown }; onSettingsChanged(changed: string[]): void }) => {
    стенд.настройкиОкна = параметры;
  },
  sendUpdateState: () => {},
  SETTINGS_CHANNEL: 'jarvis-settings',
}));

function домДляПроверки(язык: 'ru' | 'en' = 'ru', onboarded = true): string {
  const дом = mkdtempSync(path.join(os.tmpdir(), 'jarvis-main-test-'));
  mkdirSync(path.join(дом, 'data'), { recursive: true });
  // Онбординг пройден: иначе голос не запускается и у первого экземпляра.
  writeFileSync(path.join(дом, 'data', 'settings.json'), JSON.stringify({ language: язык, onboarded }), 'utf8');
  return дом;
}

async function запустить(лок: boolean): Promise<void> {
  стенд.лок = лок;
  стенд.трееПоявилось = 0;
  стенд.голосЗапущен = 0;
  стенд.готово = null;
  vi.resetModules();
  process.env.JARVIS_HOME = домДляПроверки();
  await import('./main');
  взять('готово')?.();
  // Дать цепочке промисов `whenReady().then(...)` доработать.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
}

describe('главный процесс', () => {
  const былДом = process.env.JARVIS_HOME;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (былДом === undefined) delete process.env.JARVIS_HOME;
    else process.env.JARVIS_HOME = былДом;
  });

  it('первый экземпляр вешает значок и запускает голос', async () => {
    await запустить(true);
    expect(стенд.трееПоявилось).toBe(1);
    expect(стенд.голосЗапущен).toBe(1);
  });

  it('второй экземпляр не вешает второй значок и не лезет за микрофоном', async () => {
    await запустить(false);
    expect(стенд.трееПоявилось).toBe(0);
    expect(стенд.голосЗапущен).toBe(0);
  });
});

/**
 * Посреди лекции выход, перезапуск и смена настроек обрывали запись, а итог
 * не дописывался вовсе: тестер 21.10.2026 обновился посреди пары.
 */
describe('посреди лекции', () => {
  const пункт = (начало: string) => взять('меню').find((p) => p.label?.startsWith(начало));
  const подождать = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
  };

  beforeEach(async () => {
    стенд.лекция = 'off';
    стенд.вышел = 0;
    стенд.вопросов = 0;
    стенд.законченоЛекций = 0;
    await запустить(true);
  });

  it('без лекции «Выйти» выходит сразу, без вопроса', async () => {
    пункт('Выйти')?.click?.();
    await подождать();
    expect(стенд.вопросов).toBe(0);
    expect(стенд.вышел).toBe(1);
  });

  it('«Выйти» спрашивает; «Отмена» — остаёмся, «Закончить конспект и выйти» — сначала итог', async () => {
    стенд.лекция = 'on';
    стенд.ответ = 2;
    пункт('Выйти')?.click?.();
    await подождать();
    expect(стенд.вопросов).toBe(1);
    expect(стенд.вышел).toBe(0);

    стенд.ответ = 0;
    пункт('Выйти')?.click?.();
    await подождать();
    expect(стенд.законченоЛекций).toBe(1);
    expect(стенд.вышел).toBe(1);
  });

  it('«Перезапустить голос» спрашивает; «Отмена» — голос не трогается', async () => {
    стенд.лекция = 'on';
    стенд.ответ = 1;
    const было = стенд.голосЗапущен;
    пункт('Перезапустить')?.click?.();
    await подождать();
    expect(стенд.вопросов).toBe(1);
    expect(стенд.голосЗапущен).toBe(было);
  });

  it('настройка, которой нужен перезапуск, применяется, когда конспект закончится', async () => {
    пункт('Настройки')?.click?.();
    стенд.лекция = 'on';
    const было = стенд.голосЗапущен;
    взять('настройкиОкна')?.onSettingsChanged(['language']);
    await подождать();
    expect(стенд.голосЗапущен).toBe(было);
    стенд.лекция = 'off';
    взять('слушательЛекции')?.('off');
    await подождать();
    expect(стенд.голосЗапущен).toBe(было + 1);
  });
});

/**
 * Язык главного процесса.
 *
 * `setLanguage` звал только голосовой мост. Пока он не поднялся — а на первом
 * запуске он и не поднимается, — всё, что главный процесс говорит через
 * `tr()`, выходило по-русски даже в английском режиме: причина отказа при
 * проверке своей модели, отказ при скачивании модели, причина, по которой не
 * запустился голос. Во время онбординга это вдобавок не чинилось само:
 * `applyPatch` не зовёт `onSettingsChanged`, пока `onboarded` не выставлен.
 */
describe('язык главного процесса', () => {
  it('берётся из настроек ещё до голосового моста', async () => {
    vi.resetModules();
    process.env.JARVIS_HOME = домДляПроверки('en', false);
    await import('./main');
    const { currentLanguage } = await import('../jarvis/locale/language');
    expect(currentLanguage()).toBe('en');
  });

  it('едет за настройками, даже когда онбординг ещё не пройден', async () => {
    стенд.лок = true;
    стенд.настройкиОкна = null;
    стенд.готово = null;
    vi.resetModules();
    process.env.JARVIS_HOME = домДляПроверки('ru', false);
    await import('./main');
    взять('готово')?.();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    const { currentLanguage } = await import('../jarvis/locale/language');
    expect(currentLanguage()).toBe('ru');

    // Мастер меняет язык через то же хранилище, что держит главный процесс.
    const хранилище = взять('настройкиОкна')?.settings;
    expect(хранилище).toBeTruthy();
    хранилище?.update({ language: 'en' });
    expect(currentLanguage()).toBe('en');
  });
});

/**
 * Windows берёт из подсказки значка 127 знаков и остальное молча отрезает —
 * ровно конец, где сказано, что делать.
 */
describe('трейПодсказка', () => {
  it('короткое состояние оставляет как есть', async () => {
    process.env.JARVIS_HOME = домДляПроверки();
    const { трейПодсказка } = await import('./main');
    expect(трейПодсказка('слушаю')).toBe('Rujarvis — слушаю');
  });

  it('длинную причину режет сама и показывает, что текст не весь', async () => {
    process.env.JARVIS_HOME = домДляПроверки();
    const { трейПодсказка } = await import('./main');
    const причина =
      'голос не запустился: Ни одна модель распознавания не установлена в ' +
      'C:\\Users\\человек\\AppData\\Local\\Rujarvis\\models\\whisper. ' +
      'Откройте настройки Джарвиса и скачайте модель.';
    const подсказка = трейПодсказка(причина);
    expect(причина.length).toBeGreaterThan(127);
    expect(подсказка.length).toBeLessThanOrEqual(127);
    expect(подсказка.endsWith('…')).toBe(true);
  });
});
