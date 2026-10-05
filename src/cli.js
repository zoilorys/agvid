import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
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
up to 30 fps at 256px wide by default, at most 512x512 pixels in area). --analysis-fps (1-60) and --analysis-width (64-512)
tune detection cost and sensitivity. Use --start/--end on long videos. Needs FFmpeg 5.1+. --crop limits detection
to the region; use it for small UI changes.
TIME accepts seconds, MM:SS.s, or HH:MM:SS.s; clock minute and second fields must be below 60.
DURATION accepts seconds, with optional s suffix. Manifest times keep sub-millisecond precision;
filenames and sheet labels round to milliseconds.
Times are on the container timeline (0 is the container start, as in players and ffmpeg -ss); probe start/end
give the selected video stream's span on it, which may begin after 0. --start/--end are clamped to that span;
--at and --around must fall inside it. A time shows the frame on screen then: the last one at or before it.
--start/--end cannot combine with --around/--window.
--crop takes fractions 0-1 of the displayed frame (left, top, width, height) and cuts
that region at source resolution before --width scaling. Output is capped at the displayed width
(square pixels: SAR applied to the coded horizontal axis, then rotated).
--window is the total duration centered on --around. Options also accept --key=value.
--video-stream N selects the zero-based video stream (0:v:N), default 0, on every command.
Writes JPEG frames and manifest.json; overview, inspect and changes also write
timecode-labeled sheet-NN.jpg. Output defaults to .agvid/runs/ under the git root (else cwd);
--output DIR must be new or empty; a run holds DIR/.agvid.lock until it ends, so a concurrent run on DIR fails
(a killed run's lock is replaced).
SIGINT/SIGTERM stop FFmpeg and remove the incomplete run's files. Raw elementary streams (no timestamps) are rejected.
probe with several videos prints an array, with
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
const TICK = Symbol('tick');

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

// Running children and the signal that cancelled this run, if any. Cancellation kills every child and makes new
// spawns fail, so a run settles its jobs and cleans up instead of leaving FFmpeg writing into its output.
const children = new Set();
let cancelled;

function cancellationError() {
  return Object.assign(new Error(`cancelled by ${cancelled}`), { exitCode: 128 + (os.constants.signals[cancelled] ?? 0) });
}

function cancel(signal) {
  if (cancelled) return;
  cancelled = signal;
  for (const child of children) child.kill('SIGTERM');
}

function start(program, args) {
  if (cancelled) throw cancellationError();
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.on('close', () => children.delete(child));
  child.on('error', () => children.delete(child));
  return child;
}

function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = start(program, args);
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
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time,duration,format_name:stream=index,codec_type,width,height,avg_frame_rate,codec_name,start_pts,start_time,time_base,duration_ts,duration,nb_frames,pix_fmt,bits_per_raw_sample,sample_aspect_ratio:stream_side_data=rotation:stream_tags=DURATION,rotate', '-of', 'json', video]);
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
  let untimed = false;
  // FFmpeg's Matroska muxer writes DURATION as the endpoint on the raw stream timeline, including any start offset.
  if (!valid(duration) && stream.tags?.DURATION) {
    durationSource = 'tag';
    try { duration = parseTime(stream.tags.DURATION) - streamStart; }
    catch { duration = NaN; }
  }
  // FFmpeg estimates MPEG-PS/TS durations from timestamps near the end of the file, which can stop short of the
  // last frames (stream and container alike), so those spans come from the packets. Other formats keep their metadata.
  const estimated = (format.format_name ?? '').split(',').some((name) => name === 'mpeg' || name === 'mpegts');
  if (!valid(duration) || estimated) {
    // The first pts comes from the head; the end from the tail past the container's estimated end.
    const [head, packets] = await Promise.all([packetSpan(video, videoStream, '%+#32'),
      tailPackets(video, videoStream, containerMicros / 1e6 + Number(format.duration))]);
    let { end } = packets;
    // With no pts at all (raw elementary streams) the timeline is synthetic: the span stays unknown.
    untimed = !Number.isFinite(head.start);
    if (!untimed && !packets.exact) {
      // Packets without pts only bound the end from below; decode the tail for the frames' actual times.
      const tail = await decodedTail(video, videoStream, packets.last - containerMicros / 1e6 - 1, packets.lastDuration);
      if (tail.end > end || !Number.isFinite(end)) end = tail.end;
    }
    if (valid(end - head.start)) {
      durationSource = 'packets';
      duration = end - head.start;
      streamStart = head.start;
    }
  }
  if (!valid(duration) && untimed) {
    throw new Error(`video stream ${videoStream} has no timestamps (a raw elementary stream?); re-encode it into a container first, e.g. ffmpeg -r FPS -i VIDEO out.mp4`);
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
  return { [SOURCE_FORMAT]: format.format_name ?? '', [TICK]: ticksToSeconds(1), video, videoStream, streamIndex: stream.index, start: Math.max(0, relativeStart), end: relativeStart + duration, duration,
    containerStart: containerMicros / 1e6, width: swap ? stream.height : stream.width, height: swap ? stream.width : stream.height,
    sar, rotation, codedWidth: stream.width, codedHeight: stream.height, fps, frameRate: stream.avg_frame_rate ?? null,
    frameCount, frameCountEstimated, codec: stream.codec_name, pixelFormat: stream.pix_fmt ?? null,
    bitDepth: Number.isInteger(bitDepth) && bitDepth > 0 ? bitDepth : null,
    hasAudio: streams.some((entry) => entry.codec_type === 'audio'), durationSource };
}

// Runs a program and passes each line of its `from` output ('stdout' or 'stderr') to `consume` as it arrives,
// so packet and frame listings are never held whole.
function lines(program, args, from, consume) {
  return new Promise((resolve, reject) => {
    const child = start(program, args);
    const pending = { stdout: '', stderr: '' };
    // The last stderr lines, for the error message.
    const errors = [];
    const read = (stream, line) => {
      if (stream === from) consume(line);
      if (stream === 'stderr' && line.trim() && errors.push(line.trim()) > 20) errors.shift();
    };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        const parts = (pending[stream] + chunk).split('\n');
        pending[stream] = parts.pop();
        for (const line of parts) read(stream, line);
      });
    }
    child.on('error', (error) => reject(new Error(`${program}: ${error.message}`)));
    child.on('close', (code) => {
      read('stdout', pending.stdout);
      read('stderr', pending.stderr);
      if (code !== 0) return reject(new Error(`${program} exited ${code}: ${errors.join('\n')}`));
      resolve();
    });
  });
}

