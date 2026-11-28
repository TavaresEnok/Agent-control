import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {chmod, rename, writeFile} from 'node:fs/promises';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {loadInstallation} from './installation.ts';
import {personalBackupRoot} from './personal-backup-paths.ts';
import {SPACE_RECORD_FILE, spaceBudgetState} from './personal-disk.ts';
import {storageSettings} from './storage-config.ts';

/**
 * Medição do espaço do próprio Agent Control (`npm run personal:espaco`). O total do AC não conta os projetos:
 * o que pertence a um projeto configurado (qa-cache/<id>, verificacoes/<id>, pastas de job dele, worktrees
 * compartilhados do repositório dele, imagens e volumes com o rótulo com.agent-control.project) sai à parte.
 * Arquivo com o mesmo inode conta uma vez só, na primeira categoria que o encontra: projeto antes do AC,
 * worktrees antes do repositório e dos temporários. GB aqui é 10^9 bytes, como o Docker.
 */
export const GB = 1e9;
export type SpaceState = 'ok' | 'alerta' | 'acima';
export type SpaceCategory = {key: string; label: string; bytes: number; detail?: {name: string; bytes: number}[]};
export type SpaceProject = {id: string; label: string; bytes: number; parts: {key: string; bytes: number}[]};
export type SpaceReport = {
  schemaVersion: 1; measuredAt: string; budgetGB: number; alertRatio: number; acBytes: number; state: SpaceState;
  categories: SpaceCategory[]; projects: SpaceProject[]; problems: string[];
};

export const spaceState: (acBytes: number, budgetGB: number, alertRatio: number) => SpaceState = spaceBudgetState;

/** Soma de blocos alocados (como o du), sem seguir links e sem repetir inode já visto. Pasta ilegível vira problema. */
export function diskUsage(paths: readonly string[], seen: Set<string>, problems: string[]): number {
  let total = 0;
  const stack = [...paths];
  while (stack.length) {
    const path = stack.pop()!;
    let info;
    try { info = lstatSync(path, {bigint: false}); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`não li ${path} (${(error as NodeJS.ErrnoException).code ?? 'erro'})`);
      continue;
    }
    const key = info.dev + ':' + info.ino;
    if (seen.has(key)) continue;
    seen.add(key);
    total += info.blocks * 512;
    if (!info.isDirectory()) continue;
    try { for (const name of readdirSync(path)) stack.push(join(path, name)); }
    catch (error) { problems.push(`não li ${path} (${(error as NodeJS.ErrnoException).code ?? 'erro'})`); }
  }
  return total;
}

function children(path: string): string[] {
  try { return readdirSync(path).map(name => join(path, name)); } catch { return []; }
}

/** Mede cada filho à parte, para o detalhe da categoria. Os maiores primeiro. */
function measureChildren(paths: readonly string[], seen: Set<string>, problems: string[]) {
  const detail: {name: string; bytes: number}[] = [];
  let bytes = 0;
  for (const root of paths) {
    let info;
    try { info = lstatSync(root); } catch { continue; }
    const key = info.dev + ':' + info.ino;
    if (seen.has(key)) continue;
    if (!info.isDirectory()) { const n = diskUsage([root], seen, problems); bytes += n; detail.push({name: root, bytes: n}); continue; }
    seen.add(key);
    bytes += info.blocks * 512;
    for (const child of children(root)) {
      const n = diskUsage([child], seen, problems);
      bytes += n;
      if (n > 0) detail.push({name: child.slice(root.length + 1) || child, bytes: n});
    }
  }
  return {bytes, detail: detail.sort((a, b) => b.bytes - a.bytes).slice(0, 12)};
}

/** Each path as one line of the detail (a worktree, a temporary, a login folder). */
function measureEach(paths: readonly string[], seen: Set<string>, problems: string[], home?: string) {
  const detail = paths.map(path => ({name: home && path.startsWith(home + '/') ? '~' + path.slice(home.length) : path, bytes: diskUsage([path], seen, problems)}));
  return {bytes: detail.reduce((sum, item) => sum + item.bytes, 0), detail: detail.filter(item => item.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 12)};
}

