import { spawn } from 'node:child_process';
import os from 'node:os';

// Running children and the signal that cancelled this run, if any. Cancellation kills every child and makes new
// spawns fail, so a run settles its jobs and cleans up instead of leaving FFmpeg writing into its output.
const children = new Set();
export let cancelled;

export function cancellationError() {
  return Object.assign(new Error(`cancelled by ${cancelled}`), { exitCode: 128 + (os.constants.signals[cancelled] ?? 0) });
}

export function cancel(signal) {
  if (cancelled) return;
  cancelled = signal;
  for (const child of children) child.kill('SIGTERM');
}

export function start(program, args) {
  if (cancelled) throw cancellationError();
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.on('close', () => children.delete(child));
  child.on('error', () => children.delete(child));
  return child;
}

export function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = start(program, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => reject(new Error(`${program}: ${error.message}`)));
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${program} exited ${code}: ${stderr.trim()}`)));
  });
}

// Runs a program and passes each line of its `from` output ('stdout' or 'stderr') to `consume` as it arrives,
// so packet and frame listings are never held whole.
export function lines(program, args, from, consume) {
  return new Promise((resolve, reject) => {
    const child = start(program, args);
    const pending = { stdout: '', stderr: '' };
    // The last stderr lines, for the error message.
    const errors = [];
    const read = (stream, line) => {
      if (stream === from) consume(line);
      if (stream === 'stderr' && line.trim() && errors.push(line.trim()) > 20) errors.shift();
    };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        const parts = (pending[stream] + chunk).split('\n');
        pending[stream] = parts.pop();
        for (const line of parts) read(stream, line);
      });
    }
    child.on('error', (error) => reject(new Error(`${program}: ${error.message}`)));
    child.on('close', (code) => {
      read('stdout', pending.stdout);
      read('stderr', pending.stderr);
      if (code !== 0) return reject(new Error(`${program} exited ${code}: ${errors.join('\n')}`));
      resolve();
    });
  });
}

// Runs fn over items with bounded concurrency. After the first failure or a cancellation no new job starts;
// it rejects with that error only once every started job has settled.
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  const worker = async () => {
    while (!failure && next < items.length) {
      if (cancelled) { failure = { error: cancellationError() }; break; }
      const i = next++;
      try { results[i] = await fn(items[i], i); }
      catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}
