import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, mkdtemp, open, readdir, rename, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const runName = /^ac-perf-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ownerToken = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ownerLabel = 'org.agent-control.performance.owner';
const cleanupTimeout = 5000;
const defaultDirectory = join(homedir(), '.local', 'state', 'agent-control', 'performance-docker');

export function performanceDocker(dockerBinary, cwd) {
  if (dockerBinary !== 'docker' && !isAbsolute(dockerBinary)) throw new Error('caminho local do Docker inválido');
  const env = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: cwd,
    DOCKER_CONFIG: join(cwd, 'docker-config'), DOCKER_HOST: 'unix:///var/run/docker.sock', LC_ALL: 'C'};
  return (args, {timeout = 15_000, limit = 8192, signal} = {}) => {
    signal?.throwIfAborted();
    return new Promise((ok, fail) => {
      execFile(dockerBinary, args, {cwd, env, encoding: 'utf8', timeout, maxBuffer: limit, killSignal: 'SIGKILL', signal},
        (error, stdout, stderr) => {
          if (!error) return ok(stdout.trim());
          error.stderr = stderr;
          fail(error);
        });
    });
  };
}

async function privateDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directory.stat();
    if (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('diretório privado de recuperação Docker exigido');
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function openRegistry(directory = defaultDirectory) {
  if (!isAbsolute(directory)) throw new Error('diretório absoluto de recuperação Docker exigido');
  const path = resolve(directory);
  const created = await mkdir(path, {recursive: true, mode: 0o700});
  const registry = await privateDirectory(path);
  try {
    if (created) {
      const last = dirname(created);
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
        try { await handle.sync(); } finally { await handle.close(); }
        if (parent === last) break;
      }
    }
    return registry;
  } catch (error) {
    await registry.close();
    throw error;
  }
}

// flock usa a mesma descrição de arquivo aberta pelo Node, que retém a trava
// até fechar o descritor. O kernel também a libera se o processo morrer.
function tryLock(directory) {
  return new Promise((ok, fail) => {
    const child = spawn('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '73', '3'],
      {stdio: ['ignore', 'ignore', 'ignore', directory.fd]});
    child.once('error', fail);
    child.once('close', code => {
      if (code === 0) ok(true);
      else if (code === 73) ok(false);
      else fail(new Error('falha na trava do registro Docker'));
    });
  });
}

function anchored(directory, file = '') {
  return join(`/proc/self/fd/${directory.fd}/`, file);
}

function resourceKind(run, name) {
  if ([run, `${run}-obs`, `${run}-obs-static`].includes(name)) return 'container';
  if (name === `${run}-link`) return 'volume';
  return null;
}

class RecoveryRun {
  constructor(registry, directory, name, state) {
    this.registry = registry;
    this.directory = directory;
    this.name = name;
    this.state = state;
  }

  async save() {
    const next = anchored(this.directory, 'state.next');
    const file = await open(next, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify(this.state));
      await file.sync();
    } finally { await file.close(); }
    await rename(next, anchored(this.directory, 'state.json'));
    await this.directory.sync();
  }

  async reserve(kind, name) {
    if (resourceKind(this.name, name) !== kind || Object.hasOwn(this.state.resources, name)) {
      throw new Error('reserva Docker inválida');
    }
    this.state.resources[name] = false;
    await this.save();
    return ['--label', `${ownerLabel}=${this.state.owner}`];
  }

  async discardUnsent(name) {
    delete this.state.resources[name];
    await this.save();
  }

  async owned(docker, kind, name, options) {
    const labels = kind === 'container' ? '.Config.Labels' : '.Labels';
    const identity = kind === 'container' ? '.Id' : '.Name';
    const format = `{{${identity}}} {{index ${labels} "${ownerLabel}"}}`;
    let inspected;
    try { inspected = await docker([kind, 'inspect', '--format', format, name], options); }
    catch (error) {
      if (error?.code === 1 && /no such (?:container|object|volume)\b/i.test(error.stderr ?? '')) return null;
      throw error;
    }
    const [id, owner] = inspected.split(' ');
    if (owner !== this.state.owner || (kind === 'container' ? !/^[a-f0-9]{64}$/.test(id) : id !== name)) {
      throw new Error('propriedade Docker sem confirmação');
    }
    return id;
  }

  async confirmCreation(docker, kind, name) {
    const id = await this.owned(docker, kind, name, {timeout: cleanupTimeout});
    if (!id) throw new Error('criação Docker sem confirmação');
    this.state.resources[name] = true;
    await this.save();
    return id;
  }

  async clean(docker, {attempts = 1, signal} = {}) {
    const options = {timeout: cleanupTimeout, signal};
    const names = Object.keys(this.state.resources).reverse();
    for (const name of names) {
      signal?.throwIfAborted();
      const kind = resourceKind(this.name, name);
      for (let attempt = 0; attempt < attempts; attempt++) {
        signal?.throwIfAborted();
        try {
          const id = await this.owned(docker, kind, name, options);
          if (id) {
            if (!this.state.resources[name]) {
              this.state.resources[name] = true;
              await this.save();
            }
            const args = kind === 'container' ? ['container', 'rm', '-f', id] : ['volume', 'rm', id];
            await docker(args, options);
            if (await this.owned(docker, kind, name, options)) throw new Error('recurso Docker ainda presente');
          }
          // Ausência não encerra uma criação cuja resposta não foi confirmada.
          if (this.state.resources[name]) {
            delete this.state.resources[name];
            await this.save();
            break;
          }
        } catch {
          signal?.throwIfAborted();
          // A intenção continua disponível para a próxima passagem.
        }
        if (attempt + 1 < attempts) await delay(200, undefined, {signal});
      }
    }
    return Object.keys(this.state.resources).length;
  }

  async close() {
    try {
      if (!Object.keys(this.state.resources).length) {
        await rm(anchored(this.registry, this.name), {recursive: true, force: true});
        await this.registry.sync();
      }
    } finally {
      try { await this.directory.close(); }
      finally { await this.registry.close(); }
    }
  }
}

