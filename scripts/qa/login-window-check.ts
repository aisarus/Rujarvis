/**
 * Живая проверка окна входа в аккаунт.
 *
 * Вход — единственный шаг онбординга, который обойти нельзя, и он не работал:
 * живой прогон 26.09.2026 у владельца открыл окно с
 *
 *   "\"C:\Users\ariel\.local\bin\claude.exe\"" не является внутренней или
 *   внешней командой
 *
 * Тесты сборки лежат рядом (`app/loginTerminal.vitest.test.ts`), но они не
 * доказывают, что Windows эту команду ПРАВДА исполнит: между строкой аргументов
 * и запущенной программой стоят правило кавычек Node и правило кавычек cmd.
 * Проверяется настоящим запуском.
 *
 * Настоящий `claude auth login` не зовём нарочно: он поднял бы вход в браузере
 * за человека. Вместо CLI ставим заглушку, и она сама пишет, что её позвали и с
 * какими доводами. Путь заглушки — С ПРОБЕЛОМ: у любого, чьё имя в системе из
 * двух слов, путь такой, и именно на нём ломались прежние попытки.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { сценарийВхода, скриптТерминала, терминалДляВхода } from '../../app/loginTerminal';

type Итог =
  | { вид: 'прошло'; чем: string }
  | { вид: 'не прошло'; почему: string }
  | { вид: 'нечем мерить'; почему: string };

const NL = String.fromCharCode(10);

/** Заглушка вместо CLI: пишет доводы в файл и закрывает своё окно. */
function стенд(): { заглушка: string; метка: string; папка: string } {
  const корень = mkdtempSync(path.join(os.tmpdir(), 'jarvis-login-'));
  // Пробел в имени папки — тот самый случай «C:\Users\John Smith».
  const папка = path.join(корень, 'dva slova');
  mkdirSync(папка, { recursive: true });

  // Имена файлов латиницей: cmd читает их своей кодовой страницей, и
  // кириллическое имя он просто не находит (замерено).
  const метка = path.join(папка, 'mark.txt');
  const заглушка = path.join(папка, 'login-stub.cmd');
  writeFileSync(
    заглушка,
    ['@echo off', `echo POZVALI %*> "${метка}"`, 'exit'].join(NL) + NL,
    'ascii',
  );
  return { заглушка, метка, папка };
}

