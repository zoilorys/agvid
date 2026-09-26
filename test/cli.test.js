import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('extracts bounded frames and a contact sheet from a video', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-test-'));
  try {
    const video = path.join(directory, 'clip.mp4');
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=8', '-t', '3', '-c:v', 'mpeg4', video]);
    const overview = JSON.parse(run(process.execPath, ['bin/agvid.js', 'overview', '--frames', '5', '--width', '160', '--output', path.join(directory, 'overview'), video]));
    const overviewManifest = JSON.parse(await readFile(overview.manifest, 'utf8'));
    assert.equal(overviewManifest.frames.length, 5);
    assert.ok(overviewManifest.frames.every((frame) => frame.time > 0 && frame.time < 3));
    const sheetInfo = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', overview.contactSheet]));
    assert.equal(sheetInfo.streams[0].width, 480);
    assert.equal((await readdir(overview.directory)).filter((name) => name.startsWith('frame-')).length, 5);

    const inspect = JSON.parse(run(process.execPath, ['bin/agvid.js', 'inspect', video, '--around', '1.5', '--window', '2s', '--fps', '4', '--output', path.join(directory, 'inspect')]));
    const inspectManifest = JSON.parse(await readFile(inspect.manifest, 'utf8'));
    assert.equal(inspectManifest.frames.length, 8);
    assert.ok(inspectManifest.frames.every((frame) => frame.time >= 0.5 && frame.time < 2.5));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
