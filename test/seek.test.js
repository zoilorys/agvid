import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
