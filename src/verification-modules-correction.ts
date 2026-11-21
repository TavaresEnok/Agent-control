import {Id, Refusal, type Authority} from './contracts.ts';
import type {Ledger, VerificationModule} from './ledger.ts';
import {assertNoSymlinkAlongPath, correctionReceipt, groupCorrectionFindings, loadCorrectionRequests, saveCorrectionRequest, type CorrectionReceipt} from './verification-correction-requests.ts';
import {assertPersonalActivation} from './verify-intent.ts';
import {REMEDIATION_ACCEPTANCE} from './verify-types.ts';
import {lockWorkflowProjectShared} from './workflow-generations.ts';
import {ACHADO_ID, assertModuleRepoRelativePath, assertVerificationModule, isProtectedFindingSource, isProtectedLocation, locateRepoFile, protectedLocation} from './verification-modules-contracts.ts';

export function uniqueSortedIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new Refusal('VERIFY_NOTHING_TO_FIX', 400);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !ACHADO_ID.safeParse(id).success) throw new Refusal('VERIFY_FINDING_MISSING', 404);
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  if (unique.length > 20) throw new Refusal('VERIFY_TOO_MANY', 400);
  unique.sort((a, b) => a.localeCompare(b));
  return unique;
}

export function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].map(String).sort((x, y) => x.localeCompare(y));
  const b = [...right].map(String).sort((x, y) => x.localeCompare(y));
  return a.every((id, index) => id === b[index]);
}

export function moduleRegressionPath(module: string, achadoId: string): string {
  const folder = module === 'verify' ? 'seguranca' : module;
  return `tests/${folder}/${achadoId.toLowerCase()}.test.ts`;
}

function moduleRegressionText(module: string, ids: readonly string[]): string {
  return ids.map(id => `O teste ${moduleRegressionPath(module, id)} tem de falhar antes da correção e passar depois.`).join('\n');
}

type EligibleFinding = {
  id: string;
  file: string;
  line: number | null;
  status: string;
  severity: string;
  title: string;
  snippet: string;
};

function renderModuleRemediationTask(input: {
  projectId: string;
  module: string;
  runId: string;
  groups: readonly {file: string; items: EligibleFinding[]}[];
  writePaths: readonly string[];
  regression: string;
}): string {
  const body = input.groups.map(group => [
    `Arquivo: ${group.file}`,
    ...(input.module === 'prontidao' && isProtectedLocation(group.file)
      ? ['Ação manual do responsável: tratar o arquivo protegido; não ler nem editar esse arquivo.'] : []),
    ...group.items.map(item => `- ${item.id} linha ${item.line ?? 'não informada'}: ${item.title}\n  Prova: ${item.snippet}`),
  ].join('\n')).join('\n');
  return [
    `Corrija os achados selecionados do módulo ${input.module}.`,
    `Projeto: ${input.projectId}`,
    `Execução: ${input.runId}`,
    '',
    'O que corrigir:',
    body,
    '',
    'Caminhos de escrita:',
    ...input.writePaths.map(file => `- ${file}`),
    '',
    'Teste de regressão exigido:',
    input.regression,
    '',
    'Critério de aceite:',
    REMEDIATION_ACCEPTANCE,
  ].join('\n');
}

/**
 * Idempotently converts confirmed/reopened findings from a module run into a product task
 * linked to the project, with real repository write paths, regression test path, and acceptance criteria.
 */
