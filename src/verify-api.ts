import {randomUUID} from 'node:crypto';
import {lstat, realpath} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {Hono} from 'hono';
import {z} from 'zod';
import {Authority, Id, Refusal} from './contracts.ts';
import {VERIFICATION_MODULES, type Ledger, type VerificationModule} from './ledger.ts';
import {listModuleReports, readModuleReport, renderModuleCoverageMarkdown, requestModuleCorrection, type ModuleReportSummary} from './verification-modules.ts';
import {isSecretClassBasename, redactUnknownSecrets} from './verify-redact.ts';
import {Achado, CoverageRow, ReportSummary} from './verify-types.ts';
import {listSecurityReports, readAchadoMarkdown, readSecurityReport, removeSecurityReport} from './verify-report.ts';
import {
  recheckFindings,
  requestCorrection,
  VERIFY_RECHECK_NEW_EXAM_GUIDANCE,
  VERIFY_RECHECK_NEW_EXAM_REQUIRED,
} from './verify-remediate.ts';
import {readVerificationProgress} from './verify-command.ts';

type ManagerAuthority = z.infer<typeof Authority>;
type Panel = {dataDirectory: string; projectId: string; installationPath: string};
type VerificationStart = {id: string; status: 'running'; phase: string};
const verificationStartBody = z.union([
  z.object({}).strict(),
  z.object({url: z.string().min(1).max(500)}).strict(),
]);
type ApiEnv = {Variables: {principal: string; timingStarted: number; authenticationMs: number}};
type VisibleAchado = Omit<z.infer<typeof Achado>, 'secretPreview'>;

const achadoIdsBody = z.object({
  achadoIds: z.array(z.string().regex(/^ACH-\d{3}$/)).max(20),
}).strict();
const achadoIdParam = z.string().regex(/^ACH-\d{3}$/);

export type VerificationRouteDeps = {
  ledger: Ledger;
  requireInstallationOwner: (principal: string) => Promise<void>;
  personalPanel: Panel | undefined;
  selectedProjectId: string;
  manager: (contextId: string) => ManagerAuthority | undefined;
  listSecurityReports: typeof listSecurityReports;
  readSecurityReport: typeof readSecurityReport;
  readAchadoMarkdown: typeof readAchadoMarkdown;
  requestCorrection: typeof requestCorrection;
  recheckFindings: typeof recheckFindings;
  /** No model worker is available on the request. The route is omitted unless a caller injects this. */
  recheck?: (
    principal: string,
    authority: ManagerAuthority,
    input: {runId: string; achadoIds: string[]; dataDirectory: string; projectId: string},
  ) => Promise<{results: {id: string; status: 'fechado' | 'reaberto'}[]}>;
  /** Injected by the installation. The route never calls a model itself. */
  start?: (
    principal: string,
    panel: Panel,
    body: {url?: string},
  ) => Promise<VerificationStart>;
};

function missingReport(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (error instanceof Refusal) return error.status === 404;
  const code = 'code' in error ? (error as {code?: unknown}).code : undefined;
  if (code === 'ENOENT' || code === 'ENOTDIR') return true;
  return 'cause' in error ? missingReport((error as {cause?: unknown}).cause) : false;
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function coverageMarkdown(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const lines = ['| Arquivo | Examinador | Modelo | Itens |', '| --- | --- | --- | --- |'];
  for (const row of value) {
    const parsed = CoverageRow.safeParse(row);
    if (!parsed.success) return undefined;
    lines.push(`| ${markdownCell(parsed.data.file)} | ${markdownCell(parsed.data.examinerProvider)} | ${markdownCell(parsed.data.examinerModel)} | ${markdownCell(parsed.data.checklist.join(', '))} |`);
  }
  return lines.join('\n');
}

function visibleAchado(value: unknown): VisibleAchado {
  const parsed = Achado.safeParse(value);
  if (!parsed.success) throw new Error('VERIFY_REPORT_SHAPE');
  const {secretPreview: _secret, ...visible} = parsed.data;
  return visible;
}

function reportDetail(value: unknown): {resumo: z.infer<typeof ReportSummary>; achados: VisibleAchado[]; cobertura: string} {
  if (value == null) throw new Refusal('NOT_FOUND', 404);
  if (!value || typeof value !== 'object') throw new Error('VERIFY_REPORT_SHAPE');
  const row = value as Record<string, unknown>;
  const resumo = ReportSummary.safeParse(row.resumo ?? row.summary);
  const achados = row.achados ?? row.findings;
  const cobertura = coverageMarkdown(row.cobertura ?? row.coverage ?? row.coverageMarkdown);
  if (!resumo.success || !Array.isArray(achados) || cobertura === undefined) throw new Error('VERIFY_REPORT_SHAPE');
  return {resumo: resumo.data, achados: achados.map(visibleAchado), cobertura};
}

function achadoMarkdown(value: unknown): string {
  if (value == null) throw new Refusal('NOT_FOUND', 404);
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as {markdown?: unknown}).markdown === 'string') return (value as {markdown: string}).markdown;
  throw new Error('VERIFY_REPORT_SHAPE');
}

