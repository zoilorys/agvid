import { run, start } from './process.js';
import { TIME_TOLERANCE, attempts, seekArgs, trimEnd } from './seek.js';
import { checkBudget } from './plan.js';
import { formatTimecode } from './time.js';

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
export async function requireFfmpeg51() {
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

// Whether event a is kept over b: higher score, then the earlier time.
const stronger = (a, b) => a.score > b.score || (a.score === b.score && a.time < b.time);

// `progress` gets the attempt's decode start and span, each decoded frame's source time and the candidate count, for
// progress reports. An attempt falling back to the video start must fit the budget too: it fails before it starts.
function detectChanges(video, info, range, crop, settings, progress, attempt = 0) {
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
  // source PTS and precede select/showinfo to keep frame/time pairing intact. Thread counts stay automatic: an output
  // -threads:v 1 also made the filter graph single-threaded, scanning 1.4-1.8x slower with identical events.
  const startPts = range.start + info.containerStart + TIME_TOLERANCE;
  const before = Number.isFinite(window) ? `gte(t,${startPts - window})` : '1';
  const select = `if(lte(t,${startPts}),${before},isnan(prev_selected_t)+gte(t-prev_selected_t,${1 / analysisFps - 1e-6}))`;
  const args = ['-hide_banner', '-nostats', '-loglevel', 'info', ...seekArgs(slow, range.start), '-i', video,
    '-map', `0:v:${info.videoStream}`, '-vf', `${trimEnd(info, range.end + info.containerStart)},${cut}select='${select}',scale=${width}:${height},format=rgb24,showinfo`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  const from = slow ? info.start : range.start;
  return new Promise((resolve, reject) => {
    if (slow && !plan[0].slow) {
      checkBudget(from, range.end, settings.budget, 'input seeking found no frame at the range start, so it is decoded from the video start');
    }
    Object.assign(progress, { from, seconds: range.end - from, time: from, candidates: 0 });
    const child = start('ffmpeg', args);
    const pendingFrames = [];
    const pendingTimes = [];
    // The `max` strongest candidates, strongest first, and the strongest in each of `max` equal slices of the range.
    // Together they hold every event a truncated selection can keep (see findChanges).
    const events = [];
    const slices = new Array(max).fill(null);
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
          progress.candidates = ++candidates;
          const index = events.findIndex((kept) => stronger(event, kept));
          if (index >= 0) events.splice(index, 0, event);
          else if (events.length < max) events.push(event);
          if (events.length > max) events.pop();
          const slice = Math.min(max - 1, Math.floor((time - range.start) / (range.end - range.start) * max));
          if (!slices[slice] || stronger(event, slices[slice])) slices[slice] = event;
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
          if (match && timeBase) {
            progress.time = Number(match[1]) * timeBase[0] / timeBase[1] - info.containerStart;
            pendingTimes.push(progress.time);
          }
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
      if (missed) return resolve(detectChanges(video, info, range, crop, settings, progress, attempt + 1));
      if (failed) return reject(failed);
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}: ${errors.join('\n')}`));
      drain();
      if (missed) return resolve(detectChanges(video, info, range, crop, settings, progress, attempt + 1));
      if (pendingFrames.length || pendingTimes.length || filled) {
        return reject(new Error(`ffmpeg frame/pts mismatch: ${pendingFrames.length} frames and ${pendingTimes.length} times unpaired, ${filled} trailing bytes`));
      }
      if (!reference && retry) return resolve(detectChanges(video, info, range, crop, settings, progress, attempt + 1));
      // A valid sparse range may contain no new PTS. Baseline extraction still validates its displayed frame.
      resolve({ events, slices, candidates, from, width, height });
    });
  });
}

// Reports scan progress on stderr every PROGRESS_INTERVAL ms, so short scans stay quiet and stdout keeps only JSON.
const PROGRESS_INTERVAL = 5000;

// Detects changes in `range` per `settings` ({ threshold, minGap, max, analysisFps, analysisWidth, budget }) and
// returns the kept { time, score } events in time order with the manifest's detection summary. Up to `max` candidates
// are all kept. Beyond that, the strongest candidate of each of `max` equal slices of the range is kept, so quiet
// stretches stay represented however strong one busy stretch is, and slots left by empty slices go to the strongest
// remaining candidates.
export async function findChanges({ video, info, range, crop, settings }) {
  const { threshold, minGap, max, analysisFps, budget } = settings;
  const began = Date.now();
  const progress = {};
  const timer = setInterval(() => {
    const { from, seconds, time } = progress;
    const share = Math.min(1, Math.max(0, (time - from) / seconds));
    process.stderr.write(`agvid changes: scanned ${formatTimecode(Math.max(from, Math.min(range.end, time)))} of ${formatTimecode(range.end)}`
      + ` (${Math.floor(share * 100)}%), ${progress.candidates} candidates, ${Math.round((Date.now() - began) / 1000)}s elapsed\n`);
  }, PROGRESS_INTERVAL);
  let result;
  try { result = await detectChanges(video, info, range, crop, settings, progress); }
  finally { clearInterval(timer); }
  const { events, slices, candidates, from, ...analysis } = result;
  const truncated = candidates > max;
  let kept = events;
  let selection = { method: 'all candidates' };
  if (truncated) {
    kept = slices.filter(Boolean);
    const fromSlices = kept.length;
    const chosen = new Set(kept);
    for (const event of events) if (kept.length < max && !chosen.has(event)) kept.push(event);
    selection = { method: 'strongest per time slice, then strongest remaining', slices: max, sliceDuration: (range.end - range.start) / max,
      fromSlices, byScore: kept.length - fromSlices };
  }
  const detection = { metric: `RGB any-channel-diff>${PIXEL_DELTA}@${analysis.width}x${analysis.height}px,${analysisFps}fps vs last detected candidate`,
    analysis: { ...analysis, fps: analysisFps }, threshold, minGap, max, candidates, truncated, selection,
    scan: { from, to: range.end, seconds: range.end - from, budget } };
  return { events: kept.sort((a, b) => a.time - b.time), detection };
}
