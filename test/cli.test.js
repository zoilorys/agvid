import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatTimecode } from '../src/cli.js';

const video = path.resolve('test/fixtures/test.mov');
const cli = path.resolve('bin/agvid.js');

function invoke(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

function invokeIn(options, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });
}

function success(...args) {
  const result = invoke(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function ffmpeg(...args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

// FFmpeg 6.0 added -display_rotation; 5.1 takes the rotate tag, which it maps to the same display matrix.
function rotate90(input, output) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-display_rotation', '90', '-i', input, '-c', 'copy', '-y', output]);
  if (result.status !== 0) ffmpeg('-i', input, '-c', 'copy', '-metadata:s:v', 'rotate=90', '-y', output);
}

async function withTempDirectory(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-test-'));
  try { await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function jpegInfo(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,sample_aspect_ratio', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const stream = JSON.parse(result.stdout).streams?.[0];
  assert.equal(stream?.codec_name, 'mjpeg');
  assert.ok(stream.width > 0 && stream.height > 0);
  return stream;
}

test('probe reports the real fixture and frame extracts a bounded JPEG at its requested time', async () => {
  await withTempDirectory(async (directory) => {
    const info = success('probe', video);
    assert.ok(info.duration > 25.5 && info.duration < 25.7);
    assert.ok(info.width > 0 && info.height > 0);
    assert.ok(info.codec);
    // The fixture is VFR: avg_frame_rate 16332/307 differs from r_frame_rate 60/1.
    assert.equal(info.fps, 53.199);
    assert.deepEqual([info.frameCount, info.frameCountEstimated, info.hasAudio], [1361, false, false]);

    const output = success('frame', video, '--at', '00:07.5', '--width', '160', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.frames, [{ file: 'frame-0000_00-07.500.jpg', time: 7.5, timecode: '00:07.500' }]);
    assert.deepEqual((await readdir(directory)).sort(), ['frame-0000_00-07.500.jpg', 'manifest.json']);
    assert.ok(!('sheets' in output) && !('sheets' in manifest));
    const frame = jpegInfo(path.join(output.directory, manifest.frames[0].file));
    assert.ok(frame.width <= 160);
    assert.ok(Math.abs(frame.width / frame.height - info.width / info.height) < 0.03);
  });
});

test('probe of several videos keeps argument order and reports failures inline', async () => {
  await withTempDirectory(async (directory) => {
    const clip = path.join(directory, 'clip.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=10:duration=1', '-pix_fmt', 'yuv420p', clip);
    const both = success('probe', video, clip);
    assert.deepEqual(both.map((entry) => entry.video), [video, clip]);
    assert.equal(both[1].width, 64);

    const missing = path.join(directory, 'missing.mov');
    const result = invoke('probe', video, missing, clip);
    assert.equal(result.status, 1);
    const entries = JSON.parse(result.stdout);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].video, video);
    assert.ok(entries[0].duration > 25);
    assert.deepEqual(Object.keys(entries[1]), ['video', 'error']);
    assert.equal(entries[1].video, missing);
    assert.equal(entries[2].video, clip);

    assert.notEqual(invoke('frame', video, clip, '--at', '1').status, 0);
  });
});

test('selected video stream drives metadata, frames, sheets, and change analysis', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'multi.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi', '-i', 'color=red:size=80x64:rate=4:duration=2',
      '-f', 'lavfi', '-i', 'testsrc2=size=128x96:rate=4:duration=2',
      '-map', '0:a', '-map', '1:v', '-map', '2:v', '-c:a', 'aac', '-c:v', 'mpeg4', '-y', source);

    const first = success('probe', source);
    const second = success('probe', source, '--video-stream=1');
    assert.deepEqual([first.videoStream, first.streamIndex, first.width, first.height], [0, 1, 80, 64]);
    assert.deepEqual([second.videoStream, second.streamIndex, second.width, second.height], [1, 2, 128, 96]);
    const batch = invoke('probe', '--video-stream', '1', source, video);
    assert.equal(batch.status, 1);
    const batched = JSON.parse(batch.stdout);
    assert.equal(batched[0].streamIndex, 2);
    assert.match(batched[1].error, /video stream 1 not found/);

    for (const [command, args] of [
      ['frame', ['--at', '0.5']],
      ['overview', ['--frames', '2']],
      ['inspect', ['--around', '1', '--window', '1s', '--fps', '2']],
      ['changes', ['--threshold', '0.01']],
    ]) {
      const output = success(command, source, '--video-stream', '1', ...args, '--output', path.join(directory, command));
      const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
      assert.deepEqual([manifest.source.videoStream, manifest.source.streamIndex], [1, 2]);
      const frame = jpegInfo(path.join(output.directory, manifest.frames[0].file));
      assert.deepEqual([frame.width, frame.height], [128, 96]);
      if (command !== 'frame') assert.ok(output.sheets.length);
      if (command === 'changes') assert.ok(output.changes > 0);
    }
    const staticChanges = success('changes', source, '--video-stream', '0', '--output', path.join(directory, 'static'));
    assert.equal(staticChanges.changes, 0);

    for (const value of ['-1', '1.5', 'banana', '2']) {
      const out = path.join(directory, `invalid-${value}`);
      const failed = invoke('frame', source, '--video-stream', value, '--at', '0.5', '--output', out);
      assert.notEqual(failed.status, 0);
      assert.equal((await readdir(directory)).includes(path.basename(out)), false);
    }
  });
});

test('frame accepts --option=value spelling and rejects duplicates across spellings', async () => {
  await withTempDirectory(async (directory) => {
    // The filename uses milliseconds; the manifest keeps the requested position.
    const output = success('frame', video, '--at=7.5004', '--width=160', `--output=${directory}`);
    assert.equal(output.directory, directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual([manifest.frames[0].time, manifest.frames[0].file], [7.5004, 'frame-0000_00-07.500.jpg']);
    assert.ok(jpegInfo(path.join(output.directory, manifest.frames[0].file)).width <= 160);
    const duplicate = invoke('frame', video, '--width', '160', '--width=320', '--output', path.join(directory, 'dup'));
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate option: --width\b/);
  });
});

test('empty items in multi-value options are rejected', async () => {
  await withTempDirectory(async (directory) => {
    const out = path.join(directory, 'out');
    for (const [command, args] of [['frame', ['--at', ',']], ['frame', ['--at', '3,']], ['frame', ['--at=1,,2']], ['inspect', ['--around', '1,']]]) {
      const result = invoke(command, video, ...args, '--output', out);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(`empty item in --${command === 'frame' ? 'at' : 'around'}`));
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test('batched frame times are sorted, deduped and sheeted', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('frame', video, '--at=12,3', '--at', '7.5,00:07.5', '--width', '160', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.frames.map((frame) => [frame.file, frame.time]), [
      ['frame-0000_00-03.000.jpg', 3], ['frame-0001_00-07.500.jpg', 7.5], ['frame-0002_00-12.000.jpg', 12]]);
    assert.equal(output.frames, 3);
    assert.deepEqual(manifest.sheets.map((sheet) => [sheet.file, ...sheet.frames]), [['sheet-01.jpg', 0, 2]]);
    jpegInfo(output.sheets[0]);
    for (const frame of manifest.frames) jpegInfo(path.join(directory, frame.file));
  });
});

test('batched inspect groups frames and sheets per window', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('inspect', video, '--around=12', '--around', '3,12', '--window', '1s', '--fps', '4', '--width', '160', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 8);
    assert.deepEqual(manifest.frames.map((frame) => frame.file.slice(0, 10)), Array.from({ length: 8 }, (_, i) => `frame-000${i}`));
    assert.deepEqual(manifest.windows.map((w) => [w.around, w.start, w.end, ...w.frames]), [[3, 2.5, 3.5, 0, 3], [12, 11.5, 12.5, 4, 7]]);
    for (const w of manifest.windows) {
      const times = manifest.frames.slice(w.frames[0], w.frames[1] + 1).map((frame) => frame.time);
      assert.ok(times.every((time, i) => time >= w.start && time <= w.end && (i === 0 || time > times[i - 1])));
      assert.equal(w.sheets.length, 1);
    }
    assert.deepEqual(manifest.windows.flatMap((w) => w.sheets), manifest.sheets.map((sheet) => sheet.file));
    assert.deepEqual(manifest.sheets.map((sheet) => [sheet.file, ...sheet.frames]), [['sheet-01.jpg', 0, 3], ['sheet-02.jpg', 4, 7]]);
    assert.deepEqual(output.sheets, manifest.sheets.map((sheet) => path.join(directory, sheet.file)));
    for (const file of output.sheets) jpegInfo(file);
  });
});

test('overlapping windows stay separate', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('inspect', video, '--around', '5,5.5', '--window', '2s', '--fps', '2', '--width', '160', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.windows.map((w) => w.frames), [[0, 3], [4, 7]]);
    assert.equal(manifest.frames.length, 8);
    assert.equal(new Set(manifest.frames.map((frame) => frame.file)).size, 8);
  });
});

test('single inspect has one window; an out-of-range --around in a batch fails without output', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('inspect', video, '--around', '5.0004', '--width', '160', '--output', path.join(directory, 'one'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.windows.map((w) => [w.around, ...w.frames]), [[5.0004, 0, manifest.frames.length - 1]]);
    const out = path.join(directory, 'bad');
    const result = invoke('inspect', video, '--around', '3,99', '--output', out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--around 01:39\.000 is beyond/);
    assert.deepEqual((await readdir(directory)).sort(), ['one']);
  });
});

test('100+ one-frame windows keep sheet filenames in manifest order', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'clip.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10:duration=30', '-c:v', 'mpeg4', '-y', source);
    const arounds = Array.from({ length: 105 }, (_, i) => (0.5 + i * 0.25).toFixed(2));
    const out = path.join(directory, 'out');
    const output = success('inspect', source, `--around=${arounds.join(',')}`, '--window', '0.09', '--fps', '10', '--output', out);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.windows.length, 105);
    assert.equal(manifest.sheets.length, 105);
    assert.equal(manifest.sheets[0].file, 'sheet-001.jpg');
    const onDisk = (await readdir(out)).filter((file) => file.startsWith('sheet-')).sort();
    assert.deepEqual(onDisk, manifest.sheets.map((sheet) => sheet.file));
  });
});

