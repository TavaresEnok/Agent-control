import {lstat, readFile, statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {Refusal} from './contracts.ts';
import {localDockerStorage} from './docker-storage.ts';

export const DISK_BLOCK_PERCENT = 95;

/** Match df's accounting for blocks reserved for the filesystem administrator. */
export function usedDiskPercent(info: {blocks: number; bfree: number; bavail: number}): number {
  const used = info.blocks - info.bfree;
  const capacity = used + info.bavail;
  if (used < 0 || info.bavail < 0 || capacity <= 0) throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  return 100 * used / capacity;
}

type NativeRoots = {planning: {hostRoot: string; accountRoot: string}; execution: {hostRoot: string; accountRoot: string}};
/** Not a path: stands for the local Docker daemon's storage, whose directory only the daemon knows. Resolved (and cached) when measured. */
export const DOCKER_STORAGE_VOLUME = 'docker-storage:local';

type VolumeSource = {dataDirectory: string; activation?: string | undefined; accountHomesDirectory?: string | undefined; nativeBootstrap?: object | undefined;
  project?: {repo: string} | undefined; projects?: readonly {repo: string}[] | undefined; projectRoots?: readonly {path: string}[] | undefined};

/** Every volume an installation writes to: data, native host and account roots, account homes and temp, then the
 * project repositories and roots and, on a personal installation, the local Docker storage. One list serves the watch,
 * the capacity gate and the supervisors. Remote servers are not listed: their disks are not this machine's. */
export function installationVolumes(config: VolumeSource): string[] {
  const boot = config.nativeBootstrap && 'planning' in config.nativeBootstrap && 'execution' in config.nativeBootstrap ? config.nativeBootstrap as NativeRoots : undefined;
  const paths = [config.dataDirectory, ...(config.accountHomesDirectory ? [config.accountHomesDirectory] : []),
    ...(boot ? [boot.planning.hostRoot, boot.planning.accountRoot, boot.execution.hostRoot, boot.execution.accountRoot] : []), tmpdir(),
    ...(config.projectRoots ?? []).map(root => root.path), ...[config.project, ...(config.projects ?? [])].flatMap(project => project ? [project.repo] : [])].map(path => resolve(path));
  return [...new Set([...paths, ...(config.activation === 'personal' ? [DOCKER_STORAGE_VOLUME] : [])])];
}

async function volumeUsedPercent(path: string): Promise<number> {
  // Newly created jobs and installations can have an as-yet absent leaf.
  let directory = resolve(path);
  for (;;) {
    try {
      return usedDiskPercent(await statfs(directory));
    } catch (error) {
      const parent = dirname(directory);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === directory) {
        if (error instanceof Refusal) throw error;
        throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
      }
      directory = parent;
    }
  }
}

/** Docker storage that this machine cannot see (no local daemon, or its directory lives elsewhere) is skipped, not an error. */
async function dockerStorageUsedPercent(): Promise<number | undefined> {
  const root = await localDockerStorage();
  if (!root) return undefined;
  try {
    return usedDiskPercent(await statfs(root));
  } catch (error) {
    if (error instanceof Refusal) throw error;
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  }
}

/** A fixed reading a test injects in place of the host disk; undefined (always, in production) means the real statfs. */
let testMeasure: ((paths: readonly string[]) => Promise<number>) | undefined;
/** Tests only: every disk reading of the product (launch gate, verify-db pressure, watch) returns `measure` until the
 * returned function restores the real reading. The product never calls it, so the 95% guard keeps reading the real disk. */
export function useDiskMeasureForTests(measure: (paths: readonly string[]) => Promise<number>): () => void {
  const previous = testMeasure;
  testMeasure = measure;
  return () => { testMeasure = previous; };
}

/** Highest use among the volumes. A path that cannot be measured makes the whole figure unavailable. */
export async function diskUsedPercent(paths: string | readonly string[]): Promise<number> {
  if (testMeasure) return testMeasure(typeof paths === 'string' ? [paths] : paths);
  const list = typeof paths === 'string' ? [paths] : paths;
  const measured = (await Promise.all(list.map(path => path === DOCKER_STORAGE_VOLUME ? dockerStorageUsedPercent() : volumeUsedPercent(path)))).filter((used): used is number => used !== undefined);
  if (measured.length === 0) throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  return Math.max(...measured);
}

/** Volumes a gate must measure: those the Ledger was opened with, or the data directory alone when it carries none. */
export function launchVolumesOf(source: {launchVolumes?: readonly string[]} | undefined, dataDirectory: string): readonly string[] {
  return source?.launchVolumes && source.launchVolumes.length > 0 ? source.launchVolumes : [dataDirectory];
}

