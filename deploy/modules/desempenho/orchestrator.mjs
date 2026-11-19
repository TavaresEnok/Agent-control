/** Orquestra somente a coleta HTTP; CPU e SQL continuam declarados não medidos. */
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeRepoRelativePath, validateConfig, validateModuleOutput} from './lib.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(moduleDir, '../../..');
const excluded = new Set(['.git', 'node_modules', '.next', '.nuxt', 'coverage', '.lighthouseci']);
const sensitive = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.ssh|\.aws|\.kube|.*\.(?:pem|key|p12|pfx))$/i;
const maxFile = 10 * 1024 * 1024;
const maxTotal = 128 * 1024 * 1024;

/** Falha fechada ao exceder os limites; nunca segue symlinks ou arquivos especiais. */
export function snapshotRepository(source, destination, ignoredPath = '') {
  const sourceRoot = realpathSync(source);
  const destRoot = resolve(destination);
  let files = 0, bytes = 0;
  function copy(from, to, logical) {
    const dir = openSync(from, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      mkdirSync(to, {recursive: true, mode: 0o755});
      chmodSync(to, 0o755);
      const anchored = `/proc/self/fd/${dir}`;
      for (const entry of readdirSync(anchored, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const input = join(anchored, entry.name), output = join(to, entry.name), path = join(logical, entry.name);
        if (path === ignoredPath || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
        if (sensitive.test(entry.name)) throw new Error(`entrada potencialmente sensível no snapshot: ${entry.name}`);
        if (entry.isDirectory()) { copy(input, output, path); continue; }
        if (!entry.isFile()) continue;
        const fd = openSync(input, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || info.size > maxFile || ++files > 2500 || (bytes += info.size) > maxTotal) throw new Error('limite ou tipo inválido no snapshot');
          const data = readFileSync(fd);
          if (data.length !== info.size) throw new Error('arquivo mudou durante o snapshot');
          writeFileSync(output, data, {mode: 0o444, flag: 'wx'});
          chmodSync(output, 0o444);
        } finally { closeSync(fd); }
      }
    } finally { closeSync(dir); }
  }
  copy(sourceRoot, destRoot, sourceRoot);
  return {files, bytes};
}

function bind(source, dest) {
  if (source.includes(',') || source.includes('\n')) throw new Error('caminho incompatível com montagem Docker');
  return `type=bind,src=${source},dst=${dest},readonly`;
}

const limits = ['--read-only', '--user', '65532:65532', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '2g', '--memory-swap', '2g', '--cpus', '1', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g'];

/**
 * Executa LHCI e k6 contra um servidor Node local em contêiner irmão.
 * A imagem deve corresponder ao digest indicado; código do coletor é montado desta árvore,
 * somente leitura. Não executa perfis CPU nem consultas SQL.
 * A chamada exige Docker local e uma configuração server explícita no snapshot.
 */
export function runIsolatedPerformanceHttp({repoPath, imageDigest}) {
  const pinned = readFileSync(join(moduleDir, 'digest.txt'), 'utf8').trim();
  if (typeof imageDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageDigest) || imageDigest !== pinned) throw new Error('digest da imagem inválido ou diferente do fixado');
  const repo = realpathSync(repoPath);
  if (!lstatSync(repo).isDirectory()) throw new Error('repositório inválido');
  const temp = mkdtempSync(join(workspace, '.perf-isolado-'));
  chmodSync(temp, 0o755);
  const dockerConfig = join(temp, 'docker-config');
  mkdirSync(dockerConfig, {mode: 0o700});
  const env = {PATH: process.env.PATH || '/usr/bin:/bin', HOME: temp, DOCKER_CONFIG: dockerConfig, DOCKER_HOST: 'unix:///var/run/docker.sock'};
  const name = `ac-perf-${randomBytes(12).toString('hex')}`;
  const observerName = `${name}-obs`;
  let targetCreated = false, observerCreated = false;
  function docker(args, timeout = 30_000) {
    const result = spawnSync('docker', args, {env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024});
    if (result.status !== 0) throw new Error(`Docker falhou (${args[0]}, exit=${result.status}): ${(result.stderr || result.error?.message || '').slice(0, 400)}`);
    return result.stdout.trim();
  }
  try {
    const snapshot = join(temp, 'repo');
    const snapshotInfo = snapshotRepository(repo, snapshot, temp);
    const config = validateConfig(JSON.parse(readFileSync(join(snapshot, 'desempenho.config.json'), 'utf8')));
    if (!config.server) throw new Error('configuração de servidor ausente');
    const entry = normalizeRepoRelativePath(config.server.entry);
    if (!entry || !lstatSync(join(snapshot, entry)).isFile()) throw new Error('servidor ausente no snapshot');
    const actualId = docker(['image', 'inspect', '--format', '{{.Id}}', imageDigest]);
    if (actualId !== imageDigest) throw new Error('identidade da imagem divergente');
    // O nome aleatório permite remover também um contêiner criado antes de timeout no cliente.
    targetCreated = true;
    docker(['run', '-d', '--name', name, '--pull', 'never', '--network', 'none', '--log-driver', 'none', ...limits,
      '--mount', bind(snapshot, '/repo'), '--workdir', '/repo', '--env', `${config.server.portEnv}=31873`, '--entrypoint', 'node', imageDigest, `/repo/${entry}`]);
    const mounts = ['collector.mjs', 'lib.mjs', 'static-server.mjs'].flatMap(file => ['--mount', bind(join(moduleDir, file), `/opt/desempenho-tools/${file}`)]);
    mounts.push('--mount', bind(join(moduleDir, 'entrypoint.sh'), '/usr/local/bin/desempenho-entrypoint.sh'));
    observerCreated = true;
    const raw = docker(['run', '--rm', '--name', observerName, '--pull', 'never', '--network', `container:${name}`, ...limits,
      '--mount', bind(snapshot, '/repo'), ...mounts, '--env', 'PERF_ISOLATED_TARGET=1', imageDigest], 300_000);
    if (docker(['inspect', '--format', '{{.State.Running}} {{.Image}}', name]) !== `true ${imageDigest}`) throw new Error('alvo terminou ou mudou de imagem durante a medição');
    const output = validateModuleOutput(JSON.parse(raw));
    output.coverage.unshift({tool: 'isolamento-http', version: '1', status: 'ok', detail: `imagem=${actualId}; snapshot=${snapshotInfo.files} arquivos/${snapshotInfo.bytes} bytes; alvo e observador com PID e arquivos separados, loopback compartilhado`});
    return output;
  } finally {
    let cleanupError = null;
    for (const containerName of [observerCreated && observerName, targetCreated && name].filter(Boolean)) {
      const removed = spawnSync('docker', ['rm', '-f', containerName], {env, encoding: 'utf8', timeout: 20_000});
      if (removed.status !== 0) {
        const inspect = spawnSync('docker', ['inspect', containerName], {env, encoding: 'utf8', timeout: 10_000});
        if (inspect.status !== 1 || !/no such (object|container)/i.test(inspect.stderr || '')) cleanupError = new Error(`não foi possível confirmar remoção de ${containerName}`);
      }
    }
    rmSync(temp, {recursive: true, force: true});
    if (cleanupError) throw cleanupError;
  }
}
