import { copyFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nonempty } from './output.js';
import { cancellationError, cancelled, lines, pool, run } from './process.js';
import { TICK, TIME_TOLERANCE, attempts, seekArgs, trimEnd } from './seek.js';
import { formatTimecode } from './time.js';

// setpts numbers the kept frames in whole seconds, the encoder's time base, so frames sharing a source pts (which the
// JPEG encoder rejects as invalid timestamps) reach it in decode order; select and showinfo before it see source pts.
function filters(width, crop) {
  const cut = crop ? `crop=${crop.pixels.width}:${crop.pixels.height}:${crop.pixels.x}:${crop.pixels.y},` : '';
  return `setpts=N/TB,${cut}scale=${width}:max(2\\,round(${width}/dar/2)*2),setsar=1`;
}

async function extract(video, info, time, width, filename, crop, decoding) {
  const target = time + info.containerStart + TIME_TOLERANCE;
  let emptyError;
  // A time before the first decoded frame (AVI rebuilds pts from dts, delaying it) shows that first frame.
  for (const { slow, window } of [...attempts(info, time), { slow: true, window: 0 }]) {
    const select = window === 0 ? '' : `${trimEnd(info, target)},select='${Number.isFinite(window) ? `between(t,${target - window},${target})` : `lte(t,${target})`}',`;
    try {
      // image2 -update rewrites the file per kept frame, leaving the last one at or before `time` (of frames sharing a
      // pts, the last decoded). Passthrough keeps
      // every kept frame; the default constant-rate sync drops a VFR frame that lands in the same output tick.
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...decoding, ...seekArgs(slow, time), '-i', video, '-map', `0:v:${info.videoStream}`, ...(window === 0 ? ['-frames:v', '1'] : []), '-vf', `${select}${filters(width, crop)}`, '-fps_mode', 'passthrough', '-enc_time_base:v', '1', '-update', '1', '-threads:v', '1', '-q:v', '4', '-y', filename]);
    } catch (error) {
      // FFmpeg 8 can fail to initialize MJPEG at EOF when seeking yielded no decoded frame.
      if (await nonempty(filename) || !/Non full-range YUV[\s\S]*Could not open encoder before EOF/.test(error.message)) throw error;
      emptyError ??= error;
    }
    if (await nonempty(filename)) return;
  }
  if (emptyError) throw emptyError;
}

// Dense times (consecutive ones at most DENSE_GAP apart) share one decode, split into chunks of at least CHUNK_SPAN
// seconds so several can run at once. Wider gaps seek per time instead, skipping the frames between.
const DENSE_GAP = 1;
const CHUNK_SPAN = 1;
// Packets are listed past the last time by this much: decode order can put frames shown before it after later ones.
const REORDER = 1;

function denseChunks(info, times) {
  const groups = [];
  for (const [i, time] of times.entries()) {
    if (i && time - times[i - 1] <= DENSE_GAP) groups.at(-1).push(time);
    else groups.push([time]);
  }
  return groups.filter((group) => group.length > 1).flatMap((group) => {
    // Every chunk of a group decoded from the origin (MPEG-TS, near the start) would decode the same frames again.
    if (attempts(info, group.at(-1))[0].slow) return [group];
    const count = Math.max(1, Math.min(group.length >> 1, Math.floor((group.at(-1) - group[0]) / CHUNK_SPAN)));
    return Array.from({ length: count }, (_, k) => group.slice(Math.round(k * group.length / count), Math.round((k + 1) * group.length / count)));
  });
}