export type DockerRun = (args: string[]) => Promise<{ok: boolean; stdout: string}>;
const realDocker: DockerRun = args => new Promise(done => execFile('docker', args, {maxBuffer: 64 * 1024 * 1024, timeout: 120_000},
  (error, stdout) => done({ok: !error, stdout: String(stdout)})));

/** Imagens do AC pelo nome (as mesmas da retenção) ou por qualquer rótulo com.agent-control.*. */
const acImageName = /^(?:ac-|localhost:5000\/ac-|ac-design|agent-control-|mcr\.microsoft\.com\/playwright|moby\/buildkit|registry:2|hadolint)/;
const EMPTY_LAYER = 'sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef';

/** Tamanho de "1.2GB", "185.7MB", "0B" do `docker system df`. */
export function parseDockerSize(text: string): number {
  const m = /^([\d.]+)\s*([kKMGT]?B)$/.exec(String(text).trim());
  if (!m) return 0;
  return Number(m[1]) * ({B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12} as Record<string, number>)[m[2]!]!;
}

export type ImageLayers = {id: string; owner: 'ac' | string; layers: {id: string; bytes: number}[]};
/** Bytes de cada dono pela união das camadas: camada compartilhada conta uma vez, no AC se o AC a usa. */
export function layerUnion(images: readonly ImageLayers[]): {ac: number; projects: Map<string, number>} {
  const size = new Map<string, number>();
  const acLayers = new Set<string>();
  for (const image of images) for (const layer of image.layers) {
    size.set(layer.id, Math.max(size.get(layer.id) ?? 0, layer.bytes));
    if (image.owner === 'ac') acLayers.add(layer.id);
  }
  const projects = new Map<string, number>();
  const counted = new Set<string>();
  for (const image of images) {
    if (image.owner === 'ac') continue;
    for (const layer of image.layers) {
      const key = image.owner + '\0' + layer.id;
      if (acLayers.has(layer.id) || counted.has(key)) continue;
      counted.add(key);
      projects.set(image.owner, (projects.get(image.owner) ?? 0) + (size.get(layer.id) ?? 0));
    }
  }
  return {ac: [...acLayers].reduce((sum, id) => sum + (size.get(id) ?? 0), 0), projects};
}

function sha256Strings(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const m of value.matchAll(/sha256:[0-9a-f]{64}/g)) into.add(m[0]);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) sha256Strings(item, into);
  return into;
}

