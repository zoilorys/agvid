import { readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChanges, requireFfmpeg51 } from './changes.js';
import { extractFrames } from './media.js';
import { outputDirectory, release, saveManifest } from './output.js';
import { parseArgs, parseOptions, planRun, videoStreamOption } from './plan.js';
import { probe } from './probe.js';
import { cancel, cancellationError, cancelled, pool } from './process.js';
import { buildSheets } from './sheets.js';

export { displayedSize, parseCrop } from './geometry.js';
export { resolveRange } from './plan.js';
export { labelScale, planSheets, renderLabel, sheetLayout } from './sheets.js';
export { formatTimecode, parseTime } from './time.js';

const HELP = `agvid <command> <video> [options]

Work progressively: probe, overview, changes (screen recordings), then inspect or frame.
Run agvid <command> --help for its options.

Commands:
  probe <video>...               Source metadata as JSON; several videos print an array
  overview <video>               Evenly spaced frames and labeled sheets (default 12 frames)
  changes <video>                Range start plus each frame where the picture changes
  inspect <video> --around TIME  Frames at a fixed rate around a moment, or over --start/--end
  frame <video> --at TIME        The frame on screen at each time

Image commands write JPEG frames, timecode-labeled sheets and manifest.json (each frame's file and
source time) to a fresh .agvid/runs/<video>-<command>/ under the git root (else cwd), and print
their paths as JSON. Needs Node 20+ and FFmpeg/FFprobe 5.1+.
Details: README.md and skill/agvid/references/advanced.md in the package.`;

const IMAGE_OPTIONS = `  --crop X,Y,W,H            Region as fractions 0-1 of the displayed frame (left, top, width, height),
                            cut at source resolution before scaling; at least 16x16 source pixels
  --width PX                Maximum frame width, 64-4096, default 640
  --output DIR              New or empty directory; default .agvid/runs/ under the git root (else cwd)
  --video-stream N          Zero-based video stream (0:v:N), default 0`;

const TIMES = `TIME is seconds, MM:SS.s or HH:MM:SS.s; DURATION is seconds with an optional s. A time shows the
last frame at or before it, and the manifest records the requested time. A run makes at most 240
frames. A killed run leaves DIR/.agvid.lock; if no agvid run uses DIR, delete it and any
.agvid.lock.work-* directories.`;

const COMMAND_HELP = {
  probe: `agvid probe <video>... [--video-stream N]

Prints the video stream's start, end, duration, displayed and coded size, sar, rotation, fps,
frameCount, codec, pixelFormat, bitDepth and hasAudio as JSON. Several videos print an array in
argument order; a failed file becomes { "video", "error" } and the exit code is 1.

  --video-stream N          Zero-based video stream (0:v:N), default 0`,
  overview: `agvid overview <video> [--frames N] [--start TIME] [--end TIME] [options]

Evenly spaced frames across the video or range, plus timecode-labeled sheets. Open the sheets first.

  --frames N                Frames to take, 1-64, default 12
  --start TIME --end TIME   Limit to a range, clamped to the video
${IMAGE_OPTIONS}

${TIMES}`,
  changes: `agvid changes <video> [--start TIME] [--end TIME] [--crop X,Y,W,H] [options]

The range start plus each frame where more than --threshold of the pixels changed since the last
change. Use --start/--end on long videos and --crop for small UI changes: a cursor-sized change stays
under the default threshold. Progress goes to stderr every 5s; stdout holds the final JSON with
changes, candidates and truncated. Manifest frames add a score.

  --start TIME --end TIME   Limit to a range, clamped to the video
  --threshold X             Changed-pixel share needed, above 0 to 1, default 0.002
  --min-gap DURATION        Minimum spacing between changes, default 0.5s
  --max N                   Changes kept, 1-239, default 48; past it the strongest per time slice
                            are kept and truncated is true
  --analysis-fps N          Sampling rate, 1-60, default 30; higher catches shorter changes
  --analysis-width PX       Analysis width, 64-512, default 256; higher catches smaller changes
  --analysis-budget DURATION
                            Source seconds one decode attempt may cover, default 300s (not wall
                            clock); an over-budget scan fails before decoding and says what to narrow
${IMAGE_OPTIONS}

${TIMES}`,
  inspect: `agvid inspect <video> --around TIME [--window DURATION] [--fps N] [options]
agvid inspect <video> --start TIME --end TIME [--fps N] [options]

Frames at a fixed rate in a centered window or a range, plus timecode-labeled sheets.

  --around TIME             Window center; comma list or repeat, each window gets its own sheets
  --window DURATION         Total centered duration, clipped to the video, default 2s
  --start TIME --end TIME   Inspect a range instead of --around/--window
  --fps N                   Frames per second, 0.1-60, default 4
${IMAGE_OPTIONS}

${TIMES}`,
  frame: `agvid frame <video> --at TIME [options]

The frame on screen at each time. Several times also write a sheet.

  --at TIME                 Moment to extract; comma list or repeat, deduped and sorted
${IMAGE_OPTIONS}

${TIMES}`,
};

export async function main(args) {
  if (args.length === 0 || ['--help', '-h', 'help'].includes(args[0])) {
    console.log(COMMAND_HELP[args[1]] ?? HELP);
    return;
  }
  if (COMMAND_HELP[args[0]] && args.slice(1).some((arg) => arg === '--help' || arg === '-h')) {
    console.log(COMMAND_HELP[args[0]]);
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    console.log(pkg.version);
    return;
  }
  const parsed = parseArgs(args, COMMAND_HELP[args[0]] ?? HELP);
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
  const parsed = parseOptions(command, options);
  const info = await probe(video, videoStream);
  const { crop, width, range, settings, windows, ...plan } = planRun(command, options, info, parsed);
  if (settings) await requireFfmpeg51();
  // Claimed before change detection, so an unusable output fails before the scan.
  const output = await outputDirectory(video, command, options.output);
  const { directory, work } = output;
  const produced = [];
  try {
    let { times } = plan;
    let scores;
    let detection;
    if (settings) {
      const changes = await findChanges({ video, info, range, crop, settings });
      times = [range.start, ...changes.events.map((event) => event.time)];
      scores = [null, ...changes.events.map((event) => event.score)];
      ({ detection } = changes);
    }
    const frames = await extractFrames({ video, info, times, width, crop, directory: work, produced, command, windows });
    if (scores) frames.forEach((frame, i) => { frame.score = scores[i]; });
    const sheets = command !== 'frame' || frames.length > 1
      ? await buildSheets({ directory: work, frames, windows, width, info, crop, produced }) : undefined;
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
    console.log(JSON.stringify({ directory, ...(sheets ? { sheets: sheets.map((sheet) => path.join(directory, sheet.file)) } : {}), manifest, frames: frames.length, ...(detection ? { changes: frames.length - 1, candidates: detection.candidates, truncated: detection.truncated } : {}) }, null, 2));
  } catch (error) {
    await release(output, produced);
    throw error;
  }
}
