/**
 * Запускать ли голосовой слой.
 *
 * На Windows Джарвис — сам продукт и стартует по умолчанию. На других
 * платформах драйвер рабочего стола, запуск и закрытие программ не работают,
 * и включённый без спроса микрофон там — сюрприз, а не функция.
 */
export function shouldStartJarvis(platform: NodeJS.Platform, setting: string | undefined): boolean {
  const value = setting?.trim().toLowerCase();
  if (value === 'off') return false;
  if (value === 'on') return true;
  return platform === 'win32';
}
