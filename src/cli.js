import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `agvid <command> <video> [options]

Commands:
  overview [--frames N] [--start TIME] [--end TIME] [--width PX] [--output DIR] <video>
  inspect <video> --around TIME [--window DURATION] [--fps N] [--width PX] [--output DIR]
  frame <video> --at TIME [--width PX] [--output DIR]
  probe <video>...

TIME accepts seconds or HH:MM:SS.s. DURATION accepts seconds, with optional s suffix.
--window is the total duration centered on --around. Options also accept --key=value.
Writes JPEG frames and manifest.json; overview and inspect also write timecode-labeled
sheet-NN.jpg. Output defaults to .agvid/runs/ under the git root (else cwd); --output DIR
must be new or empty. FFmpeg and FFprobe must be available on PATH.`;

const OPTIONS = {
  overview: new Set(['frames', 'start', 'end', 'width', 'output']),
  inspect: new Set(['around', 'window', 'fps', 'width', 'output']),
  frame: new Set(['at', 'width', 'output']),
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
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,codec_name,duration,nb_frames,pix_fmt,bits_per_raw_sample:stream_side_data=rotation:stream_tags=DURATION,rotate', '-of', 'json', video]);
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
  return { video, duration, width: swap ? stream.height : stream.width, height: swap ? stream.width : stream.height,
    rotation, codedWidth: stream.width, codedHeight: stream.height, fps, frameRate: stream.avg_frame_rate ?? null,
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

async function extract(video, time, width, filename) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', video, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:max(2\\,round(${width}/dar/2)*2),setsar=1`, '-threads:v', '1', '-q:v', '4', '-y', filename]);
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
  const width = Math.min(info.width, numberOption(options.width ?? 640, 'width', 64, 4096, true));
  let times;
  let windows;
  let range;
  if (command === 'overview') {
    const count = numberOption(options.frames ?? 12, 'frames', 1, 64, true);
    const { start, end } = range = resolveRange(options, info);
    times = Array.from({ length: count }, (_, i) => toMs(start + (end - start) * (i + 0.5) / count));
  } else if (command === 'inspect') {
    if (options.around === undefined) throw new Error('inspect requires --around');
    const arounds = [...new Set(options.around.map((value) => toMs(parseTime(value))))].sort((a, b) => a - b);
    const window = numberOption(parseTime(options.window ?? '2s'), 'window', 0.001, 3600);
    const fps = numberOption(options.fps ?? 4, 'fps', 0.1, 60);
    times = [];
    windows = [];
    for (const around of arounds) {
      if (around > info.duration) throw new Error(`--around ${formatTimecode(around)} is beyond the video duration`);
      const start = Math.max(0, around - window / 2);
      const end = Math.min(info.duration, around + window / 2);
      const count = Math.ceil((end - start) * fps);
      if (count < 1) throw new Error('inspect window contains no frames');
      if (times.length + count > 240) throw new Error('inspect would create over 240 frames; reduce --window, --fps or --around values');
      const first = times.length;
      // Rounding moves a time by at most 0.5 ms, so times stay ordered and below end.
      for (let i = 0; i < count; i++) times.push(toMs(Math.min(end - 0.001, start + (i + 0.5) / fps)));
      windows.push({ around, start: toMs(start), end: toMs(end), frames: [first, times.length - 1] });
    }
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
    try { await extract(video, time, width, target); }
    catch (error) { extractionError = error; }
    if (extractionError && await nonempty(target)) throw extractionError;
    if (!(await nonempty(target)) && info.duration - time < 0.1) {
      await extract(video, Math.max(0, info.duration - 0.1), width, target);
    }
    if (!(await nonempty(target))) throw extractionError ?? new Error(`FFmpeg produced no frame for ${time}s`);
    return { file: filename, time, timecode };
  };
  try {
    frames.push(...await pool(times, Math.min(os.availableParallelism(), 8), extractFrame));
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
    const manifest = await saveManifest(directory, { command, source: info, outputWidth: width, ...(range && (options.start !== undefined || options.end !== undefined) ? { range: { start: toMs(range.start), end: toMs(range.end) } } : {}), frames, ...(windows ? { windows } : {}), ...(sheets ? { sheets } : {}) });
    console.log(JSON.stringify({ directory, ...(sheets ? { sheets: sheets.map((sheet) => path.join(directory, sheet.file)) } : {}), manifest, frames: frames.length }, null, 2));
  } catch (error) {
    if (created) {
      await rm(directory, { recursive: true, force: true })
        .then(() => removeParents(directory, firstParent)).catch(() => {});
    }
    else await Promise.all(produced.map((file) => rm(file, { force: true }).catch(() => {})));
    throw error;
  }
}