test('batched inspect over the frame cap fails before creating output', async () => {
  await withTempDirectory(async (directory) => {
    const out = path.join(directory, 'out');
    const result = invoke('inspect', video, '--around', '3,12', '--window', '20s', '--fps', '9', '--output', out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /over 240 frames/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('batched frame with an out-of-range time fails before creating output', async () => {
  await withTempDirectory(async (directory) => {
    const out = path.join(directory, 'out');
    const result = invoke('frame', video, '--at', '3,99', '--output', out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--at 99 must be before the video ends/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('overview samples the video duration when audio continues after it', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'short-video.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-y', source);
    const info = success('probe', source);
    assert.ok(info.duration >= 0.9 && info.duration <= 1.1);
    assert.deepEqual([info.fps, info.frameCount, info.hasAudio], [10, 10, true]);
    const output = success('overview', source, '--frames', '3', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 3);
    assert.ok(manifest.frames.every((frame) => frame.time < 1));
    for (const frame of manifest.frames) jpegInfo(path.join(output.directory, frame.file));
  });
});

test('probe reports displayed dimensions for a rotated video and frames are capped by displayed width', async () => {
  await withTempDirectory(async (directory) => {
    const plain = path.join(directory, 'plain.mp4');
    const rotated = path.join(directory, 'rotated.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=2', '-c:v', 'mpeg4', '-y', plain);
    rotate90(plain, rotated);
    const info = success('probe', rotated);
    assert.deepEqual([info.width, info.height, info.rotation, info.codedWidth, info.codedHeight], [180, 320, 90, 320, 180]);
    const output = success('frame', rotated, '--at', '1', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    const frame = jpegInfo(path.join(output.directory, manifest.frames[0].file));
    assert.ok(Math.abs(frame.width - 180) <= 2 && Math.abs(frame.height - 320) <= 2, `${frame.width}x${frame.height}`);
  });
});

test('a frame time that rounds up to a whole minute carries into the minutes', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'long.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=1:duration=61', '-c:v', 'mpeg4', '-y', source);
    const output = success('frame', source, '--at', '59.9996', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.frames, [{ file: 'frame-0000_01-00.000.jpg', time: 59.9996, timecode: '01:00.000' }]);
    jpegInfo(path.join(output.directory, manifest.frames[0].file));
  });
});

test('sub-millisecond requests near the end of a one-second video stay in bounds', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'one-second.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=10:duration=1', '-c:v', 'mpeg4', '-y', source);
    const frame = success('frame', source, '--at', '0.9996', '--output', path.join(directory, 'frame'));
    const frameManifest = JSON.parse(await readFile(frame.manifest, 'utf8'));
    assert.equal(frameManifest.frames[0].time, 0.9996);
    jpegInfo(path.join(frame.directory, frameManifest.frames[0].file));

    const overview = success('overview', source, '--start', '0', '--end', '0.001', '--frames', '2', '--output', path.join(directory, 'overview'));
    const overviewManifest = JSON.parse(await readFile(overview.manifest, 'utf8'));
    assert.deepEqual(overviewManifest.frames.map(({ time }) => time), [0.00025, 0.00075]);
    assert.ok(overviewManifest.frames.every(({ time }) => time < overviewManifest.range.end));
    for (const { file } of overviewManifest.frames) jpegInfo(path.join(overview.directory, file));

    const inspect = success('inspect', source, '--around', '0.9996', '--window', '0.001', '--output', path.join(directory, 'inspect'));
    const inspectManifest = JSON.parse(await readFile(inspect.manifest, 'utf8'));
    assert.equal(inspectManifest.windows[0].around, 0.9996);
    assert.ok(inspectManifest.frames[0].time >= inspectManifest.windows[0].start);
    assert.ok(inspectManifest.frames[0].time < inspectManifest.windows[0].end);
    jpegInfo(path.join(inspect.directory, inspectManifest.frames[0].file));
  });
});

test('invalid clock fields fail before an extraction starts', async () => {
  await withTempDirectory(async (directory) => {
    for (const [command, options] of [
      ['frame', ['--at', '00:99:99']],
      ['frame', ['--at', '99:00']],
      ['overview', ['--start', '00:01:60']],
      ['inspect', ['--around', '00:60:00']],
    ]) {
      const output = path.join(directory, command);
      const result = invoke(command, video, ...options, '--output', output);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid time:/);
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test('timecodes gain an hour field and carry into it', () => {
  assert.equal(formatTimecode(3599.9996), '1:00:00.000');
  assert.equal(formatTimecode(3661.5), '1:01:01.500');
});

test('a long streamed WebM without duration metadata uses packet timestamps', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'no-duration.webm');
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x36:rate=30:duration=90',
      '-c:v', 'libvpx', '-f', 'webm', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString());
    await writeFile(source, result.stdout);
    const info = success('probe', source);
    assert.equal(info.durationSource, 'packets');
    assert.ok(info.duration >= 89.95 && info.duration <= 90.05, String(info.duration));
    assert.deepEqual([info.fps, info.frameCount, info.frameCountEstimated], [30, 2700, true]);
    const output = success('overview', source, '--frames', '3', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 3);
    assert.ok(manifest.frames.every((frame) => frame.time < 90));
    for (const frame of manifest.frames) jpegInfo(path.join(output.directory, frame.file));
  });
});

test('a raw elementary stream fails with advice that produces a usable video', async () => {
  await withTempDirectory(async (directory) => {
    for (const [name, codec] of [['raw-video.m2v', ['-c:v', 'mpeg2video', '-f', 'mpeg2video']], ['raw-video.h264', ['-c:v', 'libx264', '-bf', '2', '-f', 'h264']]]) {
      const source = path.join(directory, name);
      ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1', ...codec, '-y', source);
      const output = path.join(directory, 'out');
      const result = invoke('overview', source, '--output', output);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /video stream 0 has no timestamps.*e\.g\. ffmpeg -r FPS -i VIDEO out\.mp4/);
      assert.ok(!(await readdir(directory)).includes('out'));
      const remuxed = path.join(directory, `${name}.mp4`);
      ffmpeg('-r', '10', '-i', source, remuxed);
      const info = success('probe', remuxed);
      assert.deepEqual([info.start, info.end, info.frameCount], [0, 1, 10], name);
    }
  });
});

test('extraction uses the video stream reported by probe', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'two-streams.mkv');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=5:duration=2',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=5:duration=2',
      '-map', '0:v', '-map', '1:v', '-c:v', 'mpeg4',
      '-disposition:v:0', '0', '-disposition:v:1', 'default', '-y', source);
    const output = success('frame', source, '--at', '0.5', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    const frame = jpegInfo(path.join(output.directory, manifest.frames[0].file));
    assert.equal(manifest.source.width, 128);
    assert.equal(manifest.source.height, 128);
    assert.equal(frame.width, 128);
    assert.equal(frame.height, 128);
  });
});

test('anamorphic frames and contact sheets use square pixels', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'anamorphic.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1',
      '-vf', 'setsar=2/1', '-c:v', 'mpeg4', '-y', source);
    const output = success('overview', source, '--frames', '1', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    const frame = jpegInfo(path.join(output.directory, manifest.frames[0].file));
    const sheet = jpegInfo(output.sheets[0]);
    for (const image of [frame, sheet]) {
      assert.equal(image.sample_aspect_ratio, '1:1');
      assert.ok(Math.abs(image.width / image.height - 32 / 9) < 0.1);
    }
  });
});

// Share of pixels that are clearly red (not the blue background) in a decoded image.
function redShare(file) {
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  let red = 0;
  for (let i = 0; i < decoded.stdout.length; i += 3) {
    if (decoded.stdout[i] > 150 && decoded.stdout[i + 2] < 100) red++;
  }
  return red / (decoded.stdout.length / 3);
}

test('crop selects the displayed region at native resolution and sheets tile it', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'quadrant.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'color=blue:size=1280x720:rate=10:duration=2',
      '-vf', 'drawbox=x=640:y=0:w=640:h=360:color=red:t=fill', '-c:v', 'mpeg4', '-q:v', '2', '-y', source);
    const output = success('frame', source, '--at', '1', '--crop=0.5,0,0.5,0.5', '--output', path.join(directory, 'frame'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.crop, { x: 0.5, y: 0, w: 0.5, h: 0.5, pixels: { x: 640, y: 0, width: 640, height: 360, displayed: { width: 640, height: 360 } } });
    const file = path.join(output.directory, manifest.frames[0].file);
    const image = jpegInfo(file);
    assert.deepEqual([image.width, image.height], [640, 360]);
    assert.ok(redShare(file) > 0.98);

    const overview = success('overview', source, '--frames', '2', '--crop', '0.5,0,0.5,0.5', '--width', '160', '--output', path.join(directory, 'overview'));
    const sheet = JSON.parse(await readFile(overview.manifest, 'utf8')).sheets[0];
    assert.ok(Math.abs(sheet.tileWidth / sheet.tileHeight - 16 / 9) < 0.1, `${sheet.tileWidth}x${sheet.tileHeight}`);
    assert.ok(redShare(overview.sheets[0]) > 0.9);
  });
});

test('crop on a rotated source uses the displayed orientation', async () => {
  await withTempDirectory(async (directory) => {
    const plain = path.join(directory, 'plain.mp4');
    const rotated = path.join(directory, 'rotated.mp4');
    // Red left and right quarters become the top and bottom bands after a 90 degree turn in either direction.
    ffmpeg('-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=10:duration=2',
      '-vf', 'drawbox=x=0:y=0:w=80:h=180:color=red:t=fill,drawbox=x=240:y=0:w=80:h=180:color=red:t=fill',
      '-c:v', 'mpeg4', '-q:v', '2', '-y', plain);
    rotate90(plain, rotated);
    const output = success('frame', rotated, '--at', '1', '--crop', '0,0,1,0.25', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.crop.pixels, { x: 0, y: 0, width: 180, height: 80, displayed: { width: 180, height: 80 } });
    const file = path.join(output.directory, manifest.frames[0].file);
    const image = jpegInfo(file);
    assert.deepEqual([image.width, image.height], [180, 80]);
    assert.ok(redShare(file) > 0.95);
  });
});

