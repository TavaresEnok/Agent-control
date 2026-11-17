import {Hono} from 'hono';
import {z} from 'zod';
import {Authority, Id, Refusal} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {Achado, CoverageRow, ReportSummary} from './verify-types.ts';
import {listSecurityReports, readAchadoMarkdown, readSecurityReport} from './verify-report.ts';
import {recheckFindings, requestCorrection} from './verify-remediate.ts';

type ManagerAuthority = z.infer<typeof Authority>;
type Panel = {dataDirectory: string; projectId: string};
type ApiEnv = {Variables: {principal: string; timingStarted: number; authenticationMs: number}};
type VisibleAchado = Omit<z.infer<typeof Achado>, 'secretPreview'>;

const achadoIdsBody = z.object({
  achadoIds: z.array(z.string().regex(/^ACH-\d{3}$/)).max(100),
}).strict();
const achadoIdParam = z.string().regex(/^ACH-\d{3}$/);

export type VerificationRouteDeps = {
  ledger: Ledger;
  requireInstallationOwner: (principal: string) => Promise<void>;
  personalPanel: Panel | undefined;
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

export function registerVerificationRoutes(app: Hono<ApiEnv>, deps: VerificationRouteDeps) {
  const listReports = deps.listSecurityReports ?? listSecurityReports;
  const readReport = deps.readSecurityReport ?? readSecurityReport;
  const readAchado = deps.readAchadoMarkdown ?? readAchadoMarkdown;
  const correct = deps.requestCorrection ?? requestCorrection;
  if (typeof deps.recheckFindings !== 'function' || typeof recheckFindings !== 'function') {
    throw new Error('VERIFY_REMEDIATE_UNAVAILABLE');
  }

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
      const result = await recheck(principal, authority, {
        runId, achadoIds, dataDirectory: panel.dataDirectory, projectId: panel.projectId,
      });
      return c.json(result);
    });
  }
}
