import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('bin/agvid.js');
const bundled = path.resolve('test/fixtures/test.mov');
const realFfmpeg = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { maxBuffer: 1 << 28, ...options });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

const ffmpeg = (...args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, '-y']);

async function withTempDirectory(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agvid-dense-'));
  try { await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

// A PATH ffmpeg that logs each call's arguments to a file of its own (concurrent appends of long lines can interleave),
// runs the real one and, for a chunk decode, logs how many JPEGs it wrote. Calls are { args, encoded }.
async function loggingFfmpeg(directory) {
  const bin = path.join(directory, 'bin');
  const log = path.join(directory, 'ffmpeg-calls');
  await mkdir(bin, { recursive: true });
  await mkdir(log);
  await writeFile(path.join(bin, 'ffmpeg'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${log}'/$$\n'${realFfmpeg}' "$@"\nstatus=$?\nfor last; do :; done\n`
    + `case "$last" in *.chunk-*) ls "\${last%-%04d.jpg}"-*.jpg 2>/dev/null | wc -l >> '${log}'/$$;; esac\nexit $status\n`);
  await chmod(path.join(bin, 'ffmpeg'), 0o755);
  return {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    calls: async () => Promise.all((await readdir(log)).map(async (name) => {
      const [args, encoded] = (await readFile(path.join(log, name), 'utf8')).trim().split('\n');
      return { args: args.split(' '), encoded: Number(encoded ?? 0) };
    })),
    reset: async () => { await rm(log, { recursive: true, force: true }); await mkdir(log); },
  };
}

async function agvid(args, env) {
  const output = JSON.parse(run(process.execPath, [cli, ...args], { encoding: 'utf8', env }));
  return { ...output, manifest: JSON.parse(await readFile(output.manifest, 'utf8')) };
}

// Every frame the source holds, decoded from the origin: pts in seconds and gray pixels of the displayed (rotated)
// frame, cut to `crop` fractions and scaled to `size` ([width, height]); pixels only for frames within `span` seconds.
// Independent of agvid's seeking, selection and geometry.
function sourceFrames(video, crop, size, [from, to]) {
  const [stream] = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base', '-of', 'json', video], { encoding: 'utf8' })).streams;
  const [num, den] = stream.time_base.split('/').map(Number);
  const pts = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=best_effort_timestamp', '-of', 'csv=p=0', video], { encoding: 'utf8' })
    .trim().split('\n').map((value) => parseInt(value, 10) * num / den);
  const first = pts.findIndex((t) => t >= from);
  const count = pts.filter((t) => t >= from && t <= to).length;
  const cut = crop ? `crop=iw*${crop[2]}:ih*${crop[3]}:iw*${crop[0]}:ih*${crop[1]},` : '';
  const raw = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-copyts', '-i', video, '-map', '0:v:0', '-vf', `${cut}select='between(n,${first},${first + count - 1})',scale=${size.join(':')},format=gray`,
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-']);
  const bytes = size[0] * size[1];
  assert.equal(raw.length, count * bytes, 'one decoded frame per listed pts');
  return { pts, size, pixels: (i) => (i >= first && i < first + count ? raw.subarray((i - first) * bytes, (i - first + 1) * bytes) : undefined) };
}

// The manifest's times on the stream timeline, with a second of frames before and after.
const span = ({ frames, source }) => [frames[0].time + source.containerStart - 1, frames.at(-1).time + source.containerStart + 1];

const imagePixels = (file, size) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${size.join(':')},format=gray`, '-f', 'rawvideo', '-']);

// Asserts each extracted frame is the source frame shown at its time: closer to that frame than to any distinguishable
// frame within two of it. Returns the shown source indexes and how many comparisons could tell frames apart.
function assertShown(directory, manifest, source, label) {
  let decisive = 0;
  const shown = manifest.frames.map(({ file, time }) => {
    const index = source.pts.findLastIndex((pts) => pts <= time + manifest.source.containerStart + 1e-9);
    assert.ok(index >= 0, `${label}: no source frame at ${time}s`);
    const image = imagePixels(path.join(directory, file), source.size);
    const expected = source.pixels(index);
    assert.ok(expected, `${label}: ${time}s outside the reference span`);
    for (const rival of [index - 2, index - 1, index + 1, index + 2]) {
      const other = source.pixels(rival);
      if (!other) continue;
      const pixels = [...expected.keys()].filter((k) => Math.abs(expected[k] - other[k]) > 40);
      if (pixels.length < 20) continue;
      decisive++;
      const distance = (frame) => pixels.reduce((sum, k) => sum + Math.abs(image[k] - frame[k]), 0) / pixels.length;
      assert.ok(distance(expected) * 3 < distance(other),
        `${label} ${time}s: ${distance(expected)} from ${source.pts[index]}s, ${distance(other)} from ${source.pts[rival]}s`);
    }
    return index;
  });
  return { shown, decisive };
}

const chunkCalls = (calls) => calls.filter(({ args }) => args.some((arg) => arg.includes('.chunk-')));
const perTimeCalls = (calls) => calls.filter(({ args }) => args.includes('-update'));
const encodedCount = (calls) => chunkCalls(calls).reduce((sum, { encoded }) => sum + encoded, 0);

test('dense inspect decodes in chunks and shows the frame at each time across CFR, VFR, holds, duplicate pts, delayed starts, TS, crop and rotation', async () => {
  await withTempDirectory(async (directory) => {
    const ffmpegLog = await loggingFfmpeg(directory);
    const file = (name) => path.join(directory, name);
    // B-frames and a 1.6 s GOP make decode order differ from presentation order and keyframes sparse.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=6', '-c:v', 'libx264', '-bf', '2', '-g', '48', '-pix_fmt', 'yuv420p', file('cfr.mp4'));
    const rotation = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-display_rotation', '90', '-i', file('cfr.mp4'), '-c', 'copy', '-y', file('rotated.mp4')]);
    if (rotation.status !== 0) ffmpeg('-i', file('cfr.mp4'), '-c', 'copy', '-metadata:s:v', 'rotate=90', file('rotated.mp4'));
    // Frames 0.1 s apart with 1.4 s and 2.1 s holds: most times there show a held frame.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=10:d=3', '-vf', "settb=1/1000,setpts='(N*0.1+gte(N,10)*1.3+gte(N,20)*2)/TB'",
      '-fps_mode', 'passthrough', '-enc_time_base', 'filter', '-c:v', 'libx264', '-g', '12', file('holds.mkv'));
    // Pairs of frames share each pts, 0.2 s apart, reordered by B-frames: a time shows the later decoded of its pair.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=10:d=3', '-vf', "settb=1/1000,setpts='floor(N/2)*0.2/TB'",
      '-fps_mode', 'passthrough', '-enc_time_base', 'filter', '-c:v', 'libx264', '-bf', '2', '-g', '12', file('duplicates.mkv'));
    // Video starts 0.8 s after the container (audio from 0), behind an MP4 edit list.
    ffmpeg('-itsoffset', '0.8', '-i', file('cfr.mp4'), '-f', 'lavfi', '-i', 'anullsrc=d=6', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', file('delayed.mp4'));
    // MPEG-TS starts at 1.4 s and always decodes from the origin.
    ffmpeg('-i', file('cfr.mp4'), '-c', 'copy', file('cfr.ts'));
    // AVI lists B-frame packets without pts, so its times seek one by one.
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=6', '-c:v', 'mpeg4', '-bf', '2', '-g', '48', file('cfr.avi'));
    const cases = [
      ['cfr', file('cfr.mp4'), ['--around', '3.7', '--window', '2.4', '--fps', '20'], 200],
      ['vfr', bundled, ['--around', '7.15', '--window', '0.6', '--fps', '60'], 640],
      ['holds', file('holds.mkv'), ['--start', '0.3', '--end', '5.8', '--fps', '10'], 200],
      ['duplicate pts', file('duplicates.mkv'), ['--start', '0.3', '--end', '2.9', '--fps', '10'], 200],
      ['delayed start', file('delayed.mp4'), ['--around', '1.1', '--window', '1.2', '--fps', '20'], 200],
      ['ts', file('cfr.ts'), ['--around', '4', '--window', '1', '--fps', '20'], 200],
      ['rotation and crop', file('rotated.mp4'), ['--around', '2.5', '--window', '1', '--fps', '15', '--crop', '0.1,0.2,0.6,0.5'], 200],
      ['avi', file('cfr.avi'), ['--around', '3', '--window', '1', '--fps', '10'], 200, false],
    ];
    for (const [label, video, args, width, chunked = true] of cases) {
      await ffmpegLog.reset();
      const output = file(`out-${label.replaceAll(' ', '-')}`);
      const { manifest } = await agvid(['inspect', video, ...args, '--output', output, '--width', String(width)], ffmpegLog.env);
      const calls = await ffmpegLog.calls();
      assert.equal(chunkCalls(calls).length > 0, chunked, `${label}: decoded in chunks`);
      assert.equal(perTimeCalls(calls).length, chunked ? 0 : manifest.frames.length, `${label}: times seeking one by one`);
      const crop = args.includes('--crop') ? args[args.indexOf('--crop') + 1].split(',').map(Number) : undefined;
      // Screen text needs the full output size to tell frames apart.
      const source = sourceFrames(video, crop, width > 200 ? [width, width * manifest.source.height / manifest.source.width] : [96, 96], span(manifest));
      const { shown, decisive } = assertShown(output, manifest, source, label);
      assert.ok(decisive >= manifest.frames.length, `${label}: only ${decisive} distinguishable comparisons`);
      // Each source frame at a shown pts is encoded once per chunk showing it (a frame held across a chunk boundary is
      // shown by both); times sharing it get copies.
      const distinct = new Set(shown).size;
      const shownPts = new Set(shown.map((i) => source.pts[i]));
      const atShown = source.pts.filter((pts) => shownPts.has(pts)).length;
      const most = Math.max(...[...shownPts].map((pts) => source.pts.filter((other) => other === pts).length));
      if (chunked) {
        assert.ok(encodedCount(calls) >= distinct && encodedCount(calls) <= atShown + (chunkCalls(calls).length - 1) * most,
          `${label}: ${encodedCount(calls)} JPEG encodes for ${distinct} frames in ${chunkCalls(calls).length} chunks`);
      }
      if (label === 'holds') assert.ok(new Set(shown).size < manifest.frames.length / 2);
      if (label === 'duplicate pts') assert.ok(shown.every((i) => source.pts[i - 1] === source.pts[i]), 'each time shows the second of a pair');
      if (label === 'delayed start') assert.ok(manifest.source.start > 0.7 && manifest.frames[0].time < manifest.source.start + 0.5);
      // The per-time seeking path, which frame uses, writes the same bytes for the same times.
      const single = await agvid(['frame', video, '--at', manifest.frames.map(({ time }) => String(time)).join(','), ...(crop ? ['--crop', crop.join(',')] : []),
        '--output', `${output}-frame`, '--width', String(width)]);
      for (const { file: name, time } of manifest.frames) {
        const twin = single.manifest.frames.find((frame) => frame.time === time);
        assert.ok((await readFile(path.join(output, name))).equals(await readFile(path.join(`${output}-frame`, twin.file))), `${label} ${time}s`);
      }
    }
  });
});

test('a frame missing from the packet listing is still the one shown at its time', async () => {
  await withTempDirectory(async (directory) => {
    const ffmpegLog = await loggingFfmpeg(directory);
    const video = path.join(directory, 'clip.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4', '-c:v', 'libx264', '-bf', '3', '-g', '30', '-pix_fmt', 'yuv420p', video);
    // 1.95 s, the last time of the only chunk, shows the frame at 1.933 s. An ffprobe whose packet listing omits it makes
    // the chunk guess the frame before; only the decoded frames can tell.
    const source = sourceFrames(video, undefined, [96, 96], [0.9, 3]);
    const [, num, den] = /(\d+)\/(\d+)/.exec(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base', '-of', 'csv=p=0', video], { encoding: 'utf8' }));
    const hidden = Math.round(source.pts[source.pts.findLastIndex((pts) => pts <= 1.95)] * den / num);
    const realFfprobe = spawnSync('sh', ['-c', 'command -v ffprobe'], { encoding: 'utf8' }).stdout.trim();
    await writeFile(path.join(directory, 'bin', 'ffprobe'), `#!/bin/sh\ncase "$*" in *packet=pts*) '${realFfprobe}' "$@" | grep -v '^${hidden},';; *) exec '${realFfprobe}' "$@";; esac\n`);
    await chmod(path.join(directory, 'bin', 'ffprobe'), 0o755);
    const output = path.join(directory, 'out');
    const { manifest } = await agvid(['inspect', video, '--start', '1', '--end', '2', '--fps', '10', '--output', output], ffmpegLog.env);
    assert.equal(manifest.frames.at(-1).time, 1.95);
    const calls = await ffmpegLog.calls();
    assert.equal(chunkCalls(calls).length, 1);
    assert.equal(perTimeCalls(calls).length, 1, 'only the unconfirmed time seeks');
    const { decisive } = assertShown(output, manifest, source, 'unlisted');
    assert.ok(decisive >= manifest.frames.length);
  });
});