test('crop on anamorphic sources is capped at the displayed crop size with square pixels', async () => {
  await withTempDirectory(async (directory) => {
    for (const [sar, displayed] of [['2/1', [320, 90]], ['1/2', [80, 90]]]) {
      const source = path.join(directory, `sar-${sar.replace('/', '-')}.mp4`);
      ffmpeg('-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=10:duration=2',
        '-vf', `drawbox=x=160:y=0:w=160:h=90:color=red:t=fill,setsar=${sar}`, '-c:v', 'mpeg4', '-q:v', '2', '-y', source);
      const output = success('frame', source, '--at', '1', '--crop=0.5,0,0.5,0.5', '--output', path.join(directory, `out-${sar.replace('/', '-')}`));
      const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
      assert.deepEqual(manifest.crop.pixels, { x: 160, y: 0, width: 160, height: 90, displayed: { width: displayed[0], height: displayed[1] } });
      const file = path.join(output.directory, manifest.frames[0].file);
      const image = jpegInfo(file);
      assert.equal(image.sample_aspect_ratio, '1:1');
      assert.ok(image.width <= displayed[0] && image.height <= displayed[1], `${sar}: ${image.width}x${image.height}`);
      assert.deepEqual([image.width, image.height], displayed);
      assert.ok(redShare(file) > 0.95);
    }
  });
});

test('inspect frames and sheets use the crop', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'quadrant.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=10:duration=2',
      '-vf', 'drawbox=x=160:y=0:w=160:h=90:color=red:t=fill', '-c:v', 'mpeg4', '-q:v', '2', '-y', source);
    const output = success('inspect', source, '--around', '1', '--window', '1s', '--fps', '2', '--crop', '0.5,0,0.5,0.5', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.outputWidth, 160);
    for (const frame of manifest.frames) {
      const file = path.join(output.directory, frame.file);
      assert.deepEqual([jpegInfo(file).width, jpegInfo(file).height], [160, 90]);
      assert.ok(redShare(file) > 0.95);
    }
    assert.ok(redShare(output.sheets[0]) > 0.9);
  });
});

test('invalid crops are rejected before any output is created', async () => {
  await withTempDirectory(async (directory) => {
    const out = path.join(directory, 'out');
    for (const [crop, message] of [['0.8,0,0.5,1', /must fit/], ['0,0,0,1', /above 0/], ['0,0,1', /four fractions/],
      ['0,0,1.5,1', /four fractions/], ['0,0,0.005,1', /at least 16x16/]]) {
      const result = invoke('frame', video, '--at', '1', '--crop', crop, '--output', out);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test('inspect clips near the end and produces decodable JPEGs at the requested source positions', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('inspect', video, '--around', '25.58', '--window', '2s', '--fps', '4', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 5);
    const times = manifest.frames.map((frame) => frame.time);
    assert.ok(times.every((time) => time >= 24.58 && time < manifest.source.duration));
    assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]));
    assert.ok(times.at(-1) > 25.5);
    for (const frame of manifest.frames) {
      jpegInfo(path.join(output.directory, frame.file));
    }
    const names = manifest.frames.map((frame) => frame.file);
    assert.deepEqual((await readdir(directory)).filter((file) => file.startsWith('frame-')).sort(), names);
    assert.deepEqual(Object.keys(output), ['directory', 'sheets', 'manifest', 'frames']);
    assert.deepEqual(output.sheets, manifest.sheets.map((sheet) => path.join(directory, sheet.file)));
    let next = 0;
    for (const sheet of manifest.sheets) {
      assert.equal(sheet.frames[0], next);
      next = sheet.frames[1] + 1;
      jpegInfo(path.join(directory, sheet.file));
    }
    assert.equal(next, 5);
  });
});

test('overview writes a contact sheet and JPEGs mapped to source times', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('overview', video, '--frames', '5', '--width', '160', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 5);
    assert.deepEqual(manifest.sheets.map((sheet) => [sheet.file, ...sheet.frames]), [['sheet-01.jpg', 0, 4]]);
    assert.ok(manifest.frames.every((frame) => frame.time > 0 && frame.time < manifest.source.duration));
    // 160x100 tiles: 2x3 (320x300) is closer to square than 3x2 (480x200).
    assert.equal(jpegInfo(output.sheets[0]).width, 320);
    for (const frame of manifest.frames) jpegInfo(path.join(output.directory, frame.file));
    for (const frame of manifest.frames) assert.ok(frame.file.endsWith(`_${frame.timecode.replaceAll(':', '-')}.jpg`), frame.file);
    assert.deepEqual((await readdir(directory)).sort(), [...manifest.frames.map((frame) => frame.file), 'manifest.json', 'sheet-01.jpg']);
  });
});

test('overview samples only the requested section and rejects bad ranges before output', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('overview', video, '--start=10', '--end', '00:20', '--frames', '5', '--width', '160', '--output', path.join(directory, 'ok'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.range, { start: 10, end: 20 });
    assert.deepEqual(manifest.frames.map((frame) => frame.time), [11, 13, 15, 17, 19]);

    const clamped = success('overview', video, '--start', '20', '--end', '999', '--frames', '2', '--width', '160', '--output', path.join(directory, 'clamped'));
    const clampedManifest = JSON.parse(await readFile(clamped.manifest, 'utf8'));
    assert.equal(clampedManifest.range.start, 20);
    assert.ok(Math.abs(clampedManifest.range.end - clampedManifest.source.duration) < 0.001);
    assert.ok(clampedManifest.frames.every((frame) => frame.time > 20 && frame.time < clampedManifest.source.duration));

    for (const args of [['--start', '20', '--end', '10'], ['--start', '10', '--end', '10'], ['--start', '99']]) {
      const bad = invoke('overview', video, ...args, '--output', path.join(directory, 'bad'));
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /--start/);
    }
    assert.deepEqual((await readdir(directory)).sort(), ['clamped', 'ok']);
    assert.ok(!('range' in JSON.parse(await readFile(success('overview', video, '--frames', '1', '--width', '160', '--output', path.join(directory, 'plain')).manifest, 'utf8'))));
  });
});

test('inspect by explicit range samples one window and rejects mixing with --around', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('inspect', video, '--start=3', '--end', '5', '--fps', '4', '--width', '160', '--output', path.join(directory, 'ok'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 8);
    assert.ok(manifest.frames.every((frame) => frame.time >= 3 && frame.time < 5));
    assert.equal(manifest.windows.length, 1);
    const [window] = manifest.windows;
    assert.deepEqual([window.around, window.start, window.end, ...window.frames], [null, 3, 5, 0, 7]);
    assert.equal(window.sheets.length, 1);

    const open = success('inspect', video, '--start', '25', '--fps', '2', '--width', '160', '--output', path.join(directory, 'open'));
    const openManifest = JSON.parse(await readFile(open.manifest, 'utf8'));
    assert.equal(openManifest.windows[0].start, 25);
    assert.ok(Math.abs(openManifest.windows[0].end - openManifest.source.duration) < 0.001);

    for (const args of [['--start', '3', '--around', '4'], ['--end', '5', '--window', '1s']]) {
      const bad = invoke('inspect', video, ...args, '--output', path.join(directory, 'bad'));
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /cannot be combined/);
    }
    const none = invoke('inspect', video, '--output', path.join(directory, 'bad'));
    assert.match(none.stderr, /requires --around or --start\/--end/);
    assert.deepEqual((await readdir(directory)).sort(), ['ok', 'open']);
  });
});

// 1280x720 at 10 fps: an 80x40 toast inside the top-left quarter from 1.5 s, a 400x300 panel outside it from 3 s.
function uiClip(directory) {
  const source = path.join(directory, 'ui.mp4');
  ffmpeg('-f', 'lavfi', '-i', 'color=black:size=1280x720:rate=10:duration=4.5',
    '-vf', "drawbox=x=40:y=40:w=80:h=40:color=white:t=fill:enable='gte(t,1.5)',drawbox=x=700:y=300:w=400:h=300:color=white:t=fill:enable='gte(t,3)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
  return source;
}

async function changesManifest(output) {
  const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
  assert.equal(output.changes, manifest.frames.length - 1);
  assert.deepEqual([manifest.frames[0].time, manifest.frames[0].score], [manifest.range?.start ?? manifest.source.start, null]);
  for (const frame of manifest.frames.slice(1)) assert.ok(frame.score > manifest.detection.threshold, JSON.stringify(frame));
  for (const file of [...manifest.frames.map((frame) => frame.file), ...manifest.sheets.map((sheet) => sheet.file)]) jpegInfo(path.join(output.directory, file));
  return manifest;
}

test('changes finds small and large UI changes', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('changes', uiClip(directory), '--width', '160', '--output', path.join(directory, 'out'));
    const manifest = await changesManifest(output);
    assert.equal(output.changes, 2);
    const [toast, panel] = manifest.frames.slice(1).map((frame) => frame.time);
    assert.ok(Math.abs(toast - 1.5) <= 0.1 && Math.abs(panel - 3) <= 0.1, `${toast} ${panel}`);
    assert.deepEqual([manifest.detection.threshold, manifest.detection.minGap, manifest.detection.candidates, manifest.detection.truncated], [0.002, 0.5, 2, false]);
  });
});

test('changes detects a color swap with nearly unchanged grayscale brightness', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'color.mp4');
    // Red (Y≈54) becomes dark green (Y≈54); grayscale analysis misses the panel.
    ffmpeg('-f', 'lavfi', '-i', 'color=0xff0000:size=320x180:rate=30:duration=2',
      '-vf', "drawbox=x=40:y=30:w=240:h=120:color=0x004c00:t=fill:enable='gte(t,1)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
    const output = success('changes', source, '--output', path.join(directory, 'out'));
    const manifest = await changesManifest(output);
    assert.equal(output.changes, 1);
    assert.ok(Math.abs(manifest.frames[1].time - 1) <= 0.04, String(manifest.frames[1].time));
    assert.match(manifest.detection.metric, /RGB any-channel-diff>16@256x\d+px,30fps/);
  });
});

test('changes samples a brief UI flash between 10 fps ticks', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'flash.mp4');
    // The panel exists only at 0.55 and 0.567 s in a 60 fps source.
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=320x180:rate=60:duration=1',
      '-vf', "drawbox=x=40:y=20:w=240:h=140:color=white:t=fill:enable='between(n,33,34)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
    const output = success('changes', source, '--output', path.join(directory, 'out'));
    const manifest = await changesManifest(output);
    assert.ok(manifest.frames.some((frame) => Math.abs(frame.time - 34 / 60) < 0.002), JSON.stringify(manifest.frames));
    const coarse = success('changes', source, '--analysis-fps', '10', '--output', path.join(directory, 'coarse'));
    assert.equal(coarse.changes, 0);
  });
});

