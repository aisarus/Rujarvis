/**
 * Руки для интерфейса: переключиться, нажать, пройти по меню, клавиши, текст в
 * поле — и приложение Claude.
 *
 * Одни и те же для прямых голосовых команд («переключись на клад», «напиши
 * клоду …») и для разговора, у которого теперь есть эти руки
 * (`talkMcpServer.ts`): незнакомую фразу разговор разбирает сам, видит список
 * на экране (`screen`) и жмёт одним-двумя вызовами — за секунды, а не
 * агентом за десять.
 *
 * ## Красные линии
 *
 * Руки модели — не руки человека. Кнопку покупки или отправки
 * (`labelRisk`) и Enter, который в мессенджере отправляет сообщение, модель
 * сама не нажимает: об этом говорится прямо, и человек говорит сам — «нажми
 * отправить». Человеку прямая команда это позволяет, как и раньше.
 * Исключение одно — «напиши клоду»: получатель — Claude, не человек.
 */

import { tr } from '../locale/language';
import { labelRisk } from '../risk/toolGate';
import type { DesktopControl, DesktopWindow } from '../desktop/driver';
import { chooseElement, type UiElement } from './elements';
import { pickBySound } from './soundMatch';
import { describeScreen, planSwitch, realWindows } from './switchTarget';

export interface UiHandsOptions {
  desktop: DesktopControl;
  /** Вкладка браузера по названию — у браузера своя полоса вкладок (`browserCommands.ts`). */
  browserTab?(name: string): Promise<{ name: string } | null>;
  /** Запасные имена окна: «хром» → Chrome (`windowCandidates`). */
  windowNames?(name: string): string[];
  /** Пауза, пока меню раскроется. */
  wait?(ms: number): Promise<void>;
  log?(line: string): void;
}

/** Кто просит: человек прямой командой или модель разговора. */
export type Who = 'person' | 'model';

export class UiRefusal extends Error {}

const ПОЧТИ_ПУСТОЕ = 12;

/** Кнопки, за которыми стирание или перезапись. */
const ПЕРЕЗАПИСЬ = new RegExp(
  String.raw`удал|замени|перезапис|стере|форматир|очистить корзин|delete|remove|replace|overwrite|erase|format\b|empty (the )?recycle`,
  'iu',
);