// Demux-only scan of the video packets, in seconds on the stream timeline: first pts, display end, last
// presentation time and that packet's duration. A packet without pts (reordered frames in AVI or MPEG-PS) counts at
// its dts, which is never after its pts, so `exact` turns false and `end`/`last` become lower bounds. `interval` is an
// ffprobe -read_intervals value; `keyframe` tells whether a timed keyframe packet was read.
async function packetSpan(video, videoStream, interval) {
  let first = Infinity;
  let last = -Infinity;
  let end = -Infinity;
  let lastLength = NaN;
  let exact = true;
  let keyframe = false;
  let timeBase;
  await lines('ffprobe', ['-v', 'error', '-select_streams', `v:${videoStream}`, ...(interval ? ['-read_intervals', interval] : []),
    '-show_entries', 'packet=pts,dts,duration,flags:stream=time_base', '-of', 'compact', video], 'stdout', (line) => {
    timeBase = /^stream\|time_base=([1-9]\d*)\/([1-9]\d*)\|?$/.exec(line.trim())?.slice(1).map(Number) ?? timeBase;
    if (!line.startsWith('packet|')) return;
    const fields = Object.fromEntries(line.trim().split('|').slice(1).map((field) => field.split('=')));
    const ticks = (value) => (/^-?\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : NaN);
    const pts = ticks(fields.pts);
    const time = Number.isFinite(pts) ? pts : ticks(fields.dts);
    if (!Number.isFinite(time)) return;
    if (Number.isFinite(pts)) first = Math.min(first, pts);
    else exact = false;
    if (fields.flags?.startsWith('K')) keyframe = true;
    const length = ticks(fields.duration);
    if (time > last) { last = time; lastLength = length; }
    if (Number.isFinite(length)) end = Math.max(end, time + length);
  });
  const seconds = (value) => (timeBase && Number.isFinite(value) ? value * timeBase[0] / timeBase[1] : NaN);
  return { start: seconds(first), end: seconds(end), last: seconds(last), lastDuration: seconds(lastLength), exact, keyframe };
}

