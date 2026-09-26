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
 * ожидания; в обратную — испорченной сцены. Поэтому объект, названный по имени
 * и не найденный в сцене, — отказ, а не «тогда возьму выделенный»: «удали
 * файл» не должно стирать то, что сейчас выделено.
 *
 * Таблицы — на обоих языках сразу: сцена одна, и человек, переключивший язык,
 * не должен терять правки. Мост зовёт разбор только после прямых команд и
 * только когда блендер жив, так что «scroll down» сюда не доходит.
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

import { tr } from '../locale/language';

const FILLER = [
  'ну', 'вот', 'уже', 'пожалуйста', 'давай', 'сейчас', 'там', 'же', 'ка',
  'please', 'now', 'just', 'the', 'a', 'an', 'can', 'you', 'could',
];

interface Colour {
  stems: string[];
  rgb: string;
  ru: string;
  en: string;
}

const COLOURS: Colour[] = [
  { stems: ['красн', 'red'], rgb: '0.9, 0.1, 0.1', ru: 'красным', en: 'red' },
  { stems: ['син', 'blue'], rgb: '0.1, 0.2, 0.9', ru: 'синим', en: 'blue' },
  { stems: ['зелен', 'green'], rgb: '0.1, 0.8, 0.2', ru: 'зелёным', en: 'green' },
  { stems: ['желт', 'yellow'], rgb: '0.95, 0.85, 0.1', ru: 'жёлтым', en: 'yellow' },
  { stems: ['бел', 'white'], rgb: '0.95, 0.95, 0.95', ru: 'белым', en: 'white' },
  { stems: ['черн', 'black'], rgb: '0.05, 0.05, 0.05', ru: 'чёрным', en: 'black' },
  { stems: ['оранжев', 'orange'], rgb: '0.95, 0.45, 0.1', ru: 'оранжевым', en: 'orange' },
  { stems: ['фиолетов', 'purple', 'violet'], rgb: '0.5, 0.2, 0.8', ru: 'фиолетовым', en: 'purple' },
  { stems: ['розов', 'pink'], rgb: '0.95, 0.5, 0.7', ru: 'розовым', en: 'pink' },
  { stems: ['сер', 'gray', 'grey'], rgb: '0.5, 0.5, 0.5', ru: 'серым', en: 'grey' },
];

/** Английские основы короткие: «red» не должно ловить «reduce». */
function colourMatches(word: string, stem: string): boolean {
  return /^[a-z]+$/u.test(stem) ? word === stem : word.startsWith(stem);
}

const NUMBERS: Record<string, number> = {
  один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7,
  восемь: 8, девять: 9, десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30,
  сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70, восемьдесят: 80,
  девяносто: 90, сто: 100,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  twice: 2, double: 2, half: 2,
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
  'останови', 'запусти', 'включи', 'выключи', 'стоп', 'градусов', 'градуса',
  'make', 'paint', 'color', 'colour', 'to', 'by', 'times', 'raise', 'lower',
  'move', 'up', 'down', 'right', 'left', 'rotate', 'turn', 'spin', 'scale',
  'bigger', 'smaller', 'larger', 'enlarge', 'shrink', 'delete', 'remove', 'hide',
  'show', 'play', 'animation', 'cancel', 'degrees', 'units', 'higher', 'it',
];

const PRONOUNS = [
  'её', 'ее', 'его', 'это', 'эту', 'этот', 'их', 'её-то', 'выделенное', 'выделенный',
  'it', 'this', 'that', 'them', 'selected', 'selection', 'object',
];

/**
 * Не предметы сцены. «Удали файл», «покажи лог» при живом блендере — просьбы
 * к другим слоям или к агенту, и отвечать на них правкой сцены нельзя.
 */
const NOT_SCENE =
  /(?:^|\s)(?:файл|папк|письм|сообщени|лог(?:\s|$)|план(?:\s|$)|окно|работу|сетк|страниц|вкладк|(?:file|folder|email|message|log|plan|window|page|tab|grid)s?(?:\s|$))/u;

export interface LiveEdit {
  kind: 'python';
  code: string;
  /** Что сказать человеку. Коротко: он смотрит на экран, а не слушает отчёт. */
  said: string;
}

