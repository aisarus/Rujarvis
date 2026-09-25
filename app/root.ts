/**
 * Корень приложения на диске.
 *
 * Сборка лежит в `dist/app/main.cjs`, поэтому корень — двумя уровнями выше.
 * Не `app.getAppPath()`: он зависит от того, как запущен Electron (папкой или
 * файлом), а ресурсы, страницы и MCP-сервер нужно находить одинаково.
 */
import path from 'node:path';

export const APP_ROOT = path.resolve(__dirname, '..', '..');
