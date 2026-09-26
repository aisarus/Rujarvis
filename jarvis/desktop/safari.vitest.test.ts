import { describe, expect, it } from 'vitest';

import {
  javaScriptЗапрещён,
  КАК_РАЗРЕШИТЬ_JS,
  вКавычки,
  открытьВкладкуScript,
  перейтиScript,
  разобратьВкладки,
  разобратьПереход,
  РАЗДЕЛИТЕЛЬ,
  РАЗДЕЛИТЕЛЬ_СТРОК,
  ВКЛАДКИ_SCRIPT,
  текстСтраницыScript,
} from './safari';

/**
 * Safari — браузер человека, а не наш.
 *
 * Playwright поднимает СВОЙ профиль: вкладки открываются в чистом браузере,
 * где человек никуда не вошёл, и «включи сериал» упирается в форму входа.
 * Safari — тот самый браузер, в котором он уже сидит.
 */
const БС = String.fromCharCode(92);

describe('вКавычки', () => {
  it('прячет кавычку в названии страницы, а не рвёт на ней скрипт', () => {
    // Заголовки сериалов полны кавычек и двоеточий. Без экранирования
    // AppleScript ломается на первом же таком названии.
    expect(вКавычки('Смотри "Друзей"')).toBe(`"Смотри ${БС}"Друзей${БС}""`);
  });

  it('удваивает обратную косую', () => {
    expect(вКавычки(`путь${БС}сюда`)).toBe(`"путь${БС}${БС}сюда"`);
  });
});

describe('скрипты навигации', () => {
  it('в именах переменных только латиница', () => {
    // В AppleScript кириллица в именах даёт «syntax error: Expected
    // expression but found unknown token». Строки в кавычках — можно.
    for (const скрипт of [открытьВкладкуScript('https://ya.ru'), перейтиScript('https://ya.ru'), ВКЛАДКИ_SCRIPT]) {
      const безСтрок = скрипт.replace(/"[^"]*"/gu, '""');
      expect(безСтрок).not.toMatch(/[а-яё]/iu);
    }
  });

  it('новая вкладка становится текущей', () => {
    // Человек сказал «открой вкладку» и ждёт, что разговор дальше про неё.
    const скрипт = открытьВкладкуScript('https://ya.ru');
    expect(скрипт).toContain('set current tab to newTab');
  });

  it('переход не плодит вкладок', () => {
    const скрипт = перейтиScript('https://ya.ru');
    expect(скрипт).toContain('set URL of current tab');
    expect(скрипт).not.toContain('make new tab');
  });

  it('на пустом Safari открывает окно, а не падает', () => {
    // Свежий мак: Safari закрыт, окон нет вовсе.
    for (const скрипт of [открытьВкладкуScript('https://ya.ru'), перейтиScript('https://ya.ru')]) {
      expect(скрипт).toContain('if (count of windows) is 0');
      expect(скрипт).toContain('make new document');
    }
  });

  it('выводит Safari вперёд: работа должна быть видна', () => {
    expect(открытьВкладкуScript('https://ya.ru')).toContain('activate');
  });
});

describe('разбор ответов', () => {
  it('читает вкладки и отмечает текущую', () => {
    const вывод =
      ['Яндекс', 'https://ya.ru', '0'].join(РАЗДЕЛИТЕЛЬ) +
      РАЗДЕЛИТЕЛЬ_СТРОК +
      ['Друзья: сезон 1', 'https://kino/1', '1'].join(РАЗДЕЛИТЕЛЬ) +
      РАЗДЕЛИТЕЛЬ_СТРОК;
    const вкладки = разобратьВкладки(вывод);
    expect(вкладки).toHaveLength(2);
    expect(вкладки[1]).toEqual({ title: 'Друзья: сезон 1', url: 'https://kino/1', active: true });
  });

  it('не рассыпается на заголовке с запятой и двоеточием', () => {
    // Ровно поэтому разделители — управляющие символы, а не запятые.
    const вывод = ['Друзья, сезон 1: начало', 'https://k/1', '1'].join(РАЗДЕЛИТЕЛЬ) + РАЗДЕЛИТЕЛЬ_СТРОК;
    expect(разобратьВкладки(вывод)[0].title).toBe('Друзья, сезон 1: начало');
  });

  it('пустой ответ — это ноль вкладок, а не поломка', () => {
    expect(разобратьВкладки('')).toEqual([]);
    expect(разобратьВкладки(`   ${РАЗДЕЛИТЕЛЬ_СТРОК}  `)).toEqual([]);
  });

  it('разбирает ответ перехода', () => {
    expect(разобратьПереход(`Яндекс${РАЗДЕЛИТЕЛЬ}https://ya.ru`)).toEqual({
      title: 'Яндекс',
      url: 'https://ya.ru',
    });
  });
});

describe('javaScriptЗапрещён', () => {
  it('отличает запрет Safari от пустой страницы', () => {
    // «Страница пустая» и «Safari не пустил» — разные беды, и чинят их
    // по-разному: вторую человек чинит одной галкой в меню «Разработка».
    for (const текст of [
      'Not authorized to send Apple Events to Safari',
      'execution error: Safari got an error: JavaScript through Apple Events is turned off (-1743)',
      'errAEEventNotPermitted',
    ]) {
      expect(javaScriptЗапрещён(new Error(текст)), текст).toBe(true);
    }
    expect(javaScriptЗапрещён(new Error('timed out after 4s'))).toBe(false);
  });

  it('подсказка называет обе галки, а не одну', () => {
    // Меню «Разработка» само по себе скрыто: без первой галки человек не
    // найдёт вторую и решит, что мы врём.
    expect(КАК_РАЗРЕШИТЬ_JS).toContain('Разработка');
    expect(КАК_РАЗРЕШИТЬ_JS).toContain('Apple Events');
  });
});

describe('текстСтраницыScript', () => {
  it('режет текст в самом браузере, а не тащит мегабайты наружу', () => {
    expect(текстСтраницыScript(2_000)).toContain('slice(0, 2000)');
  });

  it('не падает на странице без тела', () => {
    expect(текстСтраницыScript(100)).toContain('document.body ?');
  });
});
