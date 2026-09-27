import { describe, expect, it } from 'vitest';

import { сценарийВхода, скриптТерминала, терминалДляВхода } from './loginTerminal';

/**
 * Вход в аккаунт — единственный шаг онбординга, который обойти нельзя.
 *
 * Живой прогон 26.09.2026 у владельца: вкладка «войти» открывала окно, и в нём
 * стояло «"\\"C:\\Users\\ariel\\.local\\bin\\claude.exe\\"" не является
 * внутренней или внешней командой». То есть первый обязательный шаг не работал
 * вовсе, а поймать это не могло ничто: команда собиралась внутри Электрона и
 * никем не проверялась.
 */
const ПАПКА = 'C:\\Users\\John Smith\\AppData\\Local\\Rujarvis\\data';

describe('терминалДляВхода на Windows', () => {
  const путь = 'C:\\Users\\ariel\\.local\\bin\\claude.exe';

  it('не ставит своих кавычек в командную строку', () => {
    const запуск = терминалДляВхода(путь, ['auth', 'login'], ПАПКА, 'win32');

    // Node сам экранирует кавычки внутри аргумента как `\\"`, а этого cmd не
    // понимает. Своя кавычка в командной строке = сломанный вход.
    for (const довод of запуск.args) {
      expect(довод, `кавычка в доводе: ${довод}`).not.toContain('"');
    }
  });

  it('запускает файл сценария, а не сам CLI', () => {
    const запуск = терминалДляВхода(путь, ['auth', 'login'], ПАПКА, 'win32');

    // Кавычки уходят ВНУТРЬ файла, где их больше никто не переэкранирует. Это
    // и есть развязка: снаружи чисто, внутри наши кавычки.
    expect(запуск.file).toBe('cmd.exe');
    expect(запуск.args).toEqual(['/c', 'start', '', `${ПАПКА}\\vhod.cmd`]);
    expect(запуск.сценарий?.файл).toBe(`${ПАПКА}\\vhod.cmd`);
  });

  it('имя файла сценария — латиницей', () => {
    // cmd читает имена файлов своей кодовой страницей и кириллическое имя
    // просто не находит. Замерено: на этом спотыкнулась первая версия живой
    // проверки — заглушка с русским именем не запускалась вовсе.
    const имя = терминалДляВхода(путь, [], ПАПКА, 'win32').сценарий?.файл ?? '';
    expect(имя.split('\\').pop()).toMatch(/^[a-z.]+$/u);
  });

  it('заголовок окна — пустая строка, а не пара кавычек', () => {
    // `'""'` Node превратил бы в `"\\"\\""`. Пустая строка становится `""`
    // сама — тот же приём проверен живьём в запуске программ голосом.
    expect(терминалДляВхода(путь, [], ПАПКА, 'win32').args[2]).toBe('');
  });
});

describe('сценарийВхода', () => {
  it('берёт путь и доводы в кавычки', () => {
    const текст = сценарийВхода('C:\\Users\\John Smith\\bin\\claude.exe', ['auth', 'login']);

    // Пробел в пути — это имя человека из двух слов, случай обычный. Кавычки
    // здесь наши: внутри файла между этой строкой и cmd больше нет ничьего
    // экранирования, и ломаться нечему.
    expect(текст).toContain('"C:\\Users\\John Smith\\bin\\claude.exe" "auth" "login"');
  });

  it('оставляет окно открытым', () => {
    // Без pause окно закрывается вместе с CLI, и отказ входа мелькнёт и
    // исчезнет — то самое «тишина вместо причины», от которого лечим весь день.
    expect(сценарийВхода('C:\\x\\claude.exe', ['auth', 'login'])).toMatch(/\bpause\b/u);
  });

  it('переключает кодовую страницу на UTF-8', () => {
    // Иначе русский текст самого CLI приедет в окно мусором.
    expect(сценарийВхода('C:\\x\\claude.exe', [])).toContain('chcp 65001');
  });

  it('строки разделены возвратом каретки: это файл для cmd', () => {
    expect(сценарийВхода('C:\\x\\claude.exe', [])).toContain(String.fromCharCode(13));
  });
});