test('crop restricts detection and ranges bound it', async () => {
  await withTempDirectory(async (directory) => {
    const source = uiClip(directory);
    const output = success('changes', source, '--crop=0,0,0.25,0.25', '--threshold=0.002', '--min-gap=0.5', '--output', path.join(directory, 'crop'));
    const manifest = await changesManifest(output);
    assert.equal(output.changes, 1);
    assert.ok(Math.abs(manifest.frames[1].time - 1.5) <= 0.1, String(manifest.frames[1].time));
    assert.deepEqual(manifest.crop.pixels, { x: 0, y: 0, width: 320, height: 180, displayed: { width: 320, height: 180 } });

    const ranged = success('changes', source, '--start', '2', '--end', '4', '--width', '160', '--output', path.join(directory, 'range'));
    const rangedManifest = await changesManifest(ranged);
    assert.deepEqual(rangedManifest.range, { start: 2, end: 4 });
    assert.equal(ranged.changes, 1);
    assert.ok(Math.abs(rangedManifest.frames[1].time - 3) <= 0.1, String(rangedManifest.frames[1].time));

    for (const args of [['--threshold', '0'], ['--threshold', '1.5'], ['--max', '240'], ['--min-gap', '-1']]) {
      const bad = invoke('changes', source, ...args, '--output', path.join(directory, 'bad'));
      assert.notEqual(bad.status, 0);
    }
    assert.deepEqual((await readdir(directory)).sort(), ['crop', 'range', 'ui.mp4']);
  });
});

test('static clip yields only baseline', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'static.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=10:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
    const output = success('changes', source, '--output', path.join(directory, 'out'));
    const manifest = await changesManifest(output);
    assert.equal(output.changes, 0);
    assert.equal(manifest.frames.length, 1);
    assert.deepEqual([manifest.detection.candidates, manifest.detection.truncated], [0, false]);
  });
});

test('max truncates by score', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'flash.mp4');
    // A 16x16 box toggles every frame (over 100 small changes); a 160x120 panel shows only on frames 5, 15, 25...,
    // so frames 5 and 6 of each ten differ from the last candidate by the whole panel.
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=320x180:rate=10:duration=12',
      '-vf', "drawbox=x=10:y=10:w=16:h=16:color=white:t=fill:enable='mod(n,2)',drawbox=x=120:y=40:w=160:h=120:color=white:t=fill:enable='eq(mod(n,10),5)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
    const output = success('changes', source, '--min-gap=0', '--max', '10', '--output', path.join(directory, 'out'));
    const manifest = await changesManifest(output);
    assert.equal(output.changes, 10);
    assert.equal(manifest.detection.truncated, true);
    assert.ok(manifest.detection.candidates >= 100, String(manifest.detection.candidates));
    const kept = manifest.frames.slice(1);
    for (const frame of kept) {
      assert.ok(frame.score > 0.2, JSON.stringify(frame));
      assert.ok([5, 6].includes(Math.round(frame.time * 10) % 10), JSON.stringify(frame));
    }
    const times = manifest.frames.map((frame) => frame.time);
    assert.ok(times.every((time, i) => i === 0 || time > times[i - 1]), times.join());

    const gapped = success('changes', source, '--min-gap', '1', '--max', '239', '--output', path.join(directory, 'gap'));
    const gappedManifest = await changesManifest(gapped);
    const gappedTimes = gappedManifest.frames.map((frame) => frame.time);
    assert.ok(gappedTimes.length > 2);
    assert.ok(gappedTimes.every((time, i) => i === 0 || time - gappedTimes[i - 1] >= 1 - 1e-9), gappedTimes.join());
    assert.ok(gappedManifest.detection.candidates < manifest.detection.candidates);
  });
});

test('changes on a sparse VFR clip reports source frame times and extracts those frames', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'sparse.mp4');
    // Frames only at 0, 1.47 and 3.0 s: box A from 1.47 s, box B added at 3.0 s.
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=320x180:rate=100:duration=3.5',
      '-vf', "drawbox=x=20:y=20:w=80:h=60:color=white:t=fill:enable='gte(n,147)',drawbox=x=200:y=100:w=80:h=60:color=white:t=fill:enable='gte(n,300)',select='eq(n,0)+eq(n,147)+eq(n,300)'",
      '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
    const output = success('changes', source, '--width', '320', '--output', path.join(directory, 'out'));
    const manifest = await changesManifest(output);
    const first = manifest.frames[1];
    assert.ok(Math.abs(first.time - 1.47) <= 0.001, String(first.time));
    const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(output.directory, first.file),
      '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.ok(decoded.stdout[50 * 320 + 60] > 128, 'box A lit');
    assert.ok(decoded.stdout[130 * 320 + 240] < 64, 'box B not yet shown');
  });
});

test('sheet tiles of a black clip are bright only in their bottom-left label boxes', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'black.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=320x180:rate=10:duration=4', '-c:v', 'mpeg4', '-y', source);
    const out = path.join(directory, 'out');
    const output = success('overview', source, '--frames', '6', '--output', out);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    const [{ columns, rows, tileWidth, tileHeight }] = manifest.sheets;
    const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output.sheets[0], '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    const width = columns * tileWidth;
    assert.equal(decoded.stdout.length, width * rows * tileHeight);
    const lit = new Array(6).fill(false);
    for (let y = 0; y < rows * tileHeight; y++) {
      for (let x = 0; x < width; x++) {
        if (decoded.stdout[y * width + x] <= 128) continue;
        const tile = Math.floor(y / tileHeight) * columns + Math.floor(x / tileWidth);
        const inBox = tile < 6 && y % tileHeight >= tileHeight * 0.75 && x % tileWidth < tileWidth * 0.75;
        assert.ok(inBox, `bright pixel outside label boxes at ${x},${y}`);
        lit[tile] = true;
      }
    }
    assert.deepEqual(lit, new Array(6).fill(true));
    assert.deepEqual((await readdir(out)).filter((file) => !/^frame-.*\.jpg$/.test(file)).sort(), ['manifest.json', 'sheet-01.jpg']);
  });
});

test('tiles too small for a whole label stay unlabeled', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'tiny.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=32x18:rate=10:duration=2', '-c:v', 'mpeg4', '-y', source);
    const out = path.join(directory, 'out');
    const output = success('overview', source, '--frames', '3', '--output', out);
    const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', output.sheets[0], '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.ok(decoded.stdout.length > 0 && decoded.stdout.every((value) => value <= 128));
    assert.deepEqual((await readdir(out)).filter((file) => !/^frame-.*\.jpg$/.test(file)).sort(), ['manifest.json', 'sheet-01.jpg']);
  });
});

test('64-frame overview paginates into budgeted sheets covering every frame in order', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('overview', video, '--frames', '64', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.ok(manifest.sheets.length >= 2 && manifest.sheets.length <= 4, `${manifest.sheets.length} sheets`);
    assert.deepEqual(output.sheets, manifest.sheets.map((sheet) => path.join(directory, sheet.file)));
    let next = 0;
    for (const sheet of manifest.sheets) {
      const [first, last] = sheet.frames;
      assert.ok(first === next && last > first, JSON.stringify(sheet));
      assert.equal(sheet.start, manifest.frames[first].time);
      assert.equal(sheet.end, manifest.frames[last].time);
      next = last + 1;
      const image = jpegInfo(path.join(directory, sheet.file));
      assert.ok(image.width <= 1568 && image.height <= 1568, `${image.width}x${image.height}`);
    }
    assert.equal(next, 64);
  });
});

test('odd-width frames under the tile minimum still share one sheet', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('overview', video, '--width', '101', '--output', directory);
    assert.equal(output.sheets.length, 1);
    const sheet = jpegInfo(output.sheets[0]);
    assert.ok(sheet.width <= 1568 && sheet.height <= 1568, `${sheet.width}x${sheet.height}`);
  });
});

test('portrait source sheet is within budget and laid out wide', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'portrait.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=10:duration=2', '-c:v', 'mpeg4', '-y', source);
    const output = success('overview', source, '--output', path.join(directory, 'out'));
    assert.equal(output.sheets.length, 1);
    const sheet = jpegInfo(output.sheets[0]);
    // 12 tiles at 360x640 exceed the height budget; a 4-column grid would be 1440x1920.
    assert.ok(sheet.width <= 1568 && sheet.height <= 1568, `${sheet.width}x${sheet.height}`);
    assert.ok(sheet.width >= sheet.height * 0.8, `${sheet.width}x${sheet.height}`);
    // 65x116 frames round to 64x114 tiles; they must still share one sheet.
    const small = success('overview', source, '--width', '65', '--output', path.join(directory, 'small'));
    assert.equal(small.sheets.length, 1);
    const smallSheet = jpegInfo(small.sheets[0]);
    assert.ok(smallSheet.width <= 1568 && smallSheet.height <= 1568, `${smallSheet.width}x${smallSheet.height}`);
  });
});

test('an occupied explicit output directory is rejected without changing its contents', async () => {
  await withTempDirectory(async (directory) => {
    const sentinel = path.join(directory, 'keep.txt');
    await writeFile(sentinel, 'keep this');
    const result = invoke('frame', video, '--at', '1', '--output', directory);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(sentinel, 'utf8'), 'keep this');
    assert.deepEqual(await readdir(directory), ['keep.txt']);
  });
});

test('default output goes under the git root .agvid folder and stays out of git status', async () => {
  await withTempDirectory(async (directory) => {
    const repo = await realpath(directory);
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
    const sub = path.join(repo, 'sub', 'dir');
    await mkdir(sub, { recursive: true });
    const result = invokeIn({ cwd: sub }, 'frame', video, '--at', '1');
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(path.dirname(output.directory), path.join(repo, '.agvid', 'runs'));
    jpegInfo(path.join(output.directory, 'frame-0000_00-01.000.jpg'));
    assert.equal(await readFile(path.join(repo, '.agvid', '.gitignore'), 'utf8'), '*\n');
    await writeFile(path.join(sub, 'tracked.txt'), 'x');
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, '?? sub/dir/tracked.txt\n');
  });
});

test('outside a git repo default output goes under the cwd .agvid folder', async () => {
  await withTempDirectory(async (directory) => {
    const cwd = await realpath(directory);
    const output = JSON.parse(invokeIn({ cwd }, 'frame', video, '--at', '1').stdout);
    assert.equal(path.dirname(output.directory), path.join(cwd, '.agvid', 'runs'));
  });
});

