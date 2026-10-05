import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const video = path.resolve('test/fixtures/test.mov');
const cli = path.resolve('bin/agvid.js');

async function withTempDirectory(fn) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agvid-test-')));
  try { await fn(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function launch(options, ...args) {
  const child = spawn(process.execPath, [cli, ...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, exited: new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))) };
}

async function until(check, what) {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// An ffmpeg wrapper whose frame extractions record their pid in sync/ and wait for sync/go (about 30 s at most).
async function heldFfmpeg(directory) {
  const real = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(directory, 'gate');
  const sync = path.join(directory, 'sync');
  await mkdir(bin);
  await mkdir(sync);
  await writeFile(path.join(bin, 'ffmpeg'), `#!/bin/sh
case " $* " in *" -update 1 "*) ;; *) exec "${real}" "$@";; esac
touch "${sync}/$$"
i=0; while [ ! -e "${sync}/go" ]; do i=$((i+1)); [ "$i" -gt 3000 ] && exit 1; sleep 0.01; done
exec "${real}" "$@"
`);
  await chmod(path.join(bin, 'ffmpeg'), 0o755);
  return {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    pids: async () => (await readdir(sync)).filter((name) => /^\d+$/.test(name)).map(Number),
    go: () => writeFile(path.join(sync, 'go'), ''),
  };
}

// Every file under `directory` with its content, so a test can prove nothing was removed or rewritten.
async function snapshot(directory) {
  const entries = {};
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    entries[path.relative(directory, file)] = entry.isDirectory() ? null : await readFile(file, 'utf8');
  }
  return entries;
}

test('output entries with agvid-like names are never deleted; the run refuses the directory instead', async () => {
  await withTempDirectory(async (directory) => {
    const work = path.join(directory, 'work');
    const leftover = path.join(work, '.agvid.lock.work-0f1e2d3c-4b5a-4968-8776-655443322110');
    await mkdir(leftover, { recursive: true });
    await writeFile(path.join(leftover, 'frame-0000_00-01.000.jpg'), 'partial');
    const before = await snapshot(work);
    const refused = launch({}, 'frame', video, '--at', '1', '--output', work);
    const result = await refused.exited;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /holds work left by a killed agvid run/);
    assert.ok(result.stderr.includes(path.basename(leftover)), result.stderr);
    assert.deepEqual(await snapshot(work), before);

    // User files that merely share the prefix, including an older release's reclaim guard.
    const named = path.join(directory, 'named');
    await mkdir(path.join(named, '.agvid.lock.reclaim'), { recursive: true });
    await writeFile(path.join(named, '.agvid.lock.reclaim', 'note'), 'keep');
    await writeFile(path.join(named, '.agvid.lock.work-notes'), 'keep');
    const kept = await snapshot(named);
    const other = await launch({}, 'frame', video, '--at', '1', '--output', named).exited;
    assert.match(other.stderr, /output directory is not empty/);
    assert.deepEqual(await snapshot(named), kept);
  });
});

test('a killed default run is left alone while later runs get fresh directories, finish or are interrupted cleanly', async () => {
  await withTempDirectory(async (cwd) => {
    const gate = await heldFfmpeg(cwd);
    const killed = launch({ cwd, env: gate.env }, 'frame', video, '--at', '1');
    await until(async () => (await gate.pids()).length === 1, 'the first extraction');
    killed.child.kill('SIGKILL');
    await killed.exited;
    const runs = path.join(cwd, '.agvid', 'runs');
    const stale = path.join(runs, 'test-frame');
    const left = (await readdir(stale)).sort();
    const lock = await readFile(path.join(stale, '.agvid.lock'), 'utf8');
    assert.match(left.join(), /^\.agvid\.lock,\.agvid\.lock\.work-/);

    const interrupted = launch({ cwd, env: gate.env }, 'overview', video, '--frames', '3', '--width', '160');
    await until(async () => (await gate.pids()).length > 1, 'the interrupted extraction');
    interrupted.child.kill('SIGINT');
    const stopped = await interrupted.exited;
    assert.notEqual(stopped.code, 0);
    assert.match(stopped.stderr, /cancelled by SIGINT/);
    assert.deepEqual(await readdir(runs), ['test-frame']);

    const finished = await launch({ cwd }, 'frame', video, '--at', '2').exited;
    assert.equal(finished.code, 0, finished.stderr);
    const output = JSON.parse(finished.stdout).directory;
    assert.equal(output, path.join(runs, 'test-frame-1'));
    assert.deepEqual((await readdir(output)).sort(), ['frame-0000_00-02.000.jpg', 'manifest.json']);
    await gate.go();
    for (const pid of await gate.pids()) {
      await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, `FFmpeg ${pid} to exit`);
    }
    // The orphaned FFmpeg wrote only into its own run's private work directory, and its lock still stands.
    assert.deepEqual((await readdir(stale)).sort(), left);
    assert.equal(await readFile(path.join(stale, '.agvid.lock'), 'utf8'), lock);
    assert.deepEqual((await readdir(output)).sort(), ['frame-0000_00-02.000.jpg', 'manifest.json']);
  });
});
