/**
 * Компьютер-юз: чем смотреть в чужое окно и что-то в нём делать.
 *
 * Шесть действий — весь компьютер-юз Джарвиса. На Windows их делает
 * `cua-driver`, отдельная программа с деревом доступности; на маке — System
 * Events и CoreGraphics через `darwinWindows.ts`. Наружу, в описания
 * инструментов, которые читает модель, различие не выходит: форма ответов
 * одна.
 *
 * Выбор один на всё приложение и стоит рядом с выбором драйвера
 * (`platform.ts`) по той же причине: два места выбора однажды разойдутся.
 *
 * Linux остаётся на cua-driver и честно отвечает «драйвер не найден»:
 * рабочего стола под Linux у Джарвиса нет, и делать вид, что он есть, хуже,
 * чем сказать «не умею».
 */

import { CuaDriver } from './cua';
import { DarwinWindowTools } from './darwinWindows';
import type { CuaElement, CuaWindow } from './cuaProtocol';

export interface WindowTools {
  windows(): Promise<CuaWindow[]>;
  look(pid: number, windowId: number, file: string): Promise<{ width: number; height: number; path: string }>;
  find(pid: number, windowId: number, wanted: string): Promise<CuaElement[]>;
  press(pid: number, windowId: number, index: number): Promise<string>;
  writeInto(pid: number, windowId: number, index: number, text: string): Promise<string>;
  key(pid: number, windowId: number, key: string): Promise<string>;
  dispose(): void;
}

export function createWindowTools(): WindowTools {
  return process.platform === 'darwin' ? new DarwinWindowTools() : new CuaDriver();
}
