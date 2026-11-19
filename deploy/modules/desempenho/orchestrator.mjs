/** Executa o módulo de desempenho a partir do snapshot oficial do exame. */
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig, normalizeCoverageRow, validateModuleOutput} from './lib.mjs';

const imageProtocol = 'org.agent-control.performance.protocol';
const ignored = new Set(['.git', 'node_modules', '.next', '.nuxt', 'coverage', '.lighthouseci']);
const sensitive = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.ssh|\.aws|\.kube|.*\.(?:pem|key|p12|pfx))$/i;
const maxFile = 10 * 1024 * 1024;
const maxTotal = 128 * 1024 * 1024;
const limits = ['--pull', 'never', '--network', 'none', '--read-only', '--user', '65532:65532', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--memory-swap', '2g',
  '--cpus', '1', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g'];

async function officialSnapshot(path) {
  const source = resolve(path);
  const parent = dirname(source);
  if (basename(source) !== 'repo' || !basename(parent).startsWith('ac-module-snapshot-') ||
      dirname(parent) !== resolve(tmpdir()) || await realpath(source) !== join(await realpath(tmpdir()), basename(parent), 'repo')) {
    throw new Error('snapshot oficial privado do exame exigido');
  }
  const directory = await lstat(parent);
  const repo = await lstat(source);
  if (!directory.isDirectory() || !repo.isDirectory() || directory.uid !== process.getuid() ||
      repo.uid !== directory.uid || (directory.mode & 0o777) !== 0o700) {
    throw new Error('snapshot oficial privado do exame exigido');
  }
  return source;
}

async function copySnapshot(source, destination, signal) {
  const stats = {files: 0, bytes: 0, omitted: 0};
  let entries = 0;
  async function copy(from, to, depth) {
    signal.throwIfAborted();
    if (depth > 64) throw new Error('profundidade limite do snapshot excedida');
    const dir = await open(from, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await mkdir(to, {mode: 0o755});
      await chmod(to, 0o755);
      const anchored = `/proc/self/fd/${dir.fd}`;
      for (const entry of await readdir(anchored, {withFileTypes: true})) {
        signal.throwIfAborted();
        if (++entries > 5_000) throw new Error('limite de entradas do snapshot excedido');
        if (ignored.has(entry.name) || sensitive.test(entry.name) || (!entry.isDirectory() && !entry.isFile())) {
          stats.omitted++;
          continue;
        }
        const input = join(anchored, entry.name);
        const output = join(to, entry.name);
        if (entry.isDirectory()) {
          await copy(input, output, depth + 1);
          continue;
        }
        const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > maxFile || ++stats.files > 2500 || (stats.bytes += info.size) > maxTotal) {
            throw new Error('limite ou tipo inválido no snapshot');
          }
          const data = Buffer.alloc(info.size + 1);
          let offset = 0;
          while (offset < data.length) {
            const read = await file.read(data, offset, data.length - offset, offset);
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
          }
          const after = await file.stat();
          if (offset !== info.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) {
            throw new Error('arquivo mudou durante a cópia do snapshot');
          }
          await writeFile(output, data.subarray(0, offset), {mode: 0o444, flag: 'wx', signal});
          await chmod(output, 0o444);
        } finally { await file.close(); }
      }
    } finally { await dir.close(); }
  }
  await copy(source, destination, 0);
  return stats;
}

async function isSnapshotFile(snapshot, file) {
  try { return (await lstat(join(snapshot, file))).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw error;
  }
}

function absent(error) {
  return error?.code === 1 && /no such (?:container|object|volume)\b/i.test(error.stderr ?? '');
}

