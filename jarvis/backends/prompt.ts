/**
 * Composes the text handed to a subscription coding agent.
 *
 * The rule that matters: the user's own words go in verbatim and first. The
 * router's normalisation is supporting context, so a mis-normalisation can
 * never hide what was actually asked.
 */

import type { BackendRequest } from './types';

function section(title: string, lines: readonly string[]): string | null {
  const kept = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (kept.length === 0) return null;
  return `${title}\n${kept.map((line) => `- ${line}`).join('\n')}`;
}

function permissionLines(request: BackendRequest): string[] {
  const { permissions } = request;
  const lines = [
    permissions.read ? 'Reading files is allowed.' : 'Do not read files.',
    permissions.edit
      ? 'Editing files is allowed.'
      : 'Do NOT modify, create or delete any file. Inspect and report only.',
    permissions.execute
      ? 'Running commands (build, tests) is allowed.'
      : 'Do NOT run commands that change state.',
  ];
  if (!permissions.network) {
    lines.push('Do not make network requests.');
  }
  if (request.risk === 'sensitive' || request.risk === 'dangerous') {
    lines.push(
      'Do not push, publish, send messages, or take any other outward-facing action without being asked for it explicitly in the request above.',
    );
  }
  return lines;
}

/**
 * How to work on someone's screen without wrecking it.
 *
 * Written from what went wrong in practice: a model that clicks from memory
 * instead of from a fresh screenshot misses moved buttons, and one that never
 * writes anything down rediscovers the same layout on every single run while
 * the person waits.
 */
/**
 * Пульс: заглядывать, не сказал ли человек чего-нибудь, пока ты работаешь.
 *
 * Работа по одной команде идёт десятки минут, и всё это время человек рядом.
 * Без этой привычки его «крышу сделай синей» доходит до агента только через
 * полчаса — вместе с готовой крышей не того цвета.
 *
 * Пороги названы числами нарочно. «Иногда проверяй» модель выполняет как
 * «почти никогда»; «перед каждым крупным шагом и не реже, чем раз в пару
 * минут» — как указание.
 */
/**
 * Длинная работа по одной команде.
 *
 * То, ради чего всё это затевалось. Человек описал так: «джарвис получил
 * команду, составил план и работает» — сайт по биографии в концепции Бруно
 * Симон, из архива и гитхаба, с моделями, текстурами и физикой, по одной
 * фразе.
 *
 * Главное здесь — не разрешение работать долго, а запрет останавливаться.
 * Помощник, спрашивающий «какой оттенок синего вы предпочитаете» на двадцатой
 * минуте, не работает автономно: он ждёт у клавиатуры, за которой никого нет.
 */
const LONG_WORK_GUIDANCE = [
  'ЕСЛИ РАБОТА БОЛЬШАЯ:',
  '- Сначала set_plan: чего человек хочет и из каких шагов это состоит.',
  '  Он смотрит в окно и должен видеть замысел, а не молчание.',
  '- Взялся за шаг — mark_step «делаю». Кончил — «сделано» или «не вышло»',
  '  с одной строкой о том, чем именно. Сразу, а не в конце всей работы.',
  '- Вернулся к работе после перерыва — сначала show_plan. Продолжай с',
  '  неоконченного шага, а не с начала.',
  '- Не спрашивай разрешения посреди работы. Человека нет у клавиатуры: он',
  '  сказал одну фразу и ушёл. Выбирай сам, а выбор назови в ответе.',
  '- Споткнулся — обойди и иди дальше. Отметь шаг «не вышло», возьми',
  '  следующий. Останавливать всю работу из-за одного шага нельзя.',
  '- «Готово» говори, только когда проверил. Открыл файл, запустил, посмотрел',
  '  на результат — тогда готово. Не проверял — так и скажи.',
].join('\n');

const HEARTBEAT_GUIDANCE = [
  'ПОКА ТЫ РАБОТАЕШЬ, ЧЕЛОВЕК РЯДОМ:',
  '- Если работа длиннее пары минут, вызывай check_notes перед каждым крупным шагом',
  '  и не реже одного раза в две минуты.',
  '- Там лежит то, что человек сказал уже после того, как ты взялся за дело.',
  '  Это поправки к текущей работе, а не новая задача.',
  '- Забранное исчезает: учитывай сразу, второй раз не покажут.',
  '- Поправка важнее твоего плана. Услышал «крышу синей» — меняй крышу, а не',
  '  доделывай сначала стены, потому что так было задумано.',
].join('\n');