/** Instructions that write a layer even with size 0 (a RUN that changes nothing leaves the empty layer). */
const layerInstruction = /^(?:RUN|COPY|ADD|WORKDIR)\b|^\/bin\/sh -c (?!#\(nop\))|#\(nop\)\s+(?:COPY|ADD)\b/;
/** Pairs RootFS layers with `docker history` sizes (oldest first). Undefined when they cannot be paired. */
export function alignLayers(rootLayers: readonly string[], history: readonly {size: number; createdBy: string}[]): {id: string; bytes: number}[] | undefined {
  const pair = (layers: readonly string[], sizes: readonly number[]) => layers.length === sizes.length
    ? layers.map((id, i) => ({id, bytes: sizes[i]!})).filter(layer => layer.id !== EMPTY_LAYER) : undefined;
  const valid = history.filter(entry => Number.isFinite(entry.size) && entry.size >= 0);
  return pair(rootLayers.filter(layer => layer !== EMPTY_LAYER), valid.filter(entry => entry.size > 0).map(entry => entry.size))
    ?? pair(rootLayers, valid.filter(entry => entry.size > 0 || layerInstruction.test(entry.createdBy)).map(entry => entry.size));
}

type DockerSpace = {images: number; containers: number; volumes: number; projects: Map<string, {images: number; volumes: number}>};

/** Imagens (união de camadas), contêineres e volumes do AC. Volume é do AC pelo nome ac-*, pelo rótulo ou por estar montado num contêiner ac-*. */
export async function measureDocker(docker: DockerRun, pins: Set<string>, projectIds: Set<string>, problems: string[]): Promise<DockerSpace> {
  const result: DockerSpace = {images: 0, containers: 0, volumes: 0, projects: new Map()};
  const project = (id: string) => { let entry = result.projects.get(id); if (!entry) result.projects.set(id, entry = {images: 0, volumes: 0}); return entry; };
  const ids = await docker(['image', 'ls', '-q', '--no-trunc']);
  if (!ids.ok) { problems.push('Docker indisponível: imagens, contêineres e volumes não foram medidos'); return result; }
  const unique = [...new Set(ids.stdout.split('\n').map(line => line.trim()).filter(Boolean))];
  const images: ImageLayers[] = [];
  const unaligned: {id: string; owner: string; layers: string[]; size: number}[] = [];
  if (unique.length) {
    const inspected = await docker(['image', 'inspect', ...unique]);
    let list: any[] = [];
    try { list = inspected.ok ? JSON.parse(inspected.stdout) : []; } catch { /* abaixo */ }
    if (!inspected.ok || !Array.isArray(list)) problems.push('não li as imagens do Docker (docker image inspect)');
    for (const info of list) {
      const labels: Record<string, string> = info?.Config?.Labels ?? {};
      const label = labels['com.agent-control.project'];
      const owner = label && projectIds.has(label) ? label
        : (info.RepoTags ?? []).some((tag: string) => acImageName.test(tag)) || Object.keys(labels).some(key => key.startsWith('com.agent-control.'))
          || pins.has(info.Id) || (info.RepoDigests ?? []).some((digest: string) => pins.has(digest.slice(digest.indexOf('@') + 1))) ? 'ac' : undefined;
      if (!owner) continue;
      const history = await docker(['history', '--no-trunc', '--human=false', '--format', '{{json .}}', info.Id]);
      const entries = history.ok ? history.stdout.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).reverse() : [];
      const layers = alignLayers(info.RootFS?.Layers ?? [], entries.map(entry => ({size: Number(entry.Size), createdBy: String(entry.CreatedBy ?? '')})));
      if (layers) images.push({id: info.Id, owner, layers});
      else unaligned.push({id: info.Id, owner, layers: (info.RootFS?.Layers ?? []).filter((layer: string) => layer !== EMPTY_LAYER), size: Number(info.Size) || 0});
    }
  }
  // Sem histórico alinhado: as camadas já medidas noutra imagem valem; o resto do tamanho vai para a última desconhecida.
  const known = new Map(images.flatMap(image => image.layers.map(layer => [layer.id, layer.bytes] as const)));
  for (const image of unaligned) {
    problems.push(`camadas de ${image.id.slice(7, 19)} sem histórico alinhado; estimei pelo tamanho total`);
    const ids = image.layers.length ? image.layers : [image.id];
    const unknown = ids.filter(id => !known.has(id));
    const rest = Math.max(0, image.size - ids.reduce((sum, id) => sum + (known.get(id) ?? 0), 0));
    images.push({id: image.id, owner: image.owner, layers: ids.map(id => ({id, bytes: known.get(id) ?? (id === unknown.at(-1) ? rest : 0)}))});
    for (const id of unknown) known.set(id, id === unknown.at(-1) ? rest : 0);
  }
  const union = layerUnion(images);
  result.images = union.ac;
  for (const [id, bytes] of union.projects) project(id).images = bytes;
  const df = await docker(['system', 'df', '-v', '--format', '{{json .}}']);
  let usage: {Containers?: any[]; Volumes?: any[]} = {};
  try { usage = df.ok ? JSON.parse(df.stdout) : {}; } catch { /* abaixo */ }
  if (!df.ok || !usage.Volumes) { problems.push('não li contêineres e volumes do Docker (docker system df -v)'); return result; }
  const acMounts = new Set<string>();
  for (const container of usage.Containers ?? []) {
    const names = String(container.Names ?? '');
    if (!names.split(',').some(name => name.startsWith('ac-')) && !String(container.Labels ?? '').includes('com.agent-control.')) continue;
    result.containers += parseDockerSize(container.Size);
    for (const mount of String(container.Mounts ?? '').split(',')) if (mount && !mount.startsWith('/')) acMounts.add(mount);
  }
  for (const volume of usage.Volumes) {
    const name = String(volume.Name ?? ''), labels = String(volume.Labels ?? '');
    const label = /(?:^|,)com\.agent-control\.project=([^,]+)/.exec(labels)?.[1];
    const bytes = parseDockerSize(volume.Size);
    if (label && projectIds.has(label)) project(label).volumes += bytes;
    // Volume anônimo sem rótulo do AC e sem contêiner do AC não é atribuído ao AC.
    else if (name.startsWith('ac-') || labels.includes('com.agent-control.') || acMounts.has(name)) result.volumes += bytes;
  }
  return result;
}

