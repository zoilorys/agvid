import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('bin/agvid.js');
const video = path.resolve('test/fixtures/test.mov');

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { maxBuffer: 1 << 26, ...options });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

const gray = (input, ...args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-copyts', '-i', input, ...args,
  '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);

test('VFR extraction shows the last frame at or before each time, including one sharing an output tick', async () => {
  const pts = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0',
    video], { encoding: 'utf8' }).trim().split('\n').map(Number);
  // At 7.125 s the 60 fps rate rounds 7.083 s and 7.1 s into adjacent ticks, and default sync kept the earlier frame;
  // 0.266 s decodes from the origin and 7.25 s follows a 1/15 s gap.
  const times = [0.266, 7.125, 7.25];
  const shown = times.map((time) => pts.findLastIndex((t) => t <= time));
  // Decodes the shown frames and their neighbors from the origin in one pass, independently of agvid's seeking.
  const indexes = [...new Set(shown.flatMap((i) => [i - 1, i, i + 1]))].sort((a, b) => a - b);
  const raw = gray(video, '-vf', `select='${indexes.map((i) => `between(t\\,${pts[i] - 1e-4}\\,${pts[i] + 1e-4})`).join('+')}'`);
  const size = raw.length / indexes.length;
  const source = (i) => raw.subarray(indexes.indexOf(i) * size, (indexes.indexOf(i) + 1) * size);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-vfr-'));
  try {
    const output = JSON.parse(run(process.execPath, [cli, 'frame', video, '--at', times.join(','), '--width', '1280',
      '--output', directory], { encoding: 'utf8' }));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.deepEqual(manifest.frames.map(({ time }) => time), times);
    manifest.frames.forEach(({ file, time }, n) => {
      const image = gray(path.join(directory, file));
      const expected = source(shown[n]);
      assert.equal(image.length, size);
      for (const rival of [shown[n] - 1, shown[n] + 1]) {
        const other = source(rival);
        const pixels = [...expected.keys()].filter((k) => Math.abs(expected[k] - other[k]) > 40);
        assert.ok(pixels.length >= 20, `${pts[shown[n]]}s and ${pts[rival]}s differ in ${pixels.length} pixels`);
        const distance = (frame) => pixels.reduce((sum, k) => sum + Math.abs(image[k] - frame[k]), 0) / pixels.length;
        assert.ok(distance(expected) * 4 < distance(other),
          `${time}s: ${distance(expected)} from ${pts[shown[n]]}s, ${distance(other)} from ${pts[rival]}s`);
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
