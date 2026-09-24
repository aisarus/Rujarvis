/**
 * The page that owns the microphone.
 *
 * Electron only hands out `getUserMedia` inside a renderer, so the voice loop
 * needs one page even though nothing about it is visible. It stays hidden, it
 * is generated at runtime rather than shipped as an asset (nothing to copy in
 * the build), and it does exactly three things: capture, segment, play.
 *
 * Segmentation lives here on purpose. Shipping every 4096-sample buffer across
 * the IPC boundary so the main process can measure loudness would put a
 * process hop in the middle of a hot loop; deciding "this was an utterance"
 * next to the audio is both cheaper and simpler.
 */

export const AUDIO_BRIDGE_CHANNELS = {
  ready: 'jarvis-audio:ready',
  error: 'jarvis-audio:error',
  utterance: 'jarvis-audio:utterance',
  speechStarted: 'jarvis-audio:speech-started',
  pushResult: 'jarvis-audio:push-result',
  startAmbient: 'jarvis-audio:start-ambient',
  stopAmbient: 'jarvis-audio:stop-ambient',
  startPush: 'jarvis-audio:start-push',
  stopPush: 'jarvis-audio:stop-push',
  speak: 'jarvis-audio:speak',
  stopSpeaking: 'jarvis-audio:stop-speaking',
  /**
   * Фраза отзвучала.
   *
   * Без этого «сказал» означало бы «синтезировал»: окно проигрывает звук само
   * и о конце не сообщает. Пока говорил один поток, это сходило с рук. Теперь
   * говорят двое — разговор и работа, — и вторая фраза обрывала бы первую на
   * полуслове.
   */
  spoken: 'jarvis-audio:spoken',
} as const;

/** 16 kHz is what the recogniser wants, so ask the browser for it directly. */
const TARGET_SAMPLE_RATE = 16_000;

