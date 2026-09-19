/**
 * Доступ к Джарвису с телефона.
 *
 * Это самая опасная дверь во всей системе. За ней — голосовой помощник,
 * который запускает программы, читает экран, правит файлы и ходит в браузер от
 * имени человека. Кто прошёл сюда, тот получил компьютер целиком.
 *
 * Отсюда два решения, которые здесь не обсуждаются:
 *
 *   - ключ длинный и случайный, из криптографического источника;
 *   - сравнение постоянного времени, чтобы ключ нельзя было подобрать
 *     посимвольно, замеряя ответы.
 *
 * И одно, которое важнее обоих: **нет пары — нет доступа**. Не «пускать всех,
 * пока не настроено», а наоборот. Незаконченная настройка должна оставлять
 * дверь закрытой, а не открытой.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Pairing {
  /** Сам ключ: 32 случайных байта в шестнадцатеричном виде. */
  token: string;
  /** Когда выдан — чтобы можно было показать и отозвать старую пару. */
  createdAt: number;
}

export function createPairing(now: () => number = Date.now): Pairing {
  return { token: randomBytes(32).toString('hex'), createdAt: now() };
}

/**
 * Совпадает ли предъявленный ключ с выданным.
 *
 * `timingSafeEqual` требует одинаковой длины и падает на разной, поэтому
 * сравниваются хеши: они всегда одного размера, и сама длина предъявленного
 * ключа тоже перестаёт что-либо выдавать.
 */
export function matchesToken(pairing: Pairing, presented: string | undefined | null): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(pairing.token), digest(presented));
}

/** Единственная точка входа для проверки: без пары — закрыто. */
export function isPaired(pairing: Pairing | null | undefined, presented: string | undefined | null): boolean {
  if (!pairing) return false;
  return matchesToken(pairing, presented);
}

/**
 * Короткий код для человека.
 *
 * Его показывают на экране компьютера, чтобы человек убедился: телефон, к
 * которому он подключается, — тот самый. Код выводится хешем, а не куском
 * ключа, поэтому увиденный через плечо он ничего не даёт.
 */
export function shortCode(pairing: Pairing): string {
  const hash = createHash('sha256').update(`код:${pairing.token}`).digest();
  return String(hash.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
