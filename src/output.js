import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function findProjectRoot(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    try { await stat(path.join(dir, '.git')); return dir; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    if (path.dirname(dir) === dir) return cwd;
  }
}

// Removes the empty parents of `directory` that mkdir created, up to and including `first`.
async function removeParents(directory, first) {
  if (!first) return;
  for (let dir = path.dirname(directory); ; dir = path.dirname(dir)) {
    try { await rmdir(dir); }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; }
    if (dir === first || path.dirname(dir) === dir) return;
  }
}

const LOCK = '.agvid.lock';
const WORK = `${LOCK}.work-`;

// Claims `directory` for this run by exclusively creating a lock file holding its pid and host. Whichever run creates
// it first owns the directory. agvid never removes a lock it did not create: a killed run's lock stays until someone
// deletes it by hand, because no automatic staleness check is safe against pid reuse, other hosts and stalled runs.
async function claim(directory) {
  const lock = path.join(directory, LOCK);
  let handle;
  try { handle = await open(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const [pid, host] = (await readFile(lock, 'utf8').catch(() => '')).split('\n');
    const holder = pid ? ` (pid ${pid} on ${host || 'an unknown host'})` : '';
    throw Object.assign(new Error(`output directory is in use by another agvid run${holder}: ${directory}\n`
      + `agvid never removes a lock it did not create. If no agvid run is using it, delete ${lock} and any ${WORK}* `
      + 'directories beside it, then retry.'), { inUse: true });
  }
  try { await handle.writeFile(`${process.pid}\n${os.hostname()}\n`); }
  catch (error) { await handle.close().catch(() => {}); await unlink(lock).catch(() => {}); throw error; }
  await handle.close();
  return lock;
}

// Adds a work directory private to this run, where its FFmpeg writes. FFmpeg survives a SIGKILL of agvid, so finished
// files are moved into place only once this run's FFmpeg has exited; an orphan keeps writing only into its own run's
// work directory. Work left by killed runs is never removed automatically: its name alone does not prove agvid made it.
async function workspace(output) {
  const work = path.join(output.directory, `${WORK}${randomUUID()}`);
  try { await mkdir(work); }
  catch (error) { await release(output, []); throw error; }
  return { ...output, work };
}

// Returns the claimed output directory: { directory, lock, work, created, firstParent }.
export async function outputDirectory(video, command, requested) {
  if (requested) {
    const directory = path.resolve(requested);
    const firstParent = await mkdir(path.dirname(directory), { recursive: true });
    let created = true;
    try { await mkdir(directory); }
    catch (error) {
      if (error.code !== 'EEXIST') { await removeParents(directory, firstParent); throw error; }
      created = false;
    }
    // A competing run that claimed the directory first owns it, even if this run created it. That run treats it as
    // pre-existing, so if it fails the directory stays, empty; removing it here instead could race with its files.
    const lock = await claim(directory).catch(async (error) => {
      if (created && !error.inUse) await rmdir(directory).then(() => removeParents(directory, firstParent)).catch(() => {});
      throw error;
    });
    const other = created ? [] : (await readdir(directory)).filter((name) => name !== LOCK);
    if (other.length) {
      await rm(lock, { force: true });
      if (other.every((name) => name.startsWith(WORK))) {
        throw new Error(`output directory holds work left by a killed agvid run: ${directory}\n`
          + `If no agvid run is using it, delete ${other.join(', ')} and retry.`);
      }
      throw new Error(`output directory is not empty: ${directory}`);
    }
    return workspace({ directory, lock, created, firstParent: created ? firstParent : undefined });
  }
  const agvid = path.join(await findProjectRoot(process.cwd()), '.agvid');
  const root = path.join(agvid, 'runs');
  try {
    await mkdir(root, { recursive: true });
    try { await writeFile(path.join(agvid, '.gitignore'), '*\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } catch (error) {
    throw new Error(`cannot write output under ${agvid} (${error.code ?? error.message}); pass --output DIR`);
  }
  const base = `${path.parse(video).name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${command}`;
  for (let suffix = 0; ; suffix++) {
    const directory = path.join(root, suffix ? `${base}-${suffix}` : base);
    try {
      await mkdir(directory);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    const lock = await claim(directory).catch(async (error) => { await rmdir(directory).catch(() => {}); throw error; });
    return workspace({ directory, lock, created: true });
  }
}

// Deletes this run's files, then its lock, then the directory and parents it created if nothing else is in them.
export async function release({ directory, lock, work, created, firstParent }, produced) {
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  await Promise.all(produced.map((file) => rm(file, { force: true }).catch(() => {})));
  await rm(lock, { force: true }).catch(() => {});
  if (created) await rmdir(directory).then(() => removeParents(directory, firstParent)).catch(() => {});
}

export async function nonempty(filename) {
  try { return (await stat(filename)).size > 0; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function saveManifest(directory, result) {
  const filename = path.join(directory, 'manifest.json');
  const temporary = path.join(directory, 'manifest.json.tmp');
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`);
  await rename(temporary, filename);
  return filename;
}
