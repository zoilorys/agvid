import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nonempty } from './output.js';
import { pool, run } from './process.js';

const SHEET_BUDGET = 1568;

export function sheetLayout(count, tileAspect, frameWidth, frameHeight) {
  const even = (value) => Math.max(2, Math.floor(value / 2) * 2);
  let best;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const tileWidth = even(Math.min(frameWidth, SHEET_BUDGET / columns, SHEET_BUDGET * tileAspect / rows));
    let tileHeight = Math.min(frameHeight, even(Math.round(tileWidth / tileAspect)));
    while (tileHeight > 2 && rows * tileHeight > SHEET_BUDGET) tileHeight -= 2;
    const score = Math.abs(columns * tileWidth / (rows * tileHeight) - 1);
    if (!best || score < best.score) best = { columns, rows, tileWidth, tileHeight, score };
  }
  const { score, ...layout } = best;
  return layout;
}

export function planSheets(count, frameWidth, frameHeight) {
  const layout = (size) => sheetLayout(size, frameWidth / frameHeight, frameWidth, frameHeight);
  // Tile rounding can shrink even a lone tile, so the minimum is what one tile actually reaches.
  const single = layout(1);
  const minimum = Math.min(320, Math.max(single.tileWidth, single.tileHeight));
  for (let k = 1; ; k++) {
    const small = Math.floor(count / k);
    const sizes = Array.from({ length: k }, (_, i) => small + (i < count % k ? 1 : 0));
    const layouts = sizes.map(layout);
    if (k === count || layouts.every((l) => Math.max(l.tileWidth, l.tileHeight) >= minimum)) {
      let first = 0;
      return sizes.map((size, i) => ({ first, last: (first += size) - 1, layout: layouts[i] }));
    }
  }
}

// The SAR FFmpeg's scale filter sees, as a double. A 90/270 turn inverts it as an exact rational (transpose divides
// 1/1 by it), but probe stores 1 / (num / den), which can be one ulp off den / num; recover the fraction it came from.
function filterSar(info) {
  const sar = info.sar ?? 1;
  if (sar === 1 || (info.rotation !== 90 && info.rotation !== 270)) return sar;
  let [p0, q0, p1, q1, x] = [0, 1, 1, 0, sar];
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(x);
    [p0, q0, p1, q1] = [p1, q1, a * p1 + p0, a * q1 + q0];
    if (1 / (q1 / p1) === sar) return p1 / q1;
    if (x === a) break;
    x = 1 / (x - a);
  }
  return sar;
}

// Size of the extracted JPEGs, without probing them: extraction scales the (cropped) displayed frame with
// scale=W:max(2,round(W/dar/2)*2), so this repeats FFmpeg's double arithmetic step for step.
export function frameSize({ width, info, crop }) {
  const [w, h] = crop ? [crop.pixels.width, crop.pixels.height] : [info.width, info.height];
  const dar = (w / h) * filterSar(info);
  return { width, height: Math.max(2, Math.round(width / dar / 2) * 2) };
}

// 3x5 pixel font; ':' and '.' are one column wide. Tiles can be 64 px wide, so H:MM:SS.mmm must fit at scale 1.
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'], 3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '111'],
  ':': ['0', '1', '0', '1', '0'], '.': ['0', '0', '0', '0', '1'],
};

const labelUnits = (text) => [...text].reduce((sum, char) => sum + GLYPHS[char][0].length + 1, 1);

// White glyphs on a black box with one unit of padding and spacing, as a binary PGM.
export function renderLabel(text, scale) {
  const width = labelUnits(text) * scale;
  const height = 7 * scale;
  const pixels = Buffer.alloc(width * height);
  let x = 1;
  for (const char of text) {
    const glyph = GLYPHS[char];
    glyph.forEach((row, gy) => [...row].forEach((bit, gx) => {
      if (bit !== '1') return;
      for (let dy = 0; dy < scale; dy++) pixels.fill(255, ((1 + gy) * scale + dy) * width + (x + gx) * scale, ((1 + gy) * scale + dy) * width + (x + gx + 1) * scale);
    }));
    x += glyph[0].length + 1;
  }
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]);
}

export function labelScale(text, tileWidth, tileHeight) {
  let scale = Math.max(2, Math.round(tileHeight * 0.04 / 5));
  // 0 means no label: a clipped one could show a misleading timecode.
  while (scale > 0 && (labelUnits(text) * scale > tileWidth || 7 * scale > tileHeight)) scale--;
  return scale;
}

async function writeSheet(directory, frames, name, { columns, rows, tileWidth, tileHeight }, produced) {
  const sheet = path.join(directory, name);
  const labels = frames.map(({ timecode }, i) => ({ i, timecode, scale: labelScale(timecode, tileWidth, tileHeight),
    file: path.join(directory, `.label-${path.parse(name).name}-${String(i).padStart(2, '0')}.pgm`) })).filter((label) => label.scale);
  produced.push(...labels.map((label) => label.file));
  try {
    await Promise.all(labels.map((label) => writeFile(label.file, renderLabel(label.timecode, label.scale))));
    const inputs = [...frames.map((frame) => path.join(directory, frame.file)), ...labels.map((label) => label.file)].flatMap((file) => ['-i', file]);
    const n = frames.length;
    const input = new Map(labels.map((label, k) => [label.i, n + k]));
    const tiles = frames.map((_, i) => `[${i}:v]scale=${tileWidth}:${tileHeight},setsar=1${input.has(i) ? `[s${i}];[s${i}][${input.get(i)}:v]overlay=x=0:y=main_h-overlay_h` : ''}[v${i}];`).join('');
    const graph = `${tiles}${frames.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0,tile=${columns}x${rows}`;
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', graph, '-frames:v', '1', '-threads:v', '1', '-q:v', '4', '-y', sheet]);
  } finally {
    await Promise.all(labels.map((label) => rm(label.file, { force: true })));
  }
  if (!(await nonempty(sheet))) throw new Error('FFmpeg produced no contact sheet');
  return sheet;
}

// Sheets rendered at once. Two roughly halve sheet time; FFmpeg's own encoder and filter threads gained nothing.
const SHEET_JOBS = 2;

// Writes timecode-labeled sheets of `frames` (files in `directory`, extracted at `width` from `info` and `crop`) and
// returns their manifest entries. Each window ({ frames: [first, last] }) gets its own sheets, listed in its `sheets`;
// without windows all frames form one.
export async function buildSheets({ directory, frames, windows, width, info, crop, produced }) {
  const size = frameSize({ width, info, crop });
  const slices = windows ?? [{ frames: [0, frames.length - 1] }];
  const plans = slices.flatMap((slice) => {
    const offset = slice.frames[0];
    return planSheets(slice.frames[1] - offset + 1, size.width, size.height)
      .map(({ first, last, layout }) => ({ slice, first: offset + first, last: offset + last, layout }));
  });
  // Pad to the total so lexical filename order equals manifest order.
  const digits = Math.max(2, String(plans.length).length);
  for (const [i, plan] of plans.entries()) {
    plan.file = `sheet-${String(i + 1).padStart(digits, '0')}.jpg`;
    produced.push(path.join(directory, plan.file));
  }
  await pool(plans, SHEET_JOBS, ({ file, first, last, layout }) => writeSheet(directory, frames.slice(first, last + 1), file, layout, produced));
  return plans.map(({ slice, file, first, last, layout }) => {
    (slice.sheets ??= []).push(file);
    return { file, frames: [first, last], start: frames[first].time, end: frames[last].time, ...layout };
  });
}