test('overlapping windows share decoded and encoded frames but keep their own entries, files and sheets', async () => {
  await withTempDirectory(async (directory) => {
    const ffmpegLog = await loggingFfmpeg(directory);
    const video = path.join(directory, 'clip.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=5', '-c:v', 'libx264', '-g', '30', '-pix_fmt', 'yuv420p', video);
    // Windows 1-3 s and 1.5-3.5 s at 4 fps: 1.625 s to 2.875 s are in both.
    const output = path.join(directory, 'out');
    const { manifest } = await agvid(['inspect', video, '--around', '2,2.5', '--window', '2s', '--fps', '4', '--output', output], ffmpegLog.env);
    const times = manifest.frames.map(({ time }) => time);
    assert.equal(times.length, 16);
    assert.equal(new Set(times).size, 10);
    assert.equal(new Set(manifest.frames.map(({ file }) => file)).size, 16);
    assert.deepEqual((await readdir(output)).filter((name) => name.startsWith('frame-')).sort(), manifest.frames.map(({ file }) => file).sort());
    const calls = await ffmpegLog.calls();
    assert.equal(perTimeCalls(calls).length, 0);
    assert.equal(encodedCount(calls), 10);
    for (const [i, frame] of manifest.frames.entries()) {
      const first = manifest.frames.find(({ time }) => time === frame.time);
      if (first !== frame) assert.ok((await readFile(path.join(output, frame.file))).equals(await readFile(path.join(output, first.file))), `entry ${i}`);
    }
    assert.deepEqual(manifest.windows.map((window) => window.frames), [[0, 7], [8, 15]]);
    assert.equal(manifest.windows.flatMap((window) => window.sheets).length, 2);
    assertShown(output, manifest, sourceFrames(video, undefined, [96, 96], span(manifest)), 'overlap');
  });
});

