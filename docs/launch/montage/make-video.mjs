// Монтаж демо-ролика Rujarvis по списку склеек.
//
//   node docs/launch/montage/make-video.mjs docs/launch/montage/cuts.json
//
// Нужен ffmpeg (в PATH или в переменной FFMPEG) со сборкой libass — в
// обычных сборках для Windows (gyan.dev, winget Gyan.FFmpeg) он есть.
//
// Скрипт не решает, что вырезать: это делает человек или агент, заполняя
// cuts.json по сырым записям. Скрипт только честно исполняет список: режет,
// ускоряет, накладывает плашки и собирает горизонтальную и вертикальную версии.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const cutsFile = process.argv[2];
if (!cutsFile) {
  console.error('Использование: node make-video.mjs <cuts.json>');
  process.exit(2);
}
const base = path.dirname(path.resolve(cutsFile));
const cuts = JSON.parse(readFileSync(cutsFile, 'utf8'));
const font = cuts.font || (process.platform === 'win32' ? 'Segoe UI' : 'DejaVu Sans');
const work = path.join(os.tmpdir(), `rujarvis-montage-${process.pid}`);
mkdirSync(work, { recursive: true });

const FORMATS = {
  wide: { w: 1920, h: 1080, plateSize: 54, saidSize: 46, plateAlign: 1, saidAlign: 8, margin: 60 },
  tall: { w: 1080, h: 1920, plateSize: 62, saidSize: 56, plateAlign: 2, saidAlign: 8, margin: 140 },
};

function run(args) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
  if (result.error) throw new Error(`ffmpeg не запустился: ${result.error.message}. Поставьте ffmpeg или укажите путь в FFMPEG.`);
  if (result.status !== 0) throw new Error(`ffmpeg завершился с кодом ${result.status}`);
}

/** Секунды из «12.5», «01:02.3» или «00:01:02.300». */
function seconds(value) {
  if (typeof value === 'number') return value;
  return String(value)
    .split(':')
    .reduce((total, part) => total * 60 + Number(part), 0);
}

function assTime(value) {
  const cs = Math.max(0, Math.round(value * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

// libass читает фигурные скобки как команды и обратный слеш как управляющий.
function assText(text) {
  return String(text).replace(/\\/g, '＼').replace(/[{}]/g, '').replace(/\n/g, '\\N');
}

/** Плашки одного куска: снизу — что происходит, сверху — что сказано, в углу — ускорение. */
function writeAss(file, format, duration, clip) {
  const f = FORMATS[format];
  const lines = [];
  const until = assTime(duration);
  if (clip.plate) lines.push(`Dialogue: 0,0:00:00.30,${until},Plate,,0,0,0,,${assText(clip.plate)}`);
  if (clip.said) lines.push(`Dialogue: 0,0:00:00.00,${until},Said,,0,0,0,,«${assText(clip.said)}»`);
  if (clip.speed && clip.speed !== 1) lines.push(`Dialogue: 0,0:00:00.00,${until},Speed,,0,0,0,,×${clip.speed}`);
  writeFileSync(
    file,
    [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${f.w}`,
      `PlayResY: ${f.h}`,
      'WrapStyle: 0',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      // Непрозрачная подложка (BorderStyle 3): текст читается на любом экране.
      `Style: Plate,${font},${f.plateSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H40000000,1,0,0,0,100,100,0,0,3,18,0,${f.plateAlign},${f.margin},${f.margin},${f.margin},1`,
      `Style: Said,${font},${f.saidSize},&H0000D7FF,&H0000D7FF,&H00000000,&H60000000,1,0,0,0,100,100,0,0,3,14,0,${f.saidAlign},${f.margin},${f.margin},${f.margin},1`,
      `Style: Speed,${font},${f.saidSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H60000000,1,0,0,0,100,100,0,0,3,12,0,9,${f.margin},${f.margin},${f.margin},1`,
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...lines,
      '',
    ].join('\n'),
    'utf8',
  );
}

// Путь внутри фильтра ffmpeg: двоеточие диска и обратные слеши надо экранировать.
function filterPath(file) {
  return file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** Кадр в формат: широкий — вписать; высокий — видео по центру на размытом фоне. */
function frameFilter(format) {
  const { w, h } = FORMATS[format];
  if (format === 'wide') {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  }
  return (
    `split[bg][fg];[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=30:3[bg2];` +
    `[fg]scale=${w}:-2[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`
  );
}

function renderClip(clip, index, format) {
  const from = seconds(clip.from ?? 0);
  const to = seconds(clip.to);
  const speed = clip.speed ?? 1;
  const duration = (to - from) / speed;
  if (!(duration > 0)) throw new Error(`Кусок ${index + 1}: «to» должно быть больше «from»`);

  const ass = path.join(work, `${format}-${index}.ass`);
  writeAss(ass, format, duration, clip);
  const out = path.join(work, `${format}-${index}.mp4`);
  const video = `[0:v]setpts=(PTS-STARTPTS)/${speed},${frameFilter(format)},fps=30,ass='${filterPath(ass)}'[v]`;
  // Ускоренный голос звучит нелепо: на ускоренных кусках звука нет, есть плашка «×N».
  const audio = speed === 1 && !clip.mute ? '[0:a]asetpts=PTS-STARTPTS,aresample=48000[a]' : null;
  const args = ['-ss', String(from), '-to', String(to), '-i', path.resolve(base, clip.file)];
  if (!audio) args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(
    '-filter_complex', audio ? `${video};${audio}` : video,
    '-map', '[v]', '-map', audio ? '[a]' : '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-shortest', out,
  );
  run(args);
  return out;
}

function renderEndCard(format) {
  const end = cuts.end;
  if (!end) return null;
  const { w, h } = FORMATS[format];
  const duration = end.seconds ?? 4;
  const ass = path.join(work, `${format}-end.ass`);
  const size = format === 'wide' ? 96 : 110;
  const small = format === 'wide' ? 48 : 56;
  const text = [`{\\fs${size}\\b1}${assText(end.title ?? 'Rujarvis')}`, ...(end.lines ?? []).map((l) => `{\\fs${small}\\b0}${assText(l)}`)].join('\\N');
  writeFileSync(
    ass,
    [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`,
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: End,${font},${small},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,40,40,40,1`,
      '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      `Dialogue: 0,0:00:00.00,${assTime(duration)},End,,0,0,0,,${text}`, '',
    ].join('\n'),
    'utf8',
  );
  const out = path.join(work, `${format}-end.mp4`);
  run([
    '-f', 'lavfi', '-t', String(duration), '-i', `color=c=0x0f1115:s=${w}x${h}:r=30`,
    '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo',
    '-vf', `ass='${filterPath(ass)}'`,
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', out,
  ]);
  return out;
}

function build(format, clips, output) {
  if (!output || clips.length === 0) return;
  const parts = clips.map((clip, index) => renderClip(clip, index, format));
  const endCard = renderEndCard(format);
  if (endCard) parts.push(endCard);
  const list = path.join(work, `${format}-list.txt`);
  writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const target = path.resolve(base, output);
  run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', target]);
  const total = clips.reduce((sum, c) => sum + (seconds(c.to) - seconds(c.from ?? 0)) / (c.speed ?? 1), 0) + (cuts.end?.seconds ?? 0);
  console.log(`Готово: ${target} (${total.toFixed(1)} с)`);
}

try {
  build('wide', cuts.clips ?? [], cuts.output);
  build('tall', (cuts.clips ?? []).filter((c) => c.vertical), cuts.vertical);
} finally {
  rmSync(work, { recursive: true, force: true });
}
