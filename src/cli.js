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

Commands:
  probe <video>...               Source metadata as JSON; several videos print an array
  overview <video>               Evenly spaced frames: --frames N (1-64, default 12)
  changes <video>                Range start plus each frame where the picture changes
  inspect <video> --around TIME [--window DURATION] [--fps N]
  inspect <video> --start TIME --end TIME [--fps N]
                                 Frames at --fps (default 4) in a centered window (total, default 2s) or range
  frame <video> --at TIME        The frame on screen at each time

Options:
  --start TIME --end TIME   Limit overview, changes or inspect to a range
  --crop X,Y,W,H            Region as fractions 0-1 of the displayed frame (left, top, width, height)
  --width PX                Maximum frame width, 64-4096, default 640
  --output DIR              New or empty directory; default .agvid/runs/ under the git root (else cwd)
  --video-stream N          Zero-based video stream (0:v:N), default 0; works with probe too

changes tuning: --threshold X (changed-pixel share, default 0.002), --min-gap DURATION (0.5s),
--max N (48, up to 239), --analysis-fps N (30, 1-60), --analysis-width PX (256, 64-512),
--analysis-budget DURATION (300s: source video per decode attempt). Progress goes to stderr
every 5s; past --max candidates it keeps the strongest per time slice and reports truncated: true.

TIME is seconds, MM:SS.s or HH:MM:SS.s; DURATION is seconds with an optional s. --at and --around take
comma lists or repeat; a run makes at most 240 frames. A time shows the last frame at or before it,
and the manifest records the requested time. Writes JPEG frames, timecode-labeled sheets and
manifest.json, and prints their paths as JSON. A killed run leaves DIR/.agvid.lock; if no agvid run
uses DIR, delete it and any .agvid.lock.work-* directories. Needs Node 20+ and FFmpeg/FFprobe 5.1+.
Details: README.md and skill/agvid/references/advanced.md in the package.`;

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
  const parsed = parseArgs(args, HELP);
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
