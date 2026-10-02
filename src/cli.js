import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `agvid <command> <video> [options]

Commands:
  overview [--video-stream N] [--frames N] [--start TIME] [--end TIME] [--crop X,Y,W,H] [--width PX] [--output DIR] <video>
  inspect <video> [--video-stream N] (--around TIME [--window DURATION] | [--start TIME] [--end TIME]) [--fps N] [--crop X,Y,W,H] [--width PX] [--output DIR]
  frame <video> [--video-stream N] --at TIME[,TIME...] [--crop X,Y,W,H] [--width PX] [--output DIR]
  changes <video> [--video-stream N] [--start TIME] [--end TIME] [--crop X,Y,W,H] [--threshold X] [--min-gap DURATION] [--max N] [--analysis-fps N] [--analysis-width PX] [--width PX] [--output DIR]
  probe [--video-stream N] <video>...

--at and --around take comma lists or repeat the flag. --at times are deduped and sorted;
each --around gets its own window and sheets (manifest windows[]). Up to 240 frames.
changes writes the range start plus each frame where over --threshold (default 0.002) of the
picture differs in any RGB channel from the last detected candidate, at least --min-gap (default 0.5s) apart;
--max (default 48, up to 239 plus the range start) keeps the highest scores. It decodes the whole range (sampled
up to 30 fps at 256px wide by default). --analysis-fps (1-60) and --analysis-width (64-512)
tune detection cost and sensitivity. Use --start/--end on long videos. Needs FFmpeg 5.1+. --crop limits detection
to the region; use it for small UI changes.
TIME accepts seconds, MM:SS.s, or HH:MM:SS.s; clock minute and second fields must be below 60.
DURATION accepts seconds, with optional s suffix. Manifest times keep sub-millisecond precision;
filenames and sheet labels round to milliseconds.
Times are on the container timeline (0 is the container start, as in players and ffmpeg -ss); probe start/end
give the selected video stream's span on it, which may begin after 0. --start/--end are clamped to that span;
--at and --around must fall inside it. A time between frames shows the next frame, or the last one at the end.
--start/--end cannot combine with --around/--window.
--crop takes fractions 0-1 of the displayed frame (left, top, width, height) and cuts
that region at source resolution before --width scaling. Output is capped at the displayed width
(square pixels: SAR applied to the coded horizontal axis, then rotated).
--window is the total duration centered on --around. Options also accept --key=value.
--video-stream N selects the zero-based video stream (0:v:N), default 0, on every command.
Writes JPEG frames and manifest.json; overview, inspect and changes also write
timecode-labeled sheet-NN.jpg. Output defaults to .agvid/runs/ under the git root (else cwd);
--output DIR must be new or empty. probe with several videos prints an array, with
{video,error} entries for failures, and exits 1 if any failed.
FFmpeg and FFprobe must be available on PATH.`;

const OPTIONS = {
  overview: new Set(['frames', 'start', 'end', 'crop', 'width', 'output', 'video-stream']),
  inspect: new Set(['around', 'window', 'fps', 'start', 'end', 'crop', 'width', 'output', 'video-stream']),
  frame: new Set(['at', 'crop', 'width', 'output', 'video-stream']),
  changes: new Set(['start', 'end', 'crop', 'threshold', 'min-gap', 'max', 'analysis-fps', 'analysis-width', 'width', 'output', 'video-stream']),
  probe: new Set(['video-stream']),
};

const MULTI = new Set(['at', 'around']);
// Internal demuxer metadata controls seeking; symbol keys stay out of probe JSON and manifests.
const SOURCE_FORMAT = Symbol('sourceFormat');

export function parseTime(value) {
  const parts = String(value).replace(/s$/, '').split(':');
  const clockFields = parts.length === 2 ? parts : parts.slice(1);
  if (parts.length > 3 || parts.some((part, i) => !(i === parts.length - 1 ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(part))
    || clockFields.some((part) => Number(part) >= 60)) {
    throw new Error(`invalid time: ${value}`);
  }
  const seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  if (!Number.isFinite(seconds)) throw new Error(`invalid time: ${value}`);
  return seconds;
}

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

function videoStreamOption(value) {
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('--video-stream must be a non-negative integer');
  }
  return Number(value);
}

