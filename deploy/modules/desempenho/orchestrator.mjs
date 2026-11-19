/** Executa o módulo de desempenho a partir do snapshot oficial do exame. */
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {openPerformanceRecoveryRun, performanceDocker} from './docker-recovery.mjs';
import {startHostHttpLink} from './http-link.mjs';
import {loadConfig, normalizeCoverageRow, validateModuleOutput} from './lib.mjs';
import {compareIndependentMeasurement, validatePerformanceMeasurement} from './references.mjs';

export {reconcilePerformanceResources} from './docker-recovery.mjs';

async function* readHistory(source, signal) {
  signal.throwIfAborted();
  const history = typeof source === 'function' ? source(signal) : source;
  const iterator = history[Symbol.asyncIterator]();
  try {
    while (true) {
      signal.throwIfAborted();
      const interrupted = Promise.withResolvers();
      const abort = () => interrupted.reject(signal.reason);
      signal.addEventListener('abort', abort, {once: true});
      let entry;
      try {
        entry = await Promise.race([iterator.next(), interrupted.promise]);
      } finally {
        signal.removeEventListener('abort', abort);
      }
      if (entry.done) return;
      yield entry.value;
    }
  } finally {
    const closed = iterator.return?.();
    if (signal.aborted) Promise.resolve(closed).catch(() => {});
    else await closed;
  }
}

const imageProtocol = 'org.agent-control.performance.protocol';
const ignored = new Set(['.git', 'node_modules', '.next', '.nuxt', 'coverage', '.lighthouseci']);
const sensitive = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.ssh|\.aws|\.kube|.*\.(?:pem|key|p12|pfx))$/i;
const maxFile = 10 * 1024 * 1024;
const maxTotal = 128 * 1024 * 1024;
const immediateCleanupMs = 2500;
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

function socketMount(path, destination) {
  return ['--mount', `type=bind,"src=${path.replaceAll('"', '""')}",dst=${destination},readonly`];
}

