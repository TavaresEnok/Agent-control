import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, mkdtemp, open, readdir, rename, rm} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const runName = /^ac-perf-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ownerToken = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const containerId = /^[a-f0-9]{64}$/;
const ownerLabel = 'org.agent-control.performance.owner';
const cleanupTimeout = 5000;
const defaultDirectory = join(homedir(), '.local', 'state', 'agent-control', 'performance-docker');
const failedSpawns = new WeakSet();

function isSpawnError(error) {
  return ['ENOENT', 'ENOTDIR', 'EACCES', 'ENOEXEC', 'EAGAIN'].includes(error?.code) &&
    /^spawn(?: |$)/.test(error.syscall ?? '');
}

export function performanceDocker(dockerBinary, cwd) {
  if (dockerBinary !== 'docker' && !isAbsolute(dockerBinary)) throw new Error('caminho local do Docker inválido');
  const env = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: cwd,
    DOCKER_CONFIG: join(cwd, 'docker-config'), DOCKER_HOST: 'unix:///var/run/docker.sock', LC_ALL: 'C'};
  return (args, {timeout = 15_000, limit = 8192, signal} = {}) => {
    signal?.throwIfAborted();
    return new Promise((ok, fail) => {
      try {
        const child = execFile(dockerBinary, args,
          {cwd, env, encoding: 'utf8', timeout, maxBuffer: limit, killSignal: 'SIGKILL', signal},
          (error, stdout, stderr) => {
            if (!error) return ok(stdout.trim());
            error.stdout = stdout;
            error.stderr = stderr;
            if (!child.pid && isSpawnError(error)) failedSpawns.add(error);
            fail(error);
          });
      } catch (error) {
        if (isSpawnError(error)) failedSpawns.add(error);
        fail(error);
      }
    });
  };
}

