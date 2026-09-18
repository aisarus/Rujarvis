#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import imageTools from './permissive-image.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APP_ICON_PATH = path.join(ROOT, 'resources', 'icons', 'app.png');
const EXTENSION_ICON_DIR = path.join(ROOT, 'apps', 'interpreter-extension', 'extension', 'icons');
const WEBSITE_PUBLIC_DIR = path.join(ROOT, 'apps', 'interpreter-extension', 'website', 'public');
const STORE_ASSETS_DIR = path.join(ROOT, 'apps', 'interpreter-extension', 'store-assets');
const STORE_SCREENSHOT_SOURCE_PATH = path.join(
  ROOT,
  'apps',
  'interpreter-extension',
  'playwriter',
  'screenshot@2x.png',
);
const SIZES = [16, 32, 48, 128];

const BRAND = {
  idle: null,
  gray: { ring: '#7d838d', dot: '#7d838d', grayscale: true, brightness: 0.88, saturation: 0.25 },
  blue: { ring: '#2f6df6', dot: '#2f6df6' },
  green: { ring: '#1db56c', dot: '#1db56c' },
  red: { ring: '#db4d3f', dot: '#db4d3f' },
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function decodePixels(input) {
  return sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

async function writePngIfPixelsChanged(targetPath, pngBuffer) {
  if (fs.existsSync(targetPath)) {
    const [current, next] = await Promise.all([
      decodePixels(targetPath),
      decodePixels(pngBuffer),
    ]);
    const sameShape =
      current.info.width === next.info.width &&
      current.info.height === next.info.height &&
      current.info.channels === next.info.channels;
    if (sameShape && current.data.equals(next.data)) {
      return false;
    }
  }

  fs.writeFileSync(targetPath, pngBuffer);
  return true;
}

function makeStatusOverlay({ ring, dot }) {
  return Buffer.from(
    `
      <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
        <defs>
          <filter id="ring-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="8" stdDeviation="16" flood-color="${ring}" flood-opacity="0.24" />
          </filter>
          <filter id="dot-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.32" />
          </filter>
        </defs>
        <rect
          x="54"
          y="54"
          width="916"
          height="916"
          rx="224"
          fill="none"
          stroke="${ring}"
          stroke-width="44"
          opacity="0.96"
          filter="url(#ring-shadow)"
        />
        <circle cx="812" cy="812" r="112" fill="${dot}" filter="url(#dot-shadow)" />
        <circle cx="812" cy="812" r="84" fill="${dot}" />
        <circle cx="812" cy="812" r="86" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="20" />
      </svg>
    `,
    'utf8',
  );
}

async function buildStateMaster(variantName) {
  const variant = BRAND[variantName];
  let output = await imageTools.png(APP_ICON_PATH, {
    width: 1024,
    height: 1024,
    fit: 'contain',
  });
  if (variant?.grayscale) {
    output = await imageTools.transformRgba(output, {}, (data) => {
      for (let index = 0; index < data.length; index += 4) {
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
        data[index] = Math.round((luminance + (red - luminance) * variant.saturation) * variant.brightness);
        data[index + 1] = Math.round((luminance + (green - luminance) * variant.saturation) * variant.brightness);
        data[index + 2] = Math.round((luminance + (blue - luminance) * variant.saturation) * variant.brightness);
      }
    });
  }

  if (variant?.ring && variant?.dot) {
    output = await imageTools.compositeSvg(output, makeStatusOverlay(variant));
  }
  return output;
}

async function writeExtensionIcons() {
  ensureDir(EXTENSION_ICON_DIR);
  const variants = [
    ['black', 'idle'],
    ['gray', 'gray'],
    ['blue', 'blue'],
    ['green', 'green'],
    ['red', 'red'],
  ];

  for (const [filePrefix, variantName] of variants) {
    const master = await buildStateMaster(variantName);
    for (const size of SIZES) {
      const target = path.join(EXTENSION_ICON_DIR, `icon-${filePrefix}-${size}.png`);
      fs.writeFileSync(target, await imageTools.png(master, {
        width: size,
        height: size,
        fit: 'contain',
      }));
    }
  }

  fs.writeFileSync(
    path.join(EXTENSION_ICON_DIR, 'GENERATED-FROM-APP-ICON.txt'),
    [
      'Generated from resources/icons/app.png.',
      '',
      'Do not hand-edit icon-black-*.png, icon-gray-*.png, icon-blue-*.png, icon-green-*.png, or icon-red-*.png.',
      'Regenerate with: pnpm run extension:assets',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function buildStoreScreenshot() {
  const frameWidth = 1280;
  const frameHeight = 800;
  const margin = 40;
  const innerWidth = frameWidth - margin * 2;
  const innerHeight = frameHeight - margin * 2;

  const screenshot = await imageTools.png(STORE_SCREENSHOT_SOURCE_PATH, {
    width: innerWidth,
    height: innerHeight,
    fit: 'contain',
    background: '#000000',
  });
  const { canvas, ctx } = await imageTools.render(screenshot, {
    width: frameWidth,
    height: frameHeight,
    background: '#000000',
    fit: 'contain',
  });
  ctx.clearRect(0, 0, frameWidth, frameHeight);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, frameWidth, frameHeight);
  const image = await imageTools.loadImage(screenshot);
  ctx.drawImage(image, margin, margin, innerWidth, innerHeight);
  return await canvas.encode('png');
}

async function writeWebsiteAssets() {
  ensureDir(WEBSITE_PUBLIC_DIR);
  ensureDir(STORE_ASSETS_DIR);

  for (const size of [1024, 512, 32, 16]) {
    const filename = size <= 32 ? `favicon-${size}.png` : `logo-${size}.png`;
    fs.writeFileSync(
      path.join(WEBSITE_PUBLIC_DIR, filename),
      await imageTools.png(APP_ICON_PATH, { width: size, height: size }),
    );
  }

  const screenshotBuffer = await buildStoreScreenshot();

  fs.writeFileSync(path.join(WEBSITE_PUBLIC_DIR, 'screenshot@2x.png'), screenshotBuffer);
  fs.writeFileSync(
    path.join(STORE_ASSETS_DIR, 'chrome-store-screenshot-640x400.png'),
    await imageTools.png(screenshotBuffer, { width: 640, height: 400 }),
  );
  fs.writeFileSync(
    path.join(STORE_ASSETS_DIR, 'chrome-store-screenshot-1280x800.png'),
    screenshotBuffer,
  );

  fs.writeFileSync(
    path.join(STORE_ASSETS_DIR, 'README.md'),
    [
      '# Chrome Web Store Assets',
      '',
      '- `chrome-store-screenshot-1280x800.png` is the primary screenshot for the store listing.',
      '- `chrome-store-screenshot-640x400.png` is a smaller alternative export.',
      '- Source image: `../playwriter/screenshot@2x.png`.',
      '',
      'Generated with:',
      '',
      '```bash',
      'pnpm run extension:assets',
      '```',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function main() {
  if (!fs.existsSync(APP_ICON_PATH)) {
    throw new Error(`Missing app icon source: ${APP_ICON_PATH}`);
  }
  if (!fs.existsSync(STORE_SCREENSHOT_SOURCE_PATH)) {
    throw new Error(`Missing browser screenshot source: ${STORE_SCREENSHOT_SOURCE_PATH}`);
  }

  await writeExtensionIcons();
  await writeWebsiteAssets();
  console.log('[browser-extension-assets] Updated extension icons and store screenshots from app branding.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