/** O chamador mantém vivo o snapshot de prepareModuleSnapshot e repassa o sinal do heartbeat. */
export async function runPerformanceModule({snapshotPath, imageDigest, signal, timeoutMs = 480_000, maxStdoutBytes = 16 * 1024 * 1024},
  {dockerBinary = 'docker'} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1) throw new Error('limites de desempenho inválidos');
  if (dockerBinary !== 'docker' && !isAbsolute(dockerBinary)) throw new Error('caminho local do Docker inválido');
  const deadline = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  active.throwIfAborted();
  const pinned = (await readFile(new URL('./digest.txt', import.meta.url), 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) || imageDigest !== pinned) throw new Error('digest da imagem inválido ou diferente do fixado');
  const official = await officialSnapshot(snapshotPath);
  const temp = await mkdtemp(join(tmpdir(), 'ac-perf-'));
  const snapshot = join(temp, 'repo');
  const resources = [];
  const name = `ac-perf-${randomUUID()}`;
  const env = {PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: temp, DOCKER_CONFIG: join(temp, 'docker-config'), DOCKER_HOST: 'unix:///var/run/docker.sock', LC_ALL: 'C'};

  function docker(args, {timeout = 15_000, limit = 8192, cancellable = true} = {}) {
    if (cancellable) active.throwIfAborted();
    return new Promise((ok, fail) => {
      execFile(dockerBinary, args, {cwd: temp, env, encoding: 'utf8', timeout, maxBuffer: limit, killSignal: 'SIGKILL',
        signal: cancellable ? active : undefined}, (error, stdout, stderr) => {
        if (!error) return ok(stdout.trim());
        error.stderr = stderr;
        fail(error);
      });
    });
  }

  // O daemon pode continuar depois da saída do cliente. A criação é separada
  // da partida, limitada no tempo e aguardada mesmo na perda da autoridade.
  async function create(kind, resourceName, args) {
    active.throwIfAborted();
    const resource = {kind, name: resourceName, uncertain: true};
    resources.push(resource);
    try {
      await docker(args, {cancellable: false});
      resource.uncertain = false;
    } catch (error) {
      resource.uncertain = error.code !== 1 || !/error response from daemon:/i.test(error.stderr ?? '');
      throw error;
    }
    active.throwIfAborted();
    return resource;
  }

  async function remove(resource) {
    const {kind, name: resourceName} = resource;
    const removeArgs = kind === 'container' ? ['container', 'rm', '-f', resourceName] : ['volume', 'rm', resourceName];
    const options = {cancellable: false, timeout: 5000};
    for (let attempt = 0; attempt < 3; attempt++) {
      let acknowledged = false;
      try { await docker(removeArgs, options); acknowledged = true; } catch { /* confirme por inspeção */ }
      try { await docker([kind, 'inspect', resourceName], {...options, limit: 64 * 1024}); }
      catch (error) {
        if (absent(error) && (acknowledged || !resource.uncertain)) {
          resources.splice(resources.indexOf(resource), 1);
          return;
        }
      }
      if (attempt < 2) await delay(200);
    }
    throw new Error(`remoção Docker sem confirmação: ${kind} ${resourceName}`);
  }

  async function state(resource) {
    return await docker(['container', 'inspect', '--format', '{{.State.Running}} {{.Image}} {{.State.ExitCode}}', resource.name]);
  }

  try {
    const stats = await copySnapshot(official, snapshot, active);
    if (/[\r\n,]/.test(snapshot)) throw new Error('caminho do snapshot incompatível com Docker');
    const mountRepo = ['--mount', `type=bind,src=${snapshot},dst=/repo,readonly`];
    const config = loadConfig(snapshot);
    const identity = await docker(['image', 'inspect', '--format', `{{.Id}} {{index .Config.Labels "${imageProtocol}"}}`, imageDigest]);
    if (identity !== `${imageDigest} 4`) throw new Error('imagem de desempenho incompatível com o coletor integrado R4');
    const coverage = [normalizeCoverageRow({tool: 'copia-repositorio', version: '4', status: 'ok',
      detail: `${stats.files} arquivo(s), ${stats.bytes} bytes; ${stats.omitted} entrada(s) excluída(s) por tipo ou nome`})];

    async function observe(mode, observer, mounts = []) {
      const resource = await create('container', observer, ['create', '--name', observer, ...limits,
        '--log-driver', 'none', ...mountRepo, ...mounts, '--env', `PERF_HTTP_MODE=${mode}`, imageDigest]);
      const raw = await docker(['start', '--attach', observer], {timeout: timeoutMs, limit: maxStdoutBytes});
      if (await state(resource) !== `false ${imageDigest} 0`) throw new Error('estado ou imagem do observador divergente');
      active.throwIfAborted();
      return {resource, output: validateModuleOutput(JSON.parse(raw))};
    }

    let output;
    if (config?.server) {
      const {entry, portEnv} = config.server;
      const routes = await Promise.all(config.routes.map(route => route.file && isSnapshotFile(snapshot, route.file)));
      if (routes.some(Boolean) && /\.(?:cjs|mjs|js)$/i.test(entry) && await isSnapshotFile(snapshot, entry)) {
        const volume = `${name}-link`;
        const link = `type=volume,src=${volume},dst=/perf-link,volume-nocopy`;
        const socket = await create('volume', volume, ['volume', 'create', '--driver', 'local',
          '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m,nr_inodes=64,nosuid,nodev,noexec,mode=0733', volume]);
        const target = await create('container', name, ['create', '--name', name, ...limits,
          '--log-driver', 'none', ...mountRepo, '--mount', link, '--workdir', '/repo', '--entrypoint', 'node', imageDigest,
          '/opt/desempenho-tools/http-link.mjs', `/repo/${entry}`, portEnv]);
        const started = await docker(['start', name]).then(() => true, error => {
          active.throwIfAborted();
          if (error.code !== 1) throw error;
          return false;
        });
        if (started && await state(target) === `true ${imageDigest} 0`) {
          const observerName = `${name}-obs`;
          const observed = await observe('isolated', observerName, ['--mount', `${link},readonly`]);
          output = observed.output;
          if (await state(target) !== `true ${imageDigest} 0` && !output.coverage.some(row => row.tool === 'recorte-http-estatico')) {
            output = undefined;
            await remove(observed.resource);
          }
        }
        // Sem backend ativo, libere o alvo antes de servir a cópia estática.
        if (!output) {
          await remove(target);
          await remove(socket);
        }
      }
      const measuredOnTarget = output && !output.coverage.some(row => row.tool === 'servidor-isolado');
      coverage.push(normalizeCoverageRow({tool: 'isolamento-http', version: '4', status: measuredOnTarget ? 'ok' : 'skipped',
        detail: measuredOnTarget ? 'Imagem conferida; namespaces PID e rede separados; canal local limitado ao socket do alvo'
          : 'Backend local indisponível para coleta; uso de recorte estático quando disponível'}));
    }
    output ??= (await observe('static', `${name}-obs-static`)).output;
    return validateModuleOutput({coverage: [...coverage, ...output.coverage], findings: output.findings});
  } finally {
    const errors = [];
    for (const resource of [...resources].reverse()) {
      try { await remove(resource); } catch (error) { errors.push(error); }
    }
    try { await rm(temp, {recursive: true, force: true}); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join(', '));
    active.throwIfAborted();
  }
}
