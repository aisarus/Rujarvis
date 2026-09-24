// Сборка Rujarvis: три бандла esbuild, без Vite и без веб-интерфейса.
//
//   dist/app/main.cjs            главный процесс Electron
//   dist/app/preload.cjs         мост окна настроек
//   dist/jarvis/desktop/mcp.cjs  MCP-сервер рабочего стола, разговора и хук
//                                красных линий (роль выбирается при запуске)
//
// Запуск: node build.mjs (или pnpm build). Занимает секунды.
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
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
]);

// Скрипт драйвера мыши и клавиатуры сервер ищет рядом с собой.
mkdirSync(path.join('dist', 'jarvis', 'desktop'), { recursive: true });
copyFileSync(
  path.join('jarvis', 'desktop', 'win32-driver.ps1'),
  path.join('dist', 'jarvis', 'desktop', 'win32-driver.ps1'),
);

// Скрипты Python для анимации — тоже рядом с сервером (`inbetween.ts`).
cpSync(path.join('jarvis', 'desktop', 'питон'), path.join('dist', 'jarvis', 'desktop', 'питон'), { recursive: true });

console.log('[build] dist/app/main.cjs, dist/app/preload.cjs, dist/jarvis/desktop/mcp.cjs');
