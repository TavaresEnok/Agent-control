import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Refusal} from './contracts.ts';
import {loadInstallation} from './installation.ts';
import {pollSchedule} from './manager-discipline.ts';
import {readVerificationProgress, type VerificationProgress} from './verify-command.ts';
import {processAlive} from './verify-modules-status.ts';

const USAGE = 'Uso: npm run personal:status -- <instalação.json> [<projeto|runId>] [--esperar [--ate <minutos>]] [--json]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Espera sem pgrep: começa em 5 s e cresce até 60 s. */
const WAIT_BASE_MS = 5_000;
const WAIT_MAX_MS = 60_000;
const DEFAULT_WAIT_MINUTES = 24 * 60;

export type StatusArgs = {installationPath: string; target?: string; wait: boolean; untilMinutes: number; json: boolean};

export function parseStatusArgs(argv: readonly string[]): StatusArgs {
  const positional: string[] = [];
  let wait = false;
  let json = false;
  let until: number | undefined;
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!;
    if (arg === '--esperar') wait = true;
    else if (arg === '--json') json = true;
    else if (arg === '--ate') {
      const value = Number(argv[++at]);
      if (!Number.isFinite(value) || value <= 0 || value > 7 * 24 * 60) throw new Refusal('STATUS_USAGE', 400);
      until = value;
    } else if (arg.startsWith('--')) throw new Refusal('STATUS_USAGE', 400);
    else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2 || (until !== undefined && !wait)) throw new Refusal('STATUS_USAGE', 400);
  return {installationPath: positional[0]!, ...(positional[1] ? {target: positional[1]} : {}), wait, untilMinutes: until ?? DEFAULT_WAIT_MINUTES, json};
}

/** `abandonado`: o arquivo diz running, mas o processo que o grava morreu sem resultado. */
export type ExamState = 'em-andamento' | 'abandonado' | 'concluido' | 'parado' | 'falhou' | 'incompleto';
export type ExamStatusRow = {
  projectId: string; projectLabel: string; runId: string; module: string; state: ExamState; status: string; phase: string;
  startedAt: string; elapsedMs: number; judged: number | null; total: number | null; modelCalls: number | null;
  lastFailureCode: string | null; failureStreak: number | null; pid: number | null;
  /** Média por item julgado e previsão de fim, só com o exame em andamento e algum item julgado. */
  msPerJob: number | null; etaAt: string | null; note: string | null;
};

function stateOf(row: VerificationProgress, alive: (pid: number) => boolean): ExamState {
  if (row.status === 'running') return row.pid !== undefined && !alive(row.pid) ? 'abandonado' : 'em-andamento';
  if (row.status === 'done') return 'concluido';
  if (row.status === 'stopped') return 'parado';
  if (row.status === 'incomplete') return 'incompleto';
  return 'falhou';
}

export function examStatusRow(project: {id: string; label: string}, row: VerificationProgress, now: number,
  alive: (pid: number) => boolean = processAlive): ExamStatusRow {
  const state = stateOf(row, alive);
  const started = Date.parse(row.startedAt);
  const elapsedMs = row.durationMs ?? (Number.isFinite(started) ? Math.max(0, now - started) : 0);
  const judged = row.judged ?? null;
  const total = row.total ?? null;
  const msPerJob = judged && judged > 0 ? Math.round(elapsedMs / judged) : null;
  const etaAt = state === 'em-andamento' && msPerJob !== null && total !== null && total >= (judged ?? 0)
    ? new Date(now + msPerJob * (total - (judged ?? 0))).toISOString() : null;
  return {projectId: project.id, projectLabel: project.label, runId: row.id, module: row.module ?? 'seguranca', state,
    status: row.status, phase: row.phase, startedAt: row.startedAt, elapsedMs, judged, total, modelCalls: row.modelCalls ?? null,
    lastFailureCode: row.lastFailureCode ?? null, failureStreak: row.failureStreak ?? null, pid: row.pid ?? null,
    msPerJob, etaAt, note: row.note ?? null};
}

const minutes = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

export function formatStatusRow(row: ExamStatusRow): string {
  const parts = [`${row.projectLabel} ${row.module} ${row.runId}: ${row.state}`, `fase ${row.phase}`];
  if (row.judged !== null && row.total !== null) parts.push(`julgados ${row.judged}/${row.total}`);
  if (row.modelCalls !== null) parts.push(`chamadas ${row.modelCalls}`);
  if (row.lastFailureCode) parts.push(`último código ${row.lastFailureCode}${row.failureStreak ? ` (${row.failureStreak}x seguidas)` : ''}`);
  parts.push(`tempo ${minutes(row.elapsedMs)}`);
  if (row.msPerJob !== null) parts.push(`média ${minutes(row.msPerJob)} por item`);
  if (row.etaAt) parts.push(`previsão de fim ${row.etaAt}`);
  if (row.pid !== null) parts.push(`pid ${row.pid}`);
  if (row.state === 'abandonado') parts.push('o processo morreu sem resultado; rode o exame de novo');
  return parts.join(', ') + '.';
}

type Project = {id: string; label: string};
export type StatusDeps = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  load?: (path: string) => Promise<{dataDirectory: string; projects: Project[]}>;
};

