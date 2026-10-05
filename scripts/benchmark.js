#!/usr/bin/env node
// Wall-time benchmark for every agvid command, including Node startup.
// node scripts/benchmark.js [--cli PATH] [--video bundled|short|long|FILE]... [--case NAME,...] [--runs N]
//   [--json FILE] [--compare FILE] [--keep-going]
// Defaults: --cli bin/agvid.js, --video bundled --video short, --runs 3, all cases.
// short/long are generated testsrc2 1920x1080 60fps libx264 clips (20s/120s), cached in benchmark/.cache/.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'benchmark', '.cache');
const generated = { short: 20, long: 120 };
const CASES = [
  ['probe', ['probe']],
  ['overview12', ['overview']],
  ['overview48', ['overview', '--frames', '48']],
  ['frame1', ['frame', '--at', '7.5']],
  ['frame5', ['frame', '--at', '2,5,7.5,10,15']],
  ['inspect8', ['inspect', '--around', '7.5', '--window', '2s', '--fps', '4']],
  ['inspect100', ['inspect', '--start', '0', '--end', '10', '--fps', '10']],
  ['changes', ['changes']],
  ['changesCrop', ['changes', '--crop', '0,0,.5,.5']],
];

function parse(argv) {
  const options = { cli: 'bin/agvid.js', videos: [], cases: CASES.map(([name]) => name), runs: 3, keepGoing: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--cli') options.cli = value();
    else if (flag === '--video') options.videos.push(value());
    else if (flag === '--case') options.cases = value().split(',');
    else if (flag === '--runs') options.runs = Number(value());
    else if (flag === '--json') options.json = value();
    else if (flag === '--compare') options.compare = value();
    else if (flag === '--keep-going') options.keepGoing = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(readHeader());
      process.exit(0);
    } else throw new Error(`unknown option ${flag}`);
  }
  if (!options.videos.length) options.videos = ['bundled', 'short'];
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 50) throw new Error('--runs must be 1-50');
  const unknown = options.cases.filter((name) => !CASES.some(([known]) => known === name));
  if (unknown.length) throw new Error(`unknown case ${unknown.join(',')}; known: ${CASES.map(([name]) => name).join(',')}`);
  return options;
}

function readHeader() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 6).join('\n').replace(/^\/\/ ?/gm, '');
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.error) throw result.error;
  return result;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Hashes every file under the CLI package (bin, src, package.json) so results name the exact code measured.
async function treeHash(dir) {
  const hash = createHash('sha256');
  const walk = async (rel) => {
    const entries = (await readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) hash.update(`${child}\0${await sha256(path.join(dir, child))}\n`);
    }
  };
  for (const part of ['bin', 'src']) await walk(part);
  hash.update(`package.json\0${await sha256(path.join(dir, 'package.json'))}\n`);
  return hash.digest('hex');
}

async function resolveVideo(name) {
  if (name === 'bundled') return path.join(root, 'test', 'fixtures', 'test.mov');
  if (!(name in generated)) return path.resolve(name);
  const file = path.join(cache, `testsrc2-1080p60-${generated[name]}s.mp4`);
  if (existsSync(file)) return file;
  await mkdir(cache, { recursive: true });
  const partial = `${file}.partial.mp4`;
  console.error(`generating ${file}`);
  const result = run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=60:duration=${generated[name]}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', partial]);
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
  await rename(partial, file);
  return file;
}

function environment() {
  const firstLine = (tool) => run(tool, ['-version']).stdout.split('\n')[0];
  const git = (...args) => run('git', ['-C', root, ...args]).stdout.trim();
  return {
    date: new Date().toISOString(),
    node: process.version,
    ffmpeg: firstLine('ffmpeg'),
    ffprobe: firstLine('ffprobe'),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    loadavgAtStart: os.loadavg().map((load) => Number(load.toFixed(2))),
    gitHead: git('rev-parse', 'HEAD'),
    gitDirty: git('status', '--porcelain', '--', 'bin', 'src', 'package.json') !== '',
  };
}

async function probeVideo(file) {
  const result = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration,size:stream=codec_name,width,height,r_frame_rate,nb_frames', '-of', 'json', file]);
  if (result.status !== 0) throw new Error(`ffprobe failed on ${file}: ${result.stderr}`);
  const { streams: [stream], format } = JSON.parse(result.stdout);
  return { file: path.relative(root, file).startsWith('..') ? file : path.relative(root, file), sha256: await sha256(file), bytes: Number(format.size), duration: Number(format.duration), ...stream };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Runs one case `runs` times, each into a fresh output directory removed afterwards.
async function measure(cli, video, args, runs) {
  const times = [];
  let frames;
  for (let i = 0; i < runs; i++) {
    const output = await mkdtemp(path.join(os.tmpdir(), 'agvid-bench-'));
    const argv = [cli, args[0], video, ...args.slice(1), ...(args[0] === 'probe' ? [] : ['--output', output])];
    try {
      const start = process.hrtime.bigint();
      const result = spawnSync(process.execPath, argv, { encoding: 'utf8', maxBuffer: 64 << 20 });
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      if (result.error || result.status !== 0) return { error: (result.error?.message ?? result.stderr).trim(), times };
      times.push(Number(seconds.toFixed(4)));
      if (args[0] !== 'probe') frames = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')).frames.length;
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }
  return { median: Number(median(times).toFixed(4)), min: Math.min(...times), times, ...(frames === undefined ? {} : { frames }) };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const cli = path.resolve(options.cli);
  const cliRoot = path.resolve(path.dirname(cli), '..');
  const baseline = options.compare ? JSON.parse(await readFile(options.compare, 'utf8')) : undefined;
  const report = {
    environment: { ...environment(), cli: path.relative(root, cli), cliTreeSha256: await treeHash(cliRoot) },
    runs: options.runs,
    cases: Object.fromEntries(CASES.filter(([name]) => options.cases.includes(name)).map(([name, args]) => [name, ['agvid', args[0], '<video>', ...args.slice(1)].join(' ')])),
    videos: [],
  };
  let failed = false;
  for (const name of options.videos) {
    const file = await resolveVideo(name);
    const video = { name, ...(await probeVideo(file)), results: {} };
    report.videos.push(video);
    console.log(`== ${name} ${video.file} (${video.width}x${video.height} ${video.r_frame_rate} ${video.duration}s ${video.codec_name})`);
    for (const [caseName, args] of CASES.filter(([name]) => options.cases.includes(name))) {
      const result = await measure(cli, file, args, options.runs);
      video.results[caseName] = result;
      if (result.error) {
        failed = true;
        console.log(`${caseName.padEnd(12)} FAILED ${result.error}`);
        if (!options.keepGoing) break;
        continue;
      }
      const before = baseline?.videos.find((entry) => entry.name === name && entry.sha256 === video.sha256)?.results[caseName];
      const compare = before?.median ? `  baseline ${before.median.toFixed(3)}s  x${(result.median / before.median).toFixed(2)}` : '';
      const frameNote = result.frames === undefined ? '' : `  frames ${result.frames}${before?.frames !== undefined && before.frames !== result.frames ? ` (baseline ${before.frames})` : ''}`;
      console.log(`${caseName.padEnd(12)} median ${result.median.toFixed(3)}s  min ${result.min.toFixed(3)}s${frameNote}${compare}`);
    }
    if (failed && !options.keepGoing) break;
  }
  report.environment.loadavgAtEnd = os.loadavg().map((load) => Number(load.toFixed(2)));
  if (options.json) {
    await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    await writeFile(options.json, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`benchmark: ${error.message}`);
  process.exitCode = 1;
});
