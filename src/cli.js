import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `agvid <command> <video> [options]

Commands:
  overview [--frames N] [--start TIME] [--end TIME] [--crop X,Y,W,H] [--width PX] [--output DIR] <video>
  inspect <video> (--around TIME [--window DURATION] | [--start TIME] [--end TIME]) [--fps N] [--crop X,Y,W,H] [--width PX] [--output DIR]
  frame <video> --at TIME[,TIME...] [--crop X,Y,W,H] [--width PX] [--output DIR]
  changes <video> [--start TIME] [--end TIME] [--crop X,Y,W,H] [--threshold X] [--min-gap DURATION] [--max N] [--width PX] [--output DIR]
  probe <video>...

--at and --around take comma lists or repeat the flag. --at times are deduped and sorted;
each --around gets its own window and sheets (manifest windows[]). Up to 240 frames.
changes writes the range start plus each frame where over --threshold (default 0.002) of the
picture differs from the last detected candidate, at least --min-gap (default 0.5s) apart;
--max (default 48, up to 240) keeps the highest scores. It decodes the whole range (sampled
up to 10 fps): use --start/--end on long videos. Needs FFmpeg 5.1+. --crop limits detection
to the region; use it for small UI changes.
TIME accepts seconds or HH:MM:SS.s. DURATION accepts seconds, with optional s suffix.
--end is clamped to the video duration. --start/--end cannot combine with --around/--window.
--crop takes fractions 0-1 of the displayed frame (left, top, width, height) and cuts
that region at source resolution before --width scaling; it is never enlarged.
--window is the total duration centered on --around. Options also accept --key=value.
Writes JPEG frames and manifest.json; overview, inspect and changes also write
timecode-labeled sheet-NN.jpg. Output defaults to .agvid/runs/ under the git root (else cwd);
--output DIR must be new or empty. probe with several videos prints an array, with
{video,error} entries for failures, and exits 1 if any failed.
FFmpeg and FFprobe must be available on PATH.`;

const OPTIONS = {
  overview: new Set(['frames', 'start', 'end', 'crop', 'width', 'output']),
  inspect: new Set(['around', 'window', 'fps', 'start', 'end', 'crop', 'width', 'output']),
  frame: new Set(['at', 'crop', 'width', 'output']),
  changes: new Set(['start', 'end', 'crop', 'threshold', 'min-gap', 'max', 'width', 'output']),
  probe: new Set(),
};

const MULTI = new Set(['at', 'around']);

export function parseTime(value) {
  const parts = String(value).replace(/s$/, '').split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error(`invalid time: ${value}`);
  }
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

const toMs = (seconds) => Math.round(seconds * 1000) / 1000;