/** O chamador mantém vivo o snapshot de prepareModuleSnapshot e repassa o sinal do heartbeat. */
export async function runPerformanceModule({snapshotPath, imageDigest, signal, recoveryDirectory, previousMeasurement, previousMeasurements,
  timeoutMs = 480_000, maxStdoutBytes = 16 * 1024 * 1024}, {dockerBinary = 'docker'} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1) throw new Error('limites de desempenho inválidos');
  const startedAt = performance.now();
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
    if (identity !== `${imageDigest} 6`) throw new Error('imagem de desempenho incompatível com o coletor integrado R6');
    coverage.push(normalizeCoverageRow({tool: 'copia-repositorio', version: '5', status: 'ok',
      detail: `${stats.files} arquivo(s), ${stats.bytes} bytes; ${stats.omitted} entrada(s) excluída(s) por tipo ou nome`}));
    journal = await openPerformanceRecoveryRun(name, recoveryDirectory);

    // O daemon pode concluir a criação depois da saída do cliente. Persista
    // a intenção antes do envio e confira a propriedade antes de usar o recurso.
    async function create(resourceName, args, phase, command = []) {
      phase.throwIfAborted();
      const label = await journal.reserve(resourceName);
      if (phase.aborted) {
        await journal.record(resourceName);
        phase.throwIfAborted();
      }
      let created;
      try { created = await docker([...args, ...label, imageDigest, ...command], {signal: phase}); }
      catch (error) {
        await journal.recordFailedCreation(resourceName, error);
        throw error;
      }
      const id = await journal.confirmCreation(docker, resourceName, created, phase);
      phase.throwIfAborted();
      return id;
    }

    async function state(id, phase) {
      return await docker(['container', 'inspect', '--format', '{{.State.Running}} {{.Image}} {{.State.ExitCode}}', id], {signal: phase});
    }

    async function observe(mode, observer, phase, mounts = []) {
      const id = await create(observer, ['create', '--name', observer, ...limits,
        '--log-driver', 'none', ...mountRepo, ...mounts, '--env', `PERF_HTTP_MODE=${mode}`], phase);
      const raw = await docker(['start', '--attach', id], {timeout: timeoutMs, limit: maxStdoutBytes, signal: phase});
      if (await state(id, phase) !== `false ${imageDigest} 0`) throw new Error('estado ou imagem do observador divergente');
      phase.throwIfAborted();
      const parsed = JSON.parse(raw);
      const measurement = validatePerformanceMeasurement(parsed.measurement);
      if (mode === 'static' && measurement.httpMode !== mode) throw new Error('modo do observador estático divergente');
      return {...validateModuleOutput(parsed), measurement};
    }

    let output;
    if (config?.server) {
      let stage = 'entrada do backend ou associação de rota ausente no snapshot';
      let channel;
      // Mesmo que a partida ou a coleta isolada fique presa, o observador
      // estático conserva a segunda metade do prazo restante.
      const elapsed = performance.now() - startedAt;
      const backend = AbortSignal.any([active, AbortSignal.timeout(Math.max(0, Math.floor((timeoutMs - elapsed) / 2)))]);
      try {
        const {entry, portEnv} = config.server;
        const routes = await Promise.all(config.routes.map(route => route.file && isSnapshotFile(snapshot, route.file)));
        if (routes.some(Boolean) && /\.(?:cjs|mjs|js)$/i.test(entry) && await isSnapshotFile(snapshot, entry)) {
          backend.throwIfAborted();
          const targetSocket = journal.socket('target.sock');
          const observerSocket = journal.socket('observer.sock');
          stage = 'sockets do canal local indisponíveis';
          channel = await startHostHttpLink(targetSocket.listenPath, observerSocket.listenPath);
          stage = 'preparação do contêiner do backend falhou';
          const target = await create(name, ['create', '--name', name, ...limits,
            '--log-driver', 'none', ...mountRepo, ...socketMount(targetSocket.mountPath, '/perf-link/target.sock'),
            '--workdir', '/repo', '--entrypoint', 'node'], backend,
            ['/opt/desempenho-tools/http-link.mjs', `/repo/${entry}`, portEnv]);
          stage = 'partida ou permanência do backend isolado falhou';
          await docker(['start', target], {signal: backend});
          if (await state(target, backend) === `true ${imageDigest} 0`) {
            stage = 'coleta do backend isolado falhou';
            const observed = await observe('isolated', `${name}-obs`, backend, socketMount(observerSocket.mountPath, '/perf-link/http.sock'));
            if (observed.measurement.httpMode === 'static') {
              stage = 'backend isolado sem resposta válida';
            } else if (await state(target, backend) === `true ${imageDigest} 0`) {
              output = observed;
              stage = null;
            } else {
              stage = 'backend isolado terminou durante a coleta';
            }
          }
        }
      } catch (error) {
        active.throwIfAborted();
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
        if (backend.aborted) stage = 'prazo da tentativa de medição isolada esgotado';
      } finally {
        await channel?.close();
      }
      fallback = stage !== null;
      coverage.push(normalizeCoverageRow({tool: 'isolamento-http', version: '5', status: fallback ? 'failed' : 'ok',
        detail: stage ?? 'Imagem conferida, namespaces PID e rede separados e canal limitado a sockets locais'}));
    }
    output ??= await observe('static', `${name}-obs-static`, active);
    if (fallback && !output.coverage.some(row => row.tool === 'servidor-isolado' && row.status === 'failed')) {
      coverage.push(normalizeCoverageRow({tool: 'servidor-isolado', version: '5', status: 'failed',
        detail: 'Backend indisponível para medição; consulte isolamento-http e o recorte estático'}));
    }
    let historical = compareIndependentMeasurement(output.measurement, previousMeasurement, imageDigest);
    let comparedExamId = historical.coverage.status === 'ok' ? previousMeasurement.examId : undefined;
    if (previousMeasurements) {
      let latest;
      for await (const candidate of readHistory(previousMeasurements, active)) {
        active.throwIfAborted();
        const comparison = compareIndependentMeasurement(output.measurement, candidate, imageDigest);
        latest ??= comparison;
        if (comparison.coverage.status === 'ok') {
          historical = comparison;
          comparedExamId = candidate.examId;
          break;
        }
      }
      if (!comparedExamId && latest) historical = latest;
    }
    active.throwIfAborted();
    coverage.push(...output.coverage, historical.coverage);
    result = {...validateModuleOutput({coverage, findings: [...output.findings, ...historical.findings]}),
      measurement: {...output.measurement, imageDigest}, comparedExamId};
  } catch (error) {
    active.throwIfAborted();
    throw error;
  } finally {
    let pending = 0;
    try {
      if (journal?.pending) {
        const cleanup = AbortSignal.any([deadline, AbortSignal.timeout(immediateCleanupMs)]);
        try { await journal.clean(docker, {attempts: 3, signal: cleanup}); }
        catch (error) { if (!cleanup.aborted) throw error; }
        pending = journal.pending;
      }
    } finally {
      try { await journal?.close(); }
      finally { await rm(temp, {recursive: true, force: true}); }
    }
    signal?.throwIfAborted();
    if (pending && result) {
      const detail = `remoção Docker sem confirmação para ${pending} recurso(s); registro preservado para reconciliação`;
      if (!fallback) throw new Error(detail);
      result.coverage.push(normalizeCoverageRow({tool: 'limpeza-docker', version: '5', status: 'failed', detail}));
    }
  }
  return result;
}