type SpaceSource = {
  dataDirectory: string; accountHomesDirectory?: string | undefined; storage?: unknown; databaseUrl?: string;
  nativeBootstrap?: unknown; project: {id: string; label: string; repo: string}; projects?: readonly {id: string; label: string; repo: string}[];
};
export type SpaceDeps = {
  docker?: DockerRun;
  /** Pasta de job (id) → projeto, pelo banco. Ausente ou com erro: as pastas contam no AC e o problema é relatado. */
  jobProjects?: () => Promise<Map<string, string>>;
  tmpRoot?: string; backupRoot?: string; home?: string; codeRoot?: string; now?: () => Date;
};

const codeRoot = resolve(import.meta.dirname, '..');

/** Raiz do repositório principal (a pasta acima do .git comum), também quando o código roda de um worktree. */
function mainRepository(start: string): string {
  try {
    const common = realpathSync(resolve(start, readGitDir(start)));
    return dirname(common.endsWith('/worktrees/' + common.split('/').pop()) ? dirname(dirname(common)) : common);
  } catch { return start; }
}
function readGitDir(start: string): string {
  const dotGit = join(start, '.git');
  const info = lstatSync(dotGit);
  if (info.isDirectory()) return dotGit;
  return readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim();
}
/** Worktrees do repositório: as pastas listadas em .git/worktrees/<nome>/gitdir. */
function productWorktrees(repo: string): string[] {
  const root = join(repo, '.git', 'worktrees');
  return children(root).flatMap(entry => {
    try { return [dirname(readFileSync(join(entry, 'gitdir'), 'utf8').trim())]; } catch { return []; }
  }).filter(path => path !== repo);
}

async function databaseJobProjects(databaseUrl: string): Promise<Map<string, string>> {
  const pool = new pg.Pool({connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000});
  try {
    const rows = (await pool.query(`SELECT j.id::text id, c.project_id::text project FROM ac_native_execution_jobs j JOIN ac_contexts c ON c.id=j.context_id
      UNION ALL SELECT j.id::text, c.project_id::text FROM ac_native_planning_jobs j JOIN ac_contexts c ON c.id=j.context_id`)).rows;
    return new Map(rows.map(row => [String(row.id), String(row.project)]));
  } finally { await pool.end(); }
}

