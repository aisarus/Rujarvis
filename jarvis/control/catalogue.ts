/**
 * Список команд — то, что Джарвис показывает на «что ты умеешь».
 *
 * Команд около восьмидесяти, и человек, который о них не знает, ими не
 * пользуется. Для управления голосом это не мелочь: незнание команды
 * неотличимо от её отсутствия.
 *
 * ## Почему список не написан руками
 *
 * Написанный руками он расходится с кодом на первой же правке — и тогда
 * обещает то, чего нет. Человек говорит обещанное, ничего не происходит, и он
 * перестаёт верить всему списку целиком.
 *
 * Поэтому здесь перечислены только примеры, а тест проверяет, что каждый из
 * них действительно разбирается, и что представлен каждый вид команды. Список,
 * который лжёт, не пройдёт сборку.
 */

import { currentLanguage, type Language } from '../locale/language';

export interface CatalogueItem {
  /** Что сказать. */
  say: string;
  /** Что произойдёт. */
  does: string;
  /**
   * Кто это обрабатывает.
   *
   * Разметка не для человека, а для проверки: тест умеет спросить нужный слой
   * и убедиться, что обещанная фраза действительно разбирается.
   */
  layer: 'direct' | 'launch' | 'close' | 'wake' | 'silence' | 'dictation' | 'control';
}

export interface CatalogueGroup {
  title: string;
  items: CatalogueItem[];
}

/** Справочник на языке режима. У каждого языка свои фразы, проверяемые тестом. */
export function commandCatalogue(language: Language = currentLanguage()): CatalogueGroup[] {
  return language === 'en' ? englishCatalogue() : russianCatalogue();
}