function words(utterance: string): string[] {
  return (
    utterance
      .toLowerCase()
      .replace(/ё/gu, 'е')
      // Десятичный разделитель сохраняем как точку.
      //
      // Без этого «подними на 0,5» превращалось в токены «0» и «5», число
      // бралось первое — ноль, — Блендер ничего не двигал, а человек слышал
      // «Сдвинул». Запятая между цифрами это дробь, а не знак препинания.
      .replace(/(\p{N})\s*[.,]\s*(\p{N})/gu, '$1.$2')
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      // Точка, не оказавшаяся дробной, остаётся знаком препинания.
      .replace(/(^|\s)\.+|\.+(\s|$)/gu, ' ')
      .split(/\s+/u)
      .filter((word) => word && !FILLER.includes(word))
  );
}

/**
 * Число словом или цифрой. `null` — числа не назвали.
 *
 * Десятки складываются с единицами: «сорок пять» — это 45, а не 40, как было,
 * пока брали первое попавшееся число.
 */
function numberIn(parts: readonly string[]): number | null {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    // Дробь тоже число: «на 0.5» после склейки разделителя приезжает одним
    // токеном, и терять её нельзя — Блендер ничего не сдвинет, а человек
    // услышит «Сдвинул».
    if (/^\d+(?:\.\d+)?$/u.test(part)) {
      const значение = Number(part);
      return Number.isFinite(значение) ? значение : null;
    }
    const named = NUMBERS[part];
    if (named === undefined) continue;
    const next = NUMBERS[parts[index + 1] ?? ''];
    if (named >= 20 && named % 10 === 0 && named < 100 && next !== undefined && next < 10) {
      return named + next;
    }
    return named;
  }
  return null;
}

/**
 * Кого правим.
 *
 * «Её», «его», «это», «it» — активный объект. Названное вслух ищется по имени,
 * и поиск нестрогий: человек говорит «ракету», а объект зовётся
 * «Ракета_корпус». Не нашлось — отказ, а не подмена выделенным.
 */
function targetCode(parts: readonly string[]): string {
  const named = parts.find(
    (word) =>
      word.length > 3 &&
      !PRONOUNS.includes(word) &&
      !(word in NUMBERS) &&
      !VERBS.includes(word) &&
      !COLOURS.some((colour) => colour.stems.some((stem) => colourMatches(word, stem))),
  );
  if (!named) return 'bpy.context.active_object';

  // Отрезаем одно окончание, не два. «Ракету» → «ракет» находит «Ракета» и
  // «Ракета_корпус»; «раке» нашло бы ещё и «ракушку».
  const stem = /^[a-z]+$/u.test(named) ? named : named.slice(0, Math.max(4, named.length - 1));
  // Одно совпадение или отказ.
  //
  // Раньше брался первый попавшийся: в сцене с «Ракета_корпус» и
  // «Ракета_двигатель» команда «удали ракету» уносила того, кто оказался
  // первым в коллекции, и человек не узнал бы, которого именно.
  return (
    `_один([o for o in bpy.data.objects if ${JSON.stringify(stem)} in o.name.lower()])`
  );
}

const МНОГО = tr('под это имя подходит несколько: ', 'several objects match that name: ');

const HEAD =
  'import bpy\nfrom math import radians\n' +
  'def _один(с):\n' +
  '    if len(с) == 1: return с[0]\n' +
  '    if not с: return None\n' +
  `    raise RuntimeError(${JSON.stringify(МНОГО)} + ", ".join(o.name for o in с))\n`;

// Промах по имени объекта — это незнание сцены, а не поломка. Живая правка
// смотрит только на имена: в сцене может лежать «Sphere.001», «Icosphere» или
// вовсе «Шар», и ни одно из них не совпадёт со сказанным «сфера». Агент умеет
// перечислить объекты и решить сам, поэтому такую фразу надо отдать ему.
//
// Живой прогон 26.09.2026: «Покрась сферу в зелёный» дважды упало сюда, и
// фраза умирала на месте — сфера на экране была, а человек услышал тишину.
const НЕЧЕГО_ПРАВИТЬ_RU = 'не нашёл, что править';
const НЕЧЕГО_ПРАВИТЬ_EN = 'nothing to edit found';