export async function measureSpace(config: SpaceSource, deps: SpaceDeps = {}): Promise<SpaceReport> {
  const storage = storageSettings(config as {storage?: unknown});
  const problems: string[] = [];
  const seen = new Set<string>();
  const data = resolve(config.dataDirectory);
  const boot = config.nativeBootstrap as {planning?: {hostRoot?: string; accountRoot?: string}; execution?: {hostRoot?: string; accountRoot?: string}} | undefined;
  const executionHost = boot?.execution?.hostRoot ?? join(data, 'native', 'execution-host');
  const planningHost = boot?.planning?.hostRoot ?? join(data, 'native', 'planning-host');
  const projects = [config.project, ...(config.projects ?? [])];
  const projectIds = new Set(projects.map(project => project.id));

  let jobs = new Map<string, string>();
  try { jobs = await (deps.jobProjects ?? (config.databaseUrl ? () => databaseJobProjects(config.databaseUrl!) : async () => new Map<string, string>()))(); }
  catch (error) { problems.push(`banco indisponível (${(error as {code?: string}).code ?? 'erro'}): as pastas de job contam no AC`); }

  // Projetos primeiro: o que eles reclamam não volta a contar nos dados do AC.
  const projectParts = new Map<string, {key: string; bytes: number}[]>(projects.map(project => [project.id, []]));
  const add = (id: string, key: string, bytes: number) => { if (bytes > 0) projectParts.get(id)!.push({key, bytes}); };
  const jobDirs = new Map<string, string[]>();
  for (const host of [executionHost, planningHost]) for (const path of children(host)) {
    const owner = jobs.get(path.slice(host.length + 1));
    if (owner && projectIds.has(owner)) jobDirs.set(owner, [...(jobDirs.get(owner) ?? []), path]);
  }
  const shared = join(data, 'native', 'shared-worktrees');
  for (const project of projects) {
    add(project.id, 'qa-cache', diskUsage([join(data, 'qa-cache', project.id)], seen, problems));
    add(project.id, 'verificacoes', diskUsage([join(data, 'verificacoes', project.id)], seen, problems));
    add(project.id, 'jobs', diskUsage(jobDirs.get(project.id) ?? [], seen, problems));
    let repoKey: string;
    try { repoKey = createHash('sha256').update(realpathSync(project.repo)).digest('hex') + '-'; } catch { repoKey = ''; }
    if (repoKey) add(project.id, 'worktrees-compartilhados', diskUsage(children(shared).filter(path => path.slice(shared.length + 1).startsWith(repoKey)), seen, problems));
  }

  const categories: SpaceCategory[] = [];
  const category = (key: string, label: string, measured: {bytes: number; detail?: {name: string; bytes: number}[]}) =>
    categories.push({key, label, bytes: measured.bytes, ...(measured.detail?.length ? {detail: measured.detail} : {})});
  const repo = storage.productRepo ?? mainRepository(deps.codeRoot ?? codeRoot);
  const worktrees = productWorktrees(repo);
  category('worktrees', 'Worktrees do repositório do produto', measureEach(worktrees, seen, problems));
  category('repositorio', 'Repositório do produto', {bytes: diskUsage([repo], seen, problems)});
  const extra = [config.accountHomesDirectory, boot?.planning?.hostRoot, boot?.planning?.accountRoot, boot?.execution?.hostRoot, boot?.execution?.accountRoot]
    .filter((path): path is string => typeof path === 'string');
  category('dados', 'Dados da instalação (sem os projetos)', measureChildren([data, ...extra], seen, problems));
  const tmp = deps.tmpRoot ?? tmpdir();
  category('temporarios', 'Temporários /tmp/ac-*', measureEach(children(tmp).filter(path => path.slice(tmp.length + 1).startsWith('ac-')), seen, problems));
  category('backups', 'Backups', measureChildren([deps.backupRoot ?? personalBackupRoot], seen, problems));
  const home = deps.home ?? homedir();
  category('logins', 'Logins dos trabalhadores', measureEach([join(home, '.claude-trabalhadores'), ...children(home).filter(path => path.slice(home.length + 1).startsWith('.agy-'))], seen, problems, home));

  const pins = sha256Strings(config.nativeBootstrap);
  for (const file of [...children(join(repo, 'deploy', 'modules')).map(dir => join(dir, 'digest.txt')), join(repo, 'deploy', 'design-image-digest.txt')]) {
    try { sha256Strings(readFileSync(file, 'utf8'), pins); } catch { /* módulo sem pin */ }
  }
  const docker = await measureDocker(deps.docker ?? realDocker, pins, projectIds, problems);
  category('imagens', 'Imagens Docker do AC (união das camadas)', {bytes: docker.images});
  category('conteineres', 'Contêineres do AC (camada gravável)', {bytes: docker.containers});
  category('volumes', 'Volumes Docker do AC', {bytes: docker.volumes});
  for (const [id, entry] of docker.projects) { add(id, 'imagens', entry.images); add(id, 'volumes', entry.volumes); }

  const acBytes = categories.reduce((sum, item) => sum + item.bytes, 0);
  return {
    schemaVersion: 1, measuredAt: (deps.now?.() ?? new Date()).toISOString(), budgetGB: storage.budgetGB, alertRatio: storage.alertRatio,
    acBytes, state: spaceState(acBytes, storage.budgetGB, storage.alertRatio), categories,
    projects: projects.map(project => {
      const parts = projectParts.get(project.id)!;
      return {id: project.id, label: project.label, bytes: parts.reduce((sum, part) => sum + part.bytes, 0), parts};
    }),
    problems,
  };
}

