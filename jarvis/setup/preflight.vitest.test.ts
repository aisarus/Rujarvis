import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { setLanguage } from '../locale/language';
import {
  кодВыхода,
  отчёт,
  прочитатьРазрешения,
  разобратьЯрлык,
  сохранитьРазрешения,
  файлРазрешений,
  звеноВхода,
  звеноМикрофонаWindows,
  звеноМоделей,
  звеноРазговора,
  звеноСервера,
  звеноУстановки,
  звеноХука,
  звеньяРазрешенийМака,
  звеньяЯрлыка,
  значениеРеестра,
  type Звено,
} from './preflight';

afterEach(() => setLanguage('ru'));

const з = (id: string, итог: Звено['итог']): Звено => ({ id, имя: id, итог });

describe('кодВыхода', () => {
  it('любой провал — 1, даже среди прошедших', () => {
    expect(кодВыхода([з('a', 'прошло'), з('b', 'не прошло'), з('c', 'нечем мерить')])).toBe(1);
  });
  it('ничего не намерено — 2, а не «всё хорошо»', () => {
    expect(кодВыхода([з('a', 'нечем мерить'), з('b', 'нечем мерить')])).toBe(2);
    expect(кодВыхода([])).toBe(2);
  });
  it('«нечем мерить» рядом с прошедшими — не провал', () => {
    expect(кодВыхода([з('a', 'прошло'), з('b', 'нечем мерить')])).toBe(0);
  });
});

describe('отчёт', () => {
  it('совет печатается у провала и «нечем мерить», у прошедшего — нет', () => {
    const строки = отчёт([
      { id: 'a', имя: 'А', итог: 'прошло', совет: 'лишнее' },
      { id: 'b', имя: 'Б', итог: 'не прошло', совет: 'сделай так' },
    ]);
    expect(строки.join('\n')).not.toContain('лишнее');
    expect(строки.join('\n')).toContain('→ сделай так');
  });
  it('латинские итоговые строки для CI не зависят от языка', () => {
    setLanguage('en');
    const строки = отчёт([з('install', 'прошло'), з('login-codex', 'не прошло'), з('talk', 'нечем мерить')]);
    expect(строки).toContain('preflight: pass=1 fail=1 none=1');
    expect(строки).toContain('preflight-pass: install');
    expect(строки).toContain('preflight-fail: login-codex');
    expect(строки).toContain('preflight-none: talk');
    expect(строки.join('\n')).toContain('FAILED');
  });
});

