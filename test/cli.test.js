import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    const frame = jpegInfo(path.join(output.directory, manifest.frames[0].file));
    assert.ok(frame.width <= 160);
    assert.ok(Math.abs(frame.width / frame.height - info.width / info.height) < 0.03);
  });
});

test('frame accepts --option=value spelling and rejects duplicates across spellings', async () => {
  await withTempDirectory(async (directory) => {
    // A sub-millisecond request rounds to the millisecond the filename names.
    const output = success('frame', video, '--at=7.5004', '--width=160', `--output=${directory}`);
    assert.equal(output.directory, directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual([manifest.frames[0].time, manifest.frames[0].file], [7.5, 'frame-0000_00-07.500.jpg']);
    assert.ok(jpegInfo(path.join(output.directory, manifest.frames[0].file)).width <= 160);
    const duplicate = invoke('frame', video, '--at', '1', '--at=2', '--output', path.join(directory, 'dup'));
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /duplicate option: --at\b/);
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
    ffmpeg('-display_rotation', '90', '-i', plain, '-c', 'copy', '-y', rotated);
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
    assert.deepEqual(manifest.frames, [{ file: 'frame-0000_01-00.000.jpg', time: 60, timecode: '01:00.000' }]);
    jpegInfo(path.join(output.directory, manifest.frames[0].file));
  });
});

test('timecodes gain an hour field and carry into it', () => {
  assert.equal(formatTimecode(3599.9996), '1:00:00.000');
  assert.equal(formatTimecode(3661.5), '1:01:01.500');
});

test('a streamed WebM without duration metadata uses packet timestamps', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'no-duration.webm');
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=2',
      '-c:v', 'libvpx', '-f', 'webm', '-'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString());
    await writeFile(source, result.stdout);
    const info = success('probe', source);
    assert.equal(info.durationSource, 'packets');
    assert.ok(info.duration >= 1.95 && info.duration <= 2.05, String(info.duration));
    assert.deepEqual([info.fps, info.frameCount, info.frameCountEstimated], [10, 20, true]);
    const output = success('overview', source, '--frames', '3', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 3);
    assert.ok(manifest.frames.every((frame) => frame.time < 2));
    for (const frame of manifest.frames) jpegInfo(path.join(output.directory, frame.file));
  });
});

test('a video without stream duration fails with an actionable error', async () => {
  await withTempDirectory(async (directory) => {
    const source = path.join(directory, 'raw-video.m2v');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1',
      '-c:v', 'mpeg2video', '-f', 'mpeg2video', '-y', source);
    const output = path.join(directory, 'out');
    const result = invoke('overview', source, '--output', output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /first video stream has no duration metadata.*provide a video/i);
    assert.deepEqual(await readdir(directory), ['raw-video.m2v']);
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