// Resolves optional --start/--end to { start, end } seconds within the video's span on the container timeline.
export function resolveRange(options, info) {
  const start = options.start === undefined ? info.start : Math.max(info.start, parseTime(options.start));
  const end = options.end === undefined ? info.end : Math.min(info.end, parseTime(options.end));
  if (start >= info.end) throw new Error(`--start ${formatTimecode(start)} must be before the video ends`);
  if (start >= end) throw new Error(`--start ${formatTimecode(start)} must be before --end ${formatTimecode(end)}`);
  return { start, end };
}

// Parses --crop fractions and maps them to even pixel offsets and sizes in the source's displayed orientation.
// FFmpeg auto-rotates before -vf. SAR stretches one displayed axis uniformly, so equal fractions of stored pixels
// still name the displayed region; `displayed` is that region's size in square pixels (see displayedSize).
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
  return { x, y, w, h, pixels: { x: px, y: py, width, height, displayed: displayedSize(width, height, info) } };
}

// Square-pixel size of width x height stored pixels in displayed orientation. SAR scales the coded horizontal axis,
// keeping the other at stored resolution; after a 90/270 turn that axis is displayed vertically. info.sar is
// rotation-adjusted (inverted on a turn, as FFmpeg's transpose does), so dividing by it applies the coded SAR.
export function displayedSize(width, height, info) {
  const sar = info.sar ?? 1;
  return info.rotation === 90 || info.rotation === 270
    ? { width, height: Math.max(2, Math.round(height / sar)) }
    : { width: Math.max(2, Math.round(width * sar)), height };
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

async function probe(video, videoStream) {
  // Keep the full listing for audio presence and the container index of the selected video stream.
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time,format_name:stream=index,codec_type,width,height,avg_frame_rate,codec_name,start_pts,start_time,time_base,duration_ts,duration,nb_frames,pix_fmt,bits_per_raw_sample,sample_aspect_ratio:stream_side_data=rotation:stream_tags=DURATION,rotate', '-of', 'json', video]);
  const { streams = [], format = {} } = JSON.parse(raw);
  const videoStreams = streams.filter((entry) => entry.codec_type === 'video');
  const stream = videoStreams[videoStream];
  if (!stream) throw new Error(`video stream ${videoStream} not found (${videoStreams.length} video streams)`);
  const valid = (value) => Number.isFinite(value) && value > 0;
  // FFmpeg seeks relative to the container's microsecond start time. Stream timestamps need their integer
  // ticks: rounded start_time can fall after the actual first (and possibly only) frame.
  const micros = (value) => (/^-?\d+(?:\.\d+)?$/.test(value ?? '') ? Math.round(Number(value) * 1e6) : NaN);
  const containerMicros = Number.isFinite(micros(format.start_time)) ? micros(format.start_time) : 0;
  const streamMicros = micros(stream.start_time);
  const [timeNum, timeDen] = String(stream.time_base ?? '').split('/').map(Number);
  const ticksToSeconds = (ticks) => Number.isSafeInteger(ticks) && Number.isSafeInteger(timeNum) && timeNum > 0
    && Number.isSafeInteger(timeDen) && timeDen > 0
    ? ticks * timeNum / timeDen : NaN;
  const exactStart = ticksToSeconds(stream.start_pts);
  let streamStart = Number.isFinite(exactStart) ? exactStart
    : Number.isFinite(streamMicros) ? streamMicros / 1e6 : containerMicros / 1e6;
  let duration = ticksToSeconds(stream.duration_ts);
  if (!valid(duration)) duration = Number(stream.duration);
  let durationSource = 'stream';
  // FFmpeg's Matroska muxer writes DURATION as the endpoint on the raw stream timeline, including any start offset.
  if (!valid(duration) && stream.tags?.DURATION) {
    durationSource = 'tag';
    try { duration = parseTime(stream.tags.DURATION) - streamStart; }
    catch { duration = NaN; }
  }
  if (!valid(duration)) {
    durationSource = 'packets';
    const packets = await packetSpan(video, videoStream, ticksToSeconds);
    duration = packets.end - packets.start;
    if (Number.isFinite(packets.start)) streamStart = packets.start;
  }
  if (!valid(duration)) {
    throw new Error(`video stream ${videoStream} has no duration metadata; provide a video with a known video-stream duration`);
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
  const relativeStart = streamStart - containerMicros / 1e6;
  // Clipping a first PTS just before the rounded container origin to zero must not extend the stream's end.
  return { [SOURCE_FORMAT]: format.format_name ?? '', video, videoStream, streamIndex: stream.index, start: Math.max(0, relativeStart), end: relativeStart + duration, duration,
    containerStart: containerMicros / 1e6, width: swap ? stream.height : stream.width, height: swap ? stream.width : stream.height,
    sar, rotation, codedWidth: stream.width, codedHeight: stream.height, fps, frameRate: stream.avg_frame_rate ?? null,
    frameCount, frameCountEstimated, codec: stream.codec_name, pixelFormat: stream.pix_fmt ?? null,
    bitDepth: Number.isInteger(bitDepth) && bitDepth > 0 ? bitDepth : null,
    hasAudio: streams.some((entry) => entry.codec_type === 'audio'), durationSource };
}

// Runs ffprobe and passes each stdout line to `consume` as it arrives, so packet listings are never held whole.
function ffprobeLines(args, consume) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) consume(line);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`ffprobe: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${stderr.trim()}`));
      consume(pending);
      resolve();
    });
  });
}