/**
 * Имена инструментов — сразу, чтобы агент их не искал.
 *
 * Замер 19 сентября: `ToolSearch` вызывался четыре раза за одну задачу — на
 * 12-й, 104-й, 109-й и 115-й секундах. Инструментов тридцать пять, Claude Code
 * отдаёт их описания по запросу, и агент тратил секунды на поиск того, что у
 * него уже было.
 */
const DESKTOP_CAPABILITIES = ['computer', 'vision', 'browser', 'files', 'system'] as const;

const TOOL_NAMES = [
  'ИНСТРУМЕНТЫ ПО ДЕЛУ (искать не надо, они уже твои):',
  '- Blender: blender_live_start, потом blender_live — работа в открытом окне.',
  '  Фоновый blender_python — только для рендера и пакетной работы.',
  '- Сайт: page_ride (снять целиком), page_depth (есть ли что делать),',
  '  browser_open, browser_read, browser_click, browser_fill, browser_key,',
  '  browser_wait_for, browser_download.',
  '- Чужая программа: window_list → window_look (снимок окна) → window_find',
  '  (найти надпись со снимка) → window_press / window_write по номеру.',
  '  Имя бери со снимка, а не из головы. Нажимай по номеру, а не по координатам.',
  '- Экран целиком: screenshot, click, type_text, press_key, list_windows, focus, run.',
  '- Файлы: output_folder, move_to_output, show_file, list_files.',
  '- Работа: set_plan, mark_step, show_plan, check_notes.',
  '- Память и навыки: recall, remember, forget, list_skills, write_skill.',
].join('\n');

/**
 * Работа в фоне: та же работа, но не лезя человеку на экран.
 *
 * Он переключает это голосом — «работай в фоне», «показывай всё». Смысл не в
 * скрытности: он занят своим делом, и окна, открывающиеся у него под руками,
 * мешают больше, чем помогают.
 *
 * Работа при этом остаётся настоящей: файл делается, проверяется и кладётся
 * куда просили. Не показывается только сам процесс.
 */
const QUIET_MODE = [
  'РАБОТАЙ В ФОНЕ:',
  '- Человек попросил не лезть на экран. Не открывай окна программ, не выводи',
  '  файлы на передний план, не переключай фокус.',
  '- Blender — только фоновый blender_python, без blender_live_start.',
  '- Сделанное всё равно проверяй: рендер в файл и посмотреть на него глазами.',
  '  Фон — это про то, что человек не видит процесс, а не про то, что проверок',
  '  нет.',
  '- В ответе назови полный путь к готовому файлу: человек откроет его сам,',
  '  когда освободится.',
].join('\n');