async function ownerPanel(c: {get(key: 'principal'): string}, deps: VerificationRouteDeps): Promise<{principal: string; panel: Panel}> {
  if (!deps.personalPanel) throw new Refusal('NOT_FOUND', 404);
  const principal = c.get('principal');
  await deps.requireInstallationOwner(principal);
  return {principal, panel: deps.personalPanel};
}

async function authorityFor(deps: VerificationRouteDeps, runId: string, projectId: string): Promise<ManagerAuthority> {
  const found = await deps.ledger.pool.query(
    'SELECT context_id::text AS context_id FROM ac_verify_runs WHERE id=$1 AND project_id=$2',
    [runId, projectId],
  );
  const row = found.rows[0] as {context_id?: unknown} | undefined;
  const contextId = typeof row?.context_id === 'string' ? row.context_id : '';
  if (!Id.safeParse(contextId).success) throw new Refusal('NOT_FOUND', 404);
  const authority = Authority.safeParse(deps.manager(contextId));
  if (!authority.success) throw new Refusal('AUTHORITY_REQUIRED', 409);
  return authority.data;
}

async function correctionRequest(c: {get(key: 'principal'): string; req: {param(name: string): string; json(): Promise<unknown>}}, deps: VerificationRouteDeps) {
  const {principal, panel} = await ownerPanel(c, deps);
  const runId = Id.parse(c.req.param('runId'));
  const body = achadoIdsBody.parse(await c.req.json());
  const authority = await authorityFor(deps, runId, panel.projectId);
  return {principal, panel, runId, achadoIds: body.achadoIds, authority};
}

const functionalReportsPath = '/api/v1/ac/personal/verificacoes-funcionais';
const functionalModule = z.enum(VERIFICATION_MODULES);
const functionalCorrectionBody = achadoIdsBody.extend({achadoIds: z.array(achadoIdParam).min(1).max(20)});
const reportDate = z.iso.datetime();

async function functionalProject(c: {get(key: 'principal'): string}, deps: VerificationRouteDeps, write = false) {
  const {principal, panel} = await ownerPanel(c, deps);
  const projectId = deps.selectedProjectId;
  if (projectId !== panel.projectId) {
    const membership = await deps.ledger.pool.query<{role: string}>(
      'SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2', [projectId, principal],
    );
    const role = membership.rows[0]?.role;
    if (!role || (write && role === 'viewer')) throw new Refusal('PROJECT_FORBIDDEN', 403);
  }
  return {principal, projectId, dataDirectory: panel.dataDirectory};
}

function publishedModuleRuns(ledger: Ledger, projectId: string, module?: VerificationModule, runId?: string) {
  // A correção usa somente o contexto de exame registrado para o projeto e o módulo.
  return ledger.pool.query<{id: string; module: VerificationModule; context_id: string; report_dir: string; commit_id: string}>(
    `SELECT r.id, r.module, r.context_id, r.report_dir, r.commit_id
     FROM ac_verify_runs r JOIN ac_exam_contexts e USING (project_id, module, context_id)
     WHERE r.project_id=$1 AND r.module=ANY($2::text[]) AND ($3::uuid IS NULL OR r.id=$3)
       AND r.status IN ('done','failed') AND r.report_dir NOT IN ('pending','discarded')
       AND r.report_dir NOT LIKE 'discarded:%'`,
    [projectId, module ? [module] : [...VERIFICATION_MODULES], runId ?? null],
  );
}

