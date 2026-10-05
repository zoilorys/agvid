import path from 'node:path';
import { displayedSize, parseCrop } from './geometry.js';
import { SOURCE_FORMAT, attempts } from './seek.js';
import { formatTimecode, parseTime } from './time.js';

const OPTIONS = {
  overview: new Set(['frames', 'start', 'end', 'crop', 'width', 'output', 'video-stream']),
  inspect: new Set(['around', 'window', 'fps', 'start', 'end', 'crop', 'width', 'output', 'video-stream']),
  frame: new Set(['at', 'crop', 'width', 'output', 'video-stream']),
  changes: new Set(['start', 'end', 'crop', 'threshold', 'min-gap', 'max', 'analysis-fps', 'analysis-width', 'analysis-budget', 'width', 'output', 'video-stream']),
  probe: new Set(['video-stream']),
};

const MULTI = new Set(['at', 'around']);

const ANALYSIS_FPS = 30;
const ANALYSIS_WIDTH = 256;
// Seconds of source video changes may decode unless --analysis-budget allows more.
const ANALYSIS_BUDGET = 300;

function numberOption(value, name, min, max, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return number;
}

export function videoStreamOption(value) {
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error('--video-stream must be a non-negative integer');
  }
  return Number(value);
}

// Resolves optional --start/--end (TIME strings or seconds) to { start, end } seconds within the video's span on the
// container timeline.
export function resolveRange(options, info) {
  const seconds = (value) => (typeof value === 'number' ? value : parseTime(value));
  const start = options.start === undefined ? info.start : Math.max(info.start, seconds(options.start));
  const end = options.end === undefined ? info.end : Math.min(info.end, seconds(options.end));
  if (start >= info.end) throw new Error(`--start ${formatTimecode(start)} must be before the video ends`);
  if (start >= end) throw new Error(`--start ${formatTimecode(start)} must be before --end ${formatTimecode(end)}`);
  return { start, end };
}

// Splits argv into { command, video | videos, options }; `help` is appended to usage errors.
export function parseArgs(args, help) {
  const [command, ...rest] = args;
  if (!OPTIONS[command]) throw new Error(`unknown command: ${command ?? ''}\n\n${help}`);
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
    if (!videos.length) throw new Error(`missing video path\n\n${help}`);
    return { command, videos: videos.map((file) => path.resolve(file)), options };
  }
  if (!video) throw new Error(`missing video path\n\n${help}`);
  return { command, video: path.resolve(video), options };
}

// Validates a command's source-independent options (numbers, times, crop syntax and option combinations) before
// anything runs, and returns them parsed for planRun.
export function parseOptions(command, options) {
  // A huge nominal frame checks --crop syntax; planRun checks its pixel size against the source.
  if (options.crop !== undefined) parseCrop(options.crop, { width: 2 ** 30, height: 2 ** 30 });
  const time = (name) => (options[name] === undefined ? undefined : parseTime(options[name]));
  const parsed = { width: numberOption(options.width ?? 640, 'width', 64, 4096, true), start: time('start'), end: time('end') };
  if (parsed.start >= parsed.end) throw new Error(`--start ${formatTimecode(parsed.start)} must be before --end ${formatTimecode(parsed.end)}`);
  if (command === 'overview') parsed.count = numberOption(options.frames ?? 12, 'frames', 1, 64, true);
  if (command === 'inspect') {
    parsed.ranged = options.start !== undefined || options.end !== undefined;
    if (parsed.ranged && (options.around !== undefined || options.window !== undefined)) throw new Error('--start/--end cannot be combined with --around/--window');
    if (!parsed.ranged && options.around === undefined) throw new Error('inspect requires --around or --start/--end');
    parsed.fps = numberOption(options.fps ?? 4, 'fps', 0.1, 60);
    if (!parsed.ranged) {
      parsed.arounds = [...new Set(options.around.map(parseTime))].sort((a, b) => a - b);
      parsed.window = numberOption(parseTime(options.window ?? '2s'), 'window', 0.001, 3600);
    }
  }
  if (command === 'changes') {
    const threshold = Number(options.threshold ?? 0.002);
    if (!(threshold > 0 && threshold <= 1)) throw new Error('--threshold must be a fraction above 0 and at most 1');
    parsed.settings = {
      threshold,
      minGap: numberOption(parseTime(options['min-gap'] ?? '0.5'), 'min-gap', 0, 3600),
      // One of the 240 frames is the range-start baseline.
      max: numberOption(options.max ?? 48, 'max', 1, 239, true),
      analysisFps: numberOption(options['analysis-fps'] ?? ANALYSIS_FPS, 'analysis-fps', 1, 60),
      analysisWidth: numberOption(options['analysis-width'] ?? ANALYSIS_WIDTH, 'analysis-width', 64, 512, true),
      budget: numberOption(parseTime(options['analysis-budget'] ?? String(ANALYSIS_BUDGET)), 'analysis-budget', 1, 1e6),
    };
  }
  if (command === 'frame') {
    if (options.at === undefined) throw new Error('frame requires --at');
    // [time, as given] pairs, deduped by time and sorted.
    parsed.at = [...new Map(options.at.map((value) => [parseTime(value), value]))].sort(([a], [b]) => a - b);
    if (parsed.at.length > 240) throw new Error('frame would create over 240 frames; reduce --at values');
  }
  return parsed;
}