async function packetSpan(video, videoStream, ticksToSeconds) {
  let start = Infinity;
  let end = -Infinity;
  await ffprobeLines(['-v', 'error', '-select_streams', `v:${videoStream}`, '-show_entries', 'packet=pts,duration,pts_time,duration_time', '-of', 'compact', video], (line) => {
    if (!line.startsWith('packet|')) return;
    const fields = Object.fromEntries(line.trim().split('|').slice(1).map((field) => field.split('=')));
    const seconds = (ticks, time) => {
      const exact = ticksToSeconds(Number(ticks));
      return Number.isFinite(exact) ? exact : /^-?\d+(?:\.\d+)?$/.test(time ?? '') ? Number(time) : NaN;
    };
    const pts = seconds(fields.pts, fields.pts_time);
    const length = seconds(fields.duration, fields.duration_time);
    if (!Number.isFinite(pts) || !Number.isFinite(length)) return;
    start = Math.min(start, pts);
    end = Math.max(end, pts + length);
  });
  return { start, end };
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

async function extract(video, info, time, width, filename, crop) {
  const cut = crop ? `crop=${crop.pixels.width}:${crop.pixels.height}:${crop.pixels.x}:${crop.pixels.y},` : '';
  let emptyError;
  // MPEG-TS input seeking can silently skip a GOP, so it always needs decoding from the origin.
  const originDecode = info[SOURCE_FORMAT].split(',').includes('mpegts');
  for (const slow of originDecode ? [true] : [false, true]) {
    // Other demuxers can seek past the initial keyframe's DTS. Retry from the origin if that produced no frame.
    const input = slow ? ['-i', video, '-ss', String(time)] : ['-ss', String(time), '-i', video];
    try {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...input, '-map', `0:v:${info.videoStream}`, '-frames:v', '1', '-vf', `${cut}scale=${width}:max(2\\,round(${width}/dar/2)*2),setsar=1`, '-threads:v', '1', '-q:v', '4', '-y', filename]);
    } catch (error) {
      // FFmpeg 8 can fail to initialize MJPEG at EOF when seeking yielded no decoded frame.
      if (await nonempty(filename) || !/Non full-range YUV[\s\S]*Could not open encoder before EOF/.test(error.message)) throw error;
      error.emptyFrame = true;
      emptyError ??= error;
    }
    if (await nonempty(filename)) return;
  }
  if (emptyError) throw emptyError;
}