const COMPUTER_USE_GUIDANCE = [
  'WORKING ON THE SCREEN:',
  '- Start with recall: you may already know where things are from a previous run.',
  '- Look before you act. Take a screenshot, find the target on it, then click its coordinates.',
  '- After every action that changes the screen, take another screenshot and check it did what you expected.',
  '- A tool that reports failure has failed. Do not carry on as if it worked.',
  '- When you had to search for something — a button, a menu, the right window — remember it.',
  '- Prefer keyboard shortcuts and window focus over hunting for small targets.',
  "- This is the user's live desktop. Do not close their windows, dismiss their dialogs or",
  '  change their settings unless that is what was asked for.',
  '',
  // Самая тихая ловушка этой машины: скрипт отрабатывает успешно, а в
  // документе оказывается мусор вместо русского текста.
  'КИРИЛЛИЦА В СКРИПТАХ POWERSHELL:',
  '- PowerShell читает .ps1 как ANSI, если нет метки кодировки, а запись файла',
  '  её не ставит. «Привет» превращается в «РџСЂРёРІРµС‚», и скрипт при этом',
  '  сообщает об успехе.',
  '- Запускай скрипт строкой через -Command, либо держи .ps1 латинским, а',
  '  русский текст читай из отдельного файла с -Encoding UTF8.',
  '- При записи всегда -Encoding utf8: по умолчанию пишется кодовая страница.',
  '',
  // Фоновая работа не видна. Человек просил сделать в программе — значит
  // хочет увидеть это в программе, а не прочитать отчёт о сделанном.
  'РАБОТАЙ В ОТКРЫТОМ ОКНЕ, А НЕ ВМЕСТО НЕГО:',
  '- Blender: начни с blender_live_start, дальше все правки через blender_live.',
  '  Скрипт исполняется ВНУТРИ открытого окна, человек видит изменение сразу, и',
  '  файл не закрывается. Он просил именно этого: «сделал ракету, говорю — пусть',
  '  летит в космос, и он, не закрывая файл, при мне делает анимацию».',
  '- blender_python (фоновый, без окна) — только когда окна и не нужно: пакетная',
  '  обработка, рендер в файл. Для работы на глазах он не годится: каждая правка',
  '  там кончается новым окном вместо изменения старого.',
  '- Сохраняй файл только когда об этом попросили. Иначе человек получит десяток',
  '  версий и ни одной причины.',
  '',
  'ПОКАЖИ СДЕЛАННОЕ В САМОЙ ПРОГРАММЕ:',
  '- Сделал сцену в Blender — открой её в окне Blender (параметр show).',
  '- Сделал таблицу или документ — открой файл, а не только сохрани.',
  '- Сделал картинку — покажи её через show_file.',
  '- Человек смотрит на экран, а не в твой ответ. Невидимая работа для него',
  '  неотличима от несделанной.',
  '',
  // Снимок одного экрана врёт о горизонтальной работе, а безупречный на вид
  // кадр ничего не говорит о том, есть ли на странице что делать.
  'СТРАНИЦУ СУДИ ПО ВСЕЙ СТРАНИЦЕ:',
  '- Смотришь на сайт — зови page_ride, а не screenshot. Обычный снимок это один',
  '  экран, а у горизонтальной работы (Бруно Симон и подобные) один экран — это',
  '  заставка. Такая страница скриптом неподвижна, её везёт настоящее колесо.',
  '- Сделал страницу — перед «готово» зови page_depth. Он трогает её двенадцатью',
  '  действиями и считает, сколько разного она показала. Работа может быть',
  '  безупречной на вид и кончаться через тридцать секунд.',
  '- «Нечем мерить» — это не «плохо». Это значит, что прибор не смог, и чинить',
  '  надо прибор, а не работу. Не выдавай одно за другое.',
  '',
  // Без этого каждое трудно добытое знание живёт до конца задачи и в
  // следующий раз добывается заново — человеком, вручную.
  'ЧТО ВЫЯСНИЛ — ЗАПИШИ НАВЫКОМ:',
  '- Если пришлось разбираться и это повторится — сохрани через write_skill.',
  '  Каким флагом запускается программа, где у неё нужная кнопка, какой оператор',
  '  переименовали в этой версии, что именно не сработало и почему.',
  '- Сначала list_skills: дополнить существующий почти всегда лучше, чем завести',
  '  второй навык про то же самое.',
  '- Не записывай то, что узнаётся одной командой за секунду, и то, что верно',
  '  только сегодня. Навык — это знание, которое пригодится через месяц.',
  '- Пиши проверенное. Навык с выдуманным фактом хуже его отсутствия: по нему',
  '  будут действовать уверенно и неправильно.',
].join('\n');