/**
 * Живая правка не нашла объект по имени — фразу стоит передать агенту.
 *
 * Оба языка проверяются всегда: скрипт собран тем `tr()`, что действовал при
 * разборе, а язык мог смениться между сборкой и ответом блендера.
 */
export function нечегоПравить(error: string): boolean {
  return error.includes(НЕЧЕГО_ПРАВИТЬ_RU) || error.includes(НЕЧЕГО_ПРАВИТЬ_EN);
}

function guard(): string {
  const message = tr(НЕЧЕГО_ПРАВИТЬ_RU, НЕЧЕГО_ПРАВИТЬ_EN);
  return `if о is None:\n    raise RuntimeError(${JSON.stringify(message)})\n`;
}

function onTarget(target: string, body: string): string {
  return `${HEAD}о = ${target}\n${guard()}${body}`;
}

/**
 * Слова запрета. Отрицание отменяет правку целиком, а не смягчает её.
 *
 * «Don't rotate it» после очистки знаков превращается в «don t rotate it», и
 * ветка поворота срабатывала вопреки прямому запрету. То же с «не крась это в
 * синий».
 */
const ОТРИЦАНИЕ = /(?:^|\s)(?:не|нет|dont|don t|never)(?:\s|$)/u;

export function parseLiveEdit(utterance: string): LiveEdit | null {
  const parts = words(utterance);
  if (parts.length === 0) return null;
  const joined = parts.join(' ');

  // Запрет разбираем ДО выбора действия: непонятая просьба лучше сделанной
  // наоборот.
  if (ОТРИЦАНИЕ.test(` ${joined} `)) return null;

  // Анимация — раньше остального: «останови анимацию» не должно попасть в
  // таблицу движения. «Stop animation» по-английски не ловим: «stop» —
  // красное слово и перехватывается раньше любых разборов.
  if (/(играй|запусти|включи) анимаци|play (the )?animation|start (the )?animation/u.test(joined)) {
    // Проверяем ИТОГ, а не факт вызова: `animation_play` умеет вернуть
    // `{'CANCELLED'}` без всякого исключения, и «Играю» звучало бы зря.
    return {
      kind: 'python',
      code:
        `${HEAD}итог = bpy.ops.screen.animation_play()\n` +
        'if "CANCELLED" in итог:\n' +
        `    raise RuntimeError(${JSON.stringify(tr('не вышло запустить анимацию', 'could not start the animation'))})\n` +
        'print("играю")',
      said: tr('Играю.', 'Playing.'),
    };
  }
  if (/(останови|стоп|выключи) анимаци|cancel (the )?animation|end (the )?animation/u.test(joined)) {
    return {
      kind: 'python',
      // `animation_cancel` отвечает `{'PASS_THROUGH'}` и когда останавливать
      // было нечего, поэтому смотрим на состояние до и после.
      code:
        `${HEAD}играла = bpy.context.screen.is_animation_playing\n` +
        'bpy.ops.screen.animation_cancel(restore_frame=False)\n' +
        'if not играла:\n' +
        `    raise RuntimeError(${JSON.stringify(tr('анимация и не шла', 'the animation was not running'))})\n` +
        'print("остановил")',
      said: tr('Остановил.', 'Stopped.'),
    };
  }

  if (NOT_SCENE.test(joined)) return null;

  const rest = parts.filter((word) => !VERBS.includes(word));
  const target = targetCode(rest);

  // Цвет.
  const colour = COLOURS.find((entry) =>
    rest.some((word) => entry.stems.some((stem) => colourMatches(word, stem))),
  );
  if (colour && /сделай|покрась|закрась|цвет|\bmake\b|\bpaint\b|\bcolou?r\b|\bturn\b/u.test(joined)) {
    return {
      kind: 'python',
      code: onTarget(
        target,
        'м = о.active_material or bpy.data.materials.new("Цвет")\n' +
          'if not о.data.materials: о.data.materials.append(м)\n' +
          // Общий материал сначала отделяем: один материал может стоять на
          // нескольких объектах, и «сделай ракету синей» перекрашивала заодно
          // всё, что делит с ней материал.
          'if м.users > 1:\n' +
          '    м = м.copy()\n' +
          '    о.data.materials[о.active_material_index] = м\n' +
          'м.use_nodes = True\n' +
          // Цветной вход ищем у узла, который ПРАВДА подключён к выходу.
          //
          // Раньше узел искался по имени «Principled BSDF»; у материала с
          // другим шейдером его нет, узлы не трогались вовсе, а мост всё
          // равно печатал «покрасил» — менялся один `diffuse_color`, на
          // итоговый цвет такого материала не влияющий.
          'выход = next((н for н in м.node_tree.nodes if н.type == "OUTPUT_MATERIAL"), None)\n' +
          'связь = выход.inputs["Surface"].links if выход and выход.inputs["Surface"].links else None\n' +
          'шейдер = связь[0].from_node if связь else м.node_tree.nodes.get("Principled BSDF")\n' +
          'вход = next((в for в in шейдер.inputs if в.type == "RGBA"), None) if шейдер else None\n' +
          'if вход is None:\n' +
          `    raise RuntimeError(${JSON.stringify(tr('у этого материала нечего красить', 'this material has no colour input'))})\n` +
          `вход.default_value = (${colour.rgb}, 1)\n` +
          `м.diffuse_color = (${colour.rgb}, 1)\n` +
          'print("покрасил", о.name)',
      ),
      said: tr(`Сделал ${colour.ru}.`, `Made it ${colour.en}.`),
    };
  }

  // Движение. Английским нужен глагол: голое «up» или «down» — это чаще
  // клавиша или прокрутка, чем просьба к сцене.
  const moves: Array<[RegExp, string]> = [
    [/подними|вверх|выше|\braise\b|move (it )?up|\bhigher\b/u, 'location.z += '],
    [/опусти|вниз|ниже|\blower\b|move (it )?down/u, 'location.z -= '],
    [/вправо|move (it )?(to the )?right/u, 'location.x += '],
    [/влево|move (it )?(to the )?left/u, 'location.x -= '],
  ];
  const move = moves.find(([pattern]) => pattern.test(joined));
  if (move) {
    const by = numberIn(rest) ?? 1;
    return {
      kind: 'python',
      code: onTarget(target, `о.${move[1]}${by}\nprint("сдвинул", о.name)`),
      said: tr('Сдвинул.', 'Moved.'),
    };
  }

  // Поворот.
  if (/поверни|разверни|крутни|\brotate\b|\bspin\b|turn (it|this|that)\b/u.test(joined)) {
    const by = numberIn(rest) ?? 90;
    return {
      kind: 'python',
      code: onTarget(target, `о.rotation_euler.z += radians(${by})\nprint("повернул", о.name)`),
      said: tr(`Повернул на ${by}.`, `Rotated by ${by}.`),
    };
  }

  // Размер.
  const bigger = /увеличь|\bbigger\b|\blarger\b|\benlarge\b|scale (it )?up/u.test(joined);
  const smaller = /уменьши|\bsmaller\b|\bshrink\b|scale (it )?down|\bhalf\b/u.test(joined);
  if (bigger || smaller) {
    const by = numberIn(rest) ?? 2;
    const factor = smaller ? `1/${by}` : `${by}`;
    return {
      kind: 'python',
      code: onTarget(target, `к = ${factor}\nо.scale = tuple(з * к for з in о.scale)\nprint("размер", о.name)`),
      said: tr('Готово.', 'Done.'),
    };
  }

  // Видимость и удаление.
  if (/^(удали|delete|remove)(?=\s|$)/u.test(joined)) {
    return {
      kind: 'python',
      code: onTarget(target, 'bpy.data.objects.remove(о, do_unlink=True)\nprint("удалил")'),
      said: tr('Удалил.', 'Deleted.'),
    };
  }
  if (/^(спрячь|скрой|hide)(?=\s|$)/u.test(joined)) {
    return {
      kind: 'python',
      code: onTarget(target, 'о.hide_viewport = True\nprint("спрятал", о.name)'),
      said: tr('Спрятал.', 'Hidden.'),
    };
  }
  // «Покажи» — только про объект. «Покажи папку», «покажи лог», «покажи план»
  // разбирают другие слои (отсечены выше, NOT_SCENE).
  if (/^(покажи|show|unhide)(?=\s|$)/u.test(joined)) {
    return {
      kind: 'python',
      code: onTarget(target, 'о.hide_viewport = False\nprint("показал", о.name)'),
      said: tr('Показал.', 'Shown.'),
    };
  }

  return null;
}
