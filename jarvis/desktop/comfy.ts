/**
 * Рисование диффузией: ComfyUI через его HTTP-API.
 *
 * ## Зачем
 *
 * Человек попросил делать аниме агентом, и первая же попытка показала границу:
 * портрет, собранный кодом из эллипсов, никуда не годится, а фильтр по фото —
 * тем более. Штрих кладёт не языковая модель, а диффузионная. Отсюда этот
 * мост: я разбираю задачу и перебираю варианты, рисует — обученная сеть.
 *
 * ## Почему локально, а не в облаке
 *
 * Облако (Сора) лучше на один кадр и не стоит видеопамяти — но оно не удержит
 * одного персонажа одинаковым в сотне кадров. Порядок работы такой: концепт и
 * стиль перебираются в облаке, утверждается лист персонажа, а тираж по нему
 * идёт здесь — img2img от листа, поза по ControlNet, при нужде LoRA. Решает не
 * красота одного кадра, а повторяемость.
 *
 * ## Что здесь есть
 *
 * Только разговор с сервером: построить граф, поставить в очередь, дождаться,
 * забрать файл. Ни запуска сервера, ни выбора стиля: первое — дело окружения,
 * второе — дело того, кто ставит задачу.
 */

import { writeFileSync } from 'node:fs';

/** Где слушает ComfyUI. Порт свой, чтобы не спорить с чужими сервисами. */
export const COMFY_URL = process.env.JARVIS_COMFY_URL?.trim() || 'http://127.0.0.1:8188';

/** Сколько ждать картинку. На четырёх гигабайтах кадр идёт десятки секунд. */
const WAIT_MS = 10 * 60_000;

export interface DrawRequest {
  /** Что нарисовать. Английский: модели обучены на нём, русский они понимают хуже. */
  prompt: string;
  /** Чего не должно быть. Без этого аниме-модели лепят лишние пальцы и подписи. */
  negative?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  /** Имя файла модели, как его видит сервер. */
  model?: string;
  /** Куда положить готовый файл. */
  saveTo: string;
}

/** Рисование по заданной позе: скелет OpenPose управляет тем, что рисуется. */
export interface PosedRequest extends DrawRequest {
  /**
   * Имя файла скелета, как он лежит в папке input у ComfyUI.
   *
   * Именно имя, а не путь: узел LoadImage читает только оттуда, и это не
   * ограничение моста, а устройство сервера.
   */
  pose: string;
  /**
   * Какой ControlNet взять: по части имени файла.
   *
   * `openpose` задаёт только суставы и недоконтролирует форму — модель
   * додумывает объём и врёт. `depth` задаёт всё тело, и врать негде. Проверено
   * 21.09.2026: на openpose модель рисовала лишние конечности и принимала
   * цветные линии скелета за предметы.
   */
  control?: string;
  /**
   * Насколько жёстко держаться позы, 0..2.
   *
   * Единица — как учили. Ниже — модель вольничает с анатомией, выше — рисунок
   * деревенеет и начинает походить на раскрашенный скелет.
   */
  strength?: number;
}

export interface DrawResult {
  ok: boolean;
  file?: string;
  seed?: number;
  error?: string;
}

/**
 * Отрицательная подсказка по умолчанию.
 *
 * Не украшение: без неё SD 1.5 исправно рисует лишние конечности, водяные
 * знаки и подписи художников поверх кадра. Список общепринятый, и он дешевле
 * любой правки руками.
 */
const ПО_УМОЛЧАНИЮ_НЕ =
  'lowres, bad anatomy, bad hands, extra digit, fewer digits, cropped, ' +
  'worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry';

export async function isUp(): Promise<boolean> {
  try {
    const ответ = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(3000) });
    return ответ.ok;
  } catch {
    return false;
  }
}

/** Какие модели сервер видит у себя. */
export async function models(): Promise<string[]> {
  try {
    const ответ = await fetch(`${COMFY_URL}/object_info/CheckpointLoaderSimple`, {
      signal: AbortSignal.timeout(10_000),
    });
    // Отказ — это отказ, а не «моделей нет».
    //
    // Пустой список при сломанном узле отправлял человека искать пропавший
    // чекпойнт, которого он не терял. Пустым список остаётся только когда
    // сервер ответил и в нём правда ничего нет.
    if (!ответ.ok) throw new Error(`сервер ответил HTTP ${ответ.status} на список моделей`);
    const данные = (await ответ.json()) as Record<string, unknown>;
    const узел = данные['CheckpointLoaderSimple'] as
      | { input?: { required?: { ckpt_name?: unknown[] } } }
      | undefined;
    const список = узел?.input?.required?.ckpt_name?.[0];
    if (!узел) throw new Error('сервер не отдал узел CheckpointLoaderSimple');
    return Array.isArray(список) ? (список as string[]) : [];
  } catch (беда) {
    throw беда instanceof Error ? беда : new Error(String(беда));
  }
}

