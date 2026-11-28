import {z} from 'zod';
import type {DesignReportSummary} from './design-types.ts';
import type {Ledger} from './ledger.ts';
import {VERIFICATION_MODULES} from './ledger.ts';
import type {ModuleReportSummary} from './verification-modules-contracts.ts';
import {readVerificationProgress} from './verify-command.ts';
import type {ReportSummary} from './verify-types.ts';

/** Painel: uma linha por módulo, na ordem em que o painel mostra. */
export const STATUS_MODULES = ['seguranca', ...VERIFICATION_MODULES, 'design'] as const;
export type StatusModule = (typeof STATUS_MODULES)[number];
/** O processo ainda existe. EPERM: existe, de outro usuário. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export type ModuleCurrent = {
  runId: string;
  status: 'running';
  phase: string | null;
  startedAt: string;
  elapsedMs: number;
  judged: number | null;
  total: number | null;
  modelCalls: number | null;
};
export type ModuleLast = {
  runId: string;
  directoryName: string;
  createdAt: string;
  counts: {alta: number; media: number; baixa: number; informativa: number};
  toolFailures: number;
  situacao: 'concluida' | 'com-falhas' | 'parcial';
};
export type ModuleStatus = {modulo: StatusModule; andamentoDisponivel: boolean; atual: ModuleCurrent | null; ultima: ModuleLast | null};

export type ModuleStatusInput = {
  dataDirectory: string;
  /** Projeto do gateway: módulos 2 a 9 e design. */
  projectId: string;
  /** Projeto das rotas de segurança (o primário do painel). */
  securityProjectId: string;
  /** Relatórios já validados pelos leitores do produto, em qualquer ordem. */
  security: readonly ReportSummary[];
  modules: readonly ModuleReportSummary[];
  design: readonly DesignReportSummary[];
  now?: number;
};

type RunRow = {id: string; module: string; status: string; created_at: Date | string; alive: boolean};

function newest<T extends {directoryName: string}>(reports: readonly T[]): T | undefined {
  return reports.reduce<T | undefined>((best, item) => !best || item.directoryName > best.directoryName ? item : best, undefined);
}

function last(report: {id: string; directoryName: string; createdAt: string; counts: ModuleLast['counts']}, toolFailures: number, partial: boolean): ModuleLast {
  const {id, directoryName, createdAt, counts} = report;
  return {runId: id, directoryName, createdAt, counts, toolFailures, situacao: partial ? 'parcial' : toolFailures > 0 ? 'com-falhas' : 'concluida'};
}

function current(runId: string, startedAt: string, now: number, extra: Partial<ModuleCurrent> = {}): ModuleCurrent {
  const started = Date.parse(startedAt);
  return {
    runId, status: 'running', phase: null, startedAt,
    elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
    judged: null, total: null, modelCalls: null, ...extra,
  };
}

const iso = z.date().or(z.string()).transform(value => new Date(value).toISOString());

/**
 * Estado de cada módulo, só leitura. Os relatórios chegam já listados pelos leitores do produto
 * (que recusam symlink e pasta incompleta); aqui só se escolhe o mais novo de cada módulo.
 * A segurança grava arquivos de andamento (fase, julgados/total); os módulos 2 a 9 só têm a linha
 * "running" do banco. Uma execução só conta como em andamento se o gerente dela ainda tem a licença.
 */
export async function readModuleStatuses(ledger: Pick<Ledger, 'pool'>, input: ModuleStatusInput): Promise<ModuleStatus[]> {
  const now = input.now ?? Date.now();
  const progress = (await readVerificationProgress(input.dataDirectory, input.securityProjectId)).filter(row => row.status === 'running');
  const file = progress.at(-1);
  const running = await ledger.pool.query<RunRow>(
    `SELECT r.id::text AS id, r.module, r.status, r.created_at,
       EXISTS (SELECT 1 FROM ac_managers m WHERE m.context_id=r.context_id AND m.lease_until > clock_timestamp()) AS alive
     FROM ac_verify_runs r
     WHERE (r.project_id=$1 AND r.module=ANY($2::text[]) AND r.status='running')
        OR (r.project_id=$3 AND r.module='verify' AND (r.status='running' OR r.id::text=ANY($4::text[])))
     ORDER BY r.created_at DESC`,
    [input.projectId, [...VERIFICATION_MODULES], input.securityProjectId, progress.map(row => row.id)],
  );

  const active = new Map<StatusModule, ModuleCurrent>();
  // O arquivo só vale se o banco não o dá por encerrado nem sem gerente vivo. Sem linha ainda (fase de ferramentas), vale.
  const fileRow = file ? running.rows.find(row => row.id === file.id) : undefined;
  if (file && (!fileRow || fileRow.status === 'running' && fileRow.alive)) {
    active.set('seguranca', current(file.id, file.startedAt, now, {
      phase: file.phase, judged: file.judged ?? null, total: file.total ?? null, modelCalls: file.modelCalls ?? null,
    }));
  }
  // O design não tem linha em ac_verify_runs: vale o arquivo running cujo processo ainda vive.
  const design = (await readVerificationProgress(input.dataDirectory, input.projectId, {all: true}))
    .filter(row => row.module === 'design' && row.status === 'running' && row.pid !== undefined && processAlive(row.pid)).at(-1);
  if (design) {
    active.set('design', current(design.id, design.startedAt, now, {
      phase: design.phase, judged: design.judged ?? null, total: design.total ?? null, modelCalls: design.modelCalls ?? null,
    }));
  }
  for (const row of running.rows) {
    if (row.status !== 'running' || !row.alive) continue;
    const module: StatusModule | undefined = row.module === 'verify' ? 'seguranca'
      : (VERIFICATION_MODULES as readonly string[]).includes(row.module) ? row.module as StatusModule : undefined;
    if (!module || active.has(module)) continue; // a linha mais nova vem primeiro
    active.set(module, current(row.id, iso.parse(row.created_at), now));
  }

  const latest = new Map<StatusModule, ModuleLast>();
  const security = newest(input.security);
  if (security) {
    latest.set('seguranca', last(security, (security.tools?.indisponivel ?? 0) + (security.tools?.truncada ?? 0), security.partial === true));
  }
  for (const module of VERIFICATION_MODULES) {
    const report = newest(input.modules.filter(item => item.module === module));
    if (report) latest.set(module, last(report, report.toolFailures, false));
  }
  const designReport = newest(input.design);
  if (designReport) latest.set('design', last(designReport, 0, false));

  return STATUS_MODULES.map(modulo => ({
    // Todos têm andamento ao vivo: o design grava andamento/<runId>.json com o PID do processo (src/personal-design-cli.ts).
    modulo, andamentoDisponivel: true,
    atual: active.get(modulo) ?? null, ultima: latest.get(modulo) ?? null,
  }));
}
