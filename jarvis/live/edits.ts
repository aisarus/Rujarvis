/**
 * Мелкие правки в открытом блендере — без агента.
 *
 * ## Зачем
 *
 * «Сделай её синей» — это одна строчка на Python. Сегодня ради неё поднимается
 * весь агент: минута-две от фразы до цвета. Человек назвал это первым местом,
 * где ожидание мешает работать.
 *
 * ## Почему правилами, а не моделью
 *
 * Модель, пишущая Python в открытую сцену человека, — способ однажды стереть
 * ему работу. Здесь таблица: что не в ней, то молча уходит агенту, как раньше.
 * Человек не видит границы — он видит, что часть просьб стала мгновенной.
 *
 * Разбор устроен как у прямых команд (`jarvis/control/commands.ts`): точное
 * совпадение с очисткой заполнителей. Ошибка в сторону «не узнал» стоит секунды
 * ожидания; в обратную — испорченной сцены.
 *
 * ## Замер на живом окне
 *
 *     «сделай её синей»        419 мс
 *     «подними на три»         213 мс
 *     «поверни на сорок пять»  218 мс
 *     «увеличь в два раза»     218 мс
 *     «сделай её красной»      422 мс
 *
 * Те же правки через агента — от шестидесяти до ста шестидесяти секунд. Цвет
 * дороже движения вдвое: там создаётся материал и трогаются узлы.
 */

const FILLER = ['ну', 'вот', 'уже', 'пожалуйста', 'давай', 'сейчас', 'там', 'же', 'ка'];

const COLOURS: Record<string, [string, string]> = {
  красн: ['0.9, 0.1, 0.1', 'красным'],
  син: ['0.1, 0.2, 0.9', 'синим'],
  зелен: ['0.1, 0.8, 0.2', 'зелёным'],
  желт: ['0.95, 0.85, 0.1', 'жёлтым'],
  бел: ['0.95, 0.95, 0.95', 'белым'],
  черн: ['0.05, 0.05, 0.05', 'чёрным'],
  оранжев: ['0.95, 0.45, 0.1', 'оранжевым'],
  фиолетов: ['0.5, 0.2, 0.8', 'фиолетовым'],
  розов: ['0.95, 0.5, 0.7', 'розовым'],
  сер: ['0.5, 0.5, 0.5', 'серым'],
};

const NUMBERS: Record<string, number> = {
  один: 1,
  одну: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  пятнадцать: 15,
  двадцать: 20,
  тридцать: 30,
  сорок: 40,
  пятьдесят: 50,
  девяносто: 90,
  сто: 100,
};

/**
 * Слова, которые целью правки быть не могут.
 *
 * Без этого «сделай её синей» ищет в сцене объект по имени «синей» и не находит
 * ничего — а человек видит, что ничего не покрасилось. Поймано на самопроверке
 * плана, до единой написанной строчки.
 */
const VERBS = [
  'сделай', 'покрась', 'закрась', 'в', 'раза', 'раз', 'на', 'цвет', 'цвета',
  'подними', 'опусти', 'поверни', 'разверни', 'крутни', 'увеличь', 'уменьши',
  'удали', 'спрячь', 'скрой', 'покажи', 'больше', 'меньше', 'выше', 'ниже',
  'вверх', 'вниз', 'вправо', 'влево', 'анимацию', 'анимация', 'играй',
  'останови', 'запусти', 'включи', 'выключи', 'стоп',
];

const PRONOUNS = ['её', 'ее', 'его', 'это', 'эту', 'этот', 'их', 'её-то'];

export interface LiveEdit {
  kind: 'python';
  code: string;
  /** Что сказать человеку. Коротко: он смотрит на экран, а не слушает отчёт. */
  said: string;
}

function words(utterance: string): string[] {
  return utterance
    .toLowerCase()
    .replace(/ё/gu, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word && !FILLER.includes(word));
}

/** Число словом или цифрой. `null` — числа не назвали. */
function numberIn(parts: readonly string[]): number | null {
  for (const part of parts) {
    if (/^\d+$/u.test(part)) return Number(part);
    const named = NUMBERS[part];
    if (named !== undefined) return named;
  }
  return null;
}

/**
 * Кого правим.
 *
 * «Её», «его», «это» — активный объект. Названное вслух ищется по имени, и
 * поиск нестрогий: человек говорит «ракету», а объект зовётся «Ракета_корпус».
 */
function targetCode(parts: readonly string[]): string {
  const named = parts.find(
    (word) =>
      word.length > 3 &&
      !PRONOUNS.includes(word) &&
      !(word in NUMBERS) &&
      !VERBS.includes(word) &&
      !Object.keys(COLOURS).some((stem) => word.startsWith(stem)),
  );
  if (!named) return 'bpy.context.active_object';

  // Отрезаем одно окончание, не два. «Ракету» → «ракет» находит «Ракета» и
  // «Ракета_корпус»; «раке» нашло бы ещё и «ракушку».
  const stem = named.slice(0, Math.max(4, named.length - 1));
  return `next((o for o in bpy.data.objects if ${JSON.stringify(stem)} in o.name.lower()), bpy.context.active_object)`;
}