function creationRefused(error) {
  if (failedSpawns.has(error)) return true;
  if (error?.code !== 1 || error.killed || error.signal || error.stdout?.trim()) return false;
  // Apenas recusas anteriores à criação. Uma mensagem genérica do daemon
  // também pode ocorrer quando o cliente perde a resposta da operação.
  return /^(?:docker: )?Error response from daemon: (?:No such image: |Conflict\. The container name .* is already in use by container |invalid mount config for type "bind": bind source path does not exist: )/i
    .test(error.stderr?.trim() ?? '');
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

function isContainerName(run, name) {
  return [run, `${run}-obs`, `${run}-obs-static`].includes(name);
}

const legacyVolume = run => `${run}-link`;

class RecoveryRun {
  constructor(registry, directory, name, state) {
    this.registry = registry;
    this.directory = directory;
    this.name = name;
    this.state = state;
    this.dirty = false;
  }

  async save() {
    this.dirty = true;
    const next = anchored(this.directory, 'state.next');
    const file = await open(next, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify(this.state));
      await file.sync();
    } finally { await file.close(); }
    await publishState(this.directory);
    this.dirty = false;
  }

  socket(file) {
    return {listenPath: anchored(this.directory, file), mountPath: join(this.path, file)};
  }

  get pending() {
    return Object.keys(this.state.resources).length;
  }

  async reserve(name) {
    if (!isContainerName(this.name, name) || Object.hasOwn(this.state.resources, name)) {
      throw new Error('reserva Docker inválida');
    }
    try {
      // Se o cliente parar antes de gravar sua resposta, o nome sozinho
      // não distingue a criação original de um substituto.
      await this.record(name, null);
    } catch (error) {
      // A reserva pode estar visível após o rename, mas nenhum comando saiu.
      try { await this.record(name); }
      catch (rollback) {
        throw new AggregateError([error, rollback], 'falha ao gravar e desfazer a reserva Docker', {cause: error});
      }
      throw error;
    }
    return ['--label', `${ownerLabel}=${this.state.owner}`];
  }

  async record(name, state) {
    if (state === undefined) delete this.state.resources[name];
    else this.state.resources[name] = state;
    await this.save();
  }

  async ownedContainer(docker, reference, options) {
    const format = `{{.Id}} {{index .Config.Labels "${ownerLabel}"}}`;
    let inspected;
    try { inspected = await docker(['container', 'inspect', '--format', format, reference], options); }
    catch (error) {
      if (error?.code === 1 && !error.stdout?.trim() && /no such (?:container|object)\b/i.test(error.stderr ?? '')) return null;
      throw error;
    }
    const [id, owner, extra] = inspected.split(' ');
    if (owner !== this.state.owner || extra !== undefined || !containerId.test(id) ||
        (containerId.test(reference) && reference !== id)) {
      const error = new Error('propriedade Docker sem confirmação');
      if (containerId.test(id)) error.containerId = id;
      throw error;
    }
    return id;
  }

  async confirmCreation(docker, name, id, signal) {
    if (!containerId.test(id)) throw new Error('ID da criação Docker indisponível');
    await this.record(name, id);
    if (!await this.ownedContainer(docker, id, {timeout: cleanupTimeout, signal})) {
      throw new Error('criação Docker sem confirmação');
    }
    return id;
  }

  async recordFailedCreation(name, error) {
    const id = error?.stdout?.trim();
    if (id && containerId.test(id)) await this.record(name, {id});
    else if (creationRefused(error)) await this.record(name);
    else if (!id || /^[a-f0-9]{1,63}$/.test(id)) await this.record(name, false);
  }

  async inspectByName(docker, name, recorded, options) {
    // A resolução por nome também pode produzir um ID que precisa sobreviver
    // a uma interrupção da gravação. Arme a mesma proteção antes da consulta.
    try { await this.record(name, null); }
    catch (error) {
      // A consulta não saiu. Uma nova tentativa ainda pode usar o nome.
      this.state.resources[name] = recorded;
      throw error;
    }
    let id;
    try { id = await this.ownedContainer(docker, name, options); }
    catch (error) {
      const candidate = error.containerId ?? error.stdout?.trim().split(' ', 1)[0];
      await this.record(name, containerId.test(candidate) ? {id: candidate} : recorded);
      throw error;
    }
    if (!id && recorded === false) await this.record(name, false);
    return id;
  }

  async clean(docker, {attempts = 1, signal} = {}) {
    const options = {timeout: cleanupTimeout, signal};
    const names = Object.keys(this.state.resources).reverse();
    for (const name of names) {
      signal?.throwIfAborted();
      // Um nome de volume legado não fixa a identidade do objeto. Preserve
      // a intenção original, inclusive quando o daemon ainda não o publicou.
      if (name === legacyVolume(this.name)) continue;
      for (let attempt = 0; attempt < attempts; attempt++) {
        signal?.throwIfAborted();
        try {
          const recorded = this.state.resources[name];
          if (recorded === undefined || recorded === null) break;
          const id = typeof recorded === 'boolean'
            ? await this.inspectByName(docker, name, recorded, options)
            : await this.ownedContainer(docker, typeof recorded === 'string' ? recorded : recorded.id, options);
          if (id) {
            if (id !== recorded) await this.record(name, id);
            else if (this.dirty) await this.save();
            await docker(['container', 'rm', '-f', id], options);
            if (await this.ownedContainer(docker, id, options)) throw new Error('contêiner Docker ainda presente');
          }
          // Um ID recebido com erro fixa a busca, mas a ausência ainda é inconclusiva.
          if (id || recorded === true || typeof recorded === 'string') {
            await this.record(name);
            break;
          }
        } catch {
          signal?.throwIfAborted();
          // A intenção continua disponível para a próxima passagem.
        }
        if (attempt + 1 < attempts) await delay(200, undefined, {signal});
      }
    }
  }

  async finish() {
    if (!this.pending) {
      await rm(anchored(this.registry, this.name), {recursive: true, force: true});
      await this.registry.sync();
    } else if (this.dirty) await this.save();
  }

  async close() {
    try { await this.finish(); }
    finally {
      try { await this.directory.close(); }
      finally { await this.registry.close(); }
    }
  }
}