/** Grava o último resultado em <dataDirectory>/space-last.json (0600, troca atômica), lido pelo portão de admissão. */
export async function writeSpaceRecord(dataDirectory: string, report: SpaceReport): Promise<string> {
  const path = join(dataDirectory, SPACE_RECORD_FILE), temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(report, null, 1) + '\n', {mode: 0o600});
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return path;
}

const gb = (bytes: number) => (bytes / GB).toFixed(2).replace('.', ',') + ' GB';
const stateText: Record<SpaceState, string> = {ok: 'dentro do orçamento', alerta: 'em alerta', acima: 'ACIMA do orçamento'};

export function renderSpaceReport(report: SpaceReport, options: {byProject?: boolean; installationFile?: string} = {}): string[] {
  const file = options.installationFile ?? '<instalação.json>';
  const lines = [`Agent Control: ${gb(report.acBytes)} de ${gb(report.budgetGB * GB)} (${Math.round(100 * report.acBytes / (report.budgetGB * GB))}%), ${stateText[report.state]}. Projetos fora da conta.`];
  for (const item of report.categories) {
    lines.push(`  ${item.label}: ${gb(item.bytes)}`);
    for (const detail of item.detail?.slice(0, 5) ?? []) if (detail.bytes >= 0.05 * GB) lines.push(`      ${detail.name}: ${gb(detail.bytes)}`);
  }
  const projectTotal = report.projects.reduce((sum, project) => sum + project.bytes, 0);
  lines.push(`Projetos: ${gb(projectTotal)}${options.byProject ? '' : ' (detalhe com --por-projeto)'}`);
  if (options.byProject) for (const project of report.projects) {
    lines.push(`  ${project.label} (${project.id.slice(0, 8)}): ${gb(project.bytes)}`);
    for (const part of project.parts) lines.push(`      ${part.key}: ${gb(part.bytes)}`);
  }
  if (report.state === 'acima') lines.push(`Novos exames e trabalhadores ficam bloqueados (PERSONAL_SPACE_BUDGET_EXCEEDED). Rode a retenção: npm run personal:maintenance -- ${file} --retencao-automatica (prévia) e depois com --aplicar.`);
  else if (report.state === 'alerta') lines.push(`Perto do orçamento. Confira a retenção: npm run personal:maintenance -- ${file} --retencao-automatica.`);
  if (report.problems.length) lines.push(`Medição parcial (${report.problems.length} problema(s)):`, ...report.problems.slice(0, 20).map(problem => '  - ' + problem));
  return lines;
}

export async function runSpaceCommand(argv: readonly string[], deps: SpaceDeps & {load?: typeof loadInstallation; print?: (line: string) => void} = {}): Promise<number> {
  const args = [...argv], path = args.shift();
  const known = new Set(['--json', '--por-projeto']);
  if (!path || path.startsWith('--') || args.some(arg => !known.has(arg))) throw new Error('Uso: npm run personal:espaco -- <instalação.json> [--json] [--por-projeto]');
  const config = await (deps.load ?? loadInstallation)(resolve(path));
  const report = await measureSpace(config, deps);
  await writeSpaceRecord(config.dataDirectory, report);
  const print = deps.print ?? ((line: string) => console.log(line));
  if (args.includes('--json')) print(JSON.stringify(report, null, 1));
  else for (const line of renderSpaceReport(report, {byProject: args.includes('--por-projeto'), installationFile: path})) print(line);
  return report.state === 'acima' ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSpaceCommand(process.argv.slice(2)).then(code => { process.exitCode = code; },
    (error: unknown) => { console.error(error instanceof Error ? error.message : 'Falha ao medir o espaço'); process.exitCode = 1; });
}

