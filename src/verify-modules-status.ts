import {constants} from 'node:fs';
import {open, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {z} from 'zod';
import type {Ledger} from './ledger.ts';
import {VERIFICATION_MODULES} from './ledger.ts';
import {readVerificationProgress} from './verify-command.ts';

/** Painel: uma linha por módulo, na ordem em que o painel mostra. */
export const STATUS_MODULES = ['seguranca', ...VERIFICATION_MODULES, 'design'] as const;
export type StatusModule = (typeof STATUS_MODULES)[number];

const REPORT_DIR = new RegExp(`^\\d{8}-\\d{6}(?:-[a-f0-9]{8}|-[a-f0-9]{32})?-(${STATUS_MODULES.join('|')})$`);
const MAX_RUN_JSON_BYTES = 1024 * 1024;
/** Quantos relatórios do mesmo módulo, do mais novo ao mais antigo, tentar até um run.json legível. */
const CANDIDATES_PER_MODULE = 5;

const count = z.number().int().nonnegative();
const RunJson = z.object({
  id: z.string().min(1).max(64),
  directoryName: z.string(),
  createdAt: z.string().min(1).max(40),
  counts: z.object({alta: count, media: count, baixa: count, informativa: count}),
  toolFailures: count.optional(),
  tools: z.object({indisponivel: count, truncada: count}).partial().optional(),
  partial: z.boolean().optional(),
});

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
export type ModuleStatus = {modulo: StatusModule; atual: ModuleCurrent | null; ultima: ModuleLast | null};

async function readRunJson(directory: string): Promise<unknown> {
  const handle = await open(join(directory, 'run.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.stat()).size > MAX_RUN_JSON_BYTES) return null;
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}

/** Relatório mais novo de cada módulo com run.json legível. Diretório ausente, symlink ou JSON ruim não derrubam a leitura. */
async function latestReports(projectDir: string): Promise<Map<StatusModule, ModuleLast>> {
  let entries;
  try {
    entries = await readdir(projectDir, {withFileTypes: true});
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Map();
    throw error;
  }
  const byModule = new Map<StatusModule, string[]>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // symlinks não são diretórios aqui
    const module = REPORT_DIR.exec(entry.name)?.[1] as StatusModule | undefined;
    if (module) byModule.set(module, [...byModule.get(module) ?? [], entry.name]);
  }
  const found = new Map<StatusModule, ModuleLast>();
  for (const [module, names] of byModule) {
    for (const name of names.sort().reverse().slice(0, CANDIDATES_PER_MODULE)) {
      try {
        const parsed = RunJson.safeParse(await readRunJson(join(projectDir, name)));
        if (!parsed.success || parsed.data.directoryName !== name) continue;
        const {id, createdAt, counts, partial, tools} = parsed.data;
        const toolFailures = parsed.data.toolFailures ?? (tools?.indisponivel ?? 0) + (tools?.truncada ?? 0);
        found.set(module, {
          runId: id, directoryName: name, createdAt, counts, toolFailures,
          situacao: partial ? 'parcial' : toolFailures > 0 ? 'com-falhas' : 'concluida',
        });
        break;
      } catch {
        // relatório ilegível: tenta o anterior
      }
    }
  }
  return found;
}

function current(runId: string, startedAt: string, now: number, extra: Partial<ModuleCurrent> = {}): ModuleCurrent {
  const started = Date.parse(startedAt);
  return {
    runId, status: 'running', phase: null, startedAt,
    elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : 0,
    judged: null, total: null, modelCalls: null, ...extra,
  };
}

/**
 * Estado de cada módulo do projeto, só leitura. A segurança grava arquivos de andamento (fase, julgados/total);
 * os módulos 2 a 9 só têm a linha "running" do banco; o design só tem o relatório.
 */
export async function readModuleStatuses(
  ledger: Pick<Ledger, 'pool'>, dataDirectory: string, projectId: string, now = Date.now(),
): Promise<ModuleStatus[]> {
  const projectDir = join(resolve(dataDirectory), 'verificacoes', projectId);
  const [last, progress, running] = await Promise.all([
    latestReports(projectDir),
    readVerificationProgress(dataDirectory, projectId),
    ledger.pool.query<{id: string; module: string; created_at: Date | string}>(
      `SELECT id::text AS id, module, created_at FROM ac_verify_runs
       WHERE project_id=$1 AND status='running' AND module=ANY($2::text[]) ORDER BY created_at DESC`,
      [projectId, ['verify', ...VERIFICATION_MODULES]],
    ),
  ]);
  const active = new Map<StatusModule, ModuleCurrent>();
  const file = progress.filter(row => row.status === 'running').at(-1);
  if (file) {
    active.set('seguranca', current(file.id, file.startedAt, now, {
      phase: file.phase, judged: file.judged ?? null, total: file.total ?? null, modelCalls: file.modelCalls ?? null,
    }));
  }
  for (const row of running.rows) {
    const module: StatusModule | undefined = row.module === 'verify' ? 'seguranca'
      : (VERIFICATION_MODULES as readonly string[]).includes(row.module) ? row.module as StatusModule : undefined;
    if (!module || active.has(module)) continue; // a linha mais nova vem primeiro
    active.set(module, current(row.id, new Date(row.created_at).toISOString(), now));
  }
  return STATUS_MODULES.map(modulo => ({modulo, atual: active.get(modulo) ?? null, ultima: last.get(modulo) ?? null}));
}