test('a failed extraction removes directories agvid created and nothing else', async () => {
  await withTempDirectory(async (directory) => {
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'ffmpeg'), '#!/bin/sh\nexit 1\n');
    await chmod(path.join(bin, 'ffmpeg'), 0o755);
    const options = { cwd: directory, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
    const failed = invokeIn(options, 'frame', video, '--at', '1');
    assert.notEqual(failed.status, 0);
    assert.deepEqual(await readdir(path.join(directory, '.agvid', 'runs')), []);
    const empty = path.join(directory, 'empty');
    await mkdir(empty);
    for (const output of ['out', 'nested/a/out', 'empty']) {
      const explicit = invokeIn(options, 'frame', video, '--at', '1', '--output', path.join(directory, output));
      assert.notEqual(explicit.status, 0);
      assert.match(explicit.stderr, /ffmpeg exited/);
    }
    assert.deepEqual((await readdir(directory)).sort(), ['.agvid', 'bin', 'empty']);
    assert.deepEqual(await readdir(empty), []);
  });
});

test('a failure mid-way through parallel extraction waits for in-flight jobs and removes the run', async () => {
  await withTempDirectory(async (directory) => {
    const real = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
    assert.ok(real);
    const bin = path.join(directory, 'bin');
    const calls = path.join(directory, 'calls');
    await mkdir(bin);
    // mkdir is atomic, so exactly one concurrent call claims number 3 and fails fast while the others are still running.
    await writeFile(path.join(bin, 'ffmpeg'), `#!/bin/sh
n=1; while ! mkdir "${calls}/$n" 2>/dev/null; do n=$((n+1)); done
[ "$n" -eq 3 ] && exit 1
sleep 0.3
exec "${real}" "$@"
`);
    await chmod(path.join(bin, 'ffmpeg'), 0o755);
    const options = { cwd: directory, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
    // An existing empty directory takes per-file cleanup, so a job still writing after cleanup would leave a JPEG behind.
    const empty = path.join(directory, 'empty');
    await mkdir(empty);
    for (const output of [[], ['--output', path.join(directory, 'out')], ['--output', empty]]) {
      await rm(calls, { recursive: true, force: true });
      await mkdir(calls);
      const failed = invokeIn(options, 'overview', video, '--frames', '8', '--width', '160', ...output);
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /ffmpeg exited 1/);
      assert.ok((await readdir(calls)).length >= 3);
    }
    assert.deepEqual(await readdir(path.join(directory, '.agvid', 'runs')), []);
    assert.deepEqual(await readdir(empty), []);
    assert.deepEqual((await readdir(directory)).sort(), ['.agvid', 'bin', 'calls', 'empty']);
  });
});

test('an unwritable project root fails with a clear error', { skip: process.getuid?.() === 0 }, async () => {
  await withTempDirectory(async (directory) => {
    await chmod(directory, 0o555);
    try {
      const result = invokeIn({ cwd: directory }, 'frame', video, '--at', '1');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot write output under/);
      assert.match(result.stderr, /--output/);
    } finally { await chmod(directory, 0o755); }
  });
});

test('an excessive extraction request fails before creating its output directory', async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, 'too-many');
    const result = invoke('inspect', video, '--around', '12', '--window', '20s', '--fps', '60', '--output', output);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('changes rejects FFmpeg older than 5.1 before creating output, and accepts 5.1', async () => {
  await withTempDirectory(async (directory) => {
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    const shim = path.join(bin, 'ffmpeg');
    const realFfmpeg = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' }).stdout.trim();
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const versioned = (version) => writeFile(shim, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg version ${version} Copyright"; exit 0; fi\nexec ${realFfmpeg} "$@"\n`);
    await chmod(bin, 0o755);
    for (const version of ['4.4.2', 'n5.0.3', '3.4']) {
      await versioned(version);
      await chmod(shim, 0o755);
      const result = invokeIn({ cwd: directory, env }, 'changes', video, '--output', path.join(directory, 'out'));
      assert.notEqual(result.status, 0, version);
      assert.match(result.stderr, /changes needs FFmpeg 5\.1 or newer/);
    }
    assert.deepEqual((await readdir(directory)).sort(), ['bin']);
    await versioned('5.1.2');
    await chmod(shim, 0o755);
    const ok = invokeIn({ cwd: directory, env }, 'changes', video, '--end', '3', '--output', path.join(directory, 'out'));
    assert.equal(ok.status, 0, ok.stderr);
  });
});

// Mean gray level (0-255) of the left and right halves of a decoded image.
function halves(file) {
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=32:16', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { encoding: 'buffer' });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const sums = [0, 0];
  decoded.stdout.forEach((value, i) => { sums[i % 32 < 16 ? 0 : 1] += value; });
  return sums.map((sum) => sum / 256);
}

// 160x90 at 10 fps for 3 s; the left half turns white 1.5 s into the video stream.
const HALF_FLIP = "color=black:size=160x90:rate=10:duration=3,drawbox=w=80:h=90:color=white:t=fill:enable='gte(t,1.5)'";

test('a video stream starting after the audio keeps container times across commands', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'delayed.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'sine=duration=5', '-itsoffset', '2', '-f', 'lavfi', '-i', HALF_FLIP,
      '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-y', source);
    const info = success('probe', source);
    assert.deepEqual([info.start, info.end, info.duration, info.containerStart], [2, 5, 3, 0]);

    const changes = success('changes', source, '--output', path.join(directory, 'changes'));
    const manifest = await changesManifest(changes);
    assert.equal(manifest.frames[0].time, 2);
    assert.deepEqual(manifest.frames.slice(1).map((frame) => frame.time), [3.5]);
    const [left, right] = halves(path.join(changes.directory, manifest.frames[1].file));
    assert.ok(left > 200 && right < 40, `${left} ${right}`);
    assert.ok(halves(path.join(changes.directory, manifest.frames[0].file))[0] < 40);

    const overview = JSON.parse(await readFile(success('overview', source, '--frames', '3', '--output', path.join(directory, 'overview')).manifest, 'utf8'));
    assert.deepEqual(overview.frames.map((frame) => frame.time), [2.5, 3.5, 4.5]);
    const ranged = JSON.parse(await readFile(success('overview', source, '--start', '0', '--end', '9', '--frames', '1', '--output', path.join(directory, 'ranged')).manifest, 'utf8'));
    assert.deepEqual(ranged.range, { start: 2, end: 5 });
    const inspect = JSON.parse(await readFile(success('inspect', source, '--around', '4.9', '--window', '1s', '--fps', '2', '--output', path.join(directory, 'inspect')).manifest, 'utf8'));
    assert.deepEqual([inspect.windows[0].start, inspect.windows[0].end], [4.4, 5]);

    for (const [command, args, message] of [['frame', ['--at', '1'], /--at 1 is before the video starts at 00:02\.000/],
      ['inspect', ['--around', '1.5'], /before the video starts/], ['overview', ['--start', '5'], /must be before the video ends/]]) {
      const bad = invoke(command, source, ...args, '--output', path.join(directory, 'bad'));
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, message);
    }
    assert.ok(!(await readdir(directory)).includes('bad'));
  });
});

test('a nonzero container start time is timeline zero', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'shifted.mkv');
    ffmpeg('-f', 'lavfi', '-i', HALF_FLIP, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', '7', '-y', source);
    const info = success('probe', source);
    // The Matroska DURATION tag holds the raw endpoint (10 s); subtract the stream's 7 s start.
    assert.deepEqual([info.containerStart, info.start, info.end, info.durationSource], [7, 0, 3, 'tag']);
    const changes = success('changes', source, '--output', path.join(directory, 'changes'));
    const manifest = await changesManifest(changes);
    assert.deepEqual(manifest.frames.map((frame) => frame.time), [0, 1.5]);
    const frames = JSON.parse(await readFile(success('frame', source, '--at', '1.4,1.6', '--output', path.join(directory, 'frame')).manifest, 'utf8'));
    assert.deepEqual(frames.frames.map((frame) => halves(path.join(directory, 'frame', frame.file))[0] > 200), [false, true]);
  });
});

test('a shifted WebM uses its duration tag when optional packet durations are unavailable', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'shifted.webm');
    ffmpeg('-f', 'lavfi', '-i', HALF_FLIP, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
      '-pix_fmt', 'yuv420p', '-output_ts_offset', '2', '-y', source);
    const data = await readFile(source);
    // DefaultDuration is optional in Matroska. Replace its 8-byte element with an equally sized EBML Void,
    // keeping cluster offsets and the endpoint tag intact while removing assumed packet durations.
    const offset = data.indexOf(Buffer.from([0x23, 0xe3, 0x83, 0x84]));
    assert.ok(offset >= 0, 'generated WebM has no 4-byte DefaultDuration');
    Buffer.from([0xec, 0x86, 0, 0, 0, 0, 0, 0]).copy(data, offset);
    await writeFile(source, data);
    const raw = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'packet=duration,duration_time:stream=start_time:stream_tags=DURATION', '-of', 'json', source], { encoding: 'utf8' });
    assert.equal(raw.status, 0, raw.stderr);
    const metadata = JSON.parse(raw.stdout);
    assert.deepEqual([metadata.streams[0].start_time, metadata.streams[0].tags.DURATION], ['2.000000', '00:00:05.000000000']);
    assert.equal(metadata.packets.length, 30);
    assert.ok(metadata.packets.every((packet) => packet.duration === undefined && packet.duration_time === undefined));

    const info = success('probe', source);
    assert.deepEqual([info.containerStart, info.start, info.end, info.duration, info.durationSource], [2, 0, 3, 3, 'tag']);
    const output = success('frame', source, '--at', '0.5,2.95', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.frames.map((frame) => frame.time), [0.5, 2.95]);
    assert.deepEqual(manifest.frames.map((frame) => halves(path.join(output.directory, frame.file))[0] > 200), [false, true]);
  });
});

test('changes keeps the exact pts of a one-frame flash when showinfo logs six-digit pts_time', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'late-flash.mp4');
    // At 60 fps frame 6001 is at 100.0166667 s; FFmpeg 5.1 logs its pts_time as 100.017, after the frame.
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=64x36:rate=60:duration=101',
      '-vf', "drawbox=color=white:t=fill:enable='eq(n,6001)'", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', source);
    const real = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'ffmpeg'), `#!${process.execPath}
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(real)}, process.argv.slice(2), { stdio: ['inherit', 'inherit', 'pipe'] });
let pending = '';
const legacy = (text) => text.replace(/pts_time:(-?[\\d.e+-]+)/g, (_, t) => 'pts_time:' + Number(Number(t).toPrecision(6)));
child.stderr.on('data', (chunk) => { const lines = (pending + chunk).split('\\n'); pending = lines.pop(); for (const line of lines) process.stderr.write(legacy(line) + '\\n'); });
child.on('close', (code) => { process.stderr.write(legacy(pending)); process.exitCode = code; });
`);
    await chmod(path.join(bin, 'ffmpeg'), 0o755);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const legacyLog = spawnSync('ffmpeg', ['-hide_banner', '-copyts', '-ss', '100', '-i', source, '-vf', 'showinfo', '-frames:v', '2', '-f', 'null', '-'], { encoding: 'utf8', env });
    assert.match(legacyLog.stderr, /pts_time:100\.017\s/);

    const result = invokeIn({ env }, 'changes', source, '--start', '99.5', '--end', '100.5', '--analysis-fps', '60', '--output', path.join(directory, 'out'));
    assert.equal(result.status, 0, result.stderr);
    const manifest = await changesManifest(JSON.parse(result.stdout));
    assert.equal(manifest.frames.length, 2);
    assert.equal(manifest.frames[1].score, 1);
    assert.ok(Math.abs(manifest.frames[1].time - 6001 / 60) < 1e-9, String(manifest.frames[1].time));
    assert.ok(halves(path.join(directory, 'out', manifest.frames[1].file)).every((mean) => mean > 200));
  });
});