const HEAD = 'import bpy\nfrom math import radians\n';
const GUARD = 'if о is None:\n    raise RuntimeError("не понял, что править: ничего не выбрано")\n';

export function parseLiveEdit(utterance: string): LiveEdit | null {
  const parts = words(utterance);
  if (parts.length === 0) return null;
  const joined = parts.join(' ');

  // Анимация — раньше остального: «останови анимацию» не должно попасть в
  // таблицу движения.
  if (/(играй|запусти|включи) анимаци/u.test(joined)) {
    return { kind: 'python', code: `${HEAD}bpy.ops.screen.animation_play()`, said: 'Играю.' };
  }
  if (/(останови|стоп|выключи) анимаци/u.test(joined)) {
    return {
      kind: 'python',
      code: `${HEAD}bpy.ops.screen.animation_cancel(restore_frame=False)`,
      said: 'Остановил.',
    };
  }

  const rest = parts.filter((word) => !VERBS.includes(word));
  const target = targetCode(rest);

  // Цвет.
  const colour = Object.entries(COLOURS).find(([stem]) =>
    rest.some((word) => word.startsWith(stem)),
  );
  if (colour && /сделай|покрась|закрась|цвет/u.test(joined)) {
    const [, pair] = colour;
    const [rgb, said] = pair;
    return {
      kind: 'python',
      code:
        `${HEAD}о = ${target}\n${GUARD}` +
        'м = о.active_material or bpy.data.materials.new("Цвет")\n' +
        'if not о.data.materials: о.data.materials.append(м)\n' +
        'м.use_nodes = True\n' +
        'у = м.node_tree.nodes.get("Principled BSDF")\n' +
        `if у: у.inputs[0].default_value = (${rgb}, 1)\n` +
        `м.diffuse_color = (${rgb}, 1)\n` +
        'print("покрасил", о.name)',
      said: `Сделал ${said}.`,
    };
  }

  // Движение.
  const moves: Array<[RegExp, string]> = [
    [/подними|вверх|выше/u, 'location.z += '],
    [/опусти|вниз|ниже/u, 'location.z -= '],
    [/вправо/u, 'location.x += '],
    [/влево/u, 'location.x -= '],
  ];
  const move = moves.find(([pattern]) => pattern.test(joined));
  if (move) {
    const by = numberIn(rest) ?? 1;
    return {
      kind: 'python',
      code: `${HEAD}о = ${target}\n${GUARD}о.${move[1]}${by}\nprint("сдвинул", о.name)`,
      said: 'Сдвинул.',
    };
  }

  // Поворот.
  if (/поверни|разверни|крутни/u.test(joined)) {
    const by = numberIn(rest) ?? 90;
    return {
      kind: 'python',
      code: `${HEAD}о = ${target}\n${GUARD}о.rotation_euler.z += radians(${by})\nprint("повернул", о.name)`,
      said: `Повернул на ${by}.`,
    };
  }

  // Размер.
  if (/увеличь|уменьши/u.test(joined)) {
    const by = numberIn(rest) ?? 2;
    const factor = /уменьши/u.test(joined) ? `1/${by}` : `${by}`;
    return {
      kind: 'python',
      code:
        `${HEAD}о = ${target}\n${GUARD}` +
        `к = ${factor}\nо.scale = tuple(з * к for з in о.scale)\nprint("размер", о.name)`,
      said: 'Готово.',
    };
  }

  // Видимость и удаление.
  if (/^удали/u.test(joined)) {
    return {
      kind: 'python',
      code: `${HEAD}о = ${target}\n${GUARD}bpy.data.objects.remove(о, do_unlink=True)\nprint("удалил")`,
      said: 'Удалил.',
    };
  }
  if (/^(спрячь|скрой)/u.test(joined)) {
    return {
      kind: 'python',
      code: `${HEAD}о = ${target}\n${GUARD}о.hide_viewport = True\nprint("спрятал", о.name)`,
      said: 'Спрятал.',
    };
  }
  // «Покажи» — только про объект. «Покажи папку», «покажи лог», «покажи план»
  // разбирают другие слои, и перехватывать их отсюда нельзя.
  if (/^покажи/u.test(joined) && !/папк|файл|лог|план|окно|работу|сетк/u.test(joined)) {
    return {
      kind: 'python',
      code: `${HEAD}о = ${target}\n${GUARD}о.hide_viewport = False\nprint("показал", о.name)`,
      said: 'Показал.',
    };
  }

  return null;
}