test('SIGTERM during a chunk decode stops FFmpeg and removes the run', async () => {
  await withTempDirectory(async (directory) => {
    const bin = path.join(directory, 'bin');
    const pids = path.join(directory, 'pids');
    await mkdir(bin);
    await writeFile(path.join(bin, 'ffmpeg'), `#!/bin/sh\ncase "$*" in *.chunk-*) echo $$ >> '${pids}'; exec sleep 60;; esac\nexec '${realFfmpeg}' "$@"\n`);
    await chmod(path.join(bin, 'ffmpeg'), 0o755);
    const video = path.join(directory, 'clip.mp4');
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=8', '-c:v', 'libx264', '-g', '30', video);
    const output = path.join(directory, 'out');
    const child = spawn(process.execPath, [cli, 'inspect', video, '--start', '0', '--end', '8', '--fps', '10', '--output', output],
      { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    const started = async () => (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    for (let i = 0; (await started()).length < 2; i++) {
      assert.ok(i < 300, `chunk decodes did not start: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill('SIGTERM');
    assert.equal(await exited, 143, stderr);
    assert.match(stderr, /cancelled by SIGTERM/);
    for (const pid of await started()) assert.throws(() => process.kill(Number(pid), 0), { code: 'ESRCH' }, `pid ${pid}`);
    assert.ok(!(await readdir(directory)).includes('out'));
  });
});