// Packets from TAIL_SCAN seconds before `rawEnd` (the expected end on the raw container timeline) to EOF bound the end
// of the stream in time proportional to that tail. The frame shown last is decoded after the last keyframe, so a tail
// holding a keyframe holds it too. Otherwise (the end was overestimated, or a GOP is longer) the whole file is scanned.
const TAIL_SCAN = 30;

async function tailPackets(video, videoStream, rawEnd) {
  if (Number.isFinite(rawEnd)) {
    const tail = await packetSpan(video, videoStream, `${rawEnd - TAIL_SCAN}%`);
    if (tail.keyframe) return tail;
  }
  return packetSpan(video, videoStream);
}

// Decodes from `from` (container timeline seconds) to the end and returns the last decoded frame's presentation
// time and display end, in seconds on the stream timeline: the timestamps FFmpeg extraction itself selects by.
// NaN when nothing decodes. Frames without a showinfo duration (older FFmpeg) last `frameDuration` seconds.
async function decodedTail(video, videoStream, from, frameDuration) {
  const scan = async (seek) => {
    let timeBase;
    let last = -Infinity;
    let end = -Infinity;
    await lines('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'info', '-copyts', ...(seek ? ['-ss', String(from)] : []),
      '-i', video, '-map', `0:v:${videoStream}`, '-vf', 'showinfo', '-f', 'null', '-'], 'stderr', (line) => {
      if (!/Parsed_showinfo/.test(line)) return;
      timeBase = /\bconfig in time_base:\s*(\d+)\/(\d+)/.exec(line)?.slice(1).map(Number) ?? timeBase;
      const frame = /\bn:\s*\d+\s+pts:\s*(-?\d+)\s(?:.*?\bduration:\s*(\d+)\s)?/.exec(line);
      if (!frame || !timeBase?.[1]) return;
      const pts = Number(frame[1]) * timeBase[0] / timeBase[1];
      const length = frame[2] === undefined ? frameDuration : Number(frame[2]) * timeBase[0] / timeBase[1];
      last = Math.max(last, pts);
      end = Math.max(end, pts + (Number.isFinite(length) ? length : 0));
    });
    return { last, end };
  };
  // A seek can land past the last frame (MPEG-TS can skip a GOP); then decode the whole stream.
  let tail = from >= ORIGIN_MARGIN ? await scan(true) : { last: -Infinity };
  if (!Number.isFinite(tail.last)) tail = await scan(false);
  const finite = (value) => (Number.isFinite(value) ? value : NaN);
  return { last: finite(tail.last), end: finite(tail.end) };
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

const LOCK = '.agvid.lock';

// Claims `directory` for this run with an exclusively created lock file holding its pid and host. An emptiness check
// alone lets two runs share an existing empty directory; whichever creates the lock first owns it. A lock left by a
// killed run on this host is replaced under a LOCK.reclaim directory containing a unique owner file. Recovery can
// unlink a dead owner's specific file, but rmdir cannot remove a directory containing a live owner's file. A stale
// lock's owner is gone and other runs need the guard to remove it, so the lock read as stale is still the one removed.
// A lock found missing is never removed: a run that does not take the guard may have created it since.
async function claim(directory) {
  const lock = path.join(directory, LOCK);
  const guard = `${lock}.reclaim`;
  const owner = `${process.pid}\n${os.hostname()}\n`;
  const create = (file) => publish(file, owner, `${lock}.${randomUUID()}`);
  if (await create(lock)) {
    await recoverGuard(guard).catch(() => {});
    return lock;
  }
  const releaseGuard = await acquireGuard(guard, owner) || (await recoverGuard(guard) && await acquireGuard(guard, owner));
  if (releaseGuard) {
    try {
      const { state } = await readOwner(lock);
      if (state === 'stale') await rm(lock, { force: true });
      if (state !== 'held' && await create(lock)) return lock;
    } finally { await releaseGuard(); }
  }
  throw Object.assign(new Error(`output directory is in use by another agvid run: ${directory} (delete ${LOCK} if no run is active)`), { inUse: true });
}