/**
 * Граф из семи узлов: загрузка, две подсказки, пустой холст, сэмплер, декод,
 * запись. Это самый обычный txt2img, и держать его в коде честнее, чем прятать
 * в файле: видно, что именно уходит на сервер.
 */
function граф(запрос: DrawRequest, model: string, seed: number): Record<string, unknown> {
  const width = запрос.width ?? 512;
  const height = запрос.height ?? 768;
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: запрос.prompt, clip: ['1', 1] } },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: запрос.negative ?? ПО_УМОЛЧАНИЮ_НЕ, clip: ['1', 1] },
    },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: запрос.steps ?? 28,
        cfg: запрос.cfg ?? 7,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'джарвис' } },
  };
}

/**
 * Граф с ControlNet: то же самое плюс скелет.
 *
 * Скелет входит не в холст, а в обусловливание: он правит и положительную, и
 * отрицательную подсказку разом, поэтому узел один, а выходов два.
 */
function графПоПозе(
  запрос: PosedRequest,
  model: string,
  controlnet: string,
  seed: number,
): Record<string, unknown> {
  const width = запрос.width ?? 512;
  const height = запрос.height ?? 512;
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: запрос.prompt, clip: ['1', 1] } },
    '3': {
      class_type: 'CLIPTextEncode',
      inputs: { text: запрос.negative ?? ПО_УМОЛЧАНИЮ_НЕ, clip: ['1', 1] },
    },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '8': { class_type: 'LoadImage', inputs: { image: запрос.pose, upload: 'image' } },
    '9': { class_type: 'ControlNetLoader', inputs: { control_net_name: controlnet } },
    '10': {
      class_type: 'ControlNetApplyAdvanced',
      inputs: {
        strength: запрос.strength ?? 1.0,
        start_percent: 0.0,
        end_percent: 1.0,
        positive: ['2', 0],
        negative: ['3', 0],
        control_net: ['9', 0],
        image: ['8', 0],
      },
    },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: запрос.steps ?? 26,
        cfg: запрос.cfg ?? 7,
        sampler_name: 'dpmpp_2m',
        scheduler: 'karras',
        denoise: 1,
        model: ['1', 0],
        positive: ['10', 0],
        negative: ['10', 1],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'poza' } },
  };
}

/** Какие ControlNet сервер видит у себя. */
export async function controlnets(): Promise<string[]> {
  try {
    const ответ = await fetch(`${COMFY_URL}/object_info/ControlNetLoader`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!ответ.ok) throw new Error(`сервер ответил HTTP ${ответ.status} на список ControlNet`);
    const данные = (await ответ.json()) as Record<string, unknown>;
    const узел = данные['ControlNetLoader'] as
      | { input?: { required?: { control_net_name?: unknown[] } } }
      | undefined;
    const список = узел?.input?.required?.control_net_name?.[0];
    if (!узел) throw new Error('сервер не отдал узел ControlNetLoader');
    return Array.isArray(список) ? (список as string[]) : [];
  } catch (беда) {
    throw беда instanceof Error ? беда : new Error(String(беда));
  }
}

interface Вывод {
  images?: Array<{ filename: string; subfolder: string; type: string }>;
}

/**
 * Нарисовать и положить файл на диск.
 *
 * Ожидание — опросом истории, а не вебсокетом: опрос переживает разрыв, а
 * узнать надо ровно одно — готово или нет.
 */
/**
 * Нарисовать персонажа в заданной позе.
 *
 * Отличается от `draw` ровно одним: скелет OpenPose управляет анатомией, а
 * подсказка — всем остальным. Это и есть способ получить ОДНОГО персонажа в
 * десяти разных позах: подсказка и зерно одни, меняется только скелет.
 */
