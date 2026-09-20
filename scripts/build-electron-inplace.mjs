/**
 * Сборка поверх работающего приложения.
 *
 * Обычный build-electron.mjs первым делом стирает dist-electron целиком, а
 * запущенный Electron держит свой нативный аддон — удаление падает с EPERM, и
 * каталог остаётся наполовину снесённым. Здесь тот же esbuild, но без очистки
 * и без копирования аддона: он уже на месте и побайтово совпадает с исходным.
 */
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const EXTERNAL = [
  'electron', 'electron-updater', 'fsevents', '@vscode/ripgrep', 'canvas',
  '@napi-rs/canvas', 'pdfjs-dist', 'unpdf', 'mammoth', 'jszip', 'xml-formatter',
  'whatsapp-rust-bridge', '@resvg/resvg-js', 'sharp', 'trash', '@parcel/watcher',
  'node-pty', 'uiohook-napi', 'interpreter-window-pin', '@nut-tree-fork/nut-js',
  'sherpa-onnx', 'onnxruntime-node', 'esbuild', 'react', 'react-dom',
  'react/jsx-runtime', 'react/jsx-dev-runtime', 'remotion', '@remotion/bundler',
  '@remotion/renderer',
];

await esbuild.build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/electron/main.cjs',
  external: EXTERNAL,
  sourcemap: true,
  target: 'node18',
  define: {
    'process.env.NYLAS_CLIENT_ID': '"e78ec813-8f5b-455a-92cf-a19c76fa6f45"',
  },
  logLevel: 'error',
});

await esbuild.build({
  entryPoints: ['electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/electron/preload.cjs',
  external: ['electron'],
  sourcemap: true,
  target: 'node18',
  logLevel: 'error',
});

await esbuild.build({
  entryPoints: ['apps/interpreter-overlay/renderer/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/apps/interpreter-overlay/renderer/preload.cjs',
  external: ['electron'],
  sourcemap: true,
  target: 'node18',
  logLevel: 'error',
});

// MCP-сервер рабочего стола — отдельной сборкой.
//
// Без этой части сборка «поверх работающего» тихо оставляла сервер старым:
// приложение обновлялось, а инструменты агента — нет. Обнаружилось по числу
// инструментов: в коде их двадцать восемь, у запущенного сервера двадцать семь.
// Такую разницу видно только если её специально искать.
await esbuild.build({
  entryPoints: ['jarvis/desktop/serve.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist-electron/jarvis/desktop/mcp.cjs',
  // Playwright тянет свои браузеры и грузится динамически.
  external: ['playwright'],
  sourcemap: true,
  target: 'node18',
  logLevel: 'error',
});

/**
 * Скрипт драйвера рабочего стола — рядом со сборкой.
 *
 * esbuild собирает только TypeScript, а драйвер это PowerShell: он не
 * импортируется, а читается с диска по пути рядом с собранным кодом. Копии
 * в dist-electron было больше суток от роду, и каждая правка драйвера —
 * подъём окна, прокрутка вниз — молча не доезжала до работающего приложения.
 * Отладка при этом выглядела так: в исходнике починено, в работе нет.
 */
const драйвер = 'jarvis/desktop/win32-driver.ps1';
mkdirSync(path.dirname(`dist-electron/${драйвер}`), { recursive: true });
copyFileSync(драйвер, `dist-electron/${драйвер}`);

console.log('[build] собрано поверх работающего приложения');