function functionalSummary(report: ModuleReportSummary) {
  return {
    id: report.id, module: report.module, counts: report.counts, toolFailures: report.toolFailures,
    createdAt: reportDate.safeParse(report.createdAt).data ?? null,
  };
}

function reportText(text: string): string {
  return redactUnknownSecrets(text, () => '[redigido]')
    .replace(/[^\s…]{1,4}… \(sha256:[a-f0-9]{64}\)/g, '[redigido]');
}

function functionalFinding(achado: z.infer<typeof Achado>) {
  const {id, severity, status, where} = achado;
  const protectedFinding = isSecretClassBasename(where.file) || achado.secretPreview !== null;
  return {
    id, severity, status,
    where: {file: reportText(where.file), line: where.line},
    title: protectedFinding ? 'Achado em conteúdo protegido' : reportText(achado.title),
    proof: protectedFinding ? 'Conteúdo protegido. Consulte a localização indicada.' : reportText(achado.proof),
  };
}

async function functionalCoverage(ledger: Ledger, runId: string, report: Awaited<ReturnType<typeof readModuleReport>>) {
  const protectedFiles = new Set(report.achados.filter(item => item.secretPreview !== null || isSecretClassBasename(item.where.file))
    .map(item => item.where.file));
  const result = await ledger.pool.query(
    `SELECT file, examiner_provider AS "examinerProvider", examiner_model AS "examinerModel",
       profile_id AS "profileId", checklist FROM ac_verify_coverage WHERE run_id=$1 ORDER BY file`, [runId]);
  const rows = CoverageRow.array().parse(result.rows);
  for (const row of rows) if (isSecretClassBasename(row.file)) protectedFiles.add(row.file);
  const protectedNames = [...new Set(Array.from(protectedFiles, file => basename(file)))];
  const references = protectedNames.filter(Boolean).map(name => {
    const literal = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:(?<![.\\p{L}\\p{N}_-])|(?<=\\.\\.\\.))${literal}(?=->|(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_+@-]))`, 'u');
  });
  function mentionsProtected(text: string): boolean {
    return references.some(pattern => pattern.test(text)) ||
      (text.match(/[\p{L}\p{N}._@/+-]+/gu) ?? []).some(isSecretClassBasename);
  }
  const files = rows.filter(row => ![row.file, row.examinerProvider, row.examinerModel, ...row.checklist].some(mentionsProtected));
  const tools = report.toolCoverage.filter(row => ![row.tool, row.version, row.detail, ...(row.files ?? [])].some(mentionsProtected));
  const protectedCount = rows.length - files.length + report.toolCoverage.length - tools.length;
  let markdown = renderModuleCoverageMarkdown(tools, files);
  if (protectedCount) markdown += '\n[Registro de arquivo protegido omitido]\n';
  return reportText(markdown);
}

async function publishedFunctionalReport(ledger: Ledger, dataDirectory: string, projectId: string, module: VerificationModule, runId: string) {
  const {rows: [run]} = await publishedModuleRuns(ledger, projectId, module, runId);
  if (!run) throw new Refusal('NOT_FOUND', 404);
  const report = await readModuleReport(dataDirectory, projectId, runId, module).catch(error => {
    if (error instanceof Refusal && error.code === 'VERIFY_REPORT_NOT_FOUND') throw new Refusal('INVALID_CONTRACT', 400);
    throw error;
  });
  if (run.commit_id !== report.summary.commit
    || run.report_dir !== join(await realpath(dataDirectory), 'verificacoes', projectId, report.summary.directoryName)) {
    throw new Refusal('NOT_FOUND', 404);
  }
  return {run, report};
}

function registerFunctionalReports(app: Hono<ApiEnv>, deps: VerificationRouteDeps) {
  app.get(functionalReportsPath, async c => {
    c.header('Cache-Control', 'no-store');
    const {projectId, dataDirectory} = await functionalProject(c, deps);
    const module = functionalModule.optional().parse(c.req.query('modulo'));
    const {rows} = await publishedModuleRuns(deps.ledger, projectId, module);
    const runs = new Map(rows.map(run => [run.id, run]));
    const reports = rows.length ? await listModuleReports(dataDirectory, projectId, module) : [];
    const directory = reports.length ? join(await realpath(dataDirectory), 'verificacoes', projectId) : '';
    const verificacoes = reports.filter(report => {
      const run = runs.get(report.id);
      return run?.module === report.module && run.commit_id === report.commit
        && run.report_dir === join(directory, report.directoryName);
    }).reverse().map(functionalSummary);
    return c.json({verificacoes});
  });

  const reportPath = `${functionalReportsPath}/:module/:runId`;
  app.get(reportPath, async c => {
    c.header('Cache-Control', 'no-store');
    const {projectId, dataDirectory} = await functionalProject(c, deps);
    const module = functionalModule.parse(c.req.param('module'));
    const runId = Id.parse(c.req.param('runId'));
    const {report} = await publishedFunctionalReport(deps.ledger, dataDirectory, projectId, module, runId);
    return c.json({resumo: functionalSummary(report.summary), achados: report.achados.map(functionalFinding),
      cobertura: await functionalCoverage(deps.ledger, runId, report)});
  });

  app.post(`${reportPath}/corrigir`, async c => {
    c.header('Cache-Control', 'no-store');
    const {principal, projectId, dataDirectory} = await functionalProject(c, deps, true);
    const module = functionalModule.parse(c.req.param('module'));
    const runId = Id.parse(c.req.param('runId'));
    const {achadoIds} = functionalCorrectionBody.parse(await c.req.json());
    const {ledger} = deps;
    const {run, report} = await publishedFunctionalReport(ledger, dataDirectory, projectId, module, runId);
    // O produto volta a verificar os achados persistidos ao criar uma tarefa.
    const eligible = new Set(report.achados.filter(item => item.status === 'confirmado' || item.status === 'reaberto').map(item => item.id));
    if (achadoIds.some(id => !eligible.has(id))) throw new Refusal('VERIFY_FINDING_MISSING', 404);

    const authority = await ledger.acquire(principal, run.context_id, randomUUID(), 'personal-panel-correction', 60)
      .catch((error: unknown) => {
        if (error instanceof Refusal && error.code === 'MANAGER_ACTIVE') throw new Refusal('VERIFY_ALREADY_RUNNING', 409);
        throw error;
      });
    try {
      const {messageLocalId} = await requestModuleCorrection(ledger, principal, authority, {
        module, runId, achadoIds, projectId, dataDirectory,
      });
      return c.json({messageLocalId});
    } finally {
      await ledger.releaseLease(authority);
    }
  });
}

export function registerVerificationRoutes(app: Hono<ApiEnv>, deps: VerificationRouteDeps) {
  const listReports = deps.listSecurityReports ?? listSecurityReports;
  const readReport = deps.readSecurityReport ?? readSecurityReport;
  const readAchado = deps.readAchadoMarkdown ?? readAchadoMarkdown;
  const correct = deps.requestCorrection ?? requestCorrection;
  if (typeof deps.recheckFindings !== 'function' || typeof recheckFindings !== 'function') {
    throw new Error('VERIFY_REMEDIATE_UNAVAILABLE');
  }
  registerFunctionalReports(app, deps);

  app.post('/api/v1/ac/personal/verificacoes', async c => {
    c.header('Cache-Control', 'no-store');
    const {principal, panel} = await ownerPanel(c, deps);
    const body = verificationStartBody.parse(await c.req.json());
    if (!deps.start) throw new Refusal('VERIFY_WORKER_UNAVAILABLE', 503);
    const started = await deps.start(principal, panel, 'url' in body ? {url: body.url} : {});
    return c.json({id: started.id, status: started.status, phase: started.phase}, 202);
  });

  app.get('/api/v1/ac/personal/verificacoes', async c => {
    c.header('Cache-Control', 'no-store');
    const {panel} = await ownerPanel(c, deps);
    let listed: unknown;
    try {
      listed = await listReports(panel.dataDirectory, panel.projectId);
    } catch (error) {
      if (!missingReport(error)) throw error;
      listed = [];
    }
    if (!Array.isArray(listed)) throw new Error('VERIFY_REPORT_SHAPE');
    const verificacoes = listed.map(item => {
      const parsed = ReportSummary.safeParse(item);
      if (!parsed.success) throw new Error('VERIFY_REPORT_SHAPE');
      return parsed.data;
    });
    return c.json({verificacoes});
  });

  // Literal path before :runId. Otherwise "andamento" is parsed as a uuid.
  app.get('/api/v1/ac/personal/verificacoes/andamento', async c => {
    c.header('Cache-Control', 'no-store');
    const {panel} = await ownerPanel(c, deps);
    let runs: Awaited<ReturnType<typeof readVerificationProgress>> = [];
    try {
      await lstat(join(panel.dataDirectory, 'verificacoes', panel.projectId, 'andamento'));
    } catch (error) {
      if (!missingReport(error)) throw error;
      return c.json({runs});
    }
    const listed = await readVerificationProgress(panel.dataDirectory, panel.projectId);
    if (!Array.isArray(listed)) throw new Error('VERIFY_REPORT_SHAPE');
    return c.json({runs: listed});
  });

  app.get('/api/v1/ac/personal/verificacoes/:runId', async c => {
    c.header('Cache-Control', 'no-store');
    const {panel} = await ownerPanel(c, deps);
    const runId = Id.parse(c.req.param('runId'));
    let detail: unknown;
    try {
      detail = await readReport(panel.dataDirectory, panel.projectId, runId);
    } catch (error) {
      if (missingReport(error)) throw new Refusal('NOT_FOUND', 404);
      throw error;
    }
    return c.json(reportDetail(detail));
  });

  app.delete('/api/v1/ac/personal/verificacoes/:runId', async c => {
    c.header('Cache-Control', 'no-store');
    const {panel} = await ownerPanel(c, deps);
    const runId = Id.parse(c.req.param('runId'));
    await removeSecurityReport(panel.dataDirectory, panel.projectId, runId);
    return c.json({removed: true});
  });

  app.get('/api/v1/ac/personal/verificacoes/:runId/achados/:achadoId', async c => {
    c.header('Cache-Control', 'no-store');
    const {panel} = await ownerPanel(c, deps);
    const runId = Id.parse(c.req.param('runId'));
    const achadoId = achadoIdParam.parse(c.req.param('achadoId'));
    let body: unknown;
    try {
      body = await readAchado(panel.dataDirectory, panel.projectId, runId, achadoId);
    } catch (error) {
      if (missingReport(error)) throw new Refusal('NOT_FOUND', 404);
      throw error;
    }
    return c.json({markdown: achadoMarkdown(body)});
  });

  app.post('/api/v1/ac/personal/verificacoes/:runId/corrigir', async c => {
    c.header('Cache-Control', 'no-store');
    const {principal, panel, runId, achadoIds, authority} = await correctionRequest(c, deps);
    const result = await correct(deps.ledger, principal, authority, {
      runId, achadoIds, dataDirectory: panel.dataDirectory, projectId: panel.projectId,
    });
    return c.json(result);
  });

  if (deps.recheck) {
    const recheck = deps.recheck;
    app.post('/api/v1/ac/personal/verificacoes/:runId/reverificar', async c => {
      c.header('Cache-Control', 'no-store');
      const {principal, panel, runId, achadoIds, authority} = await correctionRequest(c, deps);
      try {
        const result = await recheck(principal, authority, {
          runId, achadoIds, dataDirectory: panel.dataDirectory, projectId: panel.projectId,
        });
        return c.json(result);
      } catch (error) {
        if (error instanceof Refusal && error.code === VERIFY_RECHECK_NEW_EXAM_REQUIRED) {
          const guidance = 'guidance' in error && typeof error.guidance === 'string'
            ? error.guidance
            : VERIFY_RECHECK_NEW_EXAM_GUIDANCE;
          return c.json({error: error.code, guidance}, error.status);
        }
        throw error;
      }
    });
  }
}