// Rejects a scan decoding source seconds `from` to `end` over `budget`. `origin` says why it decodes from the video
// start, where only --end narrows it.
export function checkBudget(from, end, budget, origin) {
  if (end - from <= budget + 1e-9) return;
  throw new Error(`changes would decode ${formatTimecode(end - from)} of video (${formatTimecode(from)} to ${formatTimecode(end)}`
    + `${origin ? `; ${origin}` : ''}), over --analysis-budget ${budget}s; narrow it with ${origin ? '--end' : '--start/--end'} or raise --analysis-budget`);
}

// Validates a command's options against the probed source and plans its output: { crop, width } plus, by command,
// overview { range, times }, inspect { times, windows, and range with --start/--end }, changes { range, settings }
// (times follow detection), frame { times }. Times are source seconds on the container timeline.
export function planRun(command, options, info, parsed = parseOptions(command, options)) {
  const crop = options.crop === undefined ? undefined : parseCrop(options.crop, info);
  // Cap at the displayed width so square-pixel output is never larger than the displayed frame or crop.
  const displayedWidth = (crop?.pixels.displayed ?? displayedSize(info.width, info.height, info)).width;
  const width = Math.min(displayedWidth, parsed.width);
  if (command === 'overview') {
    const { count } = parsed;
    const range = resolveRange(parsed, info);
    const { start, end } = range;
    return { crop, width, range, times: Array.from({ length: count }, (_, i) => start + (end - start) * (i + 0.5) / count) };
  }
  if (command === 'inspect') {
    const { fps, window } = parsed;
    const range = parsed.ranged ? resolveRange(parsed, info) : undefined;
    const spans = range ? [{ around: null, ...range }] : parsed.arounds.map((around) => {
      if (around > info.end) throw new Error(`--around ${formatTimecode(around)} is beyond the video end ${formatTimecode(info.end)}`);
      if (around < info.start) throw new Error(`--around ${formatTimecode(around)} is before the video starts at ${formatTimecode(info.start)}`);
      return { around, start: Math.max(info.start, around - window / 2), end: Math.min(info.end, around + window / 2) };
    });
    const times = [];
    const windows = [];
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
    return { crop, width, times, windows, ...(range ? { range } : {}) };
  }
  if (command === 'changes') {
    const range = resolveRange(parsed, info);
    // Scans decode from the video start where input seeking is unreliable: MPEG-TS, where only --end narrows them, or
    // a range start near the video start. findChanges checks the budget again before falling back to the video start
    // when input seeking finds no frame.
    const ts = info[SOURCE_FORMAT].split(',').includes('mpegts');
    const from = attempts(info, range.start)[0].slow ? info.start : range.start;
    checkBudget(from, range.end, parsed.settings.budget, ts ? 'MPEG-TS is decoded from the video start' : undefined);
    return { crop, width, range, settings: parsed.settings };
  }
  const times = parsed.at.map(([time, value]) => {
    if (time >= info.end) throw new Error(`--at ${value} must be before the video ends at ${formatTimecode(info.end)}`);
    if (time < info.start) throw new Error(`--at ${value} is before the video starts at ${formatTimecode(info.start)}`);
    return time;
  });
  return { crop, width, times };
}