async function ждатьФайл(файл: string, срокМс: number): Promise<boolean> {
  const конец = Date.now() + срокМс;
  while (Date.now() < конец) {
    if (existsSync(файл)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function проверки(): Promise<Array<{ имя: string; итог: Итог }>> {
  const итоги: Array<{ имя: string; итог: Итог }> = [];

  // 1. В командной строке нет НИ ОДНОЙ своей кавычки.
  {
    const запуск = терминалДляВхода(
      'C:\\Users\\John Smith\\bin\\claude.exe',
      ['auth', 'login'],
      'C:\\Users\\John Smith\\AppData\\Local\\Rujarvis\\data',
      'win32',
    );
    const скавычкой = запуск.args.filter((д) => д.includes('"'));
    итоги.push({
      имя: 'в командной строке нет своих кавычек',
      итог:
        скавычкой.length > 0
          ? { вид: 'не прошло', почему: `кавычки в доводах: ${скавычкой.join(' | ')}` }
          : { вид: 'прошло', чем: `${запуск.file} ${запуск.args.slice(0, 3).join(' ')} <файл сценария>` },
    });
  }

  // 2. Сценарий оставляет окно открытым: иначе отказ входа мелькнёт и исчезнет.
  {
    const текст = сценарийВхода('C:\\Users\\John Smith\\bin\\claude.exe', ['auth', 'login']);
    итоги.push({
      имя: 'сценарий берёт путь в кавычки и оставляет окно открытым',
      итог: !текст.includes('"C:\\Users\\John Smith\\bin\\claude.exe" "auth" "login"')
        ? { вид: 'не прошло', почему: `строка вызова собрана иначе: ${текст.replace(/\r?\n/gu, ' | ')}` }
        : !/\bpause\b/u.test(текст)
          ? { вид: 'не прошло', почему: 'без pause окно закроется вместе с CLI, и отказ не прочитать' }
          : { вид: 'прошло', чем: 'путь в кавычках, chcp 65001, pause в конце' },
    });
  }

  // 3. Настоящий запуск на этой машине, путь с пробелом.
  if (process.platform !== 'win32') {
    итоги.push({
      имя: 'окно входа правда открывается и доводы доходят',
      итог: {
        вид: 'нечем мерить',
        почему: `запуск через cmd проверяется только на Windows, здесь ${process.platform}`,
      },
    });
  } else {
    const { заглушка, метка, папка } = стенд();
    const запуск = терминалДляВхода(заглушка, ['auth', 'login'], папка);
    let беда: string | null = null;
    try {
      if (запуск.сценарий) writeFileSync(запуск.сценарий.файл, запуск.сценарий.текст, 'utf8');
      const дитя = spawn(запуск.file, запуск.args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: false,
      });
      дитя.stderr?.on('data', (к: Buffer) => {
        const т = к.toString('utf8').trim();
        if (т) беда = т.slice(0, 200);
      });
      дитя.unref();
    } catch (е) {
      беда = е instanceof Error ? е.message : String(е);
    }

    const дошло = await ждатьФайл(метка, 20_000);
    const написано = дошло ? readFileSync(метка, 'utf8').trim() : '';
    итоги.push({
      имя: 'окно входа правда открывается и доводы доходят',
      итог: !дошло
        ? { вид: 'не прошло', почему: `заглушка не запустилась за 20 с${беда ? `; stderr: ${беда}` : ''}` }
        : /POZVALI "?auth"? "?login"?/u.test(написано)
          ? { вид: 'прошло', чем: `заглушка ответила «${написано}» из папки с пробелом` }
          : { вид: 'не прошло', почему: `доводы потерялись: заглушка написала «${написано}»` },
    });
  }

  // 4. Скрипт для мака: строка собрана верно.
  {
    const скрипт = скриптТерминала('/Users/John Smith/bin/claude', ['auth', 'login']);
    const естьActivate = скрипт.includes('activate');
    const естьКоманда = скрипт.includes(`'/Users/John Smith/bin/claude' 'auth' 'login'`);
    итоги.push({
      имя: 'скрипт для macOS собран верно',
      итог:
        естьActivate && естьКоманда
          ? { вид: 'прошло', чем: 'activate на месте, команда в одинарных кавычках' }
          : { вид: 'не прошло', почему: `activate: ${естьActivate}, команда дословно: ${естьКоманда}` },
    });
  }

  // 5. На Маке — настоящий osascript. Три ответа, а не два.
  if (process.platform !== 'darwin') {
    итоги.push({
      имя: 'macOS: AppleScript правда компилируется и Терминал отзывается',
      итог: { вид: 'нечем мерить', почему: `osascript есть только на macOS, здесь ${process.platform}` },
    });
  } else {
    // Заглушка вместо CLI: настоящий вход поднял бы браузер за человека.
    const корень = mkdtempSync(path.join(os.tmpdir(), 'jarvis-login-mac-'));
    const папка = path.join(корень, 'dva slova');
    mkdirSync(папка, { recursive: true });
    const метка = path.join(папка, 'mark.txt');
    const заглушка = path.join(папка, 'login-stub.sh');
    writeFileSync(заглушка, ['#!/bin/sh', `printf 'POZVALI %s' "$*" > "${метка}"`, ''].join(NL), {
      encoding: 'utf8',
      mode: 0o755,
    });

    const запуск = терминалДляВхода(заглушка, ['auth', 'login'], папка);
    let ошибка = '';
    let код: number | null = null;
    await new Promise<void>((resolve) => {
      const дитя = spawn(запуск.file, запуск.args, { stdio: ['ignore', 'ignore', 'pipe'] });
      дитя.stderr?.on('data', (к: Buffer) => {
        ошибка += к.toString('utf8');
      });
      дитя.on('error', (е: Error) => {
        ошибка += е.message;
        resolve();
      });
      дитя.on('exit', (c) => {
        код = c;
        resolve();
      });
      setTimeout(resolve, 30_000);
    });

    const дошло = await ждатьФайл(метка, 20_000);
    // Отказ в автоматизации — это «нечем мерить», а не «сломано»: в CI
    // разрешения нет и быть не может, а у человека его спрашивает система.
    const этоРазрешение = /-1743|not authoriz|Not authorized|осуществлять/u.test(ошибка);
    // Ошибка КОМПИЛЯЦИИ — это уже поломка: значит строка собрана криво, и
    // никакое разрешение не поможет.
    const этоСинтаксис = /syntax error|-2741|expected|Ошибка синтаксиса/iu.test(ошибка);
    итоги.push({
      имя: 'macOS: AppleScript правда компилируется и Терминал отзывается',
      итог: дошло
        ? { вид: 'прошло', чем: `Терминал выполнил команду: ${readFileSync(метка, 'utf8').trim()}` }
        : этоСинтаксис
          ? { вид: 'не прошло', почему: `AppleScript не компилируется: ${ошибка.trim().slice(0, 200)}` }
          : этоРазрешение
            ? { вид: 'нечем мерить', почему: `нет разрешения на автоматизацию Терминала: ${ошибка.trim().slice(0, 140)}` }
            : {
                вид: 'не прошло',
                почему: `Терминал не выполнил команду; код ${String(код)}, stderr: ${ошибка.trim().slice(0, 200) || 'пусто'}`,
              },
    });
  }

  return итоги;
}

async function main(): Promise<void> {
  console.log('');
  console.log('Окно входа в аккаунт');
  console.log('');

  let прошло = 0;
  let неПрошло = 0;
  let нечем = 0;
  for (const { имя, итог } of await проверки()) {
    if (итог.вид === 'прошло') {
      прошло++;
      console.log(`  прошло       ${имя} — ${итог.чем}`);
    } else if (итог.вид === 'не прошло') {
      неПрошло++;
      console.log(`  НЕ ПРОШЛО    ${имя} — ${итог.почему}`);
    } else {
      нечем++;
      console.log(`  нечем мерить ${имя} — ${итог.почему}`);
    }
  }

  console.log('');
  console.log(`Всего ${прошло + неПрошло + нечем}: прошло ${прошло}, не прошло ${неПрошло}, нечем мерить ${нечем}`);
  process.exit(неПрошло > 0 ? 1 : нечем > 0 ? 2 : 0);
}

void main();