/** Gate for a new worker or exam only. Replays and reconciliation of existing jobs must not call it. */
export async function assertDiskSpaceForLaunch(paths: string | readonly string[], measure: (paths: string | readonly string[]) => Promise<number> = diskUsedPercent): Promise<void> {
  // Only configured volumes are measured. A supervisor without a host root (a unit fixture) has nothing to fill.
  const known = (typeof paths === 'string' ? [paths] : paths).filter((path): path is string => typeof path === 'string' && path.length > 0);
  if (!known.length) return;
  const used = await measure(known);
  if (!Number.isFinite(used)) throw new Refusal('PERSONAL_DISK_UNAVAILABLE', 503);
  if (used >= DISK_BLOCK_PERCENT) throw new Refusal('PERSONAL_DISK_FULL', 503);
  // The first volume is the data directory (installationVolumes, launchVolumesOf), where personal:espaco records its last reading.
  await assertSpaceBudgetForLaunch(known[0]!);
}

/** Last reading of `npm run personal:espaco`, in the data directory. */
export const SPACE_RECORD_FILE = 'space-last.json';
/** An older reading no longer blocks: the gate does not measure, so it only trusts a recent figure. */
export const SPACE_RECORD_MAX_AGE_MS = 15 * 60 * 1000;
const GB = 1e9;

export type SpaceVerdict =
  | {state: 'ok' | 'alerta' | 'acima'; acBytes: number; budgetGB: number; measuredAt: string}
  | {state: 'ausente' | 'vencida' | 'ilegivel'; measuredAt?: string};

/** What the recorded reading says now. The state is recomputed from the bytes and the budget written with it. */
export async function readSpaceVerdict(dataDirectory: string, now = Date.now()): Promise<SpaceVerdict> {
  const path = join(dataDirectory, SPACE_RECORD_FILE);
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024 * 1024) return {state: 'ilegivel'};
    raw = await readFile(path, 'utf8');
  } catch (error) {
    return {state: (error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR' ? 'ausente' : 'ilegivel'};
  }
  let record: {measuredAt?: unknown; acBytes?: unknown; budgetGB?: unknown; alertRatio?: unknown};
  try { record = JSON.parse(raw); } catch { return {state: 'ilegivel'}; }
  const at = typeof record.measuredAt === 'string' ? Date.parse(record.measuredAt) : NaN;
  const {acBytes, budgetGB} = record;
  const alertRatio = typeof record.alertRatio === 'number' && record.alertRatio > 0 && record.alertRatio <= 1 ? record.alertRatio : 0.9;
  if (!Number.isFinite(at) || typeof acBytes !== 'number' || !Number.isFinite(acBytes) || acBytes < 0 || typeof budgetGB !== 'number' || !(budgetGB > 0)) return {state: 'ilegivel'};
  const measuredAt = record.measuredAt as string;
  // A reading from the future is not trusted either: it would never expire.
  if (now - at > SPACE_RECORD_MAX_AGE_MS || at - now > 60_000) return {state: 'vencida', measuredAt};
  return {state: spaceBudgetState(acBytes, budgetGB, alertRatio), acBytes, budgetGB, measuredAt};
}

/** ok below `alertRatio` of the budget, alerta from there, acima at the budget itself. */
export function spaceBudgetState(acBytes: number, budgetGB: number, alertRatio: number): 'ok' | 'alerta' | 'acima' {
  const budget = budgetGB * GB;
  return acBytes >= budget ? 'acima' : acBytes >= alertRatio * budget ? 'alerta' : 'ok';
}

export function spaceBudgetText(acBytes: number, budgetGB: number, installationFile = '<instalação.json>'): string {
  const gb = (bytes: number) => (bytes / GB).toFixed(1).replace('.', ',');
  return `O Agent Control ocupa ${gb(acBytes)} GB, acima do orçamento de ${gb(budgetGB * GB)} GB. Novos exames e trabalhadores estão bloqueados. `
    + `Rode a retenção: npm run personal:maintenance -- ${installationFile} --retencao-automatica (prévia) e depois com --aplicar; meça de novo com npm run personal:espaco -- ${installationFile}.`;
}

/** Refusal whose code callers match; `detail` is the operator text. */
export class SpaceBudgetRefusal extends Refusal {
  constructor(readonly detail: string) { super('PERSONAL_SPACE_BUDGET_EXCEEDED', 503); }
}

const staleWarned = new Set<string>();
/** Gate for a new worker or exam: a recent reading above the budget refuses. A missing, stale or unreadable reading only warns. */
export async function assertSpaceBudgetForLaunch(dataDirectory: string, now = Date.now()): Promise<SpaceVerdict> {
  const verdict = await readSpaceVerdict(dataDirectory, now);
  if (verdict.state === 'acima') {
    const refusal = new SpaceBudgetRefusal(spaceBudgetText(verdict.acBytes, verdict.budgetGB));
    console.error(refusal.detail);
    throw refusal;
  }
  if ((verdict.state === 'vencida' || verdict.state === 'ilegivel') && !staleWarned.has(dataDirectory)) {
    staleWarned.add(dataDirectory);
    console.warn(`Medição de espaço ${verdict.state === 'vencida' ? 'vencida' : 'ilegível'} em ${join(dataDirectory, SPACE_RECORD_FILE)}: o orçamento do Agent Control não está sendo conferido. Rode npm run personal:espaco -- <instalação.json>.`);
  }
  return verdict;
}