export function formatTimecode(seconds) {
  const total = Math.round(seconds * 1000);
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const hours = Math.floor(total / 3600000);
  const clock = `${pad(Math.floor(total / 60000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
  return hours ? `${hours}:${clock}` : clock;
}

function numberOption(value, name, min, max, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return number;
}

// Resolves optional --start/--end to { start, end } seconds within the video; end is clamped to the duration.
export function resolveRange(options, info) {
  const start = options.start === undefined ? 0 : toMs(parseTime(options.start));
  const end = options.end === undefined ? info.duration : Math.min(info.duration, toMs(parseTime(options.end)));
  if (start >= info.duration) throw new Error(`--start ${formatTimecode(start)} must be before the video ends`);
  if (start >= end) throw new Error(`--start ${formatTimecode(start)} must be before --end ${formatTimecode(end)}`);
  return { start, end };
}

// Parses --crop fractions and maps them to even pixel offsets and sizes in the source's displayed orientation.
// FFmpeg auto-rotates before -vf. SAR stretches only the displayed horizontal axis, uniformly, so equal fractions
// of stored pixels still name the displayed region; `displayed` is that region's size in square pixels.
export function parseCrop(value, info) {
  const parts = String(value).split(',');
  const numbers = parts.map((part) => (/^\s*\d*\.?\d+\s*$/.test(part) ? Number(part) : NaN));
  if (parts.length !== 4 || numbers.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
    throw new Error(`--crop must be four fractions from 0 to 1 (x,y,w,h): ${value}`);
  }
  const [x, y, w, h] = numbers;
  if (w <= 0 || h <= 0) throw new Error(`--crop width and height must be above 0: ${value}`);
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) throw new Error(`--crop region must fit in the frame (x+w and y+h at most 1): ${value}`);
  const axis = (start, size, total) => {
    const offset = Math.floor(start * total / 2) * 2;
    return [offset, Math.min(Math.round(size * total / 2) * 2, Math.floor((total - offset) / 2) * 2)];
  };
  const [px, width] = axis(x, w, info.width);
  const [py, height] = axis(y, h, info.height);
  if (width < 16 || height < 16) throw new Error(`--crop region is ${width}x${height} source pixels; it must be at least 16x16`);
  const displayed = { width: Math.max(2, Math.round(width * (info.sar ?? 1))), height };
  return { x, y, w, h, pixels: { x: px, y: py, width, height, displayed } };
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (!OPTIONS[command]) throw new Error(`unknown command: ${command ?? ''}\n\n${HELP}`);
  const options = {};
  let video;
  const videos = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const key = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
      const name = `--${key}`;
      if (!OPTIONS[command].has(key)) throw new Error(`unknown option: ${name}`);
      if (!MULTI.has(key) && options[key] !== undefined) throw new Error(`duplicate option: ${name}`);
      const value = equals < 0 ? rest[++i] : arg.slice(equals + 1);
      if (!value || (equals < 0 && value.startsWith('--'))) throw new Error(`missing value for ${name}`);
      if (MULTI.has(key)) {
        const items = value.split(',');
        if (items.some((item) => !item)) throw new Error(`empty item in ${name}: ${value}`);
        (options[key] ??= []).push(...items);
      } else options[key] = value;
    } else if (command === 'probe') videos.push(arg);
    else if (!video) video = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  if (command === 'probe') {
    if (!videos.length) throw new Error(`missing video path\n\n${HELP}`);
    return { command, videos: videos.map((file) => path.resolve(file)), options };
  }
  if (!video) throw new Error(`missing video path\n\n${HELP}`);
  return { command, video: path.resolve(video), options };
}

function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`${program}: ${error.message}`)));
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${program} exited ${code}: ${stderr.trim()}`)));
  });
}

