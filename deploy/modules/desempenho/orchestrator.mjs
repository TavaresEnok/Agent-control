/** Executa o módulo de desempenho a partir do snapshot oficial do exame. */
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {openPerformanceRecoveryRun, performanceDocker} from './docker-recovery.mjs';
import {loadConfig, normalizeCoverageRow, validateModuleOutput} from './lib.mjs';
import {compareIndependentMeasurement, validatePerformanceMeasurement} from './references.mjs';

export {reconcilePerformanceResources} from './docker-recovery.mjs';

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

/** O chamador mantém vivo o snapshot de prepareModuleSnapshot e repassa o sinal do heartbeat. */
export async function runPerformanceModule({snapshotPath, imageDigest, signal, recoveryDirectory, previousMeasurement,
  timeoutMs = 480_000, maxStdoutBytes = 16 * 1024 * 1024}, {dockerBinary = 'docker'} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1) throw new Error('limites de desempenho inválidos');
  const deadline = AbortSignal.timeout(timeoutMs);
  const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
  active.throwIfAborted();
  const pinned = (await readFile(new URL('./digest.txt', import.meta.url), 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest) || imageDigest !== pinned) throw new Error('digest da imagem inválido ou diferente do fixado');
  const official = await officialSnapshot(snapshotPath);
  const temp = await mkdtemp(join(tmpdir(), 'ac-perf-'));
  const snapshot = join(temp, 'repo');
  const name = `ac-perf-${randomUUID()}`;
  const coverage = [];
  let docker, journal, result, fallback = false;
  try {
    docker = performanceDocker(dockerBinary, temp);
    const stats = await copySnapshot(official, snapshot, active);
    if (/[\r\n,]/.test(snapshot)) throw new Error('caminho do snapshot incompatível com Docker');
    const mountRepo = ['--mount', `type=bind,src=${snapshot},dst=/repo,readonly`];
    const config = loadConfig(snapshot);
    const identity = await docker(['image', 'inspect', '--format', `{{.Id}} {{index .Config.Labels "${imageProtocol}"}}`, imageDigest], {signal: active});
    if (identity !== `${imageDigest} 5`) throw new Error('imagem de desempenho incompatível com o coletor integrado R5');
    coverage.push(normalizeCoverageRow({tool: 'copia-repositorio', version: '5', status: 'ok',
      detail: `${stats.files} arquivo(s), ${stats.bytes} bytes; ${stats.omitted} entrada(s) excluída(s) por tipo ou nome`}));
    journal = await openPerformanceRecoveryRun(name, recoveryDirectory);

    // O daemon pode concluir a criação depois da saída do cliente. Persista
    // a intenção antes do envio e confira a propriedade antes de usar o recurso.
    async function create(kind, resourceName, args, command = []) {
      active.throwIfAborted();
      const label = await journal.reserve(kind, resourceName);
      if (active.aborted) {
        await journal.discardUnsent(resourceName);
        active.throwIfAborted();
      }
      await docker([...args, ...label, ...(kind === 'volume' ? [resourceName] : [imageDigest, ...command])]);
      active.throwIfAborted();
      const id = await journal.confirmCreation(docker, kind, resourceName);
      active.throwIfAborted();
      return id;
    }

    async function state(id) {
      return await docker(['container', 'inspect', '--format', '{{.State.Running}} {{.Image}} {{.State.ExitCode}}', id], {signal: active});
    }

    async function observe(mode, observer, mounts = []) {
      const id = await create('container', observer, ['create', '--name', observer, ...limits,
        '--log-driver', 'none', ...mountRepo, ...mounts, '--env', `PERF_HTTP_MODE=${mode}`]);
      const raw = await docker(['start', '--attach', id], {timeout: timeoutMs, limit: maxStdoutBytes, signal: active});
      if (await state(id) !== `false ${imageDigest} 0`) throw new Error('estado ou imagem do observador divergente');
      active.throwIfAborted();
      const parsed = JSON.parse(raw);
      return {...validateModuleOutput(parsed), measurement: validatePerformanceMeasurement(parsed.measurement)};
    }

    let output;
    if (config?.server) {
      let stage = 'entrada do backend ou associação de rota ausente no snapshot';
      try {
        const {entry, portEnv} = config.server;
        const routes = await Promise.all(config.routes.map(route => route.file && isSnapshotFile(snapshot, route.file)));
        if (routes.some(Boolean) && /\.(?:cjs|mjs|js)$/i.test(entry) && await isSnapshotFile(snapshot, entry)) {
          const volume = `${name}-link`;
          const link = `type=volume,src=${volume},dst=/perf-link,volume-nocopy`;
          stage = 'volume do canal local indisponível';
          await create('volume', volume, ['volume', 'create', '--driver', 'local',
            '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m,nr_inodes=64,nosuid,nodev,noexec,mode=0733']);
          stage = 'preparação do contêiner do backend falhou';
          const target = await create('container', name, ['create', '--name', name, ...limits,
            '--log-driver', 'none', ...mountRepo, '--mount', link, '--workdir', '/repo', '--entrypoint', 'node'],
          ['/opt/desempenho-tools/http-link.mjs', `/repo/${entry}`, portEnv]);
          stage = 'partida ou permanência do backend isolado falhou';
          await docker(['start', target], {signal: active});
          if (await state(target) === `true ${imageDigest} 0`) {
            stage = 'coleta do backend isolado falhou';
            const observed = await observe('isolated', `${name}-obs`, ['--mount', `${link},readonly`]);
            if (observed.measurement.httpMode === 'static') {
              output = observed;
              stage = 'backend isolado sem resposta válida';
            } else if (await state(target) === `true ${imageDigest} 0`) {
              output = observed;
              stage = null;
            } else {
              stage = 'backend isolado terminou durante a coleta';
            }
          }
        }
      } catch {
        active.throwIfAborted();
      }
      fallback = stage !== null;
      coverage.push(normalizeCoverageRow({tool: 'isolamento-http', version: '5', status: fallback ? 'failed' : 'ok',
        detail: stage ?? 'Imagem conferida, namespaces PID e rede separados e canal limitado ao socket do alvo'}));
      if (!output) await journal.clean(docker);
    }
    output ??= await observe('static', `${name}-obs-static`);
    if (fallback && !output.coverage.some(row => row.tool === 'servidor-isolado' && row.status === 'failed')) {
      coverage.push(normalizeCoverageRow({tool: 'servidor-isolado', version: '5', status: 'failed',
        detail: 'Backend indisponível para medição; consulte isolamento-http e o recorte estático'}));
    }
    const historical = compareIndependentMeasurement(output.measurement, previousMeasurement, imageDigest);
    coverage.push(...output.coverage, historical.coverage);
    result = {...validateModuleOutput({coverage, findings: [...output.findings, ...historical.findings]}),
      measurement: {...output.measurement, imageDigest}};
  } finally {
    let pending = 0;
    try {
      if (journal) pending = await journal.clean(docker, {attempts: 3});
    } finally {
      try { await journal?.close(); }
      finally { await rm(temp, {recursive: true, force: true}); }
    }
    active.throwIfAborted();
    if (pending) {
      const detail = `remoção Docker sem confirmação para ${pending} recurso(s); registro preservado para reconciliação`;
      if (!fallback || !result) throw new Error(detail);
      result.coverage.push(normalizeCoverageRow({tool: 'limpeza-docker', version: '5', status: 'failed', detail}));
    }
  }
  return result;
}