export async function openPerformanceRecoveryRun(name, recoveryDirectory) {
  if (!runName.test(name)) throw new Error('nome de execução Docker inválido');
  const registry = await openRegistry(recoveryDirectory);
  let staging, directory;
  try {
    staging = await mkdtemp(anchored(registry, '.new-'));
    directory = await privateDirectory(staging);
    if (!await tryLock(directory)) throw new Error('trava Docker inesperadamente ocupada');
    const run = new RecoveryRun(registry, directory, name, {owner: randomUUID(), resources: {}});
    await run.save();
    await rename(staging, anchored(registry, name));
    await registry.sync();
    return run;
  } catch (error) {
    if (directory) await directory.close();
    if (staging) await rm(staging, {recursive: true, force: true});
    await registry.close();
    throw error;
  }
}

async function readState(directory, name) {
  const file = await open(anchored(directory, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new Error('registro Docker inválido');
    const state = JSON.parse(await file.readFile('utf8'));
    if (typeof state?.owner !== 'string' || !ownerToken.test(state.owner) || !state.resources || typeof state.resources !== 'object' ||
        Array.isArray(state.resources) ||
        Object.entries(state.resources).some(([key, value]) => !resourceKind(name, key) || typeof value !== 'boolean')) {
      throw new Error('registro Docker inválido');
    }
    return state;
  } finally { await file.close(); }
}

/** Uma passagem no registro local. Use o mesmo diretório privado de runPerformanceModule. */
export async function reconcilePerformanceResources({recoveryDirectory, signal} = {}, {dockerBinary = 'docker'} = {}) {
  signal?.throwIfAborted();
  const registry = await openRegistry(recoveryDirectory);
  let temp;
  try {
    temp = await mkdtemp(join(tmpdir(), 'ac-perf-recovery-'));
    const docker = performanceDocker(dockerBinary, temp);
    const result = {cleaned: 0, pending: 0, active: 0, invalid: 0};
    for (const name of await readdir(anchored(registry))) {
      signal?.throwIfAborted();
      if (!runName.test(name)) continue;
      let directory;
      try {
        directory = await privateDirectory(anchored(registry, name));
        if (!await tryLock(directory)) { result.active++; continue; }
        // Outro reconciliador pode ter apagado o diretório antes da aquisição.
        const state = await readState(directory, name);
        const run = new RecoveryRun(registry, directory, name, state);
        if (await run.clean(docker, {signal})) result.pending++;
        else {
          await rm(anchored(registry, name), {recursive: true, force: true});
          await registry.sync();
          result.cleaned++;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (error.code !== 'ENOENT') result.invalid++;
      } finally { await directory?.close(); }
    }
    signal?.throwIfAborted();
    return result;
  } finally {
    try { if (temp) await rm(temp, {recursive: true, force: true}); }
    finally { await registry.close(); }
  }
}