// Time of the last video frame, from the largest packet pts in the file. Scan without seeking:
// a demuxer can seek past a later-PTS packet that precedes the final B-frame in decode order.
// Resolves NaN when ffprobe reports no usable pts or time base.
async function lastFrameTime(info) {
  let last = -Infinity;
  let timeBase;
  await ffprobeLines(['-v', 'error', '-select_streams', `v:${info.videoStream}`,
    '-show_entries', 'packet=pts:stream=time_base', '-of', 'compact', info.video], (line) => {
    const pts = /^packet\|pts=(-?\d+)(?:\||$)/.exec(line.trim());
    if (pts && Number.isSafeInteger(Number(pts[1]))) last = Math.max(last, Number(pts[1]));
    timeBase = /^stream\|time_base=([1-9]\d*)\/([1-9]\d*)$/.exec(line.trim())?.slice(1).map(Number) ?? timeBase;
  });
  // The rounded container origin can be a fraction of a microsecond after this PTS; timeline zero still shows it.
  return Number.isFinite(last) && timeBase ? Math.max(0, last * timeBase[0] / timeBase[1] - info.containerStart) : NaN;
}

const ANALYSIS_FPS = 30;
const ANALYSIS_WIDTH = 256;
const PIXEL_DELTA = 16;

// One decode pass over the range: RGB source frames thinned to at most analysisFps/s (select keeps source pts;
// no fps resampling), each scored as the share of pixels with any channel differing by more than 16/255 from the last reported frame
// (initially the first decoded one, at the range start). -copyts keeps source pts; times come from showinfo's integer
// pts and time base, since its pts_time can be rounded (%.6g in FFmpeg 5.1). Passing such a time to -ss selects that frame:
// FFmpeg truncates -ss to microseconds, at or before the pts, then rounds it to the nearest tick of the stream time base.
// Streams rawvideo; keeps only the reference frame and frames still waiting for their pts line.
// changes uses -fps_mode (FFmpeg 5.1+). Unparseable versions, such as git builds, are let through.
async function requireFfmpeg51() {
  const first = (await run('ffmpeg', ['-version'])).split('\n')[0];
  const match = /^ffmpeg version n?(\d+)\.(\d+)/.exec(first);
  if (match && (Number(match[1]) < 5 || (Number(match[1]) === 5 && Number(match[2]) < 1))) {
    throw new Error(`changes needs FFmpeg 5.1 or newer, found ${match[1]}.${match[2]}; upgrade FFmpeg or use overview/inspect instead`);
  }
}

