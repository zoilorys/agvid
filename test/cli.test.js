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

test('frame accepts --option=value spelling and rejects duplicates across spellings', async () => {
  await withTempDirectory(async (directory) => {
    // A sub-millisecond request rounds to the millisecond the filename names.
    const output = success('frame', video, '--at=7.5004', '--width=160', `--output=${directory}`);
    assert.equal(output.directory, directory);
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual([manifest.frames[0].time, manifest.frames[0].file], [7.5, 'frame-0000_00-07.500.jpg']);
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
    assert.deepEqual(manifest.windows.map((w) => [w.around, ...w.frames]), [[5, 0, manifest.frames.length - 1]]);
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
