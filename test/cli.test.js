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
    ffmpeg('-display_rotation', '90', '-i', plain, '-c', 'copy', '-y', rotated);
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
  assert.deepEqual([manifest.frames[0].time, manifest.frames[0].score], [manifest.range?.start ?? 0, null]);
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
    assert.match(manifest.detection.metric, /RGB any-channel-diff>16@256px,30fps/);
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

    for (const args of [['--threshold', '0'], ['--threshold', '1.5'], ['--max', '241'], ['--min-gap', '-1']]) {
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

    const gapped = success('changes', source, '--min-gap', '1', '--max', '240', '--output', path.join(directory, 'gap'));
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