function russianCatalogue(): CatalogueGroup[] {
  return [
    {
      title: 'Программы',
      items: [
        { say: 'открой хром', does: 'запустить программу по имени', layer: 'launch' },
        { say: 'закрой стим', does: 'закрыть программу', layer: 'close' },
        { say: 'переключись на блендер', does: 'показать уже открытое окно', layer: 'direct' },
        { say: 'разверни', does: 'развернуть окно', layer: 'direct' },
        { say: 'сверни', does: 'свернуть окно', layer: 'direct' },
        { say: 'закрой окно', does: 'закрыть текущее окно', layer: 'direct' },
        { say: 'покажи рабочий стол', does: 'свернуть всё', layer: 'direct' },
      ],
    },
    {
      title: 'Мышь и точка на экране',
      items: [
        { say: 'кликни войти', does: 'нажать кнопку по её названию', layer: 'direct' },
        { say: 'кликни', does: 'нажать там, где курсор', layer: 'direct' },
        { say: 'правый клик', does: 'нажать правой кнопкой', layer: 'direct' },
        { say: 'двойной клик', does: 'нажать дважды', layer: 'direct' },
        { say: 'сетка', does: 'показать сетку с номерами поверх экрана', layer: 'direct' },
        { say: 'клик сорок пять', does: 'нажать в середину клетки 45', layer: 'direct' },
        { say: 'точнее пять', does: 'уточнить внутри клетки до девятой доли', layer: 'direct' },
        { say: 'убери сетку', does: 'спрятать сетку', layer: 'direct' },
      ],
    },
    {
      title: 'Прокрутка',
      items: [
        { say: 'прокрути вниз', does: 'прокрутить вниз', layer: 'direct' },
        { say: 'прокрути вверх', does: 'прокрутить вверх', layer: 'direct' },
        { say: 'в самый низ', does: 'в конец страницы', layer: 'direct' },
        { say: 'в самый верх', does: 'в начало страницы', layer: 'direct' },
        { say: 'страница вниз', does: 'на экран вниз', layer: 'direct' },
        { say: 'прокрути вниз три раза', does: 'повторить команду несколько раз', layer: 'direct' },
      ],
    },
    {
      title: 'Текст',
      items: [
        { say: 'режим диктовки', does: 'всё сказанное печатается буква в букву', layer: 'direct' },
        { say: 'конец диктовки', does: 'выйти из диктовки', layer: 'direct' },
        { say: 'удали последнее слово', does: 'стереть слово — прямо во время диктовки', layer: 'dictation' },
        { say: 'удали строку', does: 'стереть строку целиком', layer: 'dictation' },
        { say: 'новая строка', does: 'перенести на новую строку', layer: 'dictation' },
        { say: 'исправь на встречу', does: 'заменить последнее слово', layer: 'dictation' },
        { say: 'напечатай привет', does: 'напечатать одну фразу', layer: 'direct' },
        { say: 'скопируй', does: 'копировать', layer: 'direct' },
        { say: 'вставь', does: 'вставить', layer: 'direct' },
        { say: 'вырежи', does: 'вырезать', layer: 'direct' },
        { say: 'выдели все', does: 'выделить всё', layer: 'direct' },
        { say: 'отмени действие', does: 'отменить последнее', layer: 'direct' },
        { say: 'удали', does: 'стереть символ', layer: 'direct' },
      ],
    },
    {
      title: 'Клавиши',
      items: [
        { say: 'enter', does: 'ввод', layer: 'direct' },
        // Здесь стояла «отмена». Она разбирается раньше — как отмена задачи,
        // и так задумано: человек назвал остановку отдельным требованием. До
        // клавиши фраза не доезжала, а справочник её обещал.
        { say: 'эскейп', does: 'escape', layer: 'direct' },
        { say: 'таб', does: 'табуляция', layer: 'direct' },
        { say: 'пробел', does: 'пробел', layer: 'direct' },
        { say: 'вниз', does: 'стрелка вниз', layer: 'direct' },
        { say: 'вверх', does: 'стрелка вверх', layer: 'direct' },
        { say: 'сохрани', does: 'сохранить', layer: 'direct' },
        { say: 'найди', does: 'поиск по странице', layer: 'direct' },
        { say: 'обнови', does: 'обновить', layer: 'direct' },
      ],
    },
    {
      title: 'Вкладки',
      items: [
        { say: 'новая вкладка', does: 'открыть вкладку', layer: 'direct' },
        { say: 'закрой вкладку', does: 'закрыть вкладку', layer: 'direct' },
        { say: 'верни вкладку', does: 'вернуть закрытую', layer: 'direct' },
        { say: 'следующая вкладка', does: 'перейти к следующей', layer: 'direct' },
      ],
    },
    {
      title: 'Звук',
      items: [
        { say: 'громче', does: 'прибавить звук', layer: 'direct' },
        { say: 'тише звук', does: 'убавить звук', layer: 'direct' },
        { say: 'выключи звук', does: 'приглушить', layer: 'direct' },
        // Здесь стояла «пауза». Она разбирается раньше — как пауза работы, и
        // это красная линия, трогать её нельзя. Музыку останавливает «играй».
        { say: 'играй', does: 'пауза и продолжение', layer: 'direct' },
        { say: 'следующий трек', does: 'следующая песня', layer: 'direct' },
      ],
    },
    {
      title: 'Разговор',
      items: [
        { say: 'джарвис', does: 'разбудить — дальше можно без имени', layer: 'wake' },
        // Красные линии. Человек сказал о них прямо: «идеально должны
        // работать команды стоп и тишина». Не обещать их в списке — значит
        // прятать единственное, что обязано срабатывать всегда; «стоп» здесь
        // не было вовсе.
        { say: 'стоп', does: 'немедленно прекратить всё, что делается', layer: 'control' },
        { say: 'тишина', does: 'замолчать и закончить разговор', layer: 'silence' },
        { say: 'пауза', does: 'отложить работу, не теряя её', layer: 'control' },
        { say: 'продолжай', does: 'вернуться к отложенной работе', layer: 'control' },
        // Разговор помнит нить весь вечер. Когда человек переходит к другому
        // делу, старая нить тянет за собой чужой замысел — и это его кнопка.
        { say: 'забудь разговор', does: 'начать разговор с чистого листа', layer: 'direct' },
        { say: 'что ты умеешь', does: 'показать этот список', layer: 'direct' },
        { say: 'что ты делаешь', does: 'открыть окно с рассказом о работе', layer: 'direct' },
        { say: 'где ты', does: 'сказать, на каком шаге плана', layer: 'direct' },
        { say: 'диктую', does: 'слушать длинную мысль с паузами до пяти секунд', layer: 'direct' },
        { say: 'работай в фоне', does: 'не открывать окна и не лезть на экран', layer: 'direct' },
        { say: 'показывай всё', does: 'снова работать на виду', layer: 'direct' },
        { say: 'закрой лог', does: 'убрать окно с рассказом', layer: 'direct' },
      ],
    },
  ];
}

/**
 * English commands. Only what the English tables really handle: dictation
 * editing and live Blender edits are Russian-only for now, so they are not
 * promised here.
 */
