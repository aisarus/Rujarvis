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