test('times inside the last frame interval return the last frame, including sparse VFR tails', async () => {
  await withTempDirectory(async (directory) => {
    const bytes = async (manifestFile) => {
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
      return Promise.all(manifest.frames.map((frame) => readFile(path.join(path.dirname(manifestFile), frame.file))));
    };
    const cfr = path.join(directory, 'one-fps.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', cfr);
    const [last] = await bytes(success('frame', cfr, '--at', '2', '--output', path.join(directory, 'cfr-2')).manifest);
    const tail = success('frame', cfr, '--at', '2.5,2.999', '--output', path.join(directory, 'cfr-tail'));
    assert.deepEqual(JSON.parse(await readFile(tail.manifest, 'utf8')).frames.map((frame) => frame.time), [2.5, 2.999]);
    assert.ok((await bytes(tail.manifest)).every((image) => image.equals(last)));
    const overview = JSON.parse(await readFile(success('overview', cfr, '--output', path.join(directory, 'overview')).manifest, 'utf8'));
    assert.equal(overview.frames.length, 12);
    const inspect = success('inspect', cfr, '--around', '2.5', '--window', '0.5', '--output', path.join(directory, 'inspect'));
    assert.ok((await bytes(inspect.manifest)).every((image) => image.equals(last)));

    // Frames at 0 and 1.47 s; the second is shown until 3.5 s.
    const sparse = path.join(directory, 'sparse.mp4');
    const tailed = path.join(directory, 'sparse-tail.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=160x90:rate=100:duration=1.5',
      '-vf', "drawbox=w=80:h=90:color=white:t=fill:enable='gte(n,147)',select='eq(n,0)+eq(n,147)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', sparse);
    ffmpeg('-i', sparse, '-c', 'copy', '-bsf:v', "setts=duration='if(eq(N,1),2.03/TB,DURATION)'", '-y', tailed);
    assert.equal(success('probe', tailed).end, 3.5);
    const [lit] = await bytes(success('frame', tailed, '--at', '1.47', '--output', path.join(directory, 'sparse-lit')).manifest);
    assert.ok(halves(path.join(directory, 'sparse-lit', 'frame-0000_00-01.470.jpg'))[0] > 200);
    assert.ok((await bytes(success('frame', tailed, '--at', '2,3.4', '--output', path.join(directory, 'sparse-tail')).manifest)).every((image) => image.equals(lit)));
  });
});

test('the last frame of an MPEG-TS clip remains available throughout its display interval', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'tail.ts');
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=160x90:rate=1:duration=3',
      '-vf', "drawbox=color=white:t=fill:enable='eq(n,2)'", '-c:v', 'libx264', '-g', '1', '-y', source);
    const output = success('frame', source, '--at', '2.5', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames[0].time, 2.5);
    assert.ok(halves(path.join(output.directory, manifest.frames[0].file)).every((mean) => mean > 200));
  });
});

test('a one-frame stream keeps precise tick boundaries when its start rounds up in ffprobe', async () => {
  await withTempDirectory(async (directory) => {
    const delayed = path.join(directory, 'delayed.mp4');
    const shifted = path.join(directory, 'shifted.mp4');
    const picture = 'color=white:size=64x36:rate=60:duration=0.0166666666666667';
    // A high movie timescale preserves the 1/60 s offset; ffprobe prints it as 0.016667 s.
    ffmpeg('-f', 'lavfi', '-i', 'anullsrc=sample_rate=48000:duration=0.05', '-itsoffset', String(1 / 60),
      '-f', 'lavfi', '-i', picture, '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-movie_timescale', '60000', '-fps_mode', 'passthrough', '-y', delayed);
    ffmpeg('-f', 'lavfi', '-i', picture, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movie_timescale', '60000',
      '-output_ts_offset', String(1 / 60), '-y', shifted);
    for (const [source, start, at] of [[delayed, 1 / 60, 0.02], [shifted, 0, 0.01]]) {
      const info = success('probe', source);
      assert.equal(info.start, start);
      assert.ok(Math.abs(info.duration - 1 / 60) < 1e-12, String(info.duration));
      const name = path.parse(source).name;
      for (const [command, args] of [['frame', ['--at', String(at)]], ['overview', ['--frames', '3']],
        ['inspect', ['--around', String(at), '--window', '0.005s']], ['changes', []]]) {
        const output = success(command, source, ...args, '--output', path.join(directory, `${name}-${command}`));
        const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
        assert.ok(manifest.frames.length > 0, command);
        if (command === 'frame') assert.equal(manifest.frames[0].time, at);
        if (command === 'changes') assert.deepEqual(manifest.frames.map((frame) => frame.time), [start]);
        for (const frame of manifest.frames) {
          assert.ok(frame.time >= info.start && frame.time < info.end);
          assert.ok(halves(path.join(output.directory, frame.file)).every((mean) => mean > 200), `${name} ${command}`);
        }
      }
      // A time beyond the precise display interval must not be admitted by rounding the endpoint up.
      const beyond = (info.end + (source === delayed ? 0.033334 : 1 / 60)) / 2;
      const bad = invoke('frame', source, '--at', String(beyond), '--output', path.join(directory, `${name}-bad`));
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /must be before the video ends/);
    }
  });
});

test('anamorphic frames and crops are never enlarged, with or without rotation', async () => {
  await withTempDirectory(async (directory) => {
    const plain = path.join(directory, 'narrow.mp4');
    const rotated = path.join(directory, 'narrow-rotated.mp4');
    // 160x90 stored pixels, each half as wide as tall: an 80x90 square-pixel picture, 90x80 once turned.
    // Red left and right quarters become the top and bottom bands after a 90 degree turn in either direction.
    ffmpeg('-f', 'lavfi', '-i', 'color=blue:size=160x90:rate=10:duration=1',
      '-vf', 'drawbox=x=0:y=0:w=40:h=90:color=red:t=fill,drawbox=x=120:y=0:w=40:h=90:color=red:t=fill,setsar=1/2', '-c:v', 'mpeg4', '-q:v', '2', '-y', plain);
    rotate90(plain, rotated);
    for (const [source, crop, size, red] of [
      [plain, [], [80, 90]], [plain, ['--crop', '0,0,1,1'], [80, 90]], [plain, ['--crop', '0,0,0.25,1'], [20, 90], true],
      [rotated, [], [90, 80]], [rotated, ['--crop', '0,0,1,1'], [90, 80]], [rotated, ['--crop', '0,0,1,0.25'], [90, 20], true],
    ]) {
      const output = success('frame', source, '--at', '0.5', ...crop, '--output', path.join(directory, `out-${path.parse(source).name}-${crop.join('')}`));
      const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
      if (crop.length) assert.deepEqual(Object.values(manifest.crop.pixels.displayed), size);
      const file = path.join(output.directory, manifest.frames[0].file);
      const image = jpegInfo(file);
      assert.equal(image.sample_aspect_ratio, '1:1');
      assert.deepEqual([image.width, image.height], size, `${source} ${crop}`);
      if (red) assert.ok(redShare(file) > 0.9, `${source} ${crop}`);
    }
  });
});

test('changes --max caps detected changes so the baseline keeps the run at 240 frames', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'blink.mp4');
    // A box toggles every frame: 259 equal-score candidates after the first frame.
    ffmpeg('-f', 'lavfi', '-i', 'color=black:size=64x36:rate=10:duration=26',
      '-vf', "drawbox=w=16:h=16:color=white:t=fill:enable='mod(n,2)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
    const output = success('changes', source, '--min-gap', '0', '--max', '239', '--output', path.join(directory, 'out'));
    const manifest = await changesManifest(output);
    assert.deepEqual([output.frames, output.changes, manifest.detection.candidates, manifest.detection.truncated], [240, 239, 259, true]);
    // Ties keep the earliest times.
    assert.ok(Math.abs(manifest.frames.at(-1).time - 23.9) < 1e-6, String(manifest.frames.at(-1).time));
    const bad = invoke('changes', source, '--max', '240', '--output', path.join(directory, 'bad'));
    assert.match(bad.stderr, /--max must be an integer from 1 to 239/);
    assert.ok(!(await readdir(directory)).includes('bad'));
  });
});

test('tail positions share one last-frame lookup, and an unusable lookup keeps the extraction error', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'one-fps.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source);
    const real = spawnSync('sh', ['-c', 'command -v ffprobe'], { encoding: 'utf8' }).stdout.trim();
    const bin = path.join(directory, 'bin');
    const calls = path.join(directory, 'calls');
    await mkdir(bin);
    // Logs tail lookups; with EMPTY set they list no packets, like a source without usable timestamps.
    await writeFile(path.join(bin, 'ffprobe'), `#!/bin/sh
case " $* " in *" -show_entries packet=pts,dts,duration,flags:stream=time_base "*) echo x >> "${calls}"; [ -n "$EMPTY" ] && exit 0;; esac
exec "${real}" "$@"
`);
    await chmod(path.join(bin, 'ffprobe'), 0o755);
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    // The default 12 frames put 2.125, 2.375, 2.625 and 2.875 s after the last frame at 2 s.
    const overview = invokeIn({ env }, 'overview', source, '--output', path.join(directory, 'overview'));
    assert.equal(overview.status, 0, overview.stderr);
    assert.equal(JSON.parse(overview.stdout).frames, 12);
    assert.equal(await readFile(calls, 'utf8'), 'x\n');

    const failed = invokeIn({ env: { ...env, EMPTY: '1' } }, 'frame', source, '--at', '2.5', '--output', path.join(directory, 'failed'));
    assert.notEqual(failed.status, 0);
    // FFmpeg 8 fails to open the encoder when no frame decodes; earlier versions exit 0 without writing one.
    assert.match(failed.stderr, /ffmpeg exited|FFmpeg produced no frame for 2\.5s/);
    assert.doesNotMatch(failed.stderr, /Infinity|NaN/);
    assert.deepEqual((await readdir(directory)).sort(), ['bin', 'calls', 'one-fps.mp4', 'overview']);
  });
});