// Extracts the frames shown at `times` (sorted, unique) in one decode from the keyframe before the first (or the
// origin, where `extract` would decode from there), encoding each shown frame once. The frame shown at a time needs
// the next frame's pts to recognize, so a demux-only packet listing guesses the shown pts and select keeps exactly
// those: every frame at a kept pts, as frames sharing one show the last decoded. showinfo before select reports every
// frame decoded up to the trim end, so each guess is checked against every frame that could be shown, including any
// the listing missed (stopping after as many frames as guesses could cut that evidence short). Returns Map time =>
// file for the verified times; the caller extracts the rest one by one.
async function extractChunk(video, info, times, width, crop, decoding, directory, prefix, produced) {
  const slow = attempts(info, times[0])[0].slow;
  const target = (time) => time + info.containerStart + TIME_TOLERANCE;
  const end = target(times.at(-1));
  const listed = [];
  let untimed = false;
  await lines('ffprobe', ['-v', 'error', '-select_streams', `v:${info.videoStream}`, '-read_intervals',
    `${slow ? '' : Math.max(0, target(times[0]) - REORDER)}%${end + REORDER}`, '-show_entries', 'packet=pts,flags', '-of', 'csv=p=0', video],
  'stdout', (line) => {
    // Discarded packets (before an edit list start) decode to no frame.
    const [, pts, flags] = /^(-?\d+|N\/A),(\S*)$/.exec(line.trim()) ?? [];
    if (pts === 'N/A') untimed = true;
    if (pts !== undefined && !flags.includes('D') && Number.isSafeInteger(Number(pts))) listed.push(Number(pts));
  });
  // The last pts at or before a time, as select's t compares it: pts times the time base as a double.
  const shown = (candidates, tick, time) => candidates.reduce((best, pts) => (pts * tick <= target(time) && !(pts <= best) ? pts : best), undefined);
  const guesses = [...new Set(times.map((time) => shown(listed, info[TICK], time)).filter((pts) => pts !== undefined))].sort((a, b) => a - b);
  // Without every pts (AVI rebuilds reordered frames' pts from dts) guesses would miss; those times seek instead.
  if (untimed || !guesses.length) return new Map();
  const file = (k) => path.join(directory, `${prefix}-${String(k).padStart(4, '0')}.jpg`);
  const kept = new Set(guesses);
  const files = Array.from({ length: listed.filter((pts) => kept.has(pts)).length }, (_, k) => file(k));
  produced.push(...files);
  const decoded = [];
  const encoded = [];
  let timeBase;
  await lines('ffmpeg', ['-hide_banner', '-nostats', '-loglevel', 'info', ...decoding, ...seekArgs(slow, times[0]), '-i', video,
    '-map', `0:v:${info.videoStream}`, '-vf', `${trimEnd(info, end)},showinfo=checksum=0,select='${guesses.map((pts) => `eq(pts,${pts})`).join('+')}',showinfo=checksum=0,${filters(width, crop)}`,
    '-fps_mode', 'passthrough', '-enc_time_base:v', '1', '-threads:v', '1', '-q:v', '4', '-start_number', '0', '-y',
    path.join(directory, `${prefix}-%04d.jpg`)], 'stderr', (line) => {
    const [, filter, rest] = /\[Parsed_showinfo_(\d+) @ [^\]]*\] (.*)/.exec(line) ?? [];
    if (filter === undefined) return;
    timeBase = /^config in time_base:\s*(\d+)\/(\d+)/.exec(rest)?.slice(1).map(Number) ?? timeBase;
    const pts = /^n:\s*\d+\s+pts:\s*(-?\d+)\s/.exec(rest)?.[1];
    if (pts !== undefined) (filter === '1' ? decoded : encoded).push(Number(pts));
  });
  // Frames the listing missed add files beyond those expected; the run's work directory is removed whole regardless.
  for (let k = files.length; k < encoded.length; k++) produced.push(files[k] = file(k));
  const result = new Map();
  if (!timeBase?.[1]) return result;
  for (const time of times) {
    const pts = shown(decoded, timeBase[0] / timeBase[1], time);
    const k = pts === undefined ? -1 : encoded.lastIndexOf(pts);
    if (k >= 0 && k < files.length && await nonempty(files[k])) result.set(time, files[k]);
  }
  return result;
}

// Extracts the frame on screen at each of `times` into `directory`, at most `width` wide, and returns { file, time,
// timecode } entries in the order of `times`. Every file it expects to write is added to `produced` before
// FFmpeg starts. Equal times are extracted once and copied. Dense inspect times are decoded in chunks, choosing each
// shown frame before encoding; other times, and any a chunk could not verify, seek per time.
export async function extractFrames({ video, info, times, width, crop, directory, produced, command }) {
  const unique = [...new Set(times)].sort((a, b) => a - b);
  const cores = os.availableParallelism();
  // Concurrent jobs share the cores between their decoders; one job keeps FFmpeg's automatic count. On 16 cores this
  // made multi-frame runs 8-18% faster, while one decoder thread per job slowed long-GOP single frames 2x.
  const share = (count) => {
    const jobs = Math.min(count, cores, 8);
    return { jobs, decoding: jobs > 1 ? ['-threads', String(Math.max(1, Math.floor(cores / jobs)))] : [] };
  };
  const names = times.map((time, i) => `frame-${String(i).padStart(4, '0')}_${formatTimecode(time).replaceAll(':', '-')}.jpg`);
  const sources = new Map();
  const chunks = command === 'inspect' ? denseChunks(info, unique) : [];
  if (chunks.length) {
    const { jobs, decoding } = share(chunks.length);
    await pool(chunks, jobs, async (chunk, c) => {
      let found;
      try { found = await extractChunk(video, info, chunk, width, crop, decoding, directory, `.chunk-${String(c).padStart(3, '0')}`, produced); }
      catch {
        if (cancelled) throw cancellationError();
        return;
      }
      for (const [time, file] of found) sources.set(time, file);
    });
  }
  const rest = unique.filter((time) => !sources.has(time));
  const { jobs, decoding } = share(rest.length);
  await pool(rest, jobs, async (time) => {
    const target = path.join(directory, names[times.indexOf(time)]);
    produced.push(target);
    await extract(video, info, time, width, target, crop, decoding);
    if (!(await nonempty(target))) throw new Error(`FFmpeg produced no frame for ${time}s`);
    sources.set(time, target);
  });
  // The first entry showing a file takes it; later ones (equal times, or times sharing a shown frame) get copies.
  const placed = new Map();
  for (const [i, time] of times.entries()) {
    const source = sources.get(time);
    const target = path.join(directory, names[i]);
    if (source !== target) {
      produced.push(target);
      if (placed.has(source)) await copyFile(placed.get(source), target);
      else await rename(source, target);
    }
    if (!placed.has(source)) placed.set(source, target);
  }
  return times.map((time, i) => ({ file: names[i], time, timecode: formatTimecode(time) }));
}
