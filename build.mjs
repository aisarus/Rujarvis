// Сборка Rujarvis: три бандла esbuild, без Vite и без веб-интерфейса.
//
//   dist/app/main.cjs            главный процесс Electron
//   dist/app/preload.cjs         мост окна настроек
//   dist/jarvis/desktop/mcp.cjs  MCP-сервер рабочего стола, разговора и хук
//                                красных линий (роль выбирается при запуске)
//
// Запуск: node build.mjs (или pnpm build). Занимает секунды.
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import esbuild from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  // `import.meta` в CJS пуст, и код это знает (см. inbetween.ts, driver.ts).
  logOverride: { 'empty-import-meta': 'silent' },
  // Нативное и тяжёлое не упаковывается: sherpa-onnx грузит WASM рядом с
  // собой, playwright тянет браузеры, electron даёт сама среда.
  external: ['electron', 'sherpa-onnx', 'playwright', 'playwright-core'],
};

await Promise.all([
  esbuild.build({ ...common, entryPoints: ['app/main.ts'], outfile: 'dist/app/main.cjs' }),
  esbuild.build({ ...common, entryPoints: ['app/preload.ts'], outfile: 'dist/app/preload.cjs' }),
  esbuild.build({ ...common, entryPoints: ['jarvis/desktop/serve.ts'], outfile: 'dist/jarvis/desktop/mcp.cjs' }),
  // Приёмка: те же слои, тот же драйвер, но без микрофона (pnpm jarvis:qa).
  esbuild.build({ ...common, entryPoints: ['scripts/qa/acceptance.ts'], outfile: 'dist/qa/acceptance.cjs' }),
]);

// Скрипт драйвера мыши и клавиатуры сервер ищет рядом с собой.
mkdirSync(path.join('dist', 'jarvis', 'desktop'), { recursive: true });
copyFileSync(
  path.join('jarvis', 'desktop', 'win32-driver.ps1'),
  path.join('dist', 'jarvis', 'desktop', 'win32-driver.ps1'),
);

/**
 * Рекурсивная копия без `fs.cpSync`.
 *
 * На Windows `cpSync` в Node 22 роняет процесс (0xC0000409, без сообщения) на
 * пути не латиницей — а папка здесь называется «питон». Поймано CI на
 * windows-latest; у человека это была бы установка, упавшая на сборке.
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

// Скрипты Python для анимации — тоже рядом с сервером (`inbetween.ts`).
copyTree(path.join('jarvis', 'desktop', 'питон'), path.join('dist', 'jarvis', 'desktop', 'питон'));

console.log('[build] dist/app/main.cjs, dist/app/preload.cjs, dist/jarvis/desktop/mcp.cjs');
