/**
 * Снимки оверлея поверх настоящих кадров записи.
 *
 * ## Зачем
 *
 * Оверлей нельзя проверить на выдумке: важно не то, красив ли он сам по себе,
 * а не лезет ли он на то, что человек смотрит, и совпадают ли нарисованные
 * лагеря с настоящей миникартой. И то, и другое видно только поверх игры.
 *
 * Поэтому здесь берётся кадр из записи, к нему считается состояние **на тот же
 * миг** — по пакету GSI с тем же настенным временем, — и оверлей рисуется
 * сверху. Никаких выдуманных чисел: и картинка, и данные из одной секунды
 * одного матча.
 *
 * ## Почему без единого окна
 *
 * Браузер поднимается безголовым. Человек просил не открывать ему окон, и это
 * правильно само по себе: окно, мелькнувшее поверх его работы, — плохая цена
 * за картинку.
 *
 * ## Как проверяется пересчёт координат
 *
 * Жёлтым кружком рисуется свой герой по `hero.xpos/ypos`, а на кадре под ним
 * видна настоящая метка Доты. Совпали — значит границы миникарты и формула
 * сняты верно. Не совпали — видно сразу и без объяснений.
 *
 * ## Запуск
 *
 *     NODE_OPTIONS=--max-old-space-size=4096 pnpm exec tsx scripts/dota-overlay-shot.ts
 */
import { chromium } from '@playwright/test';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { argv } from 'node:process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { advise, createMemory, type OverlayView } from '../jarvis/dota/advice';
import { readPacket } from '../jarvis/dota/packet';
import { applyPacket, createState } from '../jarvis/dota/state';

const ЗДЕСЬ = dirname(fileURLToPath(import.meta.url));
const ПАПКА = argv[2] ?? 'C:/Users/ariel/Desktop/Джарвис/разведка-доты/запись-2026-09-21-1255';
const КУДА = join(ПАПКА, 'снимки-оверлея');
const СТРАНИЦА = join(ЗДЕСЬ, '..', 'jarvis', 'dota', 'overlay', 'view.html');

interface Кадр {
  файл: string;
  /** Секунда от начала видео, зашита в имя файла. */
  секунда: number;
  вид: string;
}

const кадры: Кадр[] = readdirSync(join(ПАПКА, 'кадры'))
  .map((файл) => {
    const м = /^(\d+)-(.+?)-([\d.]+)s\.jpg$/.exec(файл);
    return м ? { файл, вид: м[2], секунда: Number(м[3]) } : null;
  })
  .filter((к): к is Кадр => к !== null);

// Показываем по одному кадру каждого рода плюс самый поздний обзор: этого
// хватает, чтобы увидеть и тревогу, и спокойствие, и накопленное золото.
const выбранные = [
  ...кадры.filter((к) => к.вид === 'бой'),
  кадры.find((к) => к.вид === 'смерть'),
  кадры.filter((к) => к.вид === 'обзор')[3],
  кадры.filter((к) => к.вид === 'обзор').at(-2),
].filter((к): к is Кадр => Boolean(к));

const начало = JSON.parse(readFileSync(join(ПАПКА, 'начало.json'), 'utf8')) as { видеоСтарт: number };

/** Видимое время кадра → настенное время, по которому ищется пакет. */
const настенное = (секунда: number) => начало.видеоСтарт + секунда * 1000;

const цели = выбранные
  .map((к) => ({ ...к, at: настенное(к.секунда) }))
  .sort((a, б) => a.at - б.at);

// ── Один проход по записи: состояние копится честно, с первого пакета ────────

const снимки: { кадр: Кадр; view: OverlayView; speech: string | null }[] = [];
let состояние = createState();
let память = createMemory();
let следующая = 0;

const поток = createInterface({
  input: createReadStream(join(ПАПКА, 'gsi.jsonl')),
  crlfDelay: Infinity,
});
for await (const строка of поток) {
  if (!строка) continue;
  let сырая: { t?: number; d?: unknown };
  try { сырая = JSON.parse(строка) as { t?: number; d?: unknown }; } catch { continue; }
  const п = readPacket(сырая.d, сырая.t ?? 0);
  if (!п?.self) continue;

  состояние = applyPacket(состояние, п);
  const совет = advise(состояние, память, 'full');
  память = совет.memory;

  while (следующая < цели.length && п.at >= цели[следующая].at) {
    снимки.push({ кадр: цели[следующая], view: совет.view, speech: совет.speech });
    следующая += 1;
  }
  if (следующая >= цели.length) break;
}

console.log(`кадров к съёмке: ${снимки.length}`);

// ── Съёмка ──────────────────────────────────────────────────────────────────

mkdirSync(КУДА, { recursive: true });

const браузер = await chromium.launch();
const страница = await браузер.newPage({ viewport: { width: 1920, height: 1080 } });
await страница.goto(pathToFileURL(СТРАНИЦА).href);

for (const снимок of снимки) {
  const кадрПуть = join(ПАПКА, 'кадры', снимок.кадр.файл);
  if (!existsSync(кадрПуть)) continue;
  const фон = pathToFileURL(кадрПуть).href;

  await страница.evaluate(
    ([view, путь]) => {
      (window as unknown as { нарисовать: (v: unknown, ф: string) => void })
        .нарисовать(view, путь as string);
    },
    [снимок.view, фон] as const,
  );
  // Ждём, пока подложка действительно нарисуется: снимок пустого фона обманул
  // бы ровно в том, ради чего всё затевалось.
  await страница.waitForFunction(() => {
    const и = document.getElementById('фон') as HTMLImageElement | null;
    return Boolean(и && и.complete && и.naturalWidth > 0);
  });

  const имя = `${снимок.кадр.вид}-${снимок.кадр.секунда}s.png`;
  await страница.screenshot({ path: join(КУДА, имя) });
  const часы = снимок.view.clock ?? 0;
  const мм = `${String(Math.floor(Math.abs(часы) / 60)).padStart(2, '0')}:${String(Math.abs(часы) % 60).padStart(2, '0')}`;
  console.log(`  ${имя}  часы ${мм}  опасность ${снимок.view.danger.level}`
    + `  золото ${снимок.view.gold.amount}`
    + `  лагеря ${снимок.view.camps.alive}/${снимок.view.camps.empty}/${снимок.view.camps.stale}`
    + (снимок.speech ? `  голос: «${снимок.speech}»` : ''));
}

await браузер.close();
console.log(`снимки: ${КУДА}`);