function detectChanges(video, info, range, crop, settings, slow = info[SOURCE_FORMAT].split(',').includes('mpegts')) {
  const { threshold, minGap, max, analysisFps, analysisWidth } = settings;
  const sourceWidth = crop?.pixels.width ?? info.width;
  const sourceHeight = crop?.pixels.height ?? info.height;
  const height = Math.max(2, Math.round(analysisWidth * sourceHeight / sourceWidth / 2) * 2);
  const pixels = analysisWidth * height;
  const size = pixels * 3;
  const cut = crop ? `crop=${crop.pixels.width}:${crop.pixels.height}:${crop.pixels.x}:${crop.pixels.y},` : '';
  const seek = slow ? [] : ['-ss', String(range.start)];
  // With copyts, trimming must use absolute source PTS and precede select/showinfo to keep frame/time pairing intact.
  const trim = slow ? `trim=start=${range.start + info.containerStart}:end=${range.end + info.containerStart},` : '';
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', '-copyts', ...seek, '-to', String(range.end), '-i', video,
    '-map', `0:v:${info.videoStream}`, '-vf', `${trim}${cut}select='isnan(prev_selected_t)+gte(t-prev_selected_t,${1 / analysisFps - 1e-6})',scale=${analysisWidth}:${height},format=rgb24,showinfo`,
    '-fps_mode', 'passthrough', '-threads:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pendingFrames = [];
    const pendingTimes = [];
    const events = [];
    let candidates = 0;
    const errors = [];
    let decoded = 0;
    let failed;
    let reference;
    let lastReport = range.start;
    let timeBase;
    let partial = Buffer.alloc(size);
    let filled = 0;
    let line = '';
    const score = (frame) => {
      let changed = 0;
      for (let i = 0; i < size; i += 3) {
        if (Math.abs(frame[i] - reference[i]) > PIXEL_DELTA ||
            Math.abs(frame[i + 1] - reference[i + 1]) > PIXEL_DELTA ||
            Math.abs(frame[i + 2] - reference[i + 2]) > PIXEL_DELTA) changed++;
      }
      return changed / pixels;
    };
    const drain = () => {
      while (pendingFrames.length && pendingTimes.length) {
        const frame = pendingFrames.shift();
        const time = pendingTimes.shift();
        decoded++;
        if (!reference) { reference = frame; continue; }
        if (!(time > range.start && time < range.end) || time - lastReport < minGap - 1e-9) continue;
        const value = score(frame);
        if (value > threshold) {
          const event = { time, score: Math.round(value * 1e6) / 1e6 };
          candidates++;
          // Keep the highest scores, then the earliest times on ties.
          const index = events.findIndex((kept) => kept.score < event.score || (kept.score === event.score && kept.time > event.time));
          if (index >= 0) events.splice(index, 0, event);
          else if (events.length < max) events.push(event);
          if (events.length > max) events.pop();
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
          const base = /\bconfig in time_base:\s*(\d+)\/(\d+)/.exec(text);
          if (base) timeBase = [Number(base[1]), Number(base[2])];
          const match = /\bn:\s*\d+\s+pts:\s*(-?\d+)\s/.exec(text);
          if (match && !timeBase && !failed) {
            failed = new Error('ffmpeg showinfo logged no time base');
            child.kill();
          }
          if (match && timeBase) pendingTimes.push(Number(match[1]) * timeBase[0] / timeBase[1] - info.containerStart);
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
      if (!decoded && !slow) return resolve(detectChanges(video, info, range, crop, settings, true));
      // A valid sparse range may contain no new PTS. Baseline extraction still validates its displayed frame.
      resolve({ events, candidates });
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
  const videoStream = videoStreamOption(options['video-stream'] ?? '0');
  if (command === 'probe') {
    if (videos.length === 1) {
      console.log(JSON.stringify(await probe(videos[0], videoStream), null, 2));
      return;
    }
    const results = await pool(videos, Math.min(os.availableParallelism(), 8),
      (file) => probe(file, videoStream).catch((error) => ({ video: file, error: error.message })));
    if (results.some((entry) => 'error' in entry)) process.exitCode = 1;
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  const info = await probe(video, videoStream);
  const crop = options.crop === undefined ? undefined : parseCrop(options.crop, info);
  // Cap at the displayed width so square-pixel output is never larger than the displayed frame or crop.
  const displayedWidth = (crop?.pixels.displayed ?? displayedSize(info.width, info.height, info)).width;
  const width = Math.min(displayedWidth, numberOption(options.width ?? 640, 'width', 64, 4096, true));
  let times;
  let windows;
  let range;
  let scores;
  let detection;
  if (command === 'overview') {
    const count = numberOption(options.frames ?? 12, 'frames', 1, 64, true);
    const { start, end } = range = resolveRange(options, info);
    times = Array.from({ length: count }, (_, i) => start + (end - start) * (i + 0.5) / count);
  } else if (command === 'inspect') {
    const ranged = options.start !== undefined || options.end !== undefined;
    if (ranged && (options.around !== undefined || options.window !== undefined)) throw new Error('--start/--end cannot be combined with --around/--window');
    if (!ranged && options.around === undefined) throw new Error('inspect requires --around or --start/--end');
    const fps = numberOption(options.fps ?? 4, 'fps', 0.1, 60);
    let spans;
    if (ranged) spans = [{ around: null, ...resolveRange(options, info) }];
    else {
      const arounds = [...new Set(options.around.map(parseTime))].sort((a, b) => a - b);
      const window = numberOption(parseTime(options.window ?? '2s'), 'window', 0.001, 3600);
      spans = arounds.map((around) => {
        if (around > info.end) throw new Error(`--around ${formatTimecode(around)} is beyond the video end ${formatTimecode(info.end)}`);
        if (around < info.start) throw new Error(`--around ${formatTimecode(around)} is before the video starts at ${formatTimecode(info.start)}`);
        return { around, start: Math.max(info.start, around - window / 2), end: Math.min(info.end, around + window / 2) };
      });
    }
    times = [];
    windows = [];
    for (const { around, start, end } of spans) {
      const count = Math.ceil((end - start) * fps);
      if (count < 1) throw new Error('inspect window contains no frames');
      if (times.length + count > 240) throw new Error('inspect would create over 240 frames; reduce --window, --fps or --around values');
      const first = times.length;
      for (let i = 0; i < count; i++) {
        const segmentStart = start + i / fps;
        times.push(segmentStart + Math.min(0.5 / fps, (end - segmentStart) / 2));
      }
      windows.push({ around, start, end, frames: [first, times.length - 1] });
    }
  } else if (command === 'changes') {
    const threshold = Number(options.threshold ?? 0.002);
    if (!(threshold > 0 && threshold <= 1)) throw new Error('--threshold must be a fraction above 0 and at most 1');
    const minGap = numberOption(parseTime(options['min-gap'] ?? '0.5'), 'min-gap', 0, 3600);
    // One of the 240 frames is the range-start baseline.
    const max = numberOption(options.max ?? 48, 'max', 1, 239, true);
    const analysisFps = numberOption(options['analysis-fps'] ?? ANALYSIS_FPS, 'analysis-fps', 1, 60);
    const analysisWidth = numberOption(options['analysis-width'] ?? ANALYSIS_WIDTH, 'analysis-width', 64, 512, true);
    range = resolveRange(options, info);
    await requireFfmpeg51();
    const { events, candidates } = await detectChanges(video, info, range, crop, { threshold, minGap, max, analysisFps, analysisWidth });
    const truncated = candidates > max;
    const kept = events.sort((a, b) => a.time - b.time);
    times = [range.start, ...kept.map((event) => event.time)];
    scores = [null, ...kept.map((event) => event.score)];
    detection = { metric: `RGB any-channel-diff>${PIXEL_DELTA}@${analysisWidth}px,${analysisFps}fps vs last detected candidate`, threshold, minGap, candidates, truncated };
  } else {
    if (options.at === undefined) throw new Error('frame requires --at');
    times = [...new Set(options.at.map((value) => {
      const time = parseTime(value);
      if (time >= info.end) throw new Error(`--at ${value} must be before the video ends at ${formatTimecode(info.end)}`);
      if (time < info.start) throw new Error(`--at ${value} is before the video starts at ${formatTimecode(info.start)}`);
      return time;
    }))].sort((a, b) => a - b);
    if (times.length > 240) throw new Error('frame would create over 240 frames; reduce --at values');
  }
  const { directory, created, firstParent } = await outputDirectory(video, command, options.output);
  const frames = [];
  const produced = [];
  // Shared by every position that finds no frame, including concurrent ones.
  let lastFrame;
  const extractFrame = async (time, i) => {
    const timecode = formatTimecode(time);
    const filename = `frame-${String(i).padStart(4, '0')}_${timecode.replaceAll(':', '-')}.jpg`;
    const target = path.join(directory, filename);
    produced.push(target);
    let extractionError;
    try { await extract(video, info, time, width, target, crop); }
    catch (error) { if (!error.emptyFrame) throw error; extractionError = error; }
    if (extractionError && await nonempty(target)) throw extractionError;
    if (!(await nonempty(target))) {
      // No frame at or after `time`: if it is in the last frame's display interval (such as a sparse VFR tail), take that frame.
      const last = await (lastFrame ??= lastFrameTime(info).catch(() => NaN));
      if (Number.isFinite(last) && last >= info.start && last < time) await extract(video, info, last, width, target, crop);
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
    const manifest = await saveManifest(directory, { command, source: info, outputWidth: width, ...(crop ? { crop } : {}), ...(range && (options.start !== undefined || options.end !== undefined) ? { range } : {}), ...(detection ? { detection } : {}), frames, ...(windows ? { windows } : {}), ...(sheets ? { sheets } : {}) });
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