export async function requestModuleCorrection(
  ledger: Ledger,
  principal: string,
  authority: Authority,
  input: {
    module?: VerificationModule;
    runId: string;
    achadoIds: readonly string[];
    dataDirectory: string;
    projectId: string;
    repoPath?: string;
  },
): Promise<CorrectionReceipt & {
  contextId: string;
  regressionTest: string;
  acceptance: string;
  projectId: string;
}> {
  if (input.module !== undefined) assertVerificationModule(input.module);
  if (!Id.safeParse(input.runId).success || !Id.safeParse(input.projectId).success) {
    throw new Refusal('VERIFY_RUN_MISSING', 404);
  }
  await assertPersonalActivation(ledger);
  const requested = uniqueSortedIds(input.achadoIds);

  return ledger.tx(async client => {
    await lockWorkflowProjectShared(client, authority.contextId);
    const mainRow = (await client.query<{id: string}>(
      `SELECT x.id::text AS id
       FROM ac_contexts x
       WHERE x.project_id=$1 AND x.project_id=(SELECT project_id FROM ac_contexts WHERE id=$2) AND NOT x.archived
         AND NOT EXISTS (SELECT 1 FROM ac_exam_contexts e WHERE e.context_id=x.id)
       ORDER BY x.created_at, x.id LIMIT 1`,
      [input.projectId, authority.contextId],
    )).rows[0];
    // The main-context foreign key is needed at dispatch. Lock it before the exam context
    // so a caller using main authority cannot hold it while waiting for this run lock.
    if (mainRow && mainRow.id !== authority.contextId) {
      await client.query('SELECT id FROM ac_contexts WHERE id=$1 FOR KEY SHARE', [mainRow.id]);
    }
    const authContext = await ledger.authorize(client, principal, authority.contextId);
    await ledger.fence(client, authority);
    if (authContext.project_id !== input.projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);

    const runRow = (await client.query<{
      id: string;
      context_id: string;
      module: string;
    }>(
      "SELECT id::text AS id, context_id::text AS context_id, module FROM ac_verify_runs WHERE id=$1 AND project_id=$2 AND report_dir <> 'discarded' AND report_dir NOT LIKE 'discarded:%' FOR UPDATE",
      [input.runId, input.projectId],
    )).rows[0];
    if (!runRow) throw new Refusal('VERIFY_RUN_MISSING', 404);
    if (input.module !== undefined && runRow.module !== input.module) {
      throw new Refusal('VERIFY_RUN_MISSING', 404);
    }

    const mainContextId = mainRow?.id ?? runRow.context_id;
    if (authority.contextId !== runRow.context_id && authority.contextId !== mainContextId) {
      throw new Refusal('VERIFY_RUN_MISSING', 404);
    }

    const coveredRows = (await client.query<{file: string}>('SELECT file FROM ac_verify_coverage WHERE run_id=$1', [runRow.id])).rows;
    const covered = new Set(coveredRows.map(row => String(row.file)));
    const findingRows = (await client.query<{
      achado_id: string;
      status: string;
      file: string;
      line: number | null;
      severity: string;
      payload: unknown;
    }>(
      'SELECT achado_id, status, file, line, severity, payload FROM ac_verify_findings WHERE run_id=$1 AND achado_id = ANY($2::text[])',
      [runRow.id, requested],
    )).rows;
    const byId = new Map(findingRows.map(row => [String(row.achado_id), row]));
    const findings: EligibleFinding[] = requested.map(id => {
      const row = byId.get(id);
      if (!row || !['confirmado', 'reaberto', 'fechado'].includes(row.status)) {
        throw new Refusal('VERIFY_FINDING_MISSING', 404);
      }
      const candidate = String(row.file);
      const file = runRow.module === 'prontidao' && isProtectedLocation(candidate)
        ? protectedLocation(candidate) : assertModuleRepoRelativePath(candidate);
      if (!covered.has(file)) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      const lineNum = row.line !== null && Number.isInteger(Number(row.line)) && Number(row.line) >= 1 ? Number(row.line) : null;
      const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
      if (isProtectedLocation(file)) {
        const sources = Array.isArray(payload.sources) ? payload.sources : [];
        if (runRow.module !== 'prontidao' || !isProtectedFindingSource(sources[0], sources[1])
          || typeof sources[1] !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(sources[1])
          || payload.scenario !== 'Possível segredo em arquivo protegido.'
          || payload.proof !== 'Localização informada pelo coletor; conteúdo protegido.')
          throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
        return {id, file, line: lineNum, status: String(row.status), severity: String(row.severity),
          title: 'Possível segredo em arquivo protegido', snippet: 'Localização informada pelo coletor; conteúdo protegido.'};
      }
      const title = typeof payload.title === 'string' ? payload.title.slice(0, 200) : id;
      const snippet = typeof payload.snippet === 'string'
        ? payload.snippet
        : typeof payload.proof === 'string'
          ? payload.proof
          : '';
      return {id, file, line: lineNum, status: String(row.status), severity: String(row.severity), title, snippet};
    });

    const repoRow = (await client.query<{repo: string}>('SELECT repo FROM ac_project_repositories WHERE project_id=$1', [input.projectId])).rows[0];
    const repo = repoRow?.repo ?? input.repoPath ?? null;
    if (!repo) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);

    const findRequest = await loadCorrectionRequests(client, runRow.id, requested);
    const exact = findRequest(requested);
    const groups = groupCorrectionFindings(findings, runRow.module === 'dependencias');
    const plans = exact ? [{groups, ids: requested, existing: exact}] : groups.map(group => {
      const ids = group.items.map(item => item.id);
      return {groups: [group], ids, existing: findRequest(ids)};
    });
    // A closed finding can replay its receipt. It cannot participate in new dispatch.
    if (plans.some(plan => !plan.existing) && findings.some(finding => finding.status === 'fechado')) {
      throw new Refusal('VERIFY_FINDING_MISSING', 404);
    }
    const prefix = runRow.module === 'verify' ? 'verify-fix' : `module-${runRow.module}-fix`;
    const contextIds = mainContextId === authority.contextId ? [mainContextId] : [mainContextId, authority.contextId];
    const requestsToSave = [];
    for (const plan of plans) {
      const sourcePaths = [...new Set(plan.groups.map(group => group.file))];
      const writableSources = sourcePaths.filter(path => !isProtectedLocation(path));
      const regressionPaths = plan.ids.map(id => moduleRegressionPath(runRow.module, id));
      const writePaths = [...new Set([...writableSources, ...regressionPaths])];
      const existing = plan.existing;
      if (existing?.writePaths.some(path => !writePaths.includes(path))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      for (const path of sourcePaths) {
        if (existing) await assertNoSymlinkAlongPath(repo, path);
        else if (!(await locateRepoFile(repo, path))) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
      }
      for (const path of regressionPaths) await assertNoSymlinkAlongPath(repo, path);
      const regressionTest = moduleRegressionText(runRow.module, plan.ids)
        + (writableSources.length < sourcePaths.length
          ? '\nUse dados sintéticos e teste um alvo seguro; não leia nem edite arquivos protegidos.' : '');
      requestsToSave.push({...plan, writePaths, regressionTest});
    }
    const requests = [];
    for (const {groups, ids, existing, writePaths, regressionTest} of requestsToSave) {
      requests.push(existing ?? await saveCorrectionRequest(client, {
        runId: runRow.id, prefix, ids, writePaths, regressionTest, contextIds,
        text: renderModuleRemediationTask({
          projectId: input.projectId, module: runRow.module, runId: runRow.id, groups, writePaths, regression: regressionTest,
        }),
      }));
    }
    return {
      ...correctionReceipt(requests),
      contextId: mainContextId,
      regressionTest: requests.map(request => request.regressionTest).join('\n'),
      acceptance: requests[0]!.acceptance,
      projectId: input.projectId,
    };
  });
}