describe('ярлык под PATH Finder', () => {
  const вывод = [
    '@@PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    '@@node=ok v24.1.0',
    '@@codex=fail env: node: No such file or directory',
    '@@claude=missing',
    'шум, который печатает кто угодно',
  ].join('\n');

  it('разбирает PATH и ответ каждого инструмента', () => {
    const ответ = разобратьЯрлык(вывод);
    expect(ответ.path).toBe('/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(ответ.инструменты.node).toEqual({ есть: true, работает: true, вывод: 'v24.1.0' });
    expect(ответ.инструменты.codex?.работает).toBe(false);
    expect(ответ.инструменты.claude?.есть).toBe(false);
  });

  it('Codex из npm падает на «env: node» — провал, а не «не установлен»', () => {
    const звенья = звеньяЯрлыка(разобратьЯрлык(вывод), { codex: '/opt/homebrew/bin/codex', claude: null });
    const codex = звенья.find((x) => x.id === 'finder-codex');
    expect(codex?.итог).toBe('не прошло');
    expect(codex?.подробно).toContain('env: node');
  });

  it('Claude Code не стоит нигде — «нечем мерить», а если стоит, но ярлык не видит — провал с папкой', () => {
    const нигде = звеньяЯрлыка(разобратьЯрлык(вывод), { claude: null }).find((x) => x.id === 'finder-claude');
    expect(нигде?.итог).toBe('нечем мерить');
    const невидим = звеньяЯрлыка(разобратьЯрлык(вывод), { claude: '/Users/t/.npm-global/bin/claude' }).find(
      (x) => x.id === 'finder-claude',
    );
    expect(невидим?.итог).toBe('не прошло');
    expect(невидим?.подробно).toContain('/Users/t/.npm-global/bin');
  });

  it('node не виден — провал всегда: без него нет хука', () => {
    const звенья = звеньяЯрлыка(разобратьЯрлык('@@PATH=/usr/bin\n@@node=missing'), {});
    expect(звенья.find((x) => x.id === 'finder-node')?.итог).toBe('не прошло');
  });

  it('ярлык не ответил вовсе — провал по всем трём, а не тишина', () => {
    const звенья = звеньяЯрлыка(null, {}, 'нет ярлыка');
    expect(звенья.map((x) => x.итог)).toEqual(['не прошло', 'не прошло', 'не прошло']);
  });
});

describe('вход в агентов', () => {
  const нет = { installed: false, loggedIn: 'unknown' as const };
  it('у тестера один Codex: Claude Code — «нечем мерить», не провал', () => {
    const claude = звеноВхода('claude', нет, { installed: true, loggedIn: true });
    expect(claude.итог).toBe('нечем мерить');
  });
  it('нет ни одного агента — провал с советом поставить', () => {
    const codex = звеноВхода('codex', нет, нет);
    expect(codex.итог).toBe('не прошло');
    expect(codex.совет).toContain('npm install -g @openai/codex');
  });
  it('«не вошли» по ответу CLI — провал с командой входа; «не знаю» — «нечем мерить»', () => {
    expect(звеноВхода('codex', { installed: true, loggedIn: false }, нет).совет).toContain('codex login');
    expect(звеноВхода('codex', { installed: true, loggedIn: 'unknown' }, нет).итог).toBe('нечем мерить');
    expect(звеноВхода('codex', { installed: true, loggedIn: true }, нет).итог).toBe('прошло');
  });
});

describe('модели речи', () => {
  it('нет ни одной модели распознавания — провал', () => {
    expect(звеноМоделей({ распознавание: 'small', стоятРаспознавания: [], голос: 'v', голосСтоит: true }).итог).toBe('не прошло');
  });
  it('нет голоса — провал', () => {
    expect(звеноМоделей({ распознавание: 'small', стоятРаспознавания: ['small'], голос: 'v', голосСтоит: false }).итог).toBe(
      'не прошло',
    );
  });
  it('стоит не та, что в настройках, — прошло и сказано, какая возьмётся', () => {
    const з = звеноМоделей({ распознавание: 'small', стоятРаспознавания: ['tiny'], голос: 'v', голосСтоит: true });
    expect(з.итог).toBe('прошло');
    expect(з.подробно).toContain('whisper-tiny');
  });
});

describe('разрешения мака', () => {
  it('записи нет — все три «нечем мерить», а не «не дано»', () => {
    expect(звеньяРазрешенийМака(null).map((x) => x.итог)).toEqual(['нечем мерить', 'нечем мерить', 'нечем мерить']);
  });
  it('«Универсальный доступ» не выдан — провал: нажатия молча не доходят', () => {
    const звенья = звеньяРазрешенийМака({ когда: 't', микрофон: 'дано', доступность: 'не спрашивали', экран: 'дано' });
    expect(звенья.map((x) => [x.id, x.итог])).toEqual([
      ['perm-mic', 'прошло'],
      ['perm-access', 'не прошло'],
      ['perm-screen', 'прошло'],
    ]);
    expect(звенья[1]?.совет).toContain('Универсальный доступ');
  });
  it('запись переживает круг через файл; испорченная — как отсутствующая', () => {
    const папка = mkdtempSync(path.join(os.tmpdir(), 'preflight-perm-'));
    const файл = файлРазрешений(папка);
    сохранитьРазрешения(файл, { микрофон: 'отказано', доступность: 'дано', экран: 'не спрашивали' }, new Date(2026, 8, 27, 14, 5));
    expect(прочитатьРазрешения(файл)).toEqual({
      когда: '2026-09-27 14:05',
      микрофон: 'отказано',
      доступность: 'дано',
      экран: 'не спрашивали',
    });
    writeFileSync(файл, '{"микрофон":"да"}', 'utf8');
    expect(прочитатьРазрешения(файл)).toBeNull();
    expect(прочитатьРазрешения(path.join(папка, 'нет.json'))).toBeNull();
  });
});

describe('микрофон Windows', () => {
  it('читает ответ reg query', () => {
    expect(значениеРеестра('    Value    REG_SZ    Deny\r\n')).toBe('Deny');
    expect(значениеРеестра('    Value    REG_SZ    Allow')).toBe('Allow');
    expect(значениеРеестра(null)).toBeNull();
  });
  it('запрет хоть в одном выключателе — провал; общего ответа нет — «нечем мерить»', () => {
    expect(звеноМикрофонаWindows('Allow', 'Deny').итог).toBe('не прошло');
    expect(звеноМикрофонаWindows('Allow', null).итог).toBe('прошло');
    expect(звеноМикрофонаWindows(null, null).итог).toBe('нечем мерить');
  });
});

describe('хук красных линий', () => {
  const тихо = { код: 0, вывод: '' };
  const запрет = { код: 0, вывод: '{"hookSpecificOutput":{"permissionDecision":"deny"}}' };
  it('пропускает безобидное и отклоняет нечитаемое — прошло', () => {
    expect(звеноХука({ ok: true }, тихо, запрет).итог).toBe('прошло');
  });
  it('нечитаемое не отклонено — провал: на сбое хук обязан закрываться', () => {
    expect(звеноХука({ ok: true }, тихо, тихо).итог).toBe('не прошло');
  });
  it('упал на безобидном — провал', () => {
    expect(звеноХука({ ok: true }, { код: 1, вывод: 'Error: Cannot find module' }, запрет).итог).toBe('не прошло');
  });
  it('нет node — провал с советом про node', () => {
    const з = звеноХука({ ok: false, reason: 'node не найден в PATH' });
    expect(з.итог).toBe('не прошло');
    expect(з.совет).toContain('node');
  });
});

describe('сервер, установка, разговор', () => {
  it('сервер без инструментов — провал', () => {
    expect(звеноСервера({ tools: [], ms: 5 }).итог).toBe('не прошло');
    expect(звеноСервера({ tools: ['window_list'], ms: 5 }).итог).toBe('прошло');
    expect(звеноСервера({ error: 'ENOENT' }).итог).toBe('не прошло');
  });
  it('ярлык без ключа микрофона — провал установки', () => {
    const з = звеноУстановки({
      platform: 'darwin',
      source: '/s',
      приложение: true,
      сервер: true,
      ярлык: '/a',
      ярлыкЕсть: true,
      ярлыкЗапускается: true,
      ключМикрофона: false,
    });
    expect(з.итог).toBe('не прошло');
  });
  it('без --with-agent разговор не тратит подписку и честно говорит «нечем мерить»', () => {
    const з = звеноРазговора(false);
    expect(з.итог).toBe('нечем мерить');
    expect(з.совет).toContain('--with-agent');
  });
  it('пустой ответ агента — провал, а не «прошло»', () => {
    expect(звеноРазговора(true, { ok: true, text: '  ' }).итог).toBe('не прошло');
    expect(звеноРазговора(true, { ok: true, text: 'готов' }).итог).toBe('прошло');
  });
});