// Creates `file` holding `content` unless it exists. The content is written to `staging` first and hard-linked into
// place, so `file` never appears empty: a run stalled before writing cannot have its lock mistaken for a killed run's
// and replaced, then carry on alongside the replacement. Filesystems without hard links (exFAT, FAT) intentionally fall
// back to exclusive creation: there a run stalled over a minute between creating and writing its lock can still be
// displaced. That needs an unusual stall, and failing such filesystems outright would be worse.
async function publish(file, content, staging) {
  await writeFile(staging, content, { flag: 'wx' });
  try {
    await link(staging, file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    if (!['EPERM', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
    return writeFile(file, content, { flag: 'wx' }).then(() => true,
      (error) => { if (error.code === 'EEXIST') return false; throw error; });
  } finally { await unlink(staging).catch(() => {}); }
}

// Reads a lock file through one descriptor: its owner's state, 'missing', 'stale' or 'held'.
async function readOwner(file) {
  let handle;
  try { handle = await open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'missing' }; throw error; }
  try {
    const info = await handle.stat();
    return { state: ownerState(await handle.readFile('utf8'), info.mtimeMs) };
  } finally { await handle.close(); }
}

async function acquireGuard(directory, owner) {
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') return undefined; throw error; }
  const token = randomUUID();
  const file = path.join(directory, token);
  const release = async () => {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory).catch((error) => { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; });
  };
  try {
    await publish(file, owner, `${directory}.${token}`);
    // An empty guard may have been recovered and recreated between mkdir and writeFile. Only the sole owner may
    // proceed. Its unique file keeps the directory nonempty until release; later arrivals see it and cannot win.
    const files = await readdir(directory);
    if (files.length === 1 && files[0] === token) return release;
  } catch (error) {
    if (error.code !== 'ENOENT') { await release(); throw error; }
  }
  await release();
}

async function recoverGuard(directory) {
  let info;
  try { info = await stat(directory); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (!info.isDirectory()) {
    // Older releases used a guard file. unlink cannot move or delete a replacement guard directory.
    const { state } = await readOwner(directory).catch((error) => {
      if (error.code === 'EISDIR') return { state: 'held' };
      throw error;
    });
    if (state !== 'stale') return state === 'missing';
    try { await unlink(directory); return true; }
    catch (error) {
      if (error.code === 'ENOENT') return true;
      if (['EISDIR', 'EPERM'].includes(error.code)) return false;
      throw error;
    }
  }
  let files;
  try { files = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  // Allow a creator time to write its owner file. Recovery after that remains safe even if it resumes later.
  if (!files.length && Date.now() - info.mtimeMs < 60000) return false;
  for (const name of files) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(name)) return false;
    const file = path.join(directory, name);
    const { state } = await readOwner(file);
    if (state === 'held') return false;
    // Owner filenames are never reused. A delayed recovery cannot unlink a newer owner's file.
    if (state === 'stale') await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  try { await rmdir(directory); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return true;
    if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
    throw error;
  }
}

// 'stale' when written on this host by a process that no longer exists, else 'held'. Lock files from other hosts
// (shared or container mounts), or unreadable ones, count as held. Only older releases, or filesystems without hard
// links, create a lock before writing its pid, so one still empty after a minute belongs to a run killed in between.
function ownerState(content, modified) {
  if (!content) return Date.now() - modified > 60000 ? 'stale' : 'held';
  const [pid, host] = content.split('\n');
  if (!/^[1-9]\d*$/.test(pid) || host !== os.hostname()) return 'held';
  // This run's own pid can only be a reused pid of a finished run.
  if (Number(pid) === process.pid) return 'stale';
  try { process.kill(Number(pid), 0); return 'held'; }
  catch (error) { return error.code === 'ESRCH' ? 'stale' : 'held'; }
}

const WORK = `${LOCK}.work-`;

// Adds a work directory private to this run, where its FFmpeg writes. FFmpeg survives a SIGKILL of agvid and can keep
// writing after the next run reclaims the lock, so finished files are moved into place only once this run's FFmpeg has
// exited. Work directories left by killed runs are removed; an orphan writing there affects no other run.
async function workspace(output) {
  const { directory } = output;
  const names = await readdir(directory).catch(() => []);
  await Promise.all(names.filter((name) => name.startsWith(WORK))
    .map((name) => rm(path.join(directory, name), { recursive: true, force: true, maxRetries: 3 }).catch(() => {})));
  const work = path.join(directory, `${WORK}${randomUUID()}`);
  try { await mkdir(work); }
  catch (error) { await release(output, []); throw error; }
  return { ...output, work };
}

// Returns the claimed output directory: { directory, lock, work, created, firstParent }.
async function outputDirectory(video, command, requested) {
  if (requested) {
    const directory = path.resolve(requested);
    const firstParent = await mkdir(path.dirname(directory), { recursive: true });
    let created = true;
    try { await mkdir(directory); }
    catch (error) {
      if (error.code !== 'EEXIST') { await removeParents(directory, firstParent); throw error; }
      created = false;
    }
    // A competing run that claimed the directory first owns it, even if this run created it. That run treats it as
    // pre-existing, so if it fails the directory stays, empty; removing it here instead could race with its files.
    const lock = await claim(directory).catch(async (error) => {
      if (created && !error.inUse) await rmdir(directory).then(() => removeParents(directory, firstParent)).catch(() => {});
      throw error;
    });
    if (!created && (await readdir(directory)).some((name) => !name.startsWith(LOCK))) {
      await rm(lock, { force: true });
      throw new Error(`output directory is not empty: ${directory}`);
    }
    return workspace({ directory, lock, created, firstParent: created ? firstParent : undefined });
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
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    return workspace({ directory, lock: await claim(directory), created: true });
  }
}

// Deletes this run's files, then its lock, then the directory and parents it created if nothing else is in them.
async function release({ directory, lock, work, created, firstParent }, produced) {
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  await Promise.all(produced.map((file) => rm(file, { force: true }).catch(() => {})));
  await rm(lock, { force: true }).catch(() => {});
  if (created) await rmdir(directory).then(() => removeParents(directory, firstParent)).catch(() => {});
}

// With B-frame delay, FFmpeg moves an input seek 3/23 s earlier. Near the stream start that target precedes the first
// index entry, and the AVI demuxer then resumes after the keyframe: frames decode without error but corrupt, or not
// at all. MPEG-TS input seeking can silently skip a GOP anywhere. Those positions decode from the origin instead.
const ORIGIN_MARGIN = 0.5;

function seekable(info, time) {
  return !info[SOURCE_FORMAT].split(',').includes('mpegts') && time >= info.start + ORIGIN_MARGIN;
}

// A time shows the frame on screen then: the last one whose pts is at most that time. The tolerance absorbs only float
// rounding between container-timeline seconds and source pts (about 1e-11 s at a day's timeline), far below a tick
// of any stream time base (1/90000 s for MPEG), so no later frame counts as already shown.
const TIME_TOLERANCE = 1e-9;
// Frames before a time are first kept (scaled, encoded or piped) only from this long before it; a time with no frame
// there (sparse VFR) retries with every earlier frame.
const RECENT = 0.5;

// Decode attempts for the frame on screen at `time`: input seeking where it is reliable, then from the origin.
// Other demuxers can seek past the initial keyframe's DTS, so an attempt that finds no frame falls through.
function attempts(info, time) {
  return [...(seekable(info, time) ? [false] : []), true].flatMap((slow) => [{ slow, window: RECENT }, { slow, window: Infinity }]);
}

// Seeks with -noaccurate_seek and -copyts so decoding starts at the keyframe before `time` on source pts. Output -ss
// would count from the stream's own rebased start in MPEG-PS/TS (wrong for a delayed video stream).
function seekArgs(slow, time) {
  return slow ? ['-copyts'] : ['-noaccurate_seek', '-copyts', '-ss', String(time)];
}

// Ends decoding just past `end` (source seconds). trim rounds to the nearest tick, so it ends a tick late; callers
// cut at the exact time themselves.
function trimEnd(info, end) {
  return `trim=end=${end + (Number.isFinite(info[TICK]) ? info[TICK] : 0.1) + TIME_TOLERANCE}`;
}

async function extract(video, info, time, width, filename, crop) {
  const cut = crop ? `crop=${crop.pixels.width}:${crop.pixels.height}:${crop.pixels.x}:${crop.pixels.y},` : '';
  const target = time + info.containerStart + TIME_TOLERANCE;
  let emptyError;
  // A time before the first decoded frame (AVI rebuilds pts from dts, delaying it) shows that first frame.
  for (const { slow, window } of [...attempts(info, time), { slow: true, window: 0 }]) {
    const select = window === 0 ? '' : `${trimEnd(info, target)},select='${Number.isFinite(window) ? `between(t,${target - window},${target})` : `lte(t,${target})`}',`;
    try {
      // image2 -update rewrites the file per kept frame, leaving the last one at or before `time`.
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...seekArgs(slow, time), '-i', video, '-map', `0:v:${info.videoStream}`, ...(window === 0 ? ['-frames:v', '1'] : []), '-vf', `${select}${cut}scale=${width}:max(2\\,round(${width}/dar/2)*2),setsar=1`, '-update', '1', '-threads:v', '1', '-q:v', '4', '-y', filename]);
    } catch (error) {
      // FFmpeg 8 can fail to initialize MJPEG at EOF when seeking yielded no decoded frame.
      if (await nonempty(filename) || !/Non full-range YUV[\s\S]*Could not open encoder before EOF/.test(error.message)) throw error;
      emptyError ??= error;
    }
    if (await nonempty(filename)) return;
  }
  if (emptyError) throw emptyError;
}