/** Состояние сессии в названии кнопки Claude: «Idle …», «Awaiting input …». */
const СОСТОЯНИЯ: Array<[RegExp, string]> = [
  [/^Awaiting input\s+/u, 'ждёт ответа'],
  [/^Unread response\s+/u, 'новый ответ'],
  [/^Running\s+/u, 'работает'],
  [/^Working\s+/u, 'работает'],
  [/^Idle\s+/u, 'свободна'],
  [/^#\d+\s*·\s*Draft\s+/u, 'черновик'],
];

export interface ClaudeSession {
  title: string;
  state: string;
  element: UiElement;
}

/** Сессии в боковой панели Claude — из названий кнопок. */
export function claudeSessions(elements: readonly UiElement[]): ClaudeSession[] {
  const out: ClaudeSession[] = [];
  for (const e of elements) {
    if (e.type !== 'Button') continue;
    for (const [приставка, state] of СОСТОЯНИЯ) {
      if (!приставка.test(e.name)) continue;
      out.push({ title: e.name.replace(приставка, '').trim(), state, element: e });
      break;
    }
  }
  return out;
}

export class UiHands {
  constructor(private readonly o: UiHandsOptions) {}

  private wait(ms: number): Promise<void> {
    return this.o.wait ? this.o.wait(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /** Элементы активного окна; Chromium строит дерево лениво — почти пустое спрашиваем ещё раз. */
  private async elements(): Promise<{ title: string; elements: UiElement[] }> {
    let окно = await this.o.desktop.elements();
    for (let i = 0; окно.elements.length < ПОЧТИ_ПУСТОЕ && i < 2; i += 1) {
      await this.wait(400);
      окно = await this.o.desktop.elements();
    }
    return окно;
  }

  /**
   * Элементы для выбора, а не для нажатия: не прочиталось — пусто. На маке
   * чтение переднего окна падает, когда впереди процесс без окон («Can't get
   * window 1»), и переключение на другое окно из-за этого не должно падать.
   */
  private async elementsOrNone(): Promise<{ title: string; elements: UiElement[] }> {
    try {
      return await this.elements();
    } catch (error) {
      this.o.log?.(`элементы активного окна не прочитались: ${error instanceof Error ? error.message : String(error)}`);
      return { title: '', elements: [] };
    }
  }

  async screen(): Promise<string> {
    const [windows, active] = await Promise.all([this.o.desktop.windows(), this.elementsOrNone()]);
    return describeScreen(active.title, windows, active.elements);
  }

  /**
   * Какие окна открыты — для отказа: «не нашёл» без соседей ничего не
   * объясняет. У окна без заголовка — имя программы: на маке так у окон
   * Электрона, и маковский драйвер называл их так же. null — список не
   * прочитался; пустая строка — окон правда нет.
   */
  async nearby(limit = 8): Promise<string | null> {
    try {
      const окна = realWindows(await this.o.desktop.windows());
      return [...new Set(окна.map((w) => w.title.trim() || (w as { app?: string }).app?.trim() || ''))].filter(Boolean).slice(0, limit).join(', ');
    } catch {
      return null;
    }
  }

  private async нажать(e: UiElement, who: Who): Promise<void> {
    if (who === 'model') this.проверить(e.name);
    await this.o.desktop.click({ x: e.x, y: e.y });
  }

  /**
   * Покупку, отправку и перезапись модель не жмёт — это решает человек своим
   * голосом. «Заменить», «удалить», «перезаписать» — красная линия владельца
   * про перезапись файлов и проектов: в диалоге сохранения одна такая кнопка
   * стирает чужую работу.
   */
  private проверить(название: string): void {
    const риск = labelRisk(название, '');
    if (риск.level !== 'safe') {
      throw new UiRefusal(`«${название}» — это покупка или отправка: такое нажимает только человек. Скажи ему: «нажми ${название}».`);
    }
    if (ПЕРЕЗАПИСЬ.test(название)) {
      throw new UiRefusal(`«${название}» может стереть или перезаписать файлы — такое нажимает только человек. Скажи ему: «нажми ${название}».`);
    }
  }

  /**
   * Переключиться: вкладка в активном окне, окно по звучанию, запасные имена
   * окна, вкладка браузера. Не нашлось — null, без броска: решает зовущий.
   */
  async switchTo(target: string, who: Who = 'person'): Promise<string | null> {
    const [windows, active] = await Promise.all([this.o.desktop.windows(), this.elementsOrNone()]);
    const план = planSwitch(target, windows, active.elements);
    if (план?.kind === 'element') {
      await this.нажать(план.element, who);
      return `открыл «${план.element.name}» в «${active.title}»`;
    }
    if (план?.kind === 'window') {
      const окно = await this.o.desktop.focus(план.title);
      return `переключился на «${окно.title}»`;
    }
    for (const имя of this.o.windowNames?.(target) ?? []) {
      try {
        const окно = await this.o.desktop.focus(имя);
        return `переключился на «${окно.title}»`;
      } catch (error) {
        // Следующее имя — но причину в журнал: на маке окно может найтись и
        // не подняться (нет «Универсального доступа»), и без неё не понять.
        this.o.log?.(`окно «${имя}» не поднялось: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const вкладка = await this.o.browserTab?.(target).catch(() => null);
    if (вкладка) return `переключился на вкладку «${вкладка.name}»`;
    return null;
  }

  /** Нажать в активном окне (или в названном — сначала переключиться). */
  async press(target: string, who: Who, inWindow?: string): Promise<string> {
    if (inWindow) {
      const куда = await this.switchTo(inWindow, who);
      if (!куда) throw new Error(`не нашёл окно «${inWindow}»`);
      await this.wait(250);
    }
    const { title, elements } = await this.elements();
    const точно = chooseElement(target, elements);
    const выбор = точно ? { item: точно, sure: true, close: [] as UiElement[] } : pickBySound(target, elements.filter((e) => e.enabled && e.name.trim()), (e) => e.name);
    if (!выбор) throw new Error(`в «${title}» нет ничего похожего на «${target}»`);
    if (!выбор.sure) {
      const варианты = [выбор.item, ...выбор.close].map((e) => `«${e.name}»`).join(', ');
      throw new Error(`в «${title}» похоже несколько: ${варианты} — какое?`);
    }
    await this.нажать(выбор.item, who);
    return `нажал «${выбор.item.name}» в «${title}»`;
  }

  /** Меню по пути: «Файл → Экспорт → FBX». Каждый шаг — нажать и дождаться, пока раскроется. */
  async menu(path: readonly string[], who: Who): Promise<string> {
    if (path.length === 0) throw new Error('пустой путь меню');
    const пройдено: string[] = [];
    for (const [i, шаг] of path.entries()) {
      if (i > 0) await this.wait(350);
      const { title, elements } = await this.elements();
      const кандидаты = elements.filter((e) => e.enabled && e.name.trim());
      // Пункты меню и вкладки — вперёд кнопок: «Файл» — это меню, а не кнопка «Файлы».
      const меню = кандидаты.filter((e) => /MenuItem|MenuBar|TabItem|ListItem|TreeItem/u.test(e.type));
      const выбор = pickBySound(шаг, меню, (e) => e.name) ?? pickBySound(шаг, кандидаты, (e) => e.name);
      if (!выбор?.sure) {
        throw new Error(
          `${пройдено.length ? `прошёл ${пройдено.join(' → ')}, ` : ''}дальше в «${title}» не нашёл «${шаг}»` +
            (выбор ? ` (похоже: ${[выбор.item, ...выбор.close].map((e) => `«${e.name}»`).join(', ')})` : ''),
        );
      }
      await this.нажать(выбор.item, who);
      пройдено.push(выбор.item.name);
    }
    return `открыл ${пройдено.join(' → ')}`;
  }

  /** Сочетание клавиш. Enter модель сама не жмёт: в мессенджере он отправляет. */
  async keys(combo: string, who: Who): Promise<string> {
    const клавиши = combo.toLowerCase().replace(/\s+/gu, '');
    if (who === 'model' && /(^|\+)(enter|return)$/u.test(клавиши)) {
      throw new UiRefusal('Enter может отправить сообщение — его нажимает только человек. Скажи ему: «нажми Enter».');
    }
    // Shift+Delete удаляет мимо корзины — насовсем.
    if (who === 'model' && /shift\+(delete|del)$/u.test(клавиши)) {
      throw new UiRefusal('Shift+Delete удаляет насовсем — его нажимает только человек.');
    }
    await this.o.desktop.key(клавиши);
    return `нажал ${клавиши}`;
  }

  /** Текст в поле активного окна (поле по названию — если сказано). Без Enter. */
  async type(text: string, field?: string): Promise<string> {
    if (field) {
      const { title, elements } = await this.elements();
      const поля = elements.filter((e) => /Edit|ComboBox|Document/u.test(e.type));
      const выбор = pickBySound(field, поля, (e) => e.name) ?? (chooseElement(field, поля) ? { item: chooseElement(field, поля) as UiElement, sure: true } : null);
      if (!выбор?.sure) throw new Error(`в «${title}» не нашёл поле «${field}»`);
      await this.o.desktop.click({ x: выбор.item.x, y: выбор.item.y });
      await this.wait(120);
    }
    await this.o.desktop.type(text);
    return `напечатал ${text.length} знаков`;
  }

  // ——— Приложение Claude ———

  /** Окно Claude вперёд и его элементы. */
  private async claude(): Promise<{ title: string; elements: UiElement[] }> {
    const окна: DesktopWindow[] = await this.o.desktop.windows();
    const claude = окна.find((w) => w.title.trim() === 'Claude') ?? pickBySound('Claude', окна, (w) => w.title)?.item;
    if (!claude) throw new Error('приложение Claude не открыто');
    if (!claude.focused) {
      await this.o.desktop.focus(claude.title);
      await this.wait(200);
    }
    return this.elements();
  }

  /** «Напиши клоду …»: текст в поле Prompt и отправка. Получатель — Claude, а не человек. */
  async claudeSend(text: string): Promise<string> {
    const { elements } = await this.claude();
    const поле = elements.find((e) => e.type === 'Edit' && /^prompt$/iu.test(e.name.trim())) ?? elements.find((e) => e.type === 'Edit' && /prompt|reply|message/iu.test(e.name));
    if (!поле) throw new Error('в Claude не видно поля ввода — откройте сессию');
    await this.o.desktop.click({ x: поле.x, y: поле.y });
    await this.wait(120);
    await this.o.desktop.type(text);
    await this.wait(80);
    await this.o.desktop.key('enter');
    // Без самого текста: это продиктованное, и в журнал оно не идёт.
    return `отправил Claude ${text.length} знаков`;
  }

  /** Раздел приложения: Code или Chat — переключатель вверху окна. */
  async claudeMode(mode: 'code' | 'chat'): Promise<string> {
    const { elements } = await this.claude();
    const признак = mode === 'code' ? /^code\b/iu : /^chat\b/iu;
    const раздел = elements.find((e) => e.type === 'RadioButton' && признак.test(e.name.trim()));
    if (!раздел) throw new Error(`в Claude не видно раздела ${mode === 'code' ? 'Code' : 'Chat'}`);
    await this.o.desktop.click({ x: раздел.x, y: раздел.y });
    return `Claude: ${mode === 'code' ? 'Code' : 'Chat'}`;
  }

  /** Какие сессии ждут: «ждёт ответа» и «новый ответ». */
  async claudeWaiting(): Promise<string> {
    const { elements } = await this.claude();
    const сессии = claudeSessions(elements);
    const ждут = сессии.filter((s) => s.state === 'ждёт ответа');
    const новые = сессии.filter((s) => s.state === 'новый ответ');
    if (ждут.length === 0 && новые.length === 0) return tr('Никто не ждёт: новых ответов нет.', 'Nobody is waiting: no new replies.');
    return [
      ждут.length ? tr(`Ждут ответа: ${ждут.map((s) => s.title).join('; ')}.`, `Waiting for you: ${ждут.map((s) => s.title).join('; ')}.`) : '',
      новые.length ? tr(`Новый ответ: ${новые.map((s) => s.title).join('; ')}.`, `New reply: ${новые.map((s) => s.title).join('; ')}.`) : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  /** Открыть сессию по названию — на слух. */
  async claudeOpenSession(name: string): Promise<string> {
    const { elements } = await this.claude();
    const выбор = pickBySound(name, claudeSessions(elements), (s) => s.title);
    if (!выбор) throw new Error(`в Claude нет сессии, похожей на «${name}»`);
    if (!выбор.sure) throw new Error(`похоже несколько сессий: ${[выбор.item, ...выбор.close].map((s) => `«${s.title}»`).join(', ')} — какую?`);
    await this.o.desktop.click({ x: выбор.item.element.x, y: выбор.item.element.y });
    return `открыл сессию «${выбор.item.title}»`;
  }

  /** Новая сессия — в папке проекта, если названа. */
  async claudeNewSession(project?: string): Promise<string> {
    const { elements } = await this.claude();
    const новые = elements.filter((e) => e.type === 'Button' && /^New session in /u.test(e.name));
    if (project) {
      const выбор = pickBySound(project, новые, (e) => e.name.replace(/^New session in /u, ''));
      if (!выбор?.sure) throw new Error(`не нашёл проект «${project}»${выбор ? ` (похоже: ${[выбор.item, ...выбор.close].map((e) => e.name.replace(/^New session in /u, '')).join(', ')})` : ''}`);
      await this.o.desktop.click({ x: выбор.item.x, y: выбор.item.y });
      return `новая сессия в «${выбор.item.name.replace(/^New session in /u, '')}»`;
    }
    const кнопка = elements.find((e) => e.type === 'Button' && e.name.trim() === 'New');
    if (!кнопка) throw new Error('не вижу кнопки новой сессии');
    await this.o.desktop.click({ x: кнопка.x, y: кнопка.y });
    return 'новая сессия';
  }

  /** «Прерви клода» — кнопка остановки ответа. */
  async claudeInterrupt(): Promise<string> {
    const { elements } = await this.claude();
    const стоп = elements.find((e) => e.type === 'Button' && /^stop$/iu.test(e.name.trim()));
    if (!стоп) throw new Error('Claude сейчас ничего не пишет — прерывать нечего');
    await this.o.desktop.click({ x: стоп.x, y: стоп.y });
    return 'прервал ответ Claude';
  }
}