export async function drawPosed(запрос: PosedRequest): Promise<DrawResult> {
  // Сначала про сервер, потом про его содержимое.
  //
  // Без этой проверки упавший сервер отвечал «на сервере нет ни одного
  // ControlNet»: список приходил пустым по той же причине, что и всё
  // остальное. Ошибка уводила искать пропавшую модель вместо упавшего
  // процесса — и увела.
  if (!(await isUp())) {
    return { ok: false, error: `ComfyUI не отвечает на ${COMFY_URL}` };
  }

  const сети = await controlnets();
  const какую = запрос.control ?? 'openpose';
  const сеть = сети.find((имя) => имя.includes(какую)) ?? сети[0];
  if (!сеть) return { ok: false, error: 'на сервере нет ни одного ControlNet' };
  return выполнить(запрос, (model, seed) => графПоПозе(запрос, model, сеть, seed));
}

export async function draw(запрос: DrawRequest): Promise<DrawResult> {
  return выполнить(запрос, (model, seed) => граф(запрос, model, seed));
}

/**
 * Общая работа: собрать граф, поставить в очередь, дождаться, забрать файл.
 *
 * Вынесено, потому что у рисования с позой и без неё разный только граф.
 * Держать две копии ожидания значило бы чинить разрывы дважды.
 */
async function выполнить(
  запрос: DrawRequest,
  собрать: (model: string, seed: number) => Record<string, unknown>,
): Promise<DrawResult> {
  if (!(await isUp())) {
    return { ok: false, error: `ComfyUI не отвечает на ${COMFY_URL}` };
  }

  const доступные = await models();
  const model = запрос.model ?? доступные[0];
  if (!model) return { ok: false, error: 'на сервере нет ни одной модели' };

  const seed = запрос.seed ?? Math.floor(Math.random() * 2 ** 32);

  let promptId: string;
  try {
    const ответ = await fetch(`${COMFY_URL}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: собрать(model, seed), client_id: 'jarvis' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!ответ.ok) {
      // Сервер отвечает подробной жалобой на неверный граф — её и показываем,
      // иначе «не получилось» ничего не объясняет.
      return { ok: false, error: `сервер отклонил заказ: ${(await ответ.text()).slice(0, 400)}` };
    }
    promptId = ((await ответ.json()) as { prompt_id?: string }).prompt_id ?? '';
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!promptId) return { ok: false, error: 'сервер не назвал номер заказа' };

  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      const ответ = await fetch(`${COMFY_URL}/history/${promptId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!ответ.ok) continue;
      const история = (await ответ.json()) as Record<
        string,
        { outputs?: Record<string, Вывод>; status?: { status_str?: string; messages?: unknown } }
      >;
      const запись = история[promptId];
      if (!запись) continue;

      // Упавший на сервере граф — это конец, а не повод ждать дальше.
      //
      // ComfyUI кладёт в историю запись со `status_str: 'error'` и без
      // картинок (кончилась видеопамять, нет файла позы). Раньше опрос уходил
      // на новый круг и через десять минут человек слышал «не дождались
      // картинки», хотя причина лежала тут же, в `status.messages`.
      if (запись.status?.status_str === 'error') {
        const причина = JSON.stringify(запись.status.messages ?? '').slice(0, 400);
        return { ok: false, error: `сервер не справился с заказом: ${причина}` };
      }

      const картинки = Object.values(запись.outputs ?? {}).flatMap((вывод) => вывод.images ?? []);
      const картинка = картинки[0];
      if (!картинка) continue;

      const файл = await fetch(
        `${COMFY_URL}/view?filename=${encodeURIComponent(картинка.filename)}` +
          `&subfolder=${encodeURIComponent(картинка.subfolder)}&type=${картинка.type}`,
        { signal: AbortSignal.timeout(60_000) },
      );
      if (!файл.ok) return { ok: false, error: 'картинка готова, но не отдалась' };

      const данные = Buffer.from(await файл.arrayBuffer());
      // Запись — ОТДЕЛЬНО от опроса.
      //
      // Раньше её отказ попадал в общий `catch` и глушился: опрос заходил на
      // новый круг, снова скачивал картинку, снова падал на записи — и через
      // десять минут человек слышал «не дождались картинки», хотя картинка
      // была готова с первой попытки. Настоящая причина (папки нет, диск
      // полон) не доходила вовсе.
      try {
        writeFileSync(запрос.saveTo, данные);
      } catch (беда) {
        return {
          ok: false,
          error: `картинка готова, но не записалась в ${запрос.saveTo}: ${беда instanceof Error ? беда.message : String(беда)}`,
        };
      }
      return { ok: true, file: запрос.saveTo, seed };
    } catch {
      // Разрыв на опросе — не беда, спросим ещё раз.
    }
  }

  return { ok: false, error: 'не дождались картинки за десять минут' };
}

export { ПО_УМОЛЧАНИЮ_НЕ };