describe('терминалДляВхода на macOS', () => {
  const путь = '/Users/tester/.local/bin/claude';

  it('зовёт osascript и выводит Терминал вперёд', () => {
    const запуск = терминалДляВхода(путь, ['auth', 'login'], '/tmp', 'darwin');

    expect(запуск.file).toBe('osascript');
    // Без activate окно открывается ПОЗАДИ, а человеку в него надо вводить код.
    expect(запуск.args[1]).toContain('activate');
    expect(запуск.args[1]).toContain('do script');
    // Файл сценария на маке не нужен: оболочка получает строку как есть.
    expect(запуск.сценарий).toBeUndefined();
  });

  it('берёт части в одинарные кавычки, а свои удваивает по правилу оболочки', () => {
    const скрипт = скриптТерминала("/Users/o'brien/bin/claude", ['auth', 'login']);

    // Апостроф в имени человека — не редкость, и он закрыл бы строку оболочки.
    expect(скрипт).toContain("'/Users/o'");
    expect(скрипт).toContain('auth');
    expect(скрипт).toContain('login');
  });

  it('экранирует обратную косую ПЕРЕД кавычкой, а не после', () => {
    // Порядок здесь не вкусовщина. Сначала `"` → `\\"`, потом эта новая косая
    // удвоилась бы в `\\\\"` — и кавычка снова закрыла бы строку AppleScript.
    const скрипт = скриптТерминала('/Users/t/па"ть\\bin/claude', ['login']);
    const косая = String.fromCharCode(92);

    expect(скрипт).toContain(косая + '"');
    // И ни одной ГОЛОЙ кавычки внутри самой команды: строка не должна
    // закрыться раньше конца. Без регулярок: в unicode-режиме `\\"` в образце —
    // недопустимый escape.
    const внутри = /do script "(.*)"/u.exec(скрипт)?.[1] ?? '';
    const безЭкранов = внутри.split(косая + косая).join('').split(косая + '"').join('');
    expect(безЭкранов.includes('"')).toBe(false);
  });

  it('путь без странностей проходит дословно', () => {
    expect(скриптТерминала(путь, ['auth', 'login'])).toContain(`'${путь}' 'auth' 'login'`);
  });
});

describe('терминалДляВхода на остальном', () => {
  it('на линуксе зовёт общий терминал', () => {
    const запуск = терминалДляВхода('/usr/bin/claude', ['auth', 'login'], '/tmp', 'linux');
    expect(запуск).toEqual({ file: 'x-terminal-emulator', args: ['-e', '/usr/bin/claude', 'auth', 'login'] });
  });
});

/**
 * Со слов владельца после живого теста на маке 27.09.2026: обе кнопки
 * «Войти» увели во вход Claude Code, «в странное место». Окно теперь
 * называет своего агента — и человеку, и тому, кто разбирает жалобу.
 */
describe('окно входа называет агента', () => {
  it('мак: заголовок окна и строка перед командой — свой агент у каждой кнопки', () => {
    const codex = скриптТерминала('/opt/homebrew/bin/codex', ['login'], 'Codex');
    const claude = скриптТерминала('/Users/t/.local/bin/claude', ['auth', 'login'], 'Claude Code');
    expect(codex).toContain('set custom title of t to "Вход в Codex"');
    expect(codex).toContain("'/opt/homebrew/bin/codex' 'login'");
    expect(codex).not.toContain('claude');
    expect(claude).toContain('set custom title of t to "Вход в Claude Code"');
    expect(claude).toContain("'/Users/t/.local/bin/claude' 'auth' 'login'");
  });

  it('мак: вне кавычек — только латиница, иначе AppleScript не соберётся', () => {
    const скрипт = скриптТерминала('/opt/homebrew/bin/codex', ['login'], 'Codex');
    // Строки AppleScript вырезаются вместе с экранированными кавычками внутри.
    const внеКавычек = скрипт.replace(/"(?:[^"\\]|\\.)*"/gu, '');
    expect(внеКавычек).not.toMatch(/[А-Яа-яЁё]/u);
  });

  it('Windows: заголовок и строка — латиницей, команда прежняя', () => {
    const путь = ['C:', 'Users', 't', 'AppData', 'Roaming', 'npm', 'codex.cmd'].join(String.fromCharCode(92));
    const текст = сценарийВхода(путь, ['login'], 'Codex');
    expect(текст).toContain('title Rujarvis - Codex');
    expect(текст).toContain(`"${путь}" "login"`);
    const подписи = текст.split(String.fromCharCode(13) + String.fromCharCode(10)).filter((с) => /^(title|echo ===)/u.test(с));
    expect(подписи).toHaveLength(2);
    for (const с of подписи) expect(с).toMatch(/^[\x20-\x7e]+$/u);
  });

  it('без имени агента — как прежде, без подписи', () => {
    expect(скриптТерминала('/bin/x', ['login'])).not.toContain('custom title');
    expect(сценарийВхода('C:/x.cmd', ['login'])).not.toContain('title');
  });
});