async function probe(video) {
  // No -select_streams: the full listing also reveals audio. The first video stream matches FFmpeg's 0:v:0.
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,codec_name,duration,nb_frames,pix_fmt,bits_per_raw_sample,sample_aspect_ratio:stream_side_data=rotation:stream_tags=DURATION,rotate', '-of', 'json', video]);
  const streams = JSON.parse(raw).streams ?? [];
  const stream = streams.find((entry) => entry.codec_type === 'video');
  if (!stream) throw new Error('no video stream found');
  const valid = (value) => Number.isFinite(value) && value > 0;
  let duration = Number(stream.duration);
  let durationSource = 'stream';
  if (!valid(duration) && stream.tags?.DURATION) {
    durationSource = 'tag';
    try { duration = parseTime(stream.tags.DURATION); }
    catch { duration = NaN; }
  }
  if (!valid(duration)) {
    durationSource = 'packets';
    duration = await packetDuration(video);
  }
  if (!valid(duration)) {
    throw new Error('first video stream has no duration metadata; provide a video with a known video-stream duration');
  }
  if (!Number.isInteger(stream.width) || stream.width <= 0 || !Number.isInteger(stream.height) || stream.height <= 0) {
    throw new Error('video dimensions are unavailable');
  }
  const rawRotation = Number(stream.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  const rotation = Number.isFinite(rawRotation) ? ((Math.round(rawRotation) % 360) + 360) % 360 : 0;
  const swap = rotation === 90 || rotation === 270;
  const [numerator, denominator] = String(stream.avg_frame_rate ?? '').split('/').map(Number);
  const rate = numerator / denominator;
  const fps = Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
  const counted = Number(stream.nb_frames);
  const frameCountEstimated = !(Number.isInteger(counted) && counted > 0);
  const frameCount = frameCountEstimated ? (fps === null ? null : Math.round(duration * rate)) : counted;
  const bitDepth = Number(stream.bits_per_raw_sample);
  // SAR stretches stored pixels horizontally; after a 90/270 turn it applies to the displayed vertical axis, so invert it.
  const [sarNum, sarDen] = String(stream.sample_aspect_ratio ?? '').split(':').map(Number);
  const storedSar = sarNum > 0 && sarDen > 0 ? sarNum / sarDen : 1;
  const sar = swap ? 1 / storedSar : storedSar;
  return { video, duration, width: swap ? stream.height : stream.width, height: swap ? stream.width : stream.height,
    sar, rotation, codedWidth: stream.width, codedHeight: stream.height, fps, frameRate: stream.avg_frame_rate ?? null,
    frameCount, frameCountEstimated, codec: stream.codec_name, pixelFormat: stream.pix_fmt ?? null,
    bitDepth: Number.isInteger(bitDepth) && bitDepth > 0 ? bitDepth : null,
    hasAudio: streams.some((entry) => entry.codec_type === 'audio'), durationSource };
}

async function packetDuration(video) {
  const raw = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', video]);
  let start = Infinity;
  let end = -Infinity;
  for (const line of raw.split('\n')) {
    const [pts, length] = line.split(',').map((field) => (/^-?\d+(?:\.\d+)?$/.test(field?.trim() ?? '') ? Number(field) : NaN));
    if (!Number.isFinite(pts) || !Number.isFinite(length)) continue;
    start = Math.min(start, pts);
    end = Math.max(end, pts + length);
  }
  return end - start;
}

async function findProjectRoot(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    try { await stat(path.join(dir, '.git')); return dir; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (path.dirname(dir) === dir) return cwd;
  }
}

// Removes the empty parents of `directory` that mkdir created, up to and including `first`.
async function removeParents(directory, first) {
  if (!first) return;
  for (let dir = path.dirname(directory); ; dir = path.dirname(dir)) {
    try { await rmdir(dir); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
    if (dir === first || path.dirname(dir) === dir) return;
  }
}

async function outputDirectory(video, command, requested) {
  if (requested) {
    const directory = path.resolve(requested);
    const firstParent = await mkdir(path.dirname(directory), { recursive: true });
    try {
      await mkdir(directory);
      return { directory, created: true, firstParent };
    } catch (error) {
      if (error.code !== 'EEXIST') { await removeParents(directory, firstParent); throw error; }
    }
    if ((await readdir(directory)).length) throw new Error(`output directory is not empty: ${directory}`);
    return { directory, created: false };
  }
  const agvid = path.join(await findProjectRoot(process.cwd()), '.agvid');
  const root = path.join(agvid, 'runs');
  try {
    await mkdir(root, { recursive: true });
    try { await writeFile(path.join(agvid, '.gitignore'), '*\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } catch (error) {
    throw new Error(`cannot write output under ${agvid} (${error.code ?? error.message}); pass --output DIR`);
  }
  const base = `${path.parse(video).name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${command}`;
  for (let suffix = 0; ; suffix++) {
    const directory = path.join(root, suffix ? `${base}-${suffix}` : base);
    try {
      await mkdir(directory);
      return { directory, created: true };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

async function extract(video, time, width, filename, crop) {
  const cut = crop ? `crop=${crop.pixels.width}:${crop.pixels.height}:${crop.pixels.x}:${crop.pixels.y},` : '';
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', video, '-map', '0:v:0', '-frames:v', '1', '-vf', `${cut}scale=${width}:max(2\\,round(${width}/dar/2)*2),setsar=1`, '-threads:v', '1', '-q:v', '4', '-y', filename]);
}

const ANALYSIS_FPS = 10;
const ANALYSIS_WIDTH = 160;
const PIXEL_DELTA = 16;

// One decode pass over the range: 160-px-wide gray source frames thinned to at most 10/s (select keeps source pts;
// no fps resampling), each scored as the share of pixels differing by more than 16/255 from the last reported frame
// (initially the first decoded one, at the range start). Times are source pts from showinfo, which -ss input seeking
// makes relative to the range start. Streams rawvideo; keeps only the
// reference frame and frames still waiting for their pts line.
// changes uses -fps_mode (FFmpeg 5.1+). Unparseable versions, such as git builds, are let through.
async function requireFfmpeg51() {
  const first = (await run('ffmpeg', ['-version'])).split('\n')[0];
  const match = /^ffmpeg version n?(\d+)\.(\d+)/.exec(first);
  if (match && (Number(match[1]) < 5 || (Number(match[1]) === 5 && Number(match[2]) < 1))) {
    throw new Error(`changes needs FFmpeg 5.1 or newer, found ${match[1]}.${match[2]}; upgrade FFmpeg or use overview/inspect instead`);
  }
}

function detectChanges(video, info, range, crop, { threshold, minGap }) {
  const sourceWidth = crop?.pixels.width ?? info.width;
  const sourceHeight = crop?.pixels.height ?? info.height;
  const height = Math.max(2, Math.round(ANALYSIS_WIDTH * sourceHeight / sourceWidth / 2) * 2);
  const size = ANALYSIS_WIDTH * height;
  const cut = crop ? `crop=${crop.pixels.width}:${crop.pixels.height}:${crop.pixels.x}:${crop.pixels.y},` : '';
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-ss', String(range.start), '-to', String(range.end), '-i', video,
    '-map', '0:v:0', '-vf', `${cut}select='isnan(prev_selected_t)+gte(t-prev_selected_t,${1 / ANALYSIS_FPS - 1e-6})',scale=${ANALYSIS_WIDTH}:${height},format=gray,showinfo`,
    '-fps_mode', 'passthrough', '-threads:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'];
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pendingFrames = [];
    const pendingTimes = [];
    const events = [];
    const errors = [];
    let decoded = 0;
    let failed;
    let reference;
    let lastReport = range.start;
    let partial = Buffer.alloc(size);
    let filled = 0;
    let line = '';
    const score = (frame) => {
      let changed = 0;
      for (let i = 0; i < size; i++) if (Math.abs(frame[i] - reference[i]) > PIXEL_DELTA) changed++;
      return changed / size;
    };
    const drain = () => {
      while (pendingFrames.length && pendingTimes.length) {
        const frame = pendingFrames.shift();
        // Floor so a later `-ss time` never lands just after this frame's pts.
        const time = Math.floor((range.start + pendingTimes.shift()) * 1000 + 1e-6) / 1000;
        decoded++;
        if (!reference) { reference = frame; continue; }
        if (!(time > range.start && time < range.end) || time - lastReport < minGap - 1e-9) continue;
        const value = score(frame);
        if (value > threshold) {
          events.push({ time, score: Math.round(value * 1e6) / 1e6 });
          reference = frame;
          lastReport = time;
        }
      }
    };
    child.stdout.on('data', (chunk) => {
      for (let offset = 0; offset < chunk.length;) {
        const count = Math.min(size - filled, chunk.length - offset);
        chunk.copy(partial, filled, offset, offset + count);
        filled += count;
        offset += count;
        if (filled === size) { pendingFrames.push(partial); partial = Buffer.alloc(size); filled = 0; }
      }
      drain();
      if (pendingFrames.length > 64 && !failed) {
        failed = new Error('ffmpeg frame/pts mismatch: frames arrived without showinfo times');
        child.kill();
      }
    });
    child.stderr.on('data', (chunk) => {
      const lines = (line + chunk).split('\n');
      line = lines.pop();
      for (const text of lines) {
        if (/Parsed_showinfo/.test(text)) {
          const match = /\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*(-?[\d.e+-]+)/.exec(text);
          if (match) pendingTimes.push(Number(match[1]));
        } else if (text.trim()) {
          errors.push(text.trim());
          if (errors.length > 20) errors.shift();
        }
      }
      drain();
    });
    child.on('error', (error) => reject(new Error(`ffmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (failed) return reject(failed);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${errors.join('\n')}`));
      drain();
      if (pendingFrames.length || pendingTimes.length || filled) {
        return reject(new Error(`ffmpeg frame/pts mismatch: ${pendingFrames.length} frames and ${pendingTimes.length} times unpaired, ${filled} trailing bytes`));
      }
      if (!decoded) return reject(new Error(`no decodable frames between ${formatTimecode(range.start)} and ${formatTimecode(range.end)}`));
      resolve(events);
    });
  });
}

async function nonempty(filename) {
  try { return (await stat(filename)).size > 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Runs fn over items with bounded concurrency. After the first failure no new job starts;
// it rejects with that error only once every started job has settled.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  const worker = async () => {
    while (!failure && next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); }
      catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

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

async function frameSize(file) {
  const { width, height } = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file])).streams[0];
  return { width, height };
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

async function saveManifest(directory, result) {
  const filename = path.join(directory, 'manifest.json');
  const temporary = path.join(directory, 'manifest.json.tmp');
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`);
  await rename(temporary, filename);
  return filename;
}

export async function main(args) {
  if (args.length === 0 || ['--help', '-h', 'help'].includes(args[0])) {
    console.log(HELP);
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    console.log(pkg.version);
    return;
  }
  const { command, video, videos, options } = parseArgs(args);
  if (command === 'probe') {
    if (videos.length === 1) {
      console.log(JSON.stringify(await probe(videos[0]), null, 2));
      return;
    }
    const results = await pool(videos, Math.min(os.availableParallelism(), 8),
      (file) => probe(file).catch((error) => ({ video: file, error: error.message })));
    if (results.some((entry) => 'error' in entry)) process.exitCode = 1;
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  const info = await probe(video);
  const crop = options.crop === undefined ? undefined : parseCrop(options.crop, info);
  const width = Math.min(crop?.pixels.displayed.width ?? info.width, numberOption(options.width ?? 640, 'width', 64, 4096, true));
  let times;
  let windows;
  let range;
  let scores;
  let detection;
  if (command === 'overview') {
    const count = numberOption(options.frames ?? 12, 'frames', 1, 64, true);
    const { start, end } = range = resolveRange(options, info);
    times = Array.from({ length: count }, (_, i) => toMs(start + (end - start) * (i + 0.5) / count));
  } else if (command === 'inspect') {
    const ranged = options.start !== undefined || options.end !== undefined;
    if (ranged && (options.around !== undefined || options.window !== undefined)) throw new Error('--start/--end cannot be combined with --around/--window');
    if (!ranged && options.around === undefined) throw new Error('inspect requires --around or --start/--end');
    const fps = numberOption(options.fps ?? 4, 'fps', 0.1, 60);
    let spans;
    if (ranged) spans = [{ around: null, ...resolveRange(options, info) }];
    else {
      const arounds = [...new Set(options.around.map((value) => toMs(parseTime(value))))].sort((a, b) => a - b);
      const window = numberOption(parseTime(options.window ?? '2s'), 'window', 0.001, 3600);
      spans = arounds.map((around) => {
        if (around > info.duration) throw new Error(`--around ${formatTimecode(around)} is beyond the video duration`);
        return { around, start: Math.max(0, around - window / 2), end: Math.min(info.duration, around + window / 2) };
      });
    }
    times = [];
    windows = [];
    for (const { around, start, end } of spans) {
      const count = Math.ceil((end - start) * fps);
      if (count < 1) throw new Error('inspect window contains no frames');
      if (times.length + count > 240) throw new Error('inspect would create over 240 frames; reduce --window, --fps or --around values');
      const first = times.length;
      // Rounding moves a time by at most 0.5 ms, so times stay ordered and below end.
      for (let i = 0; i < count; i++) times.push(toMs(Math.min(end - 0.001, start + (i + 0.5) / fps)));
      windows.push({ around, start: toMs(start), end: toMs(end), frames: [first, times.length - 1] });
    }
  } else if (command === 'changes') {
    const threshold = Number(options.threshold ?? 0.002);
    if (!(threshold > 0 && threshold <= 1)) throw new Error('--threshold must be a fraction above 0 and at most 1');
    const minGap = numberOption(parseTime(options['min-gap'] ?? '0.5'), 'min-gap', 0, 3600);
    const max = numberOption(options.max ?? 48, 'max', 1, 240, true);
    range = resolveRange(options, info);
    await requireFfmpeg51();
    const found = await detectChanges(video, info, range, crop, { threshold, minGap });
    const truncated = found.length > max;
    const kept = truncated ? [...found].sort((a, b) => b.score - a.score || a.time - b.time).slice(0, max).sort((a, b) => a.time - b.time) : found;
    times = [range.start, ...kept.map((event) => event.time)];
    scores = [null, ...kept.map((event) => event.score)];
    detection = { metric: `gray-diff>${PIXEL_DELTA}@${ANALYSIS_WIDTH}px,${ANALYSIS_FPS}fps vs last detected candidate`, threshold, minGap, candidates: found.length, truncated };
  } else {
    if (options.at === undefined) throw new Error('frame requires --at');
    times = [...new Set(options.at.map((value) => {
      const time = toMs(parseTime(value));
      if (time >= info.duration) throw new Error(`--at ${value} must be before the video ends`);
      return time;
    }))].sort((a, b) => a - b);
    if (times.length > 240) throw new Error('frame would create over 240 frames; reduce --at values');
  }
  const { directory, created, firstParent } = await outputDirectory(video, command, options.output);
  const frames = [];
  const produced = [];
  const extractFrame = async (time, i) => {
    const timecode = formatTimecode(time);
    const filename = `frame-${String(i).padStart(4, '0')}_${timecode.replaceAll(':', '-')}.jpg`;
    const target = path.join(directory, filename);
    produced.push(target);
    let extractionError;
    try { await extract(video, time, width, target, crop); }
    catch (error) { extractionError = error; }
    if (extractionError && await nonempty(target)) throw extractionError;
    if (!(await nonempty(target)) && info.duration - time < 0.1) {
      await extract(video, Math.max(0, info.duration - 0.1), width, target, crop);
    }
    if (!(await nonempty(target))) throw extractionError ?? new Error(`FFmpeg produced no frame for ${time}s`);
    return { file: filename, time, timecode };
  };
  try {
    frames.push(...await pool(times, Math.min(os.availableParallelism(), 8), extractFrame));
    if (scores) frames.forEach((frame, i) => { frame.score = scores[i]; });
    let sheets;
    if (command !== 'frame' || frames.length > 1) {
      const size = await frameSize(path.join(directory, frames[0].file));
      sheets = [];
      const slices = windows ?? [{ frames: [0, frames.length - 1] }];
      const plans = slices.map((slice) => {
        const offset = slice.frames[0];
        return planSheets(slice.frames[1] - offset + 1, size.width, size.height)
          .map(({ first, last, layout }) => ({ slice, first: offset + first, last: offset + last, layout }));
      }).flat();
      // Pad to the total so lexical filename order equals manifest order.
      const digits = Math.max(2, String(plans.length).length);
      for (const [i, { slice, first, last, layout }] of plans.entries()) {
        const file = `sheet-${String(i + 1).padStart(digits, '0')}.jpg`;
        produced.push(path.join(directory, file));
        await writeSheet(directory, frames.slice(first, last + 1), file, layout, produced);
        sheets.push({ file, frames: [first, last], start: frames[first].time, end: frames[last].time, ...layout });
        (slice.sheets ??= []).push(file);
      }
    }
    produced.push(path.join(directory, 'manifest.json.tmp'), path.join(directory, 'manifest.json'));
    const manifest = await saveManifest(directory, { command, source: info, outputWidth: width, ...(crop ? { crop } : {}), ...(range && (options.start !== undefined || options.end !== undefined) ? { range: { start: toMs(range.start), end: toMs(range.end) } } : {}), ...(detection ? { detection } : {}), frames, ...(windows ? { windows } : {}), ...(sheets ? { sheets } : {}) });
    console.log(JSON.stringify({ directory, ...(sheets ? { sheets: sheets.map((sheet) => path.join(directory, sheet.file)) } : {}), manifest, frames: frames.length, ...(detection ? { changes: frames.length - 1 } : {}) }, null, 2));
  } catch (error) {
    if (created) {
      await rm(directory, { recursive: true, force: true })
        .then(() => removeParents(directory, firstParent)).catch(() => {});
    }
    else await Promise.all(produced.map((file) => rm(file, { force: true }).catch(() => {})));
    throw error;
  }
}
