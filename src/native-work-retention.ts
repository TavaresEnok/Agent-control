import {constants} from 'node:fs';
import {lstat, open, readFile, readdir, rmdir, unlink, type FileHandle} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Id} from './contracts.ts';

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const anchored = (dir: FileHandle, name: string) => join('/proc/self/fd', String(dir.fd), name);

async function openRoot(path: string) {
  if (resolve(path) !== path || path === '/') throw Error('Invalid host root');
  let dir = await open('/', directoryFlags);
  try {
    for (const name of path.slice(1).split('/')) {
      const next = await open(anchored(dir, name), directoryFlags);
      await dir.close();
      dir = next;
    }
    return dir;
  } catch (error) {
    await dir.close();
    throw error;
  }
}

async function assertPrivate(dir: FileHandle) {
  const st = await dir.stat();
  if (st.uid !== process.getuid?.() || (st.mode & 0o7777) !== 0o700) throw Error('Unsafe job directory');
}

async function mountId(dir: FileHandle) {
  const info = await readFile('/proc/self/fdinfo/' + dir.fd, 'utf8');
  const id = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1];
  if (!id) throw Error('Unknown mount');
  return id;
}

// Keep the parent open while visiting and unlinking its children. File and link
// removal never follows the leaf. Each directory open rejects links and mounts.
async function visit(dir: FileHandle, mount: string, remove: boolean): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(anchored(dir, '.'))) {
    const path = anchored(dir, name);
    const entry = await lstat(path);
    if (!entry.isDirectory()) {
      bytes += entry.size;
      if (remove) await unlink(path);
      continue;
    }
    const child = await open(path, directoryFlags);
    try {
      const actual = await child.stat();
      if (actual.dev !== entry.dev || actual.ino !== entry.ino || await mountId(child) !== mount) throw Error('Changed directory');
      bytes += await visit(child, mount, remove);
      if (remove) await rmdir(path);
    } finally {
      await child.close();
    }
  }
  return bytes;
}

export async function examineWorkTree(hostRoot: string, jobId: string, remove: boolean): Promise<number | null> {
  Id.parse(jobId);
  const root = await openRoot(hostRoot);
  try {
    await assertPrivate(root);
    const job = await open(anchored(root, jobId), directoryFlags);
    try {
      await assertPrivate(job);
      const mount = await mountId(job);
      if (mount !== await mountId(root)) throw Error('Unexpected job mount');
      const workPath = anchored(job, 'work');
      let work: FileHandle;
      try {
        work = await open(workPath, directoryFlags);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      try {
        const stat = await work.stat();
        if (stat.uid !== process.getuid?.() || await mountId(work) !== mount) throw Error('Unsafe work directory');
        const bytes = await visit(work, mount, remove);
        if (remove) await rmdir(workPath);
        return bytes;
      } finally {
        await work.close();
      }
    } finally {
      await job.close();
    }
  } finally {
    await root.close();
  }
}
