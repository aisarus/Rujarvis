// Рисует иконки Rujarvis: светящееся кольцо с точкой в центре.
// Без зависимостей: PNG кодируется вручную (zlib), ICO хранит PNG внутри.
// Запуск: node scripts/make-icons.mjs  → resources/icon.png, icon.ico, tray.png, tray.ico
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

// `fileURLToPath`, а не `URL.pathname`.
//
// `pathname` оставляет процентную кодировку как есть: в пути вида
// «C:\Users\Иван\Мои проекты\rujarvis» каталогом вывода становился
// «C:/Users/%D0%98.../resources». `mkdirSync` молча его создавал, скрипт
// отчитывался успехом, а `resources/` проекта не менялся вовсе. Пути с
// пробелами и кириллицей здесь норма, а не исключение.
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size);
      const at = y * (size * 4 + 1) + 1 + x * 4;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    header[at] = size >= 256 ? 0 : size; header[at + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

const smooth = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};
const ACCENT = [79, 163, 255];

/** Иконка приложения: тёмная плашка, светящееся кольцо, точка. */
function appPixel(x, y, size) {
  const s = 4; // сглаживание подвыборкой
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < s; sy += 1) for (let sx = 0; sx < s; sx += 1) {
    const u = (x + (sx + 0.5) / s) / size * 2 - 1;
    const v = (y + (sy + 0.5) / s) / size * 2 - 1;
    const corner = 0.36;
    const qx = Math.max(Math.abs(u) - (1 - corner), 0), qy = Math.max(Math.abs(v) - (1 - corner), 0);
    const inside = Math.hypot(qx, qy) <= corner ? 1 : 0;
    if (!inside) continue;
    const d = Math.hypot(u, v);
    const ring = 1 - smooth(0.04, 0.08, Math.abs(d - 0.55));
    const glow = Math.exp(-((d - 0.55) ** 2) / 0.02) * 0.45;
    const dot = 1 - smooth(0.12, 0.17, d);
    const light = Math.min(1, ring + glow + dot);
    r += 15 + (ACCENT[0] - 15) * light; g += 17 + (ACCENT[1] - 17) * light; b += 21 + (ACCENT[2] - 21) * light; a += 255;
  }
  const n = s * s;
  return [r / n, g / n, b / n, a / n].map(Math.round);
}

/** Иконка трея: только кольцо и точка на прозрачном — видно и на светлой, и на тёмной панели. */
function trayPixel(x, y, size) {
  const s = 4;
  let a = 0;
  for (let sy = 0; sy < s; sy += 1) for (let sx = 0; sx < s; sx += 1) {
    const u = (x + (sx + 0.5) / s) / size * 2 - 1;
    const v = (y + (sy + 0.5) / s) / size * 2 - 1;
    const d = Math.hypot(u, v);
    const ring = 1 - smooth(0.1, 0.16, Math.abs(d - 0.68));
    const dot = 1 - smooth(0.2, 0.28, d);
    a += Math.min(1, ring + dot) * 255;
  }
  return [...ACCENT, Math.round(a / (s * s))];
}

mkdirSync(OUT, { recursive: true });
const appSizes = [16, 32, 48, 64, 128, 256];
const appImages = appSizes.map((size) => ({ size, data: png(size, appPixel) }));
writeFileSync(path.join(OUT, 'icon.png'), png(512, appPixel));
writeFileSync(path.join(OUT, 'icon.ico'), ico(appImages));
const trayImages = [16, 24, 32, 48].map((size) => ({ size, data: png(size, trayPixel) }));
writeFileSync(path.join(OUT, 'tray.png'), png(32, trayPixel));
writeFileSync(path.join(OUT, 'tray.ico'), ico(trayImages));
console.log(`icons written to ${OUT}`);
