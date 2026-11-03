/**
 * Уведомление системы об итоге долгой работы: разбор документа, конспект
 * лекции. Строка на плашке живёт шесть секунд, а итог приходит через минуты,
 * когда человек уже ушёл с пары или из-за стола (аудит интерфейса 21.10.2026).
 * Щелчок — открыть то, что получилось.
 */

import { Notification } from 'electron';

export function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body.slice(0, 250), silent: true });
  if (onClick) n.on('click', onClick);
  n.show();
}