async function loadProjects(path: string): Promise<{dataDirectory: string; projects: Project[]}> {
  const config = await loadInstallation(resolve(path));
  return {dataDirectory: config.dataDirectory, projects: [config.project, ...config.projects].map(item => ({id: item.id, label: item.label}))};
}

/** Rows of the exams in progress (or abandoned), or every row of the run or project named. */
async function collect(dataDirectory: string, projects: readonly Project[], target: string | undefined, now: number,
  alive: (pid: number) => boolean): Promise<ExamStatusRow[]> {
  const project = target ? projects.find(item => item.id === target || item.label === target) : undefined;
  if (target && !project && !UUID.test(target)) throw new Refusal('NOT_FOUND', 404);
  const rows: ExamStatusRow[] = [];
  for (const item of project ? [project] : projects) {
    const progress = await readVerificationProgress(dataDirectory, item.id, {all: true}).catch(() => [] as VerificationProgress[]);
    for (const row of progress) rows.push(examStatusRow(item, row, now, alive));
  }
  if (target && !project) return rows.filter(row => row.runId === target);
  if (project) {
    // The project named: what runs now, else the newest run of each module.
    const live = rows.filter(row => row.state === 'em-andamento' || row.state === 'abandonado');
    if (live.length) return live;
    const newest = new Map<string, ExamStatusRow>();
    for (const row of rows) if (!newest.has(row.module) || newest.get(row.module)!.startedAt < row.startedAt) newest.set(row.module, row);
    return [...newest.values()];
  }
  return rows.filter(row => row.state === 'em-andamento' || row.state === 'abandonado');
}

export type StatusOutcome = {code: 0 | 2 | 3; rows: ExamStatusRow[]; lines: string[]; json?: string};

/**
 * `personal:status`. Without `--esperar` it shows and leaves (0). With `--esperar` it blocks in this process, with a growing
 * wait and no pgrep, until every exam it follows ends: 0 when all finished, 2 when one stopped, failed, came out incomplete or
 * was abandoned, 3 when `--ate` ran out first.
 */
export async function runPersonalStatus(argv: readonly string[], deps: StatusDeps = {}): Promise<StatusOutcome> {
  const args = parseStatusArgs(argv);
  const now = deps.now ?? Date.now;
  const alive = deps.alive ?? processAlive;
  const sleep = deps.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const {dataDirectory, projects} = await (deps.load ?? loadProjects)(args.installationPath);
  let rows = await collect(dataDirectory, projects, args.target, now(), alive);
  if (args.target && UUID.test(args.target) && !projects.some(item => item.id === args.target) && rows.length === 0) throw new Refusal('NOT_FOUND', 404);
  let code: StatusOutcome['code'] = 0;
  if (args.wait) {
    // The exams followed are fixed at the start: a new one that begins later is not waited for.
    const followed = new Set(rows.filter(row => row.state === 'em-andamento').map(row => `${row.projectId}/${row.runId}`));
    const schedule = pollSchedule({backoff: true, baseMs: WAIT_BASE_MS, maxMs: WAIT_MAX_MS, deadlineMs: args.untilMinutes * 60_000});
    const deadline = now() + args.untilMinutes * 60_000;
    const current = async () => {
      const all: ExamStatusRow[] = [];
      for (const project of projects) {
        const progress = await readVerificationProgress(dataDirectory, project.id, {all: true}).catch(() => [] as VerificationProgress[]);
        for (const row of progress) if (followed.has(`${project.id}/${row.id}`)) all.push(examStatusRow(project, row, now(), alive));
      }
      return all;
    };
    let attempt = 0;
    let watched = rows.filter(row => followed.has(`${row.projectId}/${row.runId}`));
    const refresh = async () => {
      const fresh = new Map((await current()).map(row => [`${row.projectId}/${row.runId}`, row]));
      // A file removed while waited for leaves no outcome: it counts as failed, never as finished.
      watched = watched.map(row => fresh.get(`${row.projectId}/${row.runId}`)
        ?? (row.state === 'em-andamento' ? {...row, state: 'falhou' as const, note: 'O arquivo de andamento sumiu antes do fim.'} : row));
    };
    while (watched.some(row => row.state === 'em-andamento')) {
      if (now() >= deadline) break;
      await sleep(Math.min(schedule.waitMs(attempt++), Math.max(0, deadline - now())));
      await refresh();
    }
    rows = followed.size ? watched : rows;
    code = rows.some(row => row.state === 'em-andamento') ? 3
      : rows.some(row => row.state !== 'concluido') ? 2 : 0;
  }
  const lines = rows.length ? rows.map(formatStatusRow) : ['Nenhum exame em andamento.'];
  if (args.wait && code === 3) lines.push(`Tempo de espera esgotado (${args.untilMinutes} min); o exame segue rodando.`);
  return {code, rows, lines, ...(args.json ? {json: JSON.stringify({code, exames: rows})} : {})};
}

async function main(): Promise<void> {
  try {
    const outcome = await runPersonalStatus(process.argv.slice(2));
    if (outcome.json) console.log(outcome.json);
    else for (const line of outcome.lines) console.log(line);
    process.exit(outcome.code);
  } catch (error) {
    const code = error instanceof Refusal ? error.code : '';
    console.error(code === 'STATUS_USAGE' ? USAGE : code === 'NOT_FOUND' ? 'Projeto ou execução não encontrado.' : `O estado não pôde ser lido${code ? ` (código ${code})` : ''}.`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
