// Гарантия, что бинарник Electron скачан.
//
// pnpm иногда не запускает postinstall пакета electron — например, если в
// общем хранилище пакетов тот когда-то ставился с --ignore-scripts. Тогда
// приложение не стартует с невнятной ошибкой «Electron failed to install
// correctly». Проверяем сами и докачиваем тем же установщиком Electron.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('electron/package.json'));
const pathFile = path.join(root, 'path.txt');
const binary = existsSync(pathFile) ? path.join(root, 'dist', readFileSync(pathFile, 'utf8').trim()) : '';

if (binary && existsSync(binary)) process.exit(0);

console.log('[ensure-electron] бинарник Electron не найден — скачиваю');
const result = spawnSync(process.execPath, [path.join(root, 'install.js')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