test('changes on a narrow full-height crop bounds analysis pixels and still finds the change', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'tall.mp4');
    ffmpeg('-f', 'lavfi', '-i', "color=black:size=160x2160:rate=10:duration=2,drawbox=x=0:y=1000:w=16:h=200:color=white:t=fill:enable='gte(t,1)'",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source);
    // A 16x2160 crop at the default 256 px analysis width would be 256x34560.
    const output = success('changes', source, '--crop', '0,0,0.1,1', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    const { width, height } = manifest.detection.analysis;
    assert.ok(width * height <= 512 * 512, `${width}x${height}`);
    assert.ok(Math.abs(height / width / (2160 / 16) - 1) < 0.05, `${width}x${height}`);
    assert.deepEqual(manifest.frames.map(({ time }) => time), [0, 1]);
    assert.ok(manifest.frames[1].score > 0.05, String(manifest.frames[1].score));
  });
});

// Starts the CLI without waiting for it; `exited` resolves with its exit code and output.
function launch(options, ...args) {
  const child = spawn(process.execPath, [cli, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, exited: new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))) };
}

// Polls observable state, so concurrency tests wait on what processes did rather than on fixed delays.
async function until(check, what) {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// An ffmpeg wrapper that records each frame extraction (-frames:v 1) as sync/call-N/<pid>. Calls after the first PASS
// wait for sync/release and then run real FFmpeg, or fail with FAIL set (or after about 30 s, so a regression cannot
// leave them waiting). Other calls run FFmpeg directly.
async function gatedFfmpeg(directory) {
  const real = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(directory, 'gate');
  const sync = path.join(directory, 'sync');
  await mkdir(bin);
  await writeFile(path.join(bin, 'ffmpeg'), `#!/bin/sh
case " $* " in *" -frames:v 1 "*) ;; *) exec "${real}" "$@";; esac
n=1; while ! mkdir "${sync}/call-$n" 2>/dev/null; do n=$((n+1)); done
touch "${sync}/call-$n/$$"
if [ "$n" -gt "\${PASS:-0}" ]; then
  i=0; while [ ! -e "${sync}/release" ]; do i=$((i+1)); [ "$i" -gt 3000 ] && exit 1; sleep 0.01; done
  [ -n "$FAIL" ] && exit 1
fi
exec "${real}" "$@"
`);
  await chmod(path.join(bin, 'ffmpeg'), 0o755);
  const pids = async () => (await Promise.all((await readdir(sync)).filter((name) => name.startsWith('call-'))
    .map((name) => readdir(path.join(sync, name))))).flat().map(Number);
  return {
    env: (extra) => ({ ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ...extra }),
    reset: async () => { await rm(sync, { recursive: true, force: true }); await mkdir(sync); },
    release: () => writeFile(path.join(sync, 'release'), ''),
    pids,
  };
}

async function hasImage(directory) {
  for (const name of await readdir(directory).catch(() => [])) {
    if (name.endsWith('.jpg') && (await stat(path.join(directory, name))).size > 0) return true;
  }
  return false;
}

test('one of two runs sharing an explicit output directory owns it; the other leaves its files alone', async () => {
  await withTempDirectory(async (directory) => {
    const [black, white] = ['black', 'white'].map((color) => path.join(directory, `${color}.mp4`));
    for (const [file, color] of [[black, 'black'], [white, 'white']]) {
      ffmpeg('-f', 'lavfi', '-i', `color=${color}:size=64x48:rate=10:duration=1`, '-pix_fmt', 'yuv420p', file);
    }
    const gate = await gatedFfmpeg(directory);
    const shared = path.join(directory, 'shared');
    for (const [existing, fail] of [[false, false], [true, false], [false, true], [true, true]]) {
      const label = `existing=${existing} fail=${fail}`;
      await gate.reset();
      await rm(shared, { recursive: true, force: true });
      if (existing) await mkdir(shared);
      // The owner's first extraction completes and its second waits, so it holds a written image when the rival starts.
      const owner = launch({ env: gate.env({ PASS: '1', ...(fail ? { FAIL: '1' } : {}) }) }, 'frame', black, '--at', '0,0.5', '--output', shared);
      await until(async () => (await gate.pids()).length >= 2 && hasImage(shared), `owner extraction (${label})`);
      const held = (await readdir(shared)).sort();
      const rival = invoke('frame', white, '--at', '0,0.5', '--output', shared);
      assert.notEqual(rival.status, 0, label);
      assert.match(rival.stderr, /in use by another agvid run/, label);
      assert.deepEqual((await readdir(shared)).sort(), held, label);
      await gate.release();
      const result = await owner.exited;
      if (fail) {
        assert.notEqual(result.code, 0, label);
        if (existing) assert.deepEqual(await readdir(shared), [], label);
        else assert.ok(!(await readdir(directory)).includes('shared'), label);
        continue;
      }
      assert.equal(result.code, 0, result.stderr);
      const manifest = JSON.parse(await readFile(path.join(shared, 'manifest.json'), 'utf8'));
      assert.equal(manifest.source.video, black, label);
      assert.deepEqual((await readdir(shared)).sort(), [...manifest.frames.map(({ file }) => file), 'manifest.json', 'sheet-01.jpg'].sort(), label);
      for (const { file } of manifest.frames) assert.ok(halves(path.join(shared, file)).every((mean) => mean < 5), `${label} ${file}`);
    }
  });
});

test('concurrent runs with default output each claim their own directory', async () => {
  await withTempDirectory(async (directory) => {
    const cwd = await realpath(directory);
    const gate = await gatedFfmpeg(cwd);
    await gate.reset();
    const runs = [0, 1].map(() => launch({ cwd, env: gate.env() }, 'frame', video, '--at', '1'));
    await until(async () => (await gate.pids()).length === 2, 'both extractions');
    await gate.release();
    const results = await Promise.all(runs.map((run) => run.exited));
    const directories = results.map((result) => {
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout).directory;
    });
    assert.notEqual(directories[0], directories[1]);
    for (const output of directories) assert.deepEqual((await readdir(output)).sort(), ['frame-0000_00-01.000.jpg', 'manifest.json']);
  });
});

test('SIGTERM stops FFmpeg, removes the incomplete run and releases its directory', async () => {
  await withTempDirectory(async (directory) => {
    const gate = await gatedFfmpeg(directory);
    const output = path.join(directory, 'out');
    for (const existing of [false, true]) {
      await gate.reset();
      if (existing) await mkdir(output);
      const run = launch({ env: gate.env({ PASS: '1' }) }, 'overview', video, '--frames', '3', '--width', '160', '--output', output);
      await until(async () => (await gate.pids()).length >= 2 && hasImage(output), 'one written image and one held extraction');
      run.child.kill('SIGTERM');
      const result = await run.exited;
      assert.equal(result.code, 143, result.stderr);
      assert.match(result.stderr, /cancelled by SIGTERM/);
      // Every FFmpeg (or its waiting wrapper) is gone, so nothing can write after cleanup.
      for (const pid of await gate.pids()) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `pid ${pid}`);
      if (existing) assert.deepEqual(await readdir(output), []);
      else assert.ok(!(await readdir(directory)).includes('out'));
    }
  });
});

test('a lock left by a killed run on this host is reclaimed by exactly one of several runs; live or foreign locks hold', async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, 'out');
    const lock = path.join(output, '.agvid.lock');
    // The pid of a process that has exited.
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
    await mkdir(output);
    for (const owner of [`${process.pid}\n${os.hostname()}\n`, `${dead}\nanother-host\n`]) {
      await writeFile(lock, owner);
      const result = invoke('frame', video, '--at', '1', '--output', output);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /in use by another agvid run/);
      assert.deepEqual(await readdir(output), ['.agvid.lock']);
    }
    await writeFile(lock, `${dead}\n${os.hostname()}\n`);
    const gate = await gatedFfmpeg(directory);
    await gate.reset();
    // The extraction waits until every rival has exited, so a second owner would never finish.
    const runs = [0, 1, 2, 3].map(() => launch({ env: gate.env() }, 'frame', video, '--at', '1', '--output', output));
    const settled = runs.map(() => undefined);
    runs.forEach((run, i) => run.exited.then((result) => { settled[i] = result; }));
    await until(async () => settled.filter(Boolean).length === 3 && (await gate.pids()).length === 1, 'three rivals to exit');
    for (const result of settled.filter(Boolean)) assert.match(result.stderr, /in use by another agvid run/);
    await gate.release();
    const owner = (await Promise.all(runs.map((run) => run.exited))).find((result) => result.code === 0);
    assert.equal(JSON.parse(owner.stdout).directory, output);
    assert.deepEqual((await readdir(output)).sort(), ['frame-0000_00-01.000.jpg', 'manifest.json']);
  });
});