function englishCatalogue(): CatalogueGroup[] {
  return [
    {
      title: 'Apps',
      items: [
        { say: 'open chrome', does: 'start an app by name', layer: 'launch' },
        { say: 'close steam', does: 'close an app', layer: 'close' },
        { say: 'switch to blender', does: 'bring an open window forward', layer: 'direct' },
        { say: 'maximize', does: 'maximize the window', layer: 'direct' },
        { say: 'minimize', does: 'minimize the window', layer: 'direct' },
        { say: 'close the window', does: 'close the current window', layer: 'direct' },
        { say: 'show desktop', does: 'minimize everything', layer: 'direct' },
      ],
    },
    {
      title: 'Mouse and screen',
      items: [
        { say: 'click sign in', does: 'press a button by its name', layer: 'direct' },
        { say: 'click', does: 'click where the cursor is', layer: 'direct' },
        { say: 'right click', does: 'right-click', layer: 'direct' },
        { say: 'double click', does: 'double-click', layer: 'direct' },
        { say: 'show grid', does: 'numbered grid over the screen', layer: 'direct' },
        { say: 'click forty five', does: 'click the middle of cell 45', layer: 'direct' },
        { say: 'refine five', does: 'narrow down inside the cell', layer: 'direct' },
        { say: 'hide grid', does: 'hide the grid', layer: 'direct' },
      ],
    },
    {
      title: 'Scrolling',
      items: [
        { say: 'scroll down', does: 'scroll down', layer: 'direct' },
        { say: 'scroll up', does: 'scroll up', layer: 'direct' },
        { say: 'go to the bottom', does: 'end of the page', layer: 'direct' },
        { say: 'go to the top', does: 'start of the page', layer: 'direct' },
        { say: 'page down', does: 'one screen down', layer: 'direct' },
        { say: 'scroll down three times', does: 'repeat a command', layer: 'direct' },
      ],
    },
    {
      title: 'Text',
      items: [
        { say: 'start dictation', does: 'type everything you say', layer: 'direct' },
        { say: 'end dictation', does: 'leave dictation', layer: 'direct' },
        { say: 'type hello', does: 'type one phrase', layer: 'direct' },
        { say: 'copy', does: 'copy the selection', layer: 'direct' },
        { say: 'paste', does: 'paste from the clipboard', layer: 'direct' },
        { say: 'cut', does: 'cut the selection', layer: 'direct' },
        { say: 'select all', does: 'select everything', layer: 'direct' },
        { say: 'undo', does: 'undo the last action', layer: 'direct' },
      ],
    },
    {
      title: 'Keys',
      items: [
        { say: 'press enter', does: 'enter', layer: 'direct' },
        { say: 'escape', does: 'escape', layer: 'direct' },
        { say: 'space', does: 'space bar', layer: 'direct' },
        { say: 'arrow down', does: 'down arrow', layer: 'direct' },
        { say: 'save', does: 'save', layer: 'direct' },
        { say: 'find', does: 'search the page', layer: 'direct' },
        { say: 'refresh', does: 'reload', layer: 'direct' },
      ],
    },
    {
      title: 'Tabs',
      items: [
        { say: 'new tab', does: 'open a tab', layer: 'direct' },
        { say: 'close tab', does: 'close the tab', layer: 'direct' },
        { say: 'reopen tab', does: 'bring back a closed tab', layer: 'direct' },
        { say: 'next tab', does: 'go to the next tab', layer: 'direct' },
      ],
    },
    {
      title: 'Sound',
      items: [
        { say: 'volume up', does: 'louder', layer: 'direct' },
        { say: 'volume down', does: 'quieter', layer: 'direct' },
        { say: 'mute sound', does: 'mute the system sound', layer: 'direct' },
        { say: 'play music', does: 'play and pause', layer: 'direct' },
        { say: 'next track', does: 'next song', layer: 'direct' },
      ],
    },
    {
      title: 'Conversation',
      items: [
        { say: 'jarvis', does: 'wake up — then speak without the name', layer: 'wake' },
        { say: 'stop', does: 'stop whatever is being done, now', layer: 'control' },
        { say: 'silence', does: 'stop talking and end the conversation', layer: 'silence' },
        { say: 'pause', does: 'put the work aside without losing it', layer: 'control' },
        { say: 'continue', does: 'go back to the paused work', layer: 'control' },
        { say: 'new conversation', does: 'start the conversation from scratch', layer: 'direct' },
        { say: 'what can you do', does: 'show this list', layer: 'direct' },
        { say: 'what are you doing', does: 'open the events window', layer: 'direct' },
        { say: 'where are you', does: 'say which plan step is running', layer: 'direct' },
        { say: 'long message', does: 'listen to a long thought with pauses', layer: 'direct' },
        { say: 'work in the background', does: 'do not open windows or take the screen', layer: 'direct' },
        { say: 'show everything', does: 'work in view again', layer: 'direct' },
        { say: 'close the log', does: 'hide the events window', layer: 'direct' },
      ],
    },
  ];
}
