import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { LiveSession, type SessionKey } from './liveSession';
import { SessionPool } from './sessionPool';

const KEY: SessionKey = { cwd: 'C:/работа', tools: 'Read', permissionMode: 'acceptEdits' };

/** Подставной процесс: ничего не делает, но жив, пока его не убьют. */
function процесс() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter;
    stdin: { write: () => void };
    kill: () => void;
    exitCode: number | null;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {} };
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0);
  };
  return child;
}

function сессия(key: SessionKey = KEY): LiveSession {
  const s = new LiveSession({
    key,
    command: 'claude',
    consumeLine: () => {},
    spawnProcess: (() => процесс()) as never,
  });
  // Сессия поднимает процесс лениво — заставляем, чтобы она считалась живой.
  s.ask('раз');
  return s;
}

/** Свободная сессия: ход завершён, процесс жив. */
function свободная(key: SessionKey = KEY): LiveSession {
  const child = процесс();
  const s = new LiveSession({
    key,
    command: 'claude',
    consumeLine: () => {},
    spawnProcess: (() => child) as never,
  });
  const ход = s.ask('раз');
  child.stdout.emit(
    'data',
    JSON.stringify({ type: 'result', subtype: 'success' }) + String.fromCharCode(10),
  );
  void ход.result();
  return s;
}

describe('склад сессий', () => {
  it('отдаёт сессию с тем же ключом', () => {
    const склад = new SessionPool();
    const s = свободная();
    склад.keep(s);
    expect(склад.find(KEY)).toBe(s);
  });

  it('на другой ключ не отдаёт ничего', () => {
    const склад = new SessionPool();
    склад.keep(свободная());
    expect(склад.find({ ...KEY, cwd: 'C:/другая' })).toBeNull();
  });

  // Занятая сессия обрабатывает ходы по очереди. Отдать её значит поставить
  // короткую реплику в хвост чужой долгой работы.
  it('занятую не отдаёт', () => {
    const склад = new SessionPool();
    const s = сессия();
    склад.keep(s);
    expect(s.isBusy()).toBe(true);
    expect(склад.find(KEY)).toBeNull();
  });

  it('мёртвую забывает, а не выдаёт', () => {
    const склад = new SessionPool();
    const s = свободная();
    склад.keep(s);
    s.dispose();
    expect(склад.find(KEY)).toBeNull();
    expect(склад.size()).toBe(0);
  });
});

describe('предел склада', () => {
  // Каждая сессия — процесс CLI со своим MCP-сервером и PowerShell. За сутки
  // небрежности здесь уже накапливалось шесть осиротевших серверов на 956 МБ.
  it('держит не больше предела, закрывая самую старую свободную', () => {
    const склад = new SessionPool(2);
    const первая = свободная();
    склад.keep(первая);
    склад.keep(свободная());
    склад.keep(свободная());

    expect(склад.size()).toBe(2);
    expect(первая.isAlive()).toBe(false);
  });

  // Закрыть занятую значит оборвать чужую работу на полуслове.
  it('занятую при переполнении не трогает', () => {
    const склад = new SessionPool(1);
    const занятая = сессия();
    склад.keep(занятая);
    склад.keep(свободная());

    expect(занятая.isAlive()).toBe(true);
    expect(склад.size()).toBe(2);
  });

  it('закрывает всё разом', () => {
    const склад = new SessionPool();
    const s = свободная();
    склад.keep(s);
    склад.disposeAll();

    expect(s.isAlive()).toBe(false);
    expect(склад.size()).toBe(0);
  });
});
