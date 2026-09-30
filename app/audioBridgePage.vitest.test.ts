import { createContext, Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { buildAudioBridgeHtml } from './audioBridgePage';

/**
 * Страница микрофона целиком лежит внутри шаблонной строки.
 *
 * Значит, одна обратная кавычка где угодно в ней — хоть в комментарии — рвёт
 * строку пополам, и остаток кода просто не доезжает до браузера. Ровно это и
 * случилось: комментарий про причину закрытия записи назвал поле в обратных
 * кавычках, и сборка легла с «Expected ";"». Проверка типов этого не увидела.
 *
 * Здесь проверяется то, что видно снаружи: собранная страница должна
 * содержать весь свой код, а не первую его половину.
 */
describe('buildAudioBridgeHtml', () => {
  const html = buildAudioBridgeHtml();

  // Разбор страницы на части: сам текст скрипта и то, что осталось вокруг.
  //
  // Тег закрывается первым встреченным `</script>`, а не последним: браузер
  // читает именно так, и если такая строка попала внутрь кода, остаток кода
  // для браузера уже не код, а текст на странице.
  const открывающий = html.indexOf('<script>') + '<script>'.length;
  const закрывающий = html.indexOf('</script>', открывающий);
  const тело = html.slice(открывающий, закрывающий);

  it('целиком разбирается как код, а не только начинается похоже', () => {
    // Проверка типов видит файл, а не собранную страницу.
    //
    // Раньше здесь искали подстроку `jarvis-audio:stop-speaking`, но она
    // лежит в объекте каналов у самого верха скрипта: оборвись страница на
    // середине — проверка всё равно бы прошла. `</script>` же дописывается
    // снаружи шаблона и есть всегда. Ни то ни другое обрыва не видит.
    //
    // Компиляция видит. `new Script` разбирает текст и не выполняет его:
    // недостающая скобка, оборванная строка, съеденный кусок — всё это
    // падает здесь, а не в запущенном приложении, где страница молча немая.
    expect(() => new Script(тело)).not.toThrow();
  });

  it('доезжает до конца, а не обрывается на середине', () => {
    // Последнее в порядке исходника — обработчик остановки речи, и ищем мы
    // не имя канала (оно объявлено вверху), а сам обработчик.
    expect(тело).toContain('CH.stopSpeaking');
    // Всё, что идёт после первого `</script>`, до браузера доедет текстом.
    expect(html.slice(закрывающий)).not.toContain('function');
  });

  it('содержит настройки сегментации целиком', () => {
    for (const marker of ['SPEECH_RMS', 'SILENCE_MS_TO_CLOSE', 'MAX_UTTERANCE_MS']) {
      expect(html).toContain(marker);
    }
  });

  it('сообщает, сколько в куске было речи', () => {
    // Whisper выдумывает субтитры именно на тишине. Запись это знает: она
    // считает громкость каждого куска. Выбрасывать это знание — то же, что
    // выбрасывалась причина закрытия записи до 19 сентября.
    expect(html).toContain('speechShare');
    expect(html).toContain('speechSamples / bufferedSamples');
  });

  it('сообщает, почему запись закрылась', () => {
    // Без этого оборванная на полуслове мысль снова уйдёт задачей.
    expect(html).toContain('closedBy');
    expect(html).toContain("'length'");
  });
});

/**
 * Перебивание — речью, а не щелчком.
 *
 * Живой журнал 28.09.2026: Ctrl+M и Ctrl+Space обрывали Джарвиса на полуслове.
 * Щелчок клавиши у микрофона ноутбука перекрывал 256-мс кусок звука, и этого
 * хватало, чтобы «перебили — замолкаю». Здесь страница выполняется целиком, с
 * заглушками вместо Electron, и в её обработчик звука подаются настоящие
 * куски: щелчок и слог.
 */
describe('перебивание', () => {
  const html = buildAudioBridgeHtml();
  const открывающий = html.indexOf('<script>') + '<script>'.length;
  const тело = html.slice(открывающий, html.indexOf('</script>', открывающий));

  function страница(): { отправлено: string[]; звук: (samples: Float32Array) => void } {
    const отправлено: string[] = [];
    const ipcRenderer = { on: () => undefined, send: (channel: string) => { отправлено.push(channel); } };
    const контекст = createContext({
      require: () => ({ ipcRenderer }),
      setInterval: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      console,
      navigator: { mediaDevices: {} },
    });
    new Script(тело).runInContext(контекст);
    // Верхнеуровневые let страницы живут в общем лексическом окружении
    // контекста: следующий скрипт их видит и может включить прослушивание.
    new Script('ambient = true; audioContext = { sampleRate: 16000 };').runInContext(контекст);
    const onAudio = new Script('onAudio').runInContext(контекст) as (event: unknown) => void;
    return {
      отправлено,
      звук: (samples) => onAudio({ inputBuffer: { getChannelData: () => samples } }),
    };
  }

  const КУСОК = 4096;
  const тишина = (): Float32Array => new Float32Array(КУСОК);
  /** Щелчок клавиши: 16 мс на пределе громкости посреди тишины. */
  const щелчок = (): Float32Array => {
    const out = new Float32Array(КУСОК);
    for (let i = 1000; i < 1256; i += 1) out[i] = i % 2 === 0 ? 0.9 : -0.9;
    return out;
  };
  /** Слог: 200 мс голоса громкостью обычной речи у микрофона. */
  const слог = (): Float32Array => {
    const out = new Float32Array(КУСОК);
    for (let i = 0; i < 3200; i += 1) out[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / 16000);
    return out;
  };

  it('щелчок клавиши Джарвиса не перебивает', () => {
    const { отправлено, звук } = страница();
    звук(щелчок());
    звук(тишина());
    expect(отправлено).not.toContain('jarvis-audio:speech-started');
  });

  it('заговорил поверх — перебил, и один раз на реплику', () => {
    const { отправлено, звук } = страница();
    звук(слог());
    звук(слог());
    expect(отправлено.filter((c) => c === 'jarvis-audio:speech-started')).toHaveLength(1);
  });
});

/**
 * Режим лекции: лектор дальше, чем человек у ноутбука, и говорит подолгу.
 *
 * Порог речи ниже, а запись длиннее — иначе тихий голос из-за кафедры не
 * открывает запись вовсе, а длинная мысль режется на куски по 15 секунд.
 * Включается каналом из моста, как в приложении, а не правкой переменной.
 */
describe('режим лекции', () => {
  const html = buildAudioBridgeHtml();
  const открывающий = html.indexOf('<script>') + '<script>'.length;
  const тело = html.slice(открывающий, html.indexOf('</script>', открывающий));

  interface Страница {
    отправлено: Array<{ канал: string; что: unknown }>;
    звук: (samples: Float32Array) => void;
    микрофон: unknown[];
  }

  async function страница(лекция: boolean): Promise<Страница> {
    const отправлено: Array<{ канал: string; что: unknown }> = [];
    const микрофон: unknown[] = [];
    const обработчики = new Map<string, (event: unknown, value: unknown) => unknown>();
    const ipcRenderer = {
      on: (channel: string, handler: (event: unknown, value: unknown) => unknown) => {
        обработчики.set(channel, handler);
      },
      send: (channel: string, что: unknown) => {
        отправлено.push({ канал: channel, что });
      },
    };
    const контекст = createContext({
      require: () => ({ ipcRenderer }),
      setInterval: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      console,
      // Микрофон записывает, с какой обработкой его просили, и отказывает:
      // дальше страница в проверке не идёт.
      navigator: { mediaDevices: { getUserMedia: async (c: unknown) => { микрофон.push(c); throw new Error('нет микрофона в проверке'); } } },
    });
    new Script(тело).runInContext(контекст);
    new Script('ambient = true; audioContext = { sampleRate: 16000 };').runInContext(контекст);
    if (лекция) {
      await обработчики.get('jarvis-audio:lecture')?.(null, { on: true, processing: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      // Микрофон в проверке не поднимается — возвращаем «поднятый».
      new Script('audioContext = { sampleRate: 16000 };').runInContext(контекст);
    }
    const onAudio = new Script('onAudio').runInContext(контекст) as (event: unknown) => void;
    return { отправлено, микрофон, звук: (samples) => onAudio({ inputBuffer: { getChannelData: () => samples } }) };
  }

  const КУСОК = 4096;
  /** Голос из-за кафедры: тише порога речи для команд. */
  const издалека = (): Float32Array => {
    const out = new Float32Array(КУСОК);
    for (let i = 0; i < КУСОК; i += 1) out[i] = 0.02 * Math.sin((2 * Math.PI * 180 * i) / 16000);
    return out;
  };
  const тишина = (): Float32Array => new Float32Array(КУСОК);

  it('звук лекции идёт сплошь — и тишина тоже, до последнего отсчёта', async () => {
    const { отправлено, звук } = await страница(true);
    for (let i = 0; i < 4; i += 1) звук(издалека());
    for (let i = 0; i < 5; i += 1) звук(тишина());
    const куски = отправлено.filter((о) => о.канал === 'jarvis-audio:lecture-audio').map((о) => (о.что as { samples: Float32Array }).samples);
    expect(куски.length).toBeGreaterThan(0);
    // По секунде: 9 кусков по 4096 — два блока, остаток ждёт своей секунды.
    expect(куски.every((к) => к.length >= 16000)).toBe(true);
    expect(куски.reduce((n, к) => n + к.length, 0)).toBeLessThanOrEqual(9 * КУСОК);
    expect(9 * КУСОК - куски.reduce((n, к) => n + к.length, 0)).toBeLessThan(16000);
  });

  it('фразы для команд в лекции — с обычным порогом: далёкий лектор слуху команд не нужен', async () => {
    for (const лекция of [false, true]) {
      const { отправлено, звук } = await страница(лекция);
      for (let i = 0; i < 4; i += 1) звук(издалека());
      for (let i = 0; i < 5; i += 1) звук(тишина());
      expect(отправлено.some((о) => о.канал === 'jarvis-audio:utterance')).toBe(false);
    }
  });

  it('без лекции звук в конспект не уходит', async () => {
    const { отправлено, звук } = await страница(false);
    for (let i = 0; i < 10; i += 1) звук(издалека());
    expect(отправлено.some((о) => о.канал === 'jarvis-audio:lecture-audio')).toBe(false);
  });

  it('лекция берёт микрофон заново — без шумо- и эхоподавления', async () => {
    const { микрофон } = await страница(true);
    await new Promise((r) => setImmediate(r));
    expect(микрофон[0]).toMatchObject({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
  });
});

