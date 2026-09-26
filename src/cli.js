import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `agvid <command> <video> [options]

Commands:
  overview [--frames N] [--width PX] [--output DIR] <video>
  inspect <video> --around TIME [--window DURATION] [--fps N] [--width PX] [--output DIR]
  frame <video> --at TIME [--width PX] [--output DIR]
  probe <video>

TIME accepts seconds or HH:MM:SS.s. DURATION accepts seconds, with optional s suffix.
--window is the total duration centered on --around. Frames are JPEG files.
FFmpeg and FFprobe must be available on PATH.`;

const OPTIONS = {
  overview: new Set(['frames', 'width', 'output']),
  inspect: new Set(['around', 'window', 'fps', 'width', 'output']),
  frame: new Set(['at', 'width', 'output']),
  probe: new Set(),
};

export function parseTime(value) {
  const parts = String(value).replace(/s$/, '').split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) {
    throw new Error(`invalid time: ${value}`);
  }
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0);
}

function numberOption(value, name, min, max, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`--${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  }
  return number;
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (!OPTIONS[command]) throw new Error(`unknown command: ${command ?? ''}\n\n${HELP}`);
  const options = {};
  let video;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!OPTIONS[command].has(key)) throw new Error(`unknown option: ${arg}`);
      if (options[key] !== undefined) throw new Error(`duplicate option: ${arg}`);
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      options[key] = value;
    } else if (!video) video = arg;
    else throw new Error(`unexpected argument: ${arg}`);
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
  const raw = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,codec_name:format=duration', '-of', 'json', video]);
  const data = JSON.parse(raw);
  const stream = data.streams?.[0];
  if (!stream) throw new Error('no video stream found');
  const duration = Number(data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('video duration is unavailable');
  return { video, duration, width: stream.width, height: stream.height, fps: stream.avg_frame_rate, codec: stream.codec_name };
}

async function outputDirectory(video, command, requested) {
  if (requested) {
    const directory = path.resolve(requested);
    await mkdir(directory, { recursive: true });
    return directory;
  }
  const root = path.resolve('agvid-output');
  await mkdir(root, { recursive: true });
  const base = `${path.parse(video).name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${command}`;
  for (let suffix = 0; ; suffix++) {
    const directory = path.join(root, suffix ? `${base}-${suffix}` : base);
    try {
      await mkdir(directory);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

async function extract(video, time, width, filename) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(time), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', '-y', filename]);
}

async function saveManifest(directory, result) {
  const filename = path.join(directory, 'manifest.json');
  await writeFile(filename, `${JSON.stringify(result, null, 2)}\n`);
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
  const { command, video, options } = parseArgs(args);
  const info = await probe(video);
  if (command === 'probe') {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  const width = Math.min(info.width, numberOption(options.width ?? 640, 'width', 64, 4096, true));
  let times;
  if (command === 'overview') {
    const count = numberOption(options.frames ?? 12, 'frames', 1, 64, true);
    times = Array.from({ length: count }, (_, i) => info.duration * (i + 0.5) / count);
  } else if (command === 'inspect') {
    if (options.around === undefined) throw new Error('inspect requires --around');
    const around = parseTime(options.around);
    const window = numberOption(parseTime(options.window ?? '2s'), 'window', 0.001, 3600);
    const fps = numberOption(options.fps ?? 4, 'fps', 0.1, 60);
    if (around > info.duration) throw new Error('--around is beyond the video duration');
    const start = Math.max(0, around - window / 2);
    const end = Math.min(info.duration, around + window / 2);
    const count = Math.ceil((end - start) * fps);
    if (count > 240) throw new Error('inspect would create over 240 frames; reduce --window or --fps');
    times = Array.from({ length: count }, (_, i) => Math.min(end - 0.001, start + (i + 0.5) / fps));
  } else {
    if (options.at === undefined) throw new Error('frame requires --at');
    const at = parseTime(options.at);
    if (at >= info.duration) throw new Error('--at must be before the video ends');
    times = [at];
  }
  const directory = await outputDirectory(video, command, options.output);
  const frames = [];
  for (let i = 0; i < times.length; i++) {
    const filename = `frame-${String(i).padStart(4, '0')}.jpg`;
    await extract(video, times[i], width, path.join(directory, filename));
    frames.push({ file: filename, time: Number(times[i].toFixed(3)) });
  }
  let sheet;
  if (command === 'overview') {
    const columns = Math.min(4, Math.ceil(Math.sqrt(frames.length)));
    const rows = Math.ceil(frames.length / columns);
    sheet = path.join(directory, 'contact-sheet.jpg');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-framerate', '1', '-start_number', '0', '-i', path.join(directory, 'frame-%04d.jpg'), '-vf', `tile=${columns}x${rows}`, '-frames:v', '1', '-q:v', '4', '-y', sheet]);
  }
  const manifest = await saveManifest(directory, { command, source: info, outputWidth: width, frames, ...(sheet ? { contactSheet: path.basename(sheet) } : {}) });
  console.log(JSON.stringify({ directory, manifest, ...(sheet ? { contactSheet: sheet } : {}), frames: frames.length }, null, 2));
}
