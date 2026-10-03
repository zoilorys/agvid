import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('bin/agvid.js');

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

async function withTransportStream(fn, multiGop = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-seek-'));
  try {
    const video = path.join(directory, 'b-frames.ts');
    // A sparse GOP with B-frames puts its initial keyframe's DTS before the container's presentation start.
    const duration = multiGop ? 6 : 3;
    const picture = multiGop
      ? "drawbox=color=gray:t=fill:enable='between(n,1,2)',drawbox=color=white:t=fill:enable='gte(n,3)'"
      : "drawbox=color=gray:t=fill:enable='eq(n,1)',drawbox=color=white:t=fill:enable='eq(n,2)'";
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=blue:size=64x48:rate=1:duration=${duration}`,
      '-f', 'lavfi', '-i', `color=black:size=64x48:rate=1:duration=${duration},${picture}`,
      '-map', '0:v', '-map', '1:v', '-c:v', 'libx264', '-bf', '2', '-g', multiGop ? '3' : '30',
      '-x264-params', 'b-adapt=0:scenecut=0', '-pix_fmt', 'yuv420p', video]);
    const probe = JSON.parse(run(process.execPath, [cli, 'probe', video, '--video-stream', '1']));
    assert.ok(probe.containerStart > 0);
    await fn({ directory, video });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function invoke(directory, video, command, ...args) {
  const output = JSON.parse(run(process.execPath, [cli, command, video, '--video-stream', '1', ...args,
    '--output', path.join(directory, command)]));
  const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
  const levels = manifest.frames.map(({ file }) => {
    const pixels = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(output.directory, file),
      '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: null });
    // Distinct source colors distinguish a timestamp-correct extraction from a stale baseline or wrong stream.
    assert.ok(Math.max(...pixels) - Math.min(...pixels) < 5, `expected neutral frame, got ${[...pixels]}`);
    return pixels[0];
  });
  return { manifest, levels };
}

test('B-frame TS extraction shows the requested next frame and final display interval', async () => {
  await withTransportStream(async ({ directory, video }) => {
    const { manifest, levels } = await invoke(directory, video, 'frame', '--at', '0,0.5,2,2.5');
    assert.deepEqual(manifest.frames.map(({ time }) => time), [0, 0.5, 2, 2.5]);
    assert.ok(levels[0] < 5, `baseline ${levels[0]}`);
    assert.ok(levels[1] > 115 && levels[1] < 140, `interior ${levels[1]}`);
    assert.ok(levels[2] > 245 && levels[3] > 245, `final frame ${levels.slice(2)}`);
  });
});

test('B-frame TS change analysis pairs exact source times with full and cropped range images', async () => {
  await withTransportStream(async ({ directory, video }) => {
    const full = await invoke(directory, video, 'changes', '--min-gap', '0');
    assert.equal(full.manifest.frames.length, 3);
    full.manifest.frames.forEach(({ time }, i) => assert.ok(Math.abs(time - i) < 1e-9, `source time ${time}`));
    assert.ok(full.levels[0] < 5 && full.levels[1] > 115 && full.levels[1] < 140 && full.levels[2] > 245,
      `full range ${full.levels}`);
    await rm(path.join(directory, 'changes'), { recursive: true });
    const ranged = await invoke(directory, video, 'changes', '--start', '0.5', '--end', '2.5', '--crop', '0.5,0,0.5,1', '--min-gap', '0');
    assert.equal(ranged.manifest.frames.length, 2);
    ranged.manifest.frames.forEach(({ time }, i) => assert.ok(Math.abs(time - [0.5, 2][i]) < 1e-9, `range time ${time}`));
    assert.ok(ranged.levels[0] > 115 && ranged.levels[0] < 140 && ranged.levels[1] > 245, `cropped range ${ranged.levels}`);
    assert.ok(ranged.manifest.frames[1].score > 0.99);
    const image = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json',
      path.join(directory, 'changes', ranged.manifest.frames[1].file)]));
    assert.deepEqual(image.streams[0], { width: 32, height: 48 });
  });
});

test('multi-GOP TS preserves early images and changes when input seeking would skip a GOP', async () => {
  await withTransportStream(async ({ directory, video }) => {
    const frames = await invoke(directory, video, 'frame', '--at', '0,0.5,2,3,5.5');
    assert.deepEqual(frames.manifest.frames.map(({ time }) => time), [0, 0.5, 2, 3, 5.5]);
    assert.ok(frames.levels[0] < 5 && frames.levels[1] > 115 && frames.levels[1] < 140
      && frames.levels[2] > 115 && frames.levels[2] < 140 && frames.levels[3] > 245 && frames.levels[4] > 245,
    `requested images ${frames.levels}`);
    const changes = await invoke(directory, video, 'changes', '--min-gap', '0');
    assert.equal(changes.manifest.frames.length, 3);
    changes.manifest.frames.forEach(({ time }, i) => assert.ok(Math.abs(time - [0, 1, 3][i]) < 1e-9, `source time ${time}`));
    assert.ok(changes.levels[0] < 5 && changes.levels[1] > 115 && changes.levels[1] < 140 && changes.levels[2] > 245,
      `detected images ${changes.levels}`);
    await rm(path.join(directory, 'changes'), { recursive: true });
    const ranged = await invoke(directory, video, 'changes', '--start', '0.5', '--end', '4', '--min-gap', '0');
    assert.equal(ranged.manifest.frames.length, 2);
    ranged.manifest.frames.forEach(({ time }, i) => assert.ok(Math.abs(time - [0.5, 3][i]) < 1e-9, `range time ${time}`));
    assert.ok(ranged.levels[0] > 115 && ranged.levels[0] < 140 && ranged.levels[1] > 245, `ranged images ${ranged.levels}`);
  }, true);
});

test('changes in a sparse final display interval writes its baseline with no change events', async () => {
  await withTransportStream(async ({ directory, video }) => {
    const movie = path.join(directory, 'b-frames.mp4');
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', video, '-map', '0', '-c', 'copy', movie]);
    for (const source of [video, movie]) {
      const tail = await invoke(directory, source, 'changes', '--start', '2.5', '--end', '3');
      assert.deepEqual(tail.manifest.range, { start: 2.5, end: 3 });
      assert.equal(tail.manifest.frames.length, 1);
      assert.equal(tail.manifest.frames[0].time, 2.5);
      assert.equal(tail.manifest.frames[0].score, null);
      assert.equal(tail.manifest.detection.candidates, 0);
      assert.ok(tail.levels[0] > 245, `tail baseline ${tail.levels[0]}`);
      await rm(path.join(directory, 'changes'), { recursive: true });
    }
  });
});

function level(file) {
  const pixels = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file,
    '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: null });
  return pixels[0];
}

async function output(directory, name, ...args) {
  const result = JSON.parse(run(process.execPath, [cli, ...args, '--output', path.join(directory, name)]));
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
  return { manifest, levels: manifest.frames.map(({ file }) => level(path.join(result.directory, file))) };
}

// Black for 1 s, gray for 1 s, then white for 1 s, at 25 fps.
const STEPS = "color=black:size=64x48:rate=25:duration=3,drawbox=color=gray:t=fill:enable='between(t,1,2)',drawbox=color=white:t=fill:enable='gte(t,2)'";

test('AVI with packed B-frames decodes its first frames intact and finds both transitions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-seek-'));
  try {
    // One keyframe; FFmpeg moves input seeks 3/23 s earlier for B-frame streams, before this AVI's first index entry.
    const video = path.join(directory, 'source.avi');
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', STEPS, '-c:v', 'mpeg4', '-bf', '2', '-g', '250', video]);
    const start = await output(directory, 'start', 'frame', video, '--at', '0,0.04,0.08,0.5');
    assert.ok(start.levels.every((value) => value < 5), `start ${start.levels}`);
    const changes = await output(directory, 'changes', 'changes', video, '--min-gap', '0');
    assert.equal(changes.manifest.frames.length, 3);
    assert.ok(changes.levels[0] < 5 && changes.levels[1] > 115 && changes.levels[1] < 140 && changes.levels[2] > 245,
      `detected ${changes.levels}`);
    // AVI rebuilds missing pts from dts, so transitions need not sit at 1 and 2 s; each must be the first changed frame.
    const [, gray, white] = changes.manifest.frames.map(({ time }) => time);
    const before = await output(directory, 'before', 'frame', video, '--at', `${gray - 0.04},${white - 0.04}`);
    assert.ok(before.levels[0] < 5 && before.levels[1] > 115 && before.levels[1] < 140, `before ${before.levels}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MPEG-PS spans come from packets when the duration estimate stops short', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-seek-'));
  try {
    const video = path.join(directory, 'source.mpg');
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', STEPS, video]);
    const estimate = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', video]));
    assert.ok(Number(estimate.format.duration) < 2.5, `fixture estimate ${estimate.format.duration}`);
    const info = JSON.parse(run(process.execPath, [cli, 'probe', video]));
    assert.ok(info.containerStart > 0);
    assert.deepEqual([info.start, info.durationSource], [0, 'packets']);
    assert.ok(Math.abs(info.end - 3) < 1e-6, `end ${info.end}`);
    const tail = await output(directory, 'tail', 'frame', video, '--at', '2.5,2.99');
    assert.ok(tail.levels.every((value) => value > 245), `tail ${tail.levels}`);
    const overview = await output(directory, 'overview', 'overview', video);
    assert.ok(overview.manifest.frames.at(-1).time > 2.8 && overview.levels.at(-1) > 245);
    const late = spawnSync(process.execPath, [cli, 'frame', video, '--at', '3.01', '--output', path.join(directory, 'late')], { encoding: 'utf8' });
    assert.match(late.stderr, /must be before the video ends at 00:03\.000/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MPEG-PS and TS video delayed after audio keeps its span and images on the container timeline', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-seek-'));
  try {
    for (const [name, codec] of [['delayed.mpg', []], ['delayed.ts', ['-c:v', 'libx264', '-bf', '2', '-pix_fmt', 'yuv420p']]]) {
      const video = path.join(directory, name);
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=5',
        '-itsoffset', '1', '-f', 'lavfi', '-i', STEPS, '-map', '0', '-map', '1', ...codec, '-fps_mode', 'passthrough', video]);
      const info = JSON.parse(run(process.execPath, [cli, 'probe', video]));
      assert.ok(info.containerStart > 0 && info.start > 0.9 && info.start < 1.1, `${name} start ${info.start}`);
      assert.ok(Math.abs(info.end - info.start - 3) < 1e-6, `${name} end ${info.end}`);
      // Output seeking would count from the rebased video start, a second late, and miss the final second.
      const times = [0, 0.6, 1.5, 2.5, 2.99].map((offset) => info.start + offset);
      const images = await output(directory, `${name}-frames`, 'frame', video, '--at', times.join(','));
      assert.deepEqual(images.levels.map((value) => (value < 5 ? 'black' : value > 245 ? 'white' : 'gray')),
        ['black', 'black', 'gray', 'white', 'white'], `${name} ${images.levels}`);
      const early = spawnSync(process.execPath, [cli, 'frame', video, '--at', String(info.start - 0.1), '--output', path.join(directory, 'early')], { encoding: 'utf8' });
      assert.match(early.stderr, /is before the video starts/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('long MPEG-PS/TS spans come from the tail, or from every packet when the tail holds no video keyframe', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-seek-'));
  try {
    // Black for 89 s, then white for the final second.
    const source = "color=black:size=64x48:rate=25:duration=90,drawbox=color=white:t=fill:enable='gte(t,89)'";
    const h264 = ['-c:v', 'libx264', '-bf', '2', '-pix_fmt', 'yuv420p'];
    const fixtures = {
      // Most packets lack pts, so the end comes from decoding the tail.
      'tail.mpg': [],
      // Audio outlasts the video by a minute, so the tail before the estimated end has no video.
      'audio.ts': ['-f', 'lavfi', '-i', 'sine=duration=150', ...h264],
      // One GOP: the tail has no keyframe.
      'gop.ts': [...h264, '-g', '10000', '-x264-params', 'scenecut=0'],
    };
    for (const [name, args] of Object.entries(fixtures)) {
      const video = path.join(directory, name);
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, ...args, video]);
      const info = JSON.parse(run(process.execPath, [cli, 'probe', video]));
      assert.equal(info.durationSource, 'packets', name);
      assert.ok(Math.abs(info.end - info.start - 90) < 1e-6, `${name} span ${info.start}-${info.end}`);
      const tail = await output(directory, `${name}-tail`, 'frame', video, '--at', `${info.start + 88.9},${info.end - 0.01}`);
      assert.ok(tail.levels[0] < 5 && tail.levels[1] > 245, `${name} ${tail.levels}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MPEG-PS decoded end falls back to the packet duration when showinfo logs no frame duration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-seek-'));
  try {
    const video = path.join(directory, 'source.mpg');
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', STEPS, video]);
    // FFmpeg 5.1 logs showinfo frames without duration.
    const real = run('sh', ['-c', 'command -v ffmpeg']).trim();
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'ffmpeg'), `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(real)}, process.argv.slice(2), { stdio: ['ignore', 'inherit', 'pipe'] });
child.stderr.on('data', (chunk) => process.stderr.write(String(chunk).replace(/ duration: *\\d+ duration_time:\\S+/g, '')));
child.on('close', (code) => { process.exitCode = code; });
`);
    await chmod(path.join(bin, 'ffmpeg'), 0o755);
    const info = JSON.parse(run(process.execPath, [cli, 'probe', video],
      { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }));
    assert.ok(Math.abs(info.end - 3) < 1e-6, `end ${info.end}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