export function buildBackendPrompt(request: BackendRequest): string {
  const language = request.language ?? 'ru';
  const parts: string[] = [];

  // Постоянные указания человека — раньше самой задачи.
  //
  // Это его собственный системный промпт: то, чего он хочет от ассистента
  // всегда. Разовая просьба не должна их отменять, поэтому они стоят первыми.
  const standing = request.instructions?.trim();
  if (standing) {
    parts.push(`ПОСТОЯННЫЕ УКАЗАНИЯ ЧЕЛОВЕКА (действуют всегда):
${standing}`);
  }

  parts.push(`USER REQUEST (verbatim, this is the source of truth):\n"""\n${request.utterance.trim()}\n"""`);

  if (request.goal && request.goal.trim()) {
    parts.push(
      `INTERPRETED GOAL (produced by a router, may be imprecise — the verbatim request above wins):\n${request.goal.trim()}`,
    );
  }

  const constraints = section('CONSTRAINTS', request.constraints ?? []);
  if (constraints) parts.push(constraints);

  const acceptance = section('ACCEPTANCE CRITERIA', request.acceptanceCriteria ?? []);
  if (acceptance) parts.push(acceptance);

  const context = section('CONTEXT', request.context ?? []);
  if (context) parts.push(context);

  if (request.project) {
    parts.push(`PROJECT: ${request.project}${request.cwd ? ` (${request.cwd})` : ''}`);
  }

  const permissions = section('PERMISSIONS', permissionLines(request));
  if (permissions) parts.push(permissions);

  if (request.capabilities.includes('computer')) {
    parts.push(COMPUTER_USE_GUIDANCE);
  }

  // Режим работы человек переключает голосом. По умолчанию — на виду: он
  // просил видеть, что происходит.
  if (request.showWork === false) {
    parts.push(QUIET_MODE);
  }

  // Уроки — раньше указаний о работе: их немного, и они самое конкретное, что
  // здесь есть. Общие правила без них читаются как общие слова.
  if (request.lessons?.trim()) {
    parts.push(request.lessons.trim());
  }

  // Имена инструментов — только тем задачам, у которых эти инструменты есть.
  //
  // Иначе задача «расскажи, что нового» получает перечень рычагов рабочего
  // стола, которых у неё нет, и платит за него входными токенами на каждом
  // запросе.
  if (DESKTOP_CAPABILITIES.some((capability) => request.capabilities.includes(capability))) {
    parts.push(TOOL_NAMES);
  }
  parts.push(LONG_WORK_GUIDANCE);
  parts.push(HEARTBEAT_GUIDANCE);

  if (request.homeDir) {
    parts.push(
      [
        'ГДЕ ТЫ ЖИВЁШЬ:',
        `${request.homeDir} — твоя собственная папка. Читай в ней что угодно.`,
        'Внутри: папка src — твой исходный код; папка data — твой лог jarvis.log,',
        'журнал действий journal.json и файл характер.md с постоянными указаниями',
        'человека.',
        'Спросили о тебе самом — посмотри туда, а не выдумывай. «Почему ты так',
        'сделал», «какие у тебя навыки», «что ты умеешь», «покажи свой лог» —',
        'на всё это ответ лежит в файлах, и прочитать их быстрее, чем гадать.',
        'Навыки лежат в папке .claude/skills в домашней папке человека.',
        'Менять что-то в своей папке — только если человек прямо об этом попросил.',
      ].join('\n'),
    );
  }

  if (request.outputDir) {
    parts.push(
      [
        'WHERE FINISHED FILES GO:',
        `Готовые файлы клади в ${request.outputDir} — это папка ассистента на рабочем столе.`,
        'Её видно человеку, и он найдёт там результат без объяснений.',
        'Внутри разделы: Images, Video, Docs, Files, Apps. Раздел выбирается по типу',
        'файла сам — вызови move_to_output, и файл окажется где нужно. Своих папок',
        'внутри не создавай.',
        'Временные файлы туда не клади: только то, что человек просил получить.',
        'Имя файла — осмысленное и по-русски, если человек говорил по-русски.',
        // Человек слышит ответ голосом и не видит ни чата, ни твоих логов.
        // Файл, о котором сказано «он у меня» — для человека не существует.
        'Сделал файл — назови в ответе его полный путь. Одной строкой, целиком.',
        'Не пиши, что файл «в чате», «приложен», «во вложении», «у меня»: этих',
        'мест нет. Есть только диск. Если файла на диске нет — работа не сделана.',
      ].join('\n'),
    );
  }

  parts.push(
    language === 'ru'
      ? [
          'ANSWER FORMAT',
          '- Write the final answer in Russian.',
          '- Start with one short sentence stating the outcome.',
          '- Then give the details: what you found, what you changed, what you ran.',
          '- Do not narrate your reasoning; report the actions and the result.',
        ].join('\n')
      : [
          'ANSWER FORMAT',
          '- Start with one short sentence stating the outcome.',
          '- Then give the details: what you found, what you changed, what you ran.',
        ].join('\n'),
  );

  return parts.join('\n\n');
}
