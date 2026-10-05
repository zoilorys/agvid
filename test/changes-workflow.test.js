import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('bin/agvid.js');
const fixture = path.resolve('test/fixtures/test.mov');

function ffmpeg(...args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

async function withTempDirectory(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-changes-'));
  try { await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// Starts the CLI; `exited` resolves with its exit code and output.
function launch(env, ...args) {
  const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { result.stdout += chunk; });
  child.stderr.on('data', (chunk) => { result.stderr += chunk; });
  return { child, result, exited: new Promise((resolve) => child.on('close', (code) => resolve({ code, ...result }))) };
}

async function until(check, what) {
  for (let i = 0; i < 3000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ffmpeg and ffprobe wrappers that log each call's pid and arguments to `log`. With SLOW set, the change scan
// (the rawvideo call) reads its input at native speed, so a scan of N seconds takes N seconds.
async function recordingTools(directory) {
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'calls.log');
  await mkdir(bin);
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    await writeFile(path.join(bin, tool), `#!/bin/sh
echo "$$ ${tool} $*" >> "${log}"
case " $* " in *" rawvideo "*) [ -n "$SLOW" ] && exec "${real}" -re "$@";; esac
exec "${real}" "$@"
`);
    await chmod(path.join(bin, tool), 0o755);
  }
  return {
    env: (extra) => ({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extra }),
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
  };
}

const scans = (calls) => calls.filter((call) => / rawvideo /.test(call));

function gray(file, width, height) {
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${width}:${height}`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  return (x, y) => decoded.stdout[y * width + x];
}

test('a truncated selection keeps a quiet late change that stronger early changes would crowd out', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'busy-then-quiet.mp4');
    // A 160x120 panel toggles at 1, 2, ... 9 s (9 strong changes); a 40x40 box appears at 18 s.
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=320x180:rate=10:duration=20',
      '-vf', "drawbox=x=20:y=20:w=160:h=120:color=white:t=fill:enable='lt(mod(t,2),1)*lt(t,10)',drawbox=x=260:y=120:w=40:h=40:color=white:t=fill:enable='gte(t,18)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
    const result = spawnSync(process.execPath, [cli, 'changes', source, '--max', '5', '--output', path.join(directory, 'out')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    const { detection } = manifest;
    assert.deepEqual([output.changes, output.candidates, output.truncated], [5, detection.candidates, true]);
    assert.equal(detection.candidates, 10);
    // Slices of 4 s: three hold panel toggles, 12-16 s is empty, 16-20 s holds the box; the empty slice's place goes
    // to the strongest remaining toggle.
    assert.deepEqual([detection.selection.slices, detection.selection.fromSlices, detection.selection.byScore], [5, 4, 1]);
    const late = manifest.frames.at(-1);
    assert.ok(Math.abs(late.time - 18) <= 0.1, String(late.time));
    assert.ok(manifest.frames.slice(1, -1).every((frame) => frame.score > late.score * 5 && frame.time < 10), JSON.stringify(manifest.frames));
    assert.ok(gray(path.join(output.directory, late.file), 320, 180)(280, 140) > 128, 'late box shown');
  });
});

test('argument, budget and output failures happen before any scan and leave no output', async () => {
  await withTempDirectory(async (directory) => {
    const tools = await recordingTools(directory);
    const env = tools.env();
    const clip = path.join(directory, 'clip.mp4');
    const ts = path.join(directory, 'clip.ts');
    ffmpeg('-f', 'lavfi', '-i', "color=black:size=160x90:rate=10:duration=4,drawbox=w=40:h=40:color=white:t=fill:enable='gte(t,3.5)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', clip);
    ffmpeg('-i', clip, '-c', 'copy', '-f', 'mpegts', '-y', ts);
    const out = path.join(directory, 'out');
    const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--output', out], { encoding: 'utf8', env });

    // Source-independent mistakes fail before ffprobe, even on a missing video.
    for (const [args, message] of [[['--width', '10'], /--width must be/], [['--analysis-budget', '0'], /--analysis-budget must be/],
      [['--analysis-budget', 'soon'], /invalid time: soon/], [['--crop', '0,0,2,1'], /--crop must be/], [['--start', '1:75'], /invalid time/],
      [['--threshold', '0'], /--threshold/], [['--start', '3', '--end', '2s'], /--start 00:03.000 must be before --end 00:02.000/]]) {
      const result = run('changes', path.join(directory, 'missing.mp4'), ...args);
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, message);
    }
    assert.deepEqual(await tools.calls(), []);

    const budget = run('changes', clip, '--analysis-budget', '2');
    assert.notEqual(budget.status, 0);
    assert.match(budget.stderr, /changes would decode 00:04.000 of video .*over --analysis-budget 2s; narrow it with --start\/--end/);
    // MPEG-TS decodes from its start, so a late --start does not lower the cost.
    const tsBudget = run('changes', ts, '--start', '3', '--analysis-budget', '2');
    assert.notEqual(tsBudget.status, 0);
    assert.match(tsBudget.stderr, /MPEG-TS is decoded from the video start.*narrow it with --end /);
    assert.deepEqual(scans(await tools.calls()), []);

    // An occupied output directory fails before the scan; one within budget then scans and finishes.
    await mkdir(out);
    await writeFile(path.join(out, 'keep.txt'), 'mine');
    const occupied = run('changes', clip, '--start', '3', '--analysis-budget', '2');
    assert.match(occupied.stderr, /output directory is not empty/);
    assert.deepEqual(scans(await tools.calls()), []);
    assert.deepEqual(await readdir(out), ['keep.txt']);
    await rm(out, { recursive: true });

    const ok = run('changes', clip, '--start', '3', '--analysis-budget', '1.5s');
    assert.equal(ok.status, 0, ok.stderr);
    const manifest = JSON.parse(await readFile(JSON.parse(ok.stdout).manifest, 'utf8'));
    assert.deepEqual(manifest.detection.scan, { from: 3, to: 4, seconds: 1, budget: 1.5 });
    assert.ok(Math.abs(manifest.frames[1].time - 3.5) <= 0.1, JSON.stringify(manifest.frames));
    assert.equal(scans(await tools.calls()).length, 1);
  });
});

test('a fallback to the video start when input seeking finds no frame must fit the budget before it starts', async () => {
  await withTempDirectory(async (directory) => {
    const tools = await recordingTools(directory);
    const env = tools.env();
    // Stored frames only at 0 s (black), 1 s (gray) and 39 s (white). In FLV with B-frames, input seeking to 20 s
    // finds no frame at or before it, so the scan must decode from the video start.
    const flv = path.join(directory, 'sparse.flv');
    ffmpeg('-f', 'lavfi', '-i', "color=black:size=64x48:rate=1:duration=40,drawbox=color=gray:t=fill:enable='between(t,1,38)',drawbox=color=white:t=fill:enable='gte(t,39)'",
      '-vf', "select='eq(n,0)+eq(n,1)+eq(n,39)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', flv);
    const run = (budget) => spawnSync(process.execPath, [cli, 'changes', flv, '--start', '20', '--min-gap', '0', '--analysis-budget', budget,
      '--output', path.join(directory, `out-${budget}`)], { encoding: 'utf8', env });

    // The 20 s from --start fit a 25 s budget; the 40 s from the video start do not.
    const denied = run('25');
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /changes would decode 00:40.000 of video \(00:00.000 to 00:40.000; input seeking found no frame .*narrow it with --end /);
    assert.ok(!(await readdir(directory)).includes('out-25'));
    const deniedScans = scans(await tools.calls());
    assert.ok(deniedScans.length >= 1 && deniedScans.every((call) => / -ss 20 /.test(call)), deniedScans.join('\n'));

    const allowed = run('40');
    assert.equal(allowed.status, 0, allowed.stderr);
    const output = JSON.parse(allowed.stdout);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.ok(scans(await tools.calls()).slice(deniedScans.length).some((call) => !/ -ss /.test(call)), 'origin scan ran');
    assert.deepEqual(manifest.detection.scan, { from: 0, to: 40, seconds: 40, budget: 40 });
    assert.deepEqual(manifest.frames.map(({ time }) => time), [20, 39]);
    const [baseline, change] = manifest.frames.map(({ file }) => gray(path.join(output.directory, file), 64, 48)(32, 24));
    assert.ok(baseline > 115 && baseline < 140 && change > 245, `levels ${baseline}, ${change}`);
  });
});

test('a long scan reports progress on stderr only, and a cancelled scan removes its output', async () => {
  await withTempDirectory(async (directory) => {
    const tools = await recordingTools(directory);
    const env = tools.env({ SLOW: '1' });
    const clip = path.join(directory, 'clip.mp4');
    ffmpeg('-f', 'lavfi', '-i', "color=black:size=160x90:rate=10:duration=7,drawbox=w=40:h=40:color=white:t=fill:enable='gte(t,6)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', clip);
    const finished = launch(env, 'changes', clip, '--output', path.join(directory, 'done'));
    const cancelled = launch(env, 'changes', clip, '--output', path.join(directory, 'cancelled'));
    await until(() => /agvid changes: scanned/.test(cancelled.result.stderr), 'progress from the cancelled run');
    cancelled.child.kill('SIGTERM');
    const stopped = await cancelled.exited;
    assert.equal(stopped.code, 143, stopped.stderr);
    assert.ok(!(await readdir(directory)).includes('cancelled'));

    const done = await finished.exited;
    assert.equal(done.code, 0, done.stderr);
    const progress = done.stderr.split('\n').filter(Boolean);
    assert.ok(progress.length >= 1 && progress.every((line) => /^agvid changes: scanned \d\d:\d\d\.\d{3} of 00:07\.000 \(\d+%\), \d candidates, \d+s elapsed$/.test(line)), done.stderr);
    const output = JSON.parse(done.stdout);
    assert.deepEqual([output.changes, output.candidates, output.truncated], [1, 1, false]);
    // Every scan FFmpeg has exited, including the cancelled one.
    for (const pid of scans(await tools.calls()).map((call) => Number(call.split(' ')[0]))) {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `pid ${pid}`);
    }
  });
});

test('inspect by --start/--end records the requested range in its manifest', async () => {
  await withTempDirectory(async (directory) => {
    const run = (...args) => {
      const result = spawnSync(process.execPath, [cli, 'inspect', fixture, '--fps', '1', '--width', '64', ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const ranged = JSON.parse(await readFile(run('--start', '3', '--end', '5', '--output', path.join(directory, 'a')).manifest, 'utf8'));
    assert.deepEqual(ranged.range, { start: 3, end: 5 });
    const open = JSON.parse(await readFile(run('--start', '25', '--output', path.join(directory, 'b')).manifest, 'utf8'));
    assert.deepEqual(open.range, { start: 25, end: open.source.end });
    const around = JSON.parse(await readFile(run('--around', '4', '--output', path.join(directory, 'c')).manifest, 'utf8'));
    assert.equal(around.range, undefined);
  });
});
