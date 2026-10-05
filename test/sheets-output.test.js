import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { frameSize } from '../src/sheets.js';

const cli = path.resolve('bin/agvid.js');

function ffmpeg(...args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function agvid(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function jpegSize(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const { codec_name, width, height } = JSON.parse(result.stdout).streams[0];
  assert.equal(codec_name, 'mjpeg');
  return { width, height };
}

function rgb(file) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1 << 26 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

async function withTempDirectory(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-sheets-'));
  try { await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// FFmpeg 6.0 added -display_rotation; 5.1 takes the rotate tag.
function rotate90(input, output) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-display_rotation', '90', '-i', input, '-c', 'copy', '-y', output]);
  if (result.status !== 0) ffmpeg('-i', input, '-c', 'copy', '-metadata:s:v', 'rotate=90', '-y', output);
}

test('inferred frame size equals the JPEGs FFmpeg extracts, including rounding ties, SAR, rotation and crop', async () => {
  await withTempDirectory(async (directory) => {
    const source = (name, size, sar = '1/1') => {
      const file = path.join(directory, `${name}.mp4`);
      ffmpeg('-f', 'lavfi', '-i', `testsrc2=s=${size}:r=10:d=1`, '-vf', `setsar=${sar}`, '-c:v', 'mpeg4', '-q:v', '5', '-y', file);
      return file;
    };
    const rotated = (name, size, sar) => {
      const file = path.join(directory, `${name}-rotated.mp4`);
      rotate90(source(name, size, sar), file);
      return file;
    };
    const cases = [
      // 70 / (84 / 150) / 2 is 62.4999..., not 62.5: FFmpeg's double arithmetic decides the rounding.
      [source('ulp', '84x150'), ['--width', '70']],
      // An exact .5 rounds away from zero.
      [source('tie', '128x90'), ['--width', '64']],
      [source('wide-sar', '160x90', '2/1'), ['--width', '200']],
      [source('narrow-sar', '160x90', '1/2'), []],
      [source('crop', '320x180'), ['--crop', '0.1,0.2,0.5,0.35', '--width', '100']],
      // The turned SAR 11/12 is one ulp off 1 / (12 / 11), which moves 99 / dar / 2 across .5.
      [rotated('ulp-sar', '32x128', '12/11'), ['--width', '99']],
      [rotated('crop-sar', '160x120', '4/3'), ['--crop', '0,0.25,0.75,0.5', '--width', '64']],
    ];
    for (const [i, [video, options]] of cases.entries()) {
      const output = agvid('frame', video, '--at', '0.5', ...options, '--output', path.join(directory, `out-${i}`));
      const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
      const inferred = frameSize({ width: manifest.outputWidth, info: manifest.source, crop: manifest.crop });
      assert.deepEqual(inferred, jpegSize(path.join(output.directory, manifest.frames[0].file)), `${path.basename(video)} ${options.join(' ')}`);
    }
  });
});

test('concurrently rendered window sheets show their own window and tile the extracted frames exactly', async () => {
  await withTempDirectory(async (directory) => {
    // Each second has its own color, so a sheet assigned to the wrong window shows the wrong one.
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255]];
    const video = path.join(directory, 'colors.mp4');
    const hex = (rgb) => rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
    const inputs = colors.flatMap((rgb) => ['-f', 'lavfi', '-i', `color=c=0x${hex(rgb)}:s=200x150:r=10:d=1`]);
    ffmpeg(...inputs, '-filter_complex', `${colors.map((_, i) => `[${i}:v]`).join('')}concat=n=${colors.length}:v=1:a=0,setsar=4/3`, '-c:v', 'mpeg4', '-q:v', '2', '-y', video);
    const arounds = colors.map((_, i) => String(i + 0.5));
    const output = agvid('inspect', video, ...arounds.flatMap((t) => ['--around', t]), '--window', '0.8', '--fps', '5', '--output', path.join(directory, 'out'));
    const manifest = JSON.parse(await readFile(output.manifest, 'utf8'));
    assert.equal(manifest.windows.length, colors.length);
    assert.deepEqual(manifest.windows.flatMap((window) => window.sheets), manifest.sheets.map((sheet) => sheet.file));
    assert.deepEqual((await readdir(output.directory)).filter((file) => file.startsWith('sheet-')).sort(), manifest.sheets.map((sheet) => sheet.file));
    const frame = jpegSize(path.join(output.directory, manifest.frames[0].file));
    for (const [i, window] of manifest.windows.entries()) {
      assert.equal(window.sheets.length, 1);
      const sheet = manifest.sheets.find((entry) => entry.file === window.sheets[0]);
      assert.deepEqual(sheet.frames, window.frames);
      assert.ok(sheet.tileWidth <= frame.width && sheet.tileHeight <= frame.height, JSON.stringify({ sheet, frame }));
      const file = path.join(output.directory, sheet.file);
      assert.deepEqual(jpegSize(file), { width: sheet.columns * sheet.tileWidth, height: sheet.rows * sheet.tileHeight });
      // Sample the top row of the first tile, above its bottom-left label.
      const pixels = rgb(file);
      const width = sheet.columns * sheet.tileWidth;
      const at = (x, y) => [...pixels.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
      const sample = at(Math.floor(sheet.tileWidth / 2), 2);
      sample.forEach((value, c) => assert.ok(Math.abs(value - colors[i][c]) < 40, `${sheet.file}: ${sample} vs ${colors[i]}`));
    }
  });
});

test('sheets render two at a time and SIGTERM during sheets removes the run', async () => {
  await withTempDirectory(async (directory) => {
    // A PATH ffmpeg that parks sheet renders and passes everything else to the real one.
    const real = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
    const bin = path.join(directory, 'bin');
    const pids = path.join(directory, 'pids');
    await mkdir(bin);
    await writeFile(path.join(bin, 'ffmpeg'), `#!/bin/sh\ncase "$*" in *tile=*) echo $$ >> '${pids}'; exec sleep 60;; esac\nexec '${real}' "$@"\n`);
    await chmod(path.join(bin, 'ffmpeg'), 0o755);
    const video = path.join(directory, 'clip.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10:d=4', '-c:v', 'mpeg4', '-y', video);
    const output = path.join(directory, 'out');
    const child = spawn(process.execPath, [cli, 'inspect', video, '--around', '0.5', '--around', '1.5', '--around', '2.5', '--around', '3.5', '--window', '0.4', '--fps', '5', '--output', output],
      { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    const started = async () => (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    for (let i = 0; (await started()).length < 2; i++) {
      assert.ok(i < 300, `sheet renders did not start: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await started()).length, 2, 'four sheets, at most two at once');
    child.kill('SIGTERM');
    assert.equal(await exited, 143, stderr);
    assert.match(stderr, /cancelled by SIGTERM/);
    for (const pid of await started()) assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' }, `pid ${pid}`);
    assert.ok(!(await readdir(directory)).includes('out'));
  });
});