const ANALYSIS_FPS = 30;
const ANALYSIS_WIDTH = 256;
const PIXEL_DELTA = 16;
// Bounds one RGB analysis frame to 768 KiB however tall a crop is, and frames queued for their times to about 16 MiB.
const ANALYSIS_PIXELS = 512 * 512;
const PENDING_BYTES = 16 * 1024 * 1024;

// One decode pass over the range: RGB source frames thinned to at most analysisFps/s (select keeps source pts;
// no fps resampling), each scored as the share of pixels with any channel differing by more than 16/255 from the last reported frame
// (initially the one on screen at the range start). -copyts keeps source pts; times come from showinfo's integer
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

// Even analysis size at most `analysisWidth` wide and ANALYSIS_PIXELS in area, keeping the source aspect ratio.
function analysisSize(analysisWidth, sourceWidth, sourceHeight) {
  const aspect = sourceHeight / sourceWidth;
  const width = Math.max(2, Math.min(analysisWidth, Math.floor(Math.sqrt(ANALYSIS_PIXELS / aspect) / 2) * 2));
  const height = Math.max(2, Math.min(Math.round(width * aspect / 2) * 2, Math.floor(ANALYSIS_PIXELS / width / 2) * 2));
  return { width, height };
}

function detectChanges(video, info, range, crop, settings, attempt = 0) {
  const { threshold, minGap, max, analysisFps, analysisWidth } = settings;
  const { width, height } = analysisSize(analysisWidth, crop?.pixels.width ?? info.width, crop?.pixels.height ?? info.height);
  const pixels = width * height;
  const size = pixels * 3;
  // Frames normally wait at most a pipe read for their showinfo time; a longer queue means pairing broke.
  const maxPending = Math.max(8, Math.min(64, Math.floor(PENDING_BYTES / size)));
  const cut = crop ? `crop=${crop.pixels.width}:${crop.pixels.height}:${crop.pixels.x}:${crop.pixels.y},` : '';
  const plan = attempts(info, range.start);
  const { slow, window } = plan[attempt];
  const retry = attempt + 1 < plan.length;
  // The baseline is the frame on screen at the range start, so frames up to it pass (from `window` before it);
  // the last becomes the reference. Later frames are thinned to analysisFps. With copyts, trimming must use absolute
  // source PTS and precede select/showinfo to keep frame/time pairing intact.
  const startPts = range.start + info.containerStart + TIME_TOLERANCE;
  const before = Number.isFinite(window) ? `gte(t,${startPts - window})` : '1';
  const select = `if(lte(t,${startPts}),${before},isnan(prev_selected_t)+gte(t-prev_selected_t,${1 / analysisFps - 1e-6}))`;
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', ...seekArgs(slow, range.start), '-i', video,
    '-map', `0:v:${info.videoStream}`, '-vf', `${trimEnd(info, range.end + info.containerStart)},${cut}select='${select}',scale=${width}:${height},format=rgb24,showinfo`,
    '-fps_mode', 'passthrough', '-threads:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  return new Promise((resolve, reject) => {
    const child = start('ffmpeg', args);
    const pendingFrames = [];
    const pendingTimes = [];
    const events = [];
    let candidates = 0;
    const errors = [];
    // Set when this attempt found no frame at or before the range start; the next attempt replaces it.
    let missed = false;
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
      while (!missed && pendingFrames.length && pendingTimes.length) {
        const frame = pendingFrames.shift();
        const time = pendingTimes.shift();
        if (time <= range.start + TIME_TOLERANCE) { reference = frame; continue; }
        if (!reference) {
          if (retry) { missed = true; child.kill(); return; }
          reference = frame;
          continue;
        }
        if (!(time < range.end) || time - lastReport < minGap - 1e-9) continue;
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
      if (missed) return;
      for (let offset = 0; offset < chunk.length;) {
        const count = Math.min(size - filled, chunk.length - offset);
        chunk.copy(partial, filled, offset, offset + count);
        filled += count;
        offset += count;
        if (filled === size) { pendingFrames.push(partial); partial = Buffer.alloc(size); filled = 0; }
      }
      drain();
      if (pendingFrames.length > maxPending && !failed) {
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
          if (pendingTimes.length > 4096 && !failed) {
            failed = new Error('ffmpeg frame/pts mismatch: showinfo times arrived without frames');
            child.kill();
          }
        } else if (text.trim()) {
          errors.push(text.trim());
          if (errors.length > 20) errors.shift();
        }
      }
      drain();
    });
    child.on('error', (error) => reject(new Error(`ffmpeg: ${error.message}`)));
    child.on('close', (code) => {
      if (missed) return resolve(detectChanges(video, info, range, crop, settings, attempt + 1));
      if (failed) return reject(failed);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${errors.join('\n')}`));
      drain();
      if (missed) return resolve(detectChanges(video, info, range, crop, settings, attempt + 1));
      if (pendingFrames.length || pendingTimes.length || filled) {
        return reject(new Error(`ffmpeg frame/pts mismatch: ${pendingFrames.length} frames and ${pendingTimes.length} times unpaired, ${filled} trailing bytes`));
      }
      if (!reference && retry) return resolve(detectChanges(video, info, range, crop, settings, attempt + 1));
      // A valid sparse range may contain no new PTS. Baseline extraction still validates its displayed frame.
      resolve({ events, candidates, width, height });
    });
  });
}

async function nonempty(filename) {
  try { return (await stat(filename)).size > 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Runs fn over items with bounded concurrency. After the first failure or a cancellation no new job starts;
// it rejects with that error only once every started job has settled.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  const worker = async () => {
    while (!failure && next < items.length) {
      if (cancelled) { failure = { error: cancellationError() }; break; }
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
  const parsed = parseArgs(args);
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try { await execute(parsed); }
  catch (error) { throw cancelled ? cancellationError() : error; }
  finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

async function execute({ command, video, videos, options }) {
  const videoStream = videoStreamOption(options['video-stream'] ?? '0');
  if (command === 'probe') {
    if (videos.length === 1) {
      console.log(JSON.stringify(await probe(videos[0], videoStream), null, 2));
      return;
    }
    const results = await pool(videos, Math.min(os.availableParallelism(), 8),
      (file) => probe(file, videoStream).catch((error) => ({ video: file, error: error.message })));
    if (cancelled) throw cancellationError();
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
      // Float noise in a centered window (1.4000000000000001 - 0.8) must not add a frame.
      const count = Math.ceil((end - start) * fps - 1e-6);
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
    const { events, candidates, ...analysis } = await detectChanges(video, info, range, crop, { threshold, minGap, max, analysisFps, analysisWidth });
    const truncated = candidates > max;
    const kept = events.sort((a, b) => a.time - b.time);
    times = [range.start, ...kept.map((event) => event.time)];
    scores = [null, ...kept.map((event) => event.score)];
    detection = { metric: `RGB any-channel-diff>${PIXEL_DELTA}@${analysis.width}x${analysis.height}px,${analysisFps}fps vs last detected candidate`,
      analysis: { ...analysis, fps: analysisFps }, threshold, minGap, candidates, truncated };
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
  const output = await outputDirectory(video, command, options.output);
  const { directory, work } = output;
  const frames = [];
  const produced = [];
  const extractFrame = async (time, i) => {
    const timecode = formatTimecode(time);
    const filename = `frame-${String(i).padStart(4, '0')}_${timecode.replaceAll(':', '-')}.jpg`;
    const target = path.join(work, filename);
    produced.push(target);
    await extract(video, info, time, width, target, crop);
    if (!(await nonempty(target))) throw new Error(`FFmpeg produced no frame for ${time}s`);
    return { file: filename, time, timecode };
  };
  try {
    frames.push(...await pool(times, Math.min(os.availableParallelism(), 8), extractFrame));
    if (scores) frames.forEach((frame, i) => { frame.score = scores[i]; });
    let sheets;
    if (command !== 'frame' || frames.length > 1) {
      const size = await frameSize(path.join(work, frames[0].file));
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
        produced.push(path.join(work, file));
        await writeSheet(work, frames.slice(first, last + 1), file, layout, produced);
        sheets.push({ file, frames: [first, last], start: frames[first].time, end: frames[last].time, ...layout });
        (slice.sheets ??= []).push(file);
      }
    }
    // No FFmpeg runs past here, so honor a cancellation that arrived during the last steps before committing.
    if (cancelled) throw cancellationError();
    for (const file of [...frames.map((frame) => frame.file), ...(sheets ?? []).map((sheet) => sheet.file)]) {
      produced.push(path.join(directory, file));
      await rename(path.join(work, file), path.join(directory, file));
    }
    produced.push(path.join(directory, 'manifest.json.tmp'), path.join(directory, 'manifest.json'));
    const manifest = await saveManifest(directory, { command, source: info, outputWidth: width, ...(crop ? { crop } : {}), ...(range && (options.start !== undefined || options.end !== undefined) ? { range } : {}), ...(detection ? { detection } : {}), frames, ...(windows ? { windows } : {}), ...(sheets ? { sheets } : {}) });
    await rm(work, { recursive: true, force: true });
    await rm(output.lock, { force: true });
    console.log(JSON.stringify({ directory, ...(sheets ? { sheets: sheets.map((sheet) => path.join(directory, sheet.file)) } : {}), manifest, frames: frames.length, ...(detection ? { changes: frames.length - 1 } : {}) }, null, 2));
  } catch (error) {
    await release(output, produced);
    throw error;
  }
}