export async function openPerformanceRecoveryRun(name, recoveryDirectory) {
  if (!runName.test(name)) throw new Error('nome de execução Docker inválido');
  const registry = await openRegistry(recoveryDirectory);
  let runPath, directory;
  try {
    runPath = await mkdtemp(anchored(registry, '.new-'));
    directory = await privateDirectory(runPath);
    if (!await tryLock(directory)) throw new Error('trava Docker inesperadamente ocupada');
    const run = new RecoveryRun(registry, directory, name, {owner: randomUUID(), resources: {}});
    run.path = join(resolve(recoveryDirectory ?? defaultDirectory), name);
    await run.save();
    const published = anchored(registry, name);
    await rename(runPath, published);
    runPath = published;
    await registry.sync();
    return run;
  } catch (error) {
    try {
      if (runPath) {
        await rm(runPath, {recursive: true, force: true});
        await registry.sync();
      }
    } catch (rollback) {
      throw new AggregateError([error, rollback], 'falha ao publicar e desfazer o registro Docker', {cause: error});
    } finally {
      try { await directory?.close(); }
      finally { await registry.close(); }
    }
    throw error;
  }
}

async function publishState(directory) {
  await rename(anchored(directory, 'state.next'), anchored(directory, 'state.json'));
  await directory.sync();
}

async function readState(directory, name, filename) {
  const file = await open(anchored(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw new Error('registro Docker inválido');
    const state = JSON.parse(await file.readFile('utf8'));
    if (typeof state?.owner !== 'string' || !ownerToken.test(state.owner) || !state.resources || typeof state.resources !== 'object' ||
        Array.isArray(state.resources) ||
        Object.entries(state.resources).some(([key, value]) => {
          if (key === legacyVolume(name)) return typeof value !== 'boolean';
          return !isContainerName(name, key) || !(value === null || typeof value === 'boolean' ||
            (typeof value === 'string' && containerId.test(value)) ||
            (value && typeof value === 'object' && Object.keys(value).length === 1 &&
              typeof value.id === 'string' && containerId.test(value.id)));
        })) {
      throw new Error('registro Docker inválido');
    }
    return state;
  } finally { await file.close(); }
}

async function readRecoveryRun(registry, directory, name) {
  const state = await readState(directory, name, 'state.json');
  const run = new RecoveryRun(registry, directory, name, state);
  let staged;
  try { staged = await readState(directory, name, 'state.next'); }
  catch (error) {
    if (error.code === 'ENOENT') return run;
    // Um diário antigo pode ter sido interrompido antes de salvar um ID.
    // Com uma escrita ilegível, suspenda a busca por nome dessas entradas.
    for (const [key, value] of Object.entries(state.resources)) {
      if (isContainerName(name, key) && typeof value === 'boolean') {
        state.resources[key] = null;
        run.dirty = true;
      }
    }
    return run;
  }
  if (staged.owner !== state.owner) throw new Error('proprietário divergente no registro Docker pendente');
  for (const [key, value] of Object.entries(state.resources)) {
    const candidate = staged.resources[key];
    if (!isContainerName(name, key) || candidate === undefined) continue;
    const id = typeof value === 'string' ? value : value?.id;
    const stagedId = typeof candidate === 'string' ? candidate : candidate?.id;
    if (id && id !== stagedId) {
      throw new Error('identidade divergente no registro Docker pendente');
    }
  }
  // Complete a publicação sem truncar a única cópia de uma identidade nova.
  const file = await open(anchored(directory, 'state.next'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { await file.sync(); } finally { await file.close(); }
  await publishState(directory);
  return new RecoveryRun(registry, directory, name, staged);
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
        const run = await readRecoveryRun(registry, directory, name);
        await run.clean(docker, {signal});
        await run.finish();
        if (run.pending) result.pending++;
        else result.cleaned++;
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