export function buildAudioBridgeHtml(): string {
  return `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Jarvis audio</title></head>
<body>
<script>
const { ipcRenderer } = require('electron');

const CH = ${JSON.stringify(AUDIO_BRIDGE_CHANNELS)};
const TARGET_SAMPLE_RATE = ${TARGET_SAMPLE_RATE};

// Tuned by ear on a laptop mic: quiet enough to catch a normal speaking voice
// across a desk, loud enough that fan noise alone never opens an utterance.
// Raised after a live run: at 0.012 an ordinary room produced an utterance
// every few seconds, each costing ~10 s of recognition, and real speech ended
// up queued behind the noise.
const SPEECH_RMS = 0.022;
// Barge-in needs a clearly louder signal than mere speech detection. Echo
// cancellation removes most of the assistant's own voice from the microphone,
// but not all of it, and an assistant that interrupts itself is worse than one
// that cannot be interrupted.
const BARGE_IN_FACTOR = 2.5;
const SILENCE_MS_TO_CLOSE = 700;
const MIN_SPEECH_MS = 400;
// Потолок длины записи.
//
// В него упираются три процента реплик — и это самые длинные: двадцать слов
// против пяти у обычных. Длинная просьба обрывалась ровно посередине:
// «Сделай вместо зеленой сферы мультяшную красивую разноцветную» уходило
// задачей, а «космическую ракету в стиле Бруно Симон» приезжало отдельно.
// Человек сказал об этом прямо: «длинные реплики тоже плохо регает».
//
// Лечится это не потолком, а склейкой: вместе с записью уходит причина её
// закрытия, и оборванная мысль ждёт продолжения (jarvis/voice/turn.ts).
// Поднимать потолок было бы хуже — запись закрывается по потолку как раз
// тогда, когда в комнате шум или музыка и тишины не наступает вовсе, и любая
// команда в этот момент ждала бы вдвое дольше.
const MAX_UTTERANCE_MS = 15000;

let audioContext = null;
let source = null;
let processor = null;
let stream = null;

let ambient = false;
let pushing = false;

let buffer = [];
let bufferedSamples = 0;
let speechSamples = 0;
let silenceSamples = 0;
let sawSpeech = false;

let player = null;
/** Метка фразы, которая звучит сейчас: по ней главный процесс узнаёт свою. */
let playerToken = null;
/** Чем закончить текущую фразу. Оборванная тоже обязана сказать «отзвучало». */
let playerDone = null;
let lastAudioAt = 0;
let restarting = false;

function samplesToMs(count) {
  return (count / audioContext.sampleRate) * 1000;
}

function msToSamples(ms) {
  return (ms / 1000) * audioContext.sampleRate;
}

function flatten() {
  const total = bufferedSamples;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of buffer) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function resetBuffer() {
  buffer = [];
  bufferedSamples = 0;
  speechSamples = 0;
  silenceSamples = 0;
  sawSpeech = false;
}

// closedBy говорит, почему запись закончилась: 'silence' — человек замолчал,
// 'length' — упёрлись в потолок, то есть он ещё говорил. Второе слышно только
// здесь, и раньше это знание выбрасывалось: мысль уходила задачей на середине
// фразы. Догадаться о том же по тексту нельзя — распознаватель не ставит даже
// точку в конце (проверено: ноль завершающих знаков на двадцати четырёх
// подряд идущих расшифровках).
//
// Обратных кавычек здесь быть не может: вся эта страница живёт внутри
// шаблонной строки, и одна такая кавычка обрывает её на середине.
function emit(channel, closedBy) {
  if (bufferedSamples === 0) {
    ipcRenderer.send(channel, null);
    resetBuffer();
    return;
  }
  // Electron's structured clone carries a Float32Array as-is, so the main
  // process gets samples it can hand straight to the recogniser.
  ipcRenderer.send(channel, {
    sampleRate: audioContext.sampleRate,
    samples: flatten(),
    closedBy: closedBy || 'silence',
    // Какая доля куска была речью, а не тишиной.
    //
    // Whisper обучен на субтитрах к видео и в тишине слышит их концовки:
    // «Субтитры делал DimaTorzok», «Смотрите продолжение в следующей серии».
    // Список таких фраз конечен, а Whisper нет. Настоящий признак не в словах,
    // а в звуке, и он известен только здесь.
    speechShare: bufferedSamples > 0 ? speechSamples / bufferedSamples : 0,
  });
  resetBuffer();
}

function onAudio(event) {
  lastAudioAt = Date.now();
  if (!ambient && !pushing) return;

  const input = event.inputBuffer.getChannelData(0);
  const copy = new Float32Array(input.length);
  copy.set(input);

  let sum = 0;
  for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
  const rms = Math.sqrt(sum / input.length);
  const loud = rms > SPEECH_RMS;

  // Push-to-talk keeps everything between key down and key up: the user said
  // when to listen, so second-guessing them with a loudness gate only loses
  // the first syllable.
  if (pushing) {
    buffer.push(copy);
    bufferedSamples += copy.length;
    return;
  }

  if (loud) {
    // Interrupting is voice activity, not a word: waiting for "стоп" to be
    // recognised means waiting seconds, by which time the person has already
    // talked over the assistant. Speaking at all is the signal.
    if (!sawSpeech && rms > SPEECH_RMS * BARGE_IN_FACTOR) {
      ipcRenderer.send(CH.speechStarted);
    }
    sawSpeech = true;
    speechSamples += copy.length;
    silenceSamples = 0;
  } else if (!sawSpeech) {
    // Nothing has been said yet — keep a short pre-roll so the opening
    // consonant survives, and drop the rest.
    buffer.push(copy);
    bufferedSamples += copy.length;
    while (bufferedSamples > msToSamples(300)) {
      const dropped = buffer.shift();
      bufferedSamples -= dropped.length;
    }
    return;
  } else {
    silenceSamples += copy.length;
  }

  buffer.push(copy);
  bufferedSamples += copy.length;

  const closedBySilence =
    sawSpeech &&
    samplesToMs(silenceSamples) >= SILENCE_MS_TO_CLOSE &&
    samplesToMs(speechSamples) >= MIN_SPEECH_MS;
  const closedByLength = samplesToMs(bufferedSamples) >= MAX_UTTERANCE_MS;

  if (closedBySilence || closedByLength) {
    emit(CH.utterance, closedBySilence ? 'silence' : 'length');
  }
}

/**
 * Takes the microphone again after something else took it away.
 *
 * Launching a game does exactly that: Dota grabbed the audio device and the
 * capture stopped dead — eighty seconds without a single buffer, not even
 * noise — while the assistant went on believing it was listening.
 */
async function restartCapture(reason) {
  if (restarting) return;
  restarting = true;
  try {
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
    if (source) source.disconnect();
    if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
    if (audioContext) await audioContext.close();
  } catch (error) {
    // Tearing down a broken pipeline is allowed to fail; taking a new one is not.
  }
  audioContext = null;
  source = null;
  processor = null;
  stream = null;
  resetBuffer();

  try {
    await ensureCapture();
    lastAudioAt = Date.now();
    ipcRenderer.send(CH.error, 'микрофон взят заново: ' + reason);
  } catch (error) {
    ipcRenderer.send(CH.error, 'не удалось вернуть микрофон: ' + String((error && error.message) || error));
  } finally {
    restarting = false;
  }
}

// A stream that stops delivering is the only reliable signal: an ended track
// does not always fire, and a device change does not always end the track.
setInterval(function () {
  if (restarting || !audioContext) return;
  if (!ambient && !pushing) return;
  if (Date.now() - lastAudioAt > 5000) restartCapture('звук перестал поступать');
}, 2000);

async function ensureCapture() {
  if (audioContext) return;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  stream.getAudioTracks().forEach(function (track) {
    track.onended = function () { restartCapture('поток микрофона оборван'); };
  });
  navigator.mediaDevices.ondevicechange = function () {
    restartCapture('сменилось звуковое устройство');
  };

  audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  source = audioContext.createMediaStreamSource(stream);
  processor = audioContext.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = onAudio;
  source.connect(processor);
  // ScriptProcessor only runs while connected to the graph; a zero-gain node
  // keeps it alive without putting the microphone into the speakers.
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(audioContext.destination);
  lastAudioAt = Date.now();
}

ipcRenderer.on(CH.startAmbient, async () => {
  try {
    await ensureCapture();
    resetBuffer();
    ambient = true;
  } catch (error) {
    ipcRenderer.send(CH.error, String((error && error.message) || error));
  }
});

ipcRenderer.on(CH.stopAmbient, () => {
  ambient = false;
  resetBuffer();
});

ipcRenderer.on(CH.startPush, async () => {
  try {
    await ensureCapture();
    resetBuffer();
    pushing = true;
  } catch (error) {
    ipcRenderer.send(CH.error, String((error && error.message) || error));
  }
});

ipcRenderer.on(CH.stopPush, () => {
  pushing = false;
  emit(CH.pushResult);
});

ipcRenderer.on(CH.speak, (_event, payload) => {
  var token = payload && payload.token;
  try {
    // Прежняя фраза обязана закончиться, даже если её обрывают: иначе тот, кто
    // её ждёт, будет ждать до срока, а очередь — стоять.
    if (player) { player.pause(); player = null; }
    if (playerDone) playerDone();
    var audio = new Audio('data:audio/wav;base64,' + (payload && payload.data));
    player = audio;
    playerToken = token;
    // О конце фразы обязан узнать тот, кто выстраивает речь в очередь. Иначе
    // следующая начнётся поверх этой и оборвёт её на полуслове.
    //
    // Метка обязательна: «отзвучало» без неё, пришедшее с опозданием, закрыло
    // бы СЛЕДУЮЩУЮ фразу, и она оборвалась бы в начале.
    var fired = false;
    var done = function () {
      if (fired) return;
      fired = true;
      if (player === audio) { player = null; playerToken = null; playerDone = null; }
      ipcRenderer.send(CH.spoken, token);
    };
    playerDone = done;
    audio.onended = done;
    audio.onerror = done;
    var started = audio.play();
    if (started && started.catch) started.catch(done);
  } catch (error) {
    ipcRenderer.send(CH.error, String((error && error.message) || error));
    // Промолчав об этом, мы подвесили бы очередь навсегда.
    ipcRenderer.send(CH.spoken, token);
  }
});

ipcRenderer.on(CH.stopSpeaking, () => {
  if (player) {
    player.pause();
    player = null;
    playerToken = null;
    if (playerDone) playerDone();
  }
});

ipcRenderer.send(CH.ready);
</script>
</body>
</html>`;
}