test('a lock released while another run checks it for staleness is not replaced over a new owner', async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, 'out');
    const lock = path.join(output, '.agvid.lock');
    const sync = path.join(directory, 'hold');
    await mkdir(output);
    await mkdir(sync);
    // This test process stands in for the live owner.
    await writeFile(lock, `${process.pid}\n${os.hostname()}\n`);
    // The checking run's opening of the lock waits for 'read', then its result waits for 'resume'.
    const hook = path.join(directory, 'hook.mjs');
    await writeFile(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.promises.open;
const step = async (signal, wait) => {
  fs.writeFileSync(${JSON.stringify(sync)} + '/' + signal, '');
  while (!fs.existsSync(${JSON.stringify(sync)} + '/' + wait)) await new Promise((resolve) => setTimeout(resolve, 10));
};
fs.promises.open = async (file, ...rest) => {
  if (!String(file).endsWith('.agvid.lock')) return open(file, ...rest);
  await step('reading', 'read');
  const result = await open(file, ...rest).then((content) => ({ content }), (error) => ({ error }));
  await step('checked', 'resume');
  if (result.error) throw result.error;
  return result.content;
};
syncBuiltinESMExports();
`);
    const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, cli, 'frame', video, '--at', '1', '--output', output],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const checker = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    const signaled = (name) => stat(path.join(sync, name)).then(() => true, () => false);
    await until(() => signaled('reading'), 'the staleness check');
    // The owner releases its lock just before the check reads it, and a new run claims the directory right after,
    // holding it while it extracts.
    await rm(lock);
    await writeFile(path.join(sync, 'read'), '');
    await until(() => signaled('checked'), 'the lock read');
    const gate = await gatedFfmpeg(directory);
    await gate.reset();
    const newcomer = launch({ env: gate.env() }, 'frame', video, '--at', '1', '--output', output);
    await until(async () => (await gate.pids()).length === 1, 'the new owner extraction');
    const held = await readFile(lock, 'utf8');
    await writeFile(path.join(sync, 'resume'), '');
    assert.notEqual(await checker, 0);
    assert.match(stderr, /in use by another agvid run/);
    assert.equal(await readFile(lock, 'utf8'), held);
    await gate.release();
    assert.equal((await newcomer.exited).code, 0);
    assert.deepEqual((await readdir(output)).sort(), ['frame-0000_00-01.000.jpg', 'manifest.json']);
  });
});

test('stale guard recovery cannot displace a live reclaimer while it checks the stale lock', async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, 'out');
    const sync = path.join(directory, 'hold');
    const lock = path.join(output, '.agvid.lock');
    const guard = `${lock}.reclaim`;
    await mkdir(output);
    await mkdir(sync);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const stale = `${dead}\n${os.hostname()}\n`;
    const hook = path.join(directory, 'hook.mjs');
    await writeFile(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const root = ${JSON.stringify(sync)};
const step = async (signal, wait) => {
  fs.writeFileSync(root + '/' + signal, '');
  while (!fs.existsSync(root + '/' + wait)) await new Promise((resolve) => setTimeout(resolve, 10));
};
const open = fs.promises.open;
fs.promises.open = async (file, ...rest) => {
  const handle = await open(file, ...rest);
  const read = handle.readFile.bind(handle);
  handle.readFile = async (...args) => {
    const content = await read(...args);
    if (process.env.ROLE === 'A' && String(file).includes('.agvid.lock.reclaim')) await step('A-read', 'A-resume');
    if (process.env.ROLE === 'B' && String(file).endsWith('.agvid.lock')) await step('B-read', 'B-resume');
    return content;
  };
  return handle;
};
const rename = fs.promises.rename;
fs.promises.rename = async (from, to) => {
  await rename(from, to);
  if (process.env.ROLE === 'A' && String(from).endsWith('.reclaim')) await step('A-moved', 'A-finish');
};
const rmdir = fs.promises.rmdir;
let heldEmpty = false;
fs.promises.rmdir = async (file, ...rest) => {
  if (process.env.ROLE === 'A' && process.env.FORMAT === 'empty' && String(file).endsWith('.reclaim') && !heldEmpty) {
    heldEmpty = true;
    await step('A-read', 'A-resume');
  }
  return rmdir(file, ...rest);
};
const mkdir = fs.promises.mkdir;
fs.promises.mkdir = async (file, ...rest) => {
  const result = await mkdir(file, ...rest);
  if (process.env.ROLE === 'A' && process.env.FORMAT === 'publishing' && String(file).endsWith('.reclaim')) await step('A-read', 'A-resume');
  return result;
};
syncBuiltinESMExports();
`);
    const gate = await gatedFfmpeg(directory);
    // Also cover a creator resuming after its empty directory was recovered, before it published its owner file.
    for (const format of ['file', 'directory', 'empty', 'publishing']) {
      await rm(sync, { recursive: true, force: true });
      await mkdir(sync);
      await gate.reset();
      await writeFile(lock, stale);
      if (format === 'file') await writeFile(guard, stale);
      else if (format !== 'publishing') {
        await mkdir(guard);
        if (format === 'directory') await writeFile(path.join(guard, '00000000-0000-4000-8000-000000000000'), stale);
        else {
          const old = new Date(Date.now() - 61000);
          await utimes(guard, old, old);
        }
      }
      const signaled = (name) => stat(path.join(sync, name)).then(() => true, () => false);
      const runs = [];
      const start = (role) => {
        const run = launch({ env: gate.env({ ROLE: role, FORMAT: format, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` }) },
          'frame', video, '--at', '1', '--width', '160', '--output', output);
        runs.push(run);
        return run;
      };
      try {
        const a = start('A');
        let aResult;
        a.exited.then((result) => { aResult = result; });
        await until(() => signaled('A-read'), `${format}: A reads the stale guard`);
        if (format === 'publishing') {
          const old = new Date(Date.now() - 61000);
          await utimes(guard, old, old);
        }
        const b = start('B');
        await until(() => signaled('B-read'), `${format}: B owns the replacement guard and reads the stale lock`);
        await writeFile(path.join(sync, 'A-resume'), '');
        await until(async () => aResult || await signaled('A-moved'), `${format}: A attempts recovery`);
        const c = start('C');
        let cResult;
        c.exited.then((result) => { cResult = result; });
        await until(async () => cResult || (await gate.pids()).length > 0, `${format}: C attempts to claim`);
        assert.ok(cResult, `${format}: C acquired the directory while B held the reclaim guard`);
        assert.notEqual(cResult.code, 0);
        assert.match(cResult.stderr, /in use by another agvid run/);
        await writeFile(path.join(sync, 'A-finish'), '');
        assert.notEqual((await a.exited).code, 0);
        await writeFile(path.join(sync, 'B-resume'), '');
        await until(async () => (await gate.pids()).length === 1, `${format}: B extracts alone`);
        assert.equal((await readFile(lock, 'utf8')).split('\n')[0], String(b.child.pid));
        await gate.release();
        const result = await b.exited;
        assert.equal(result.code, 0, result.stderr);
        const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
        assert.deepEqual(manifest.frames.map(({ time }) => time), [1]);
        jpegInfo(path.join(output, manifest.frames[0].file));
        assert.deepEqual((await readdir(output)).sort(), [manifest.frames[0].file, 'manifest.json'].sort());
      } finally {
        await gate.release();
        for (const run of runs) run.child.kill('SIGKILL');
        await Promise.all(runs.map((run) => run.exited));
      }
      await rm(output, { recursive: true, force: true });
      await mkdir(output);
    }
  });
});

test('a reclaim guard left by a run killed while reclaiming is recovered by the next run', async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, 'out');
    const sync = path.join(directory, 'hold');
    await mkdir(output);
    await mkdir(sync);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    await writeFile(path.join(output, '.agvid.lock'), `${dead}\n${os.hostname()}\n`);
    // Holds the reclaiming run inside its guard: its opening of the stale lock never returns.
    const hook = path.join(directory, 'hook.mjs');
    await writeFile(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const open = fs.promises.open;
fs.promises.open = async (file, ...rest) => {
  if (String(file).endsWith('.agvid.lock')) {
    fs.writeFileSync(${JSON.stringify(path.join(sync, 'guarded'))}, '');
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  return open(file, ...rest);
};
syncBuiltinESMExports();
`);
    const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, cli, 'frame', video, '--at', '1', '--output', output], { stdio: 'ignore' });
    const killed = new Promise((resolve) => child.on('close', (code, signal) => resolve(signal)));
    await until(() => stat(path.join(sync, 'guarded')).then(() => true, () => false), 'the reclaim guard');
    child.kill('SIGKILL');
    assert.equal(await killed, 'SIGKILL');
    assert.deepEqual((await readdir(output)).sort(), ['.agvid.lock', '.agvid.lock.reclaim']);
    const result = invoke('frame', video, '--at', '1', '--output', output);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(output)).sort(), ['frame-0000_00-01.000.jpg', 'manifest.json']);
  });
});

test('an empty lock is held while fresh and reclaimed once a minute old', async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, 'out');
    const lock = path.join(output, '.agvid.lock');
    await mkdir(output);
    // An older release, or one on a filesystem without hard links, killed between creating the lock and writing its pid.
    await writeFile(lock, '');
    const fresh = invoke('frame', video, '--at', '1', '--output', output);
    assert.match(fresh.stderr, /in use by another agvid run/);
    const old = new Date(Date.now() - 61000);
    await utimes(lock, old, old);
    const result = invoke('frame', video, '--at', '1', '--output', output);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(output)).sort(), ['frame-0000_00-01.000.jpg', 'manifest.json']);
  });
});

test('a run stalled for over a minute while claiming a directory never shares it with a run that claimed it meanwhile', async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, 'out');
    const sync = path.join(directory, 'hold');
    await mkdir(output);
    await mkdir(sync);
    // A's exclusive creation of its lock file pauses between creating the file and writing its owner.
    const hook = path.join(directory, 'hook.mjs');
    await writeFile(hook, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const root = ${JSON.stringify(sync)};
const writeFile = fs.promises.writeFile;
fs.promises.writeFile = async (file, data, options) => {
  if (!String(file).startsWith(${JSON.stringify(path.join(output, '.agvid.lock'))}) || options?.flag !== 'wx') return writeFile(file, data, options);
  const handle = await fs.promises.open(file, 'wx');
  fs.writeFileSync(root + '/created', String(file));
  while (!fs.existsSync(root + '/resume')) await new Promise((resolve) => setTimeout(resolve, 10));
  try { await handle.writeFile(data); } finally { await handle.close(); }
};
syncBuiltinESMExports();
`);
    const gate = await gatedFfmpeg(directory);
    await gate.reset();
    const a = spawn(process.execPath, ['--import', pathToFileURL(hook).href, cli, 'frame', video, '--at', '1', '--output', output],
      { env: gate.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    a.stderr.on('data', (chunk) => { stderr += chunk; });
    let aCode;
    const aExited = new Promise((resolve) => a.on('close', (code) => resolve(aCode = code)));
    try {
      await until(() => stat(path.join(sync, 'created')).then(() => true, () => false), 'A creating its lock');
      const old = new Date(Date.now() - 61000);
      const created = await readFile(path.join(sync, 'created'), 'utf8');
      await utimes(created, old, old);
      const b = launch({ env: gate.env() }, 'frame', video, '--at', '1', '--output', output);
      await until(async () => (await gate.pids()).length === 1, 'B extracting');
      await writeFile(path.join(sync, 'resume'), '');
      await until(async () => aCode !== undefined || (await gate.pids()).length > 1, 'A resuming');
      assert.notEqual(aCode, undefined, 'A extracted into the directory B owns');
      assert.notEqual(aCode, 0);
      assert.match(stderr, /in use by another agvid run/);
      await gate.release();
      const result = await b.exited;
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual((await readdir(output)).sort(), ['frame-0000_00-01.000.jpg', 'manifest.json']);
    } finally {
      await gate.release();
      a.kill('SIGKILL');
      await aExited;
    }
  });
});
