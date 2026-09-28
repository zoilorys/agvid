import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const video = path.resolve('test/fixtures/test.mov');
const cli = path.resolve('bin/agvid.js');

function invoke(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
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

    const output = success('frame', video, '--at', '00:07.5004', '--width', '160', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 1);
    assert.equal(manifest.frames[0].time, 7.5004);
    const frame = jpegInfo(path.join(output.directory, manifest.frames[0].file));
    assert.ok(frame.width <= 160);
    assert.ok(Math.abs(frame.width / frame.height - info.width / info.height) < 0.03);
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
    const output = success('overview', source, '--frames', '3', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 3);
    assert.ok(manifest.frames.every((frame) => frame.time < 1));
    for (const frame of manifest.frames) jpegInfo(path.join(output.directory, frame.file));
  });
});

test('probe reports displayed dimensions for a rotated video', async () => {
  await withTempDirectory(async (directory) => {
    const plain = path.join(directory, 'plain.mp4');
    const rotated = path.join(directory, 'rotated.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=2', '-c:v', 'mpeg4', '-y', plain);
    ffmpeg('-display_rotation', '90', '-i', plain, '-c', 'copy', '-y', rotated);
    const info = success('probe', rotated);
    assert.deepEqual([info.width, info.height, info.rotation, info.codedWidth, info.codedHeight], [180, 320, 90, 320, 180]);
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
    const frame = jpegInfo(path.join(output.directory, 'frame-0000.jpg'));
    const sheet = jpegInfo(output.contactSheet);
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
  });
});

test('overview writes a contact sheet and JPEGs mapped to source times', async () => {
  await withTempDirectory(async (directory) => {
    const output = success('overview', video, '--frames', '5', '--width', '160', '--output', directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.frames.length, 5);
    assert.equal(manifest.contactSheet, 'contact-sheet.jpg');
    assert.ok(manifest.frames.every((frame) => frame.time > 0 && frame.time < manifest.source.duration));
    assert.equal(jpegInfo(output.contactSheet).width, 480);
    for (const frame of manifest.frames) jpegInfo(path.join(output.directory, frame.file));
    assert.deepEqual((await readdir(directory)).sort(), [
      'contact-sheet.jpg', 'frame-0000.jpg', 'frame-0001.jpg', 'frame-0002.jpg',
      'frame-0003.jpg', 'frame-0004.jpg', 'manifest.json',
    ]);
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

test('an excessive extraction request fails before creating its output directory', async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, 'too-many');
    const result = invoke('inspect', video, '--around', '12', '--window', '20s', '--fps', '60', '--output', output);
    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(directory), []);
  });
});
