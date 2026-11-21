import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {lstat, readdir, rename, rm} from 'node:fs/promises';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {z} from 'zod';
import {Refusal, type Authority} from './contracts.ts';
import {finishExamIntentTx} from './exam-intent.ts';
import type {Ledger, VerificationModule} from './ledger.ts';
import {moduleContainerJournal, runBoundedCollectorProcess, type CollectorProcess} from './module-container-cleanup.ts';
import {endRound} from './personal-artifact-hooks.ts';
import {assertPersonalActivation} from './verify-intent.ts';
import {Achado} from './verify-types.ts';
import {MODULE_REPORT_DIR, ModuleCollectorOutput, ModuleReportSummary, ModuleToolCoverage, collectorMeasuredDetailFile, isErrno} from './verification-modules-contracts.ts';
import {validateModuleCollectorObject} from './verification-modules-collector.ts';
import {achadoMarkdown, assertNoLiveAccessKey, failureCounts, guardReportText, readTextInside, renderModuleReadme, reportDirectoryExists, requireDataDirectory, requiredModuleArtifacts, resolveProjectVerificationsDir, syncReportDirectory, writePrivate} from './verification-modules-report.ts';

async function replacePrivateFile(directory: string, name: string, body: string): Promise<void> {
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  if (!target.startsWith(directory + sep) || !temporary.startsWith(directory + sep)) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  }
  try {
    let existing = null;
    try {
      existing = await lstat(target);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    }
    if (existing && (existing.mode & 0o777) === 0o600
      && await readTextInside(directory, target, 'VERIFY_REPORT_INVALID') === body) return;
    await writePrivate(temporary, directory, body);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, {force: true});
    throw error;
  }
}

type PersistedModuleReport = {
  id: string;
  module: VerificationModule;
  commit_id: string;
  report_dir: string;
  report_prepared_dir: string | null;
  report_legacy_missing: boolean;
};

function reportIntegrity(): Refusal {
  return new Refusal('VERIFY_REPORT_INTEGRITY', 409);
}

function assertPersistedReportPath(projectDir: string, path: string, row: PersistedModuleReport): void {
  const id = row.id.replaceAll('-', '');
  const name = basename(path);
  const suffix = name.slice(16, -(row.module.length + 1));
  if (dirname(path) !== projectDir || resolve(path) !== path || !MODULE_REPORT_DIR.test(name)
    || !name.endsWith(`-${row.module}`) || (suffix !== id && (row.report_prepared_dir !== null || suffix !== id.slice(0, 8)))) {
    throw new Refusal('VERIFY_PATH_FORBIDDEN', 403);
  }
}

async function findReportSummary(directory: string): Promise<{summary: ModuleReportSummary | null; published: boolean}> {
  for (const name of ['run.json', '.run-pending.json']) {
    let text: string;
    try {
      text = await readTextInside(directory, join(directory, name), 'VERIFY_REPORT_INVALID');
    } catch (error) {
      if (error instanceof Refusal && error.code === 'VERIFY_REPORT_INVALID') continue;
      throw error;
    }
    try {
      const summary = ModuleReportSummary.safeParse(JSON.parse(text));
      return {summary: summary.success ? summary.data : null, published: name === 'run.json'};
    } catch {
      return {summary: null, published: name === 'run.json'};
    }
  }
  return {summary: null, published: false};
}

function reportMatches(summary: ModuleReportSummary, directory: string, row: PersistedModuleReport): boolean {
  return summary.id === row.id && summary.module === row.module && summary.commit === row.commit_id
    && summary.directoryName === basename(directory);
}

async function assertUnsharedLegacyReport(client: pg.PoolClient, target: string, runId: string): Promise<void> {
  // A historical short suffix can collide even if the summary is incomplete.
  const conflict = await client.query(
    "SELECT 1 FROM ac_verify_runs WHERE id<>$1 AND (report_dir IN ($2, 'discarded:' || $2) OR report_prepared_dir=$2)",
    [runId, target],
  );
  if (conflict.rowCount) throw reportIntegrity();
}

async function removePersistedModuleReport(client: pg.PoolClient, projectDir: string, row: PersistedModuleReport): Promise<void> {
  const path = row.report_dir.startsWith('discarded:') ? row.report_dir.slice('discarded:'.length) : row.report_dir;
  const target = path === 'pending' || path === 'discarded' ? row.report_prepared_dir : path;
  if (target) {
    assertPersistedReportPath(projectDir, target, row);
    if (!await reportDirectoryExists(target)) return;
    const {summary} = await findReportSummary(target);
    if (summary && !reportMatches(summary, target, row)) throw reportIntegrity();
    if (!row.report_prepared_dir) {
      await assertUnsharedLegacyReport(client, target, row.id);
      if (!summary) {
        const collision = await client.query(
          `SELECT 1 FROM ac_verify_runs own JOIN ac_verify_runs other ON other.project_id=own.project_id
           AND other.module=own.module AND left(other.id::text,8)=left(own.id::text,8)
           WHERE own.id=$1 AND other.id<>own.id AND other.report_prepared_dir IS NULL
           AND other.report_dir='pending' LIMIT 1`, [row.id],
        );
        if (collision.rowCount) throw reportIntegrity();
      }
    }
    await rm(target, {recursive: true, force: true});
    return;
  }

  // Pre-reservation runs may have prepared a directory while report_dir was
  // still pending. Match the full identity in its summary before removing it.
  if (!await reportDirectoryExists(projectDir)) return;
  for (const name of await readdir(projectDir)) {
    if (!MODULE_REPORT_DIR.test(name) || !name.endsWith(`-${row.id.slice(0, 8)}-${row.module}`)) continue;
    const directory = join(projectDir, name);
    if (!await reportDirectoryExists(directory)) continue;
    const {summary} = await findReportSummary(directory);
    if (summary && reportMatches(summary, directory, row)) {
      await assertUnsharedLegacyReport(client, directory, row.id);
      await rm(directory, {recursive: true, force: true});
    }
  }
}

export async function discardModuleReport(
  ledger: Ledger, principal: string, dataDirectory: string, projectId: string, module: VerificationModule, runId: string,
): Promise<void> {
  const load = async (client: pg.PoolClient) => {
    const activation = await client.query("SELECT 1 FROM ac_installation_activation WHERE id=1 AND mode='personal' FOR SHARE");
    if (!activation.rowCount) throw new Refusal('PERSONAL_ACTIVATION_REQUIRED', 403);
    const membership = await client.query(
      'SELECT role FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 FOR SHARE', [projectId, principal],
    );
    if (!membership.rowCount || membership.rows[0].role === 'viewer') throw new Refusal('PROJECT_FORBIDDEN', 403);
    const keys = [runId, projectId, module];
    const {rows: [binding]} = await client.query<{context_id: string}>(
      'SELECT context_id FROM ac_verify_runs WHERE id=$1 AND project_id=$2 AND module=$3', keys,
    );
    if (!binding) throw new Refusal('VERIFY_RUN_MISSING', 404);
    // Match reconciliation's context-before-run lock order.
    await ledger.authorize(client, principal, binding.context_id);
    const {rows: [row]} = await client.query<PersistedModuleReport>(
      `SELECT id, module, commit_id, report_dir, report_prepared_dir, report_legacy_missing FROM ac_verify_runs
       WHERE id=$1 AND project_id=$2 AND module=$3 AND status IN ('done','failed') FOR UPDATE`, keys,
    );
    if (!row) throw new Refusal('VERIFY_RUN_MISSING', 404);
    return row;
  };
  const parent = join(await requireDataDirectory(dataDirectory), 'verificacoes', projectId);
  await ledger.tx(async client => {
    const row = await load(client);
    if (row.report_dir === 'discarded' || row.report_dir.startsWith('discarded:')) return;
    if (row.report_dir !== 'pending') assertPersistedReportPath(parent, row.report_dir, row);
    await client.query(
      'UPDATE ac_verify_runs SET report_dir=$2, report_legacy_missing=false WHERE id=$1',
      [runId, row.report_dir === 'pending' ? 'discarded' : `discarded:${row.report_dir}`],
    );
  });
  await ledger.tx(async client => {
    const row = await load(client);
    await resolveProjectVerificationsDir(dataDirectory, projectId);
    await removePersistedModuleReport(client, parent, row);
  });
}

type PersistedFinding = {achado_id: string; severity: Achado['severity']; status: Achado['status']; file: string; line: number | null; payload: Achado};

async function recoverHistoricalCoverage(
  client: pg.PoolClient, runId: string, raw: ModuleCollectorOutput, findings: PersistedFinding[],
): Promise<void> {
  const unknown = await client.query(
    "SELECT 1 FROM ac_verify_coverage WHERE run_id=$1 AND provenance='unknown' AND examiner_provider='ferramenta' AND profile_id IS NULL LIMIT 1",
    [runId],
  );
  if (!unknown.rowCount) return;

  const archived = (await client.query<ModuleToolCoverage>(
    'SELECT tool, version, status, detail FROM ac_verify_tool_coverage WHERE run_id=$1', [runId],
  )).rows;
  const recordedTools = new Set(archived.filter(row => row.status === 'ok')
    .map(row => JSON.stringify([row.tool, row.version, row.detail])));
  const recordedFindings = new Map(findings.map(finding => [finding.achado_id, finding]));
  const proven = new Set<string>();
  for (const row of raw.coverage) {
    if (row.status !== 'ok' || !recordedTools.has(JSON.stringify([row.tool, row.version, row.detail]))) continue;
    for (const file of row.files ?? []) proven.add(file);
    const measured = collectorMeasuredDetailFile(row);
    if (measured) proven.add(measured);
    for (const [index, finding] of raw.findings.entries()) {
      if (finding.tool !== row.tool) continue;
      const recorded = recordedFindings.get(`ACH-${String(index + 1).padStart(3, '0')}`);
      if (recorded?.file === finding.file && recorded.line === finding.line
        && recorded.payload?.sources?.[0] === finding.tool && recorded.payload.sources?.[1] === finding.rule) proven.add(finding.file);
    }
  }
  if (proven.size) await client.query(
    `UPDATE ac_verify_coverage SET provenance='collector' WHERE run_id=$1 AND file=ANY($2::text[])
     AND provenance='unknown' AND examiner_provider='ferramenta' AND profile_id IS NULL`, [runId, [...proven]],
  );
}

async function publishModuleReport(client: pg.PoolClient, row: PersistedModuleReport): Promise<void> {
  const directory = row.report_dir;
  const {summary, published} = await findReportSummary(directory);
  if (!summary || !reportMatches(summary, directory, row)) throw reportIntegrity();
  const parsed = JSON.parse(await readTextInside(directory, join(directory, 'achados.json'), 'VERIFY_REPORT_INVALID'));
  const archived = z.object({achados: z.array(Achado)}).parse(parsed).achados;
  const raw = validateModuleCollectorObject(
    JSON.parse(await readTextInside(directory, join(directory, 'bruto', 'achados-brutos.json'), 'VERIFY_REPORT_INVALID')), row.module,
  );
  const files = ['mapa.md', 'cobertura.md'];
  if (row.module === 'documentacao') files.push(...requiredModuleArtifacts(raw.coverage));
  for (const file of files) {
    await readTextInside(directory, join(directory, file), 'VERIFY_REPORT_INVALID');
  }
  const findings = (await client.query<PersistedFinding>(
    'SELECT achado_id, status, severity, file, line, payload FROM ac_verify_findings WHERE run_id=$1', [row.id],
  )).rows;
  const byId = new Map(findings.map(item => [item.achado_id, item]));
  if (byId.size !== archived.length || new Set(archived.map(item => item.id)).size !== archived.length) throw reportIntegrity();
  const reconciled = archived.map(item => {
    const finding = byId.get(item.id);
    if (!finding || item.where.file !== finding.file || item.where.line !== finding.line) throw reportIntegrity();
    const persisted = Achado.strip().safeParse({...finding.payload, status: finding.status, severity: finding.severity});
    if (!persisted.success || persisted.data.id !== finding.achado_id || persisted.data.where.file !== finding.file
      || persisted.data.where.line !== finding.line) throw reportIntegrity();
    assertNoLiveAccessKey(persisted.data);
    return persisted.data;
  });
  if (!row.report_prepared_dir) await recoverHistoricalCoverage(client, row.id, raw, findings);
  const findingsDirectory = join(directory, 'achados');
  if (!await reportDirectoryExists(findingsDirectory)) throw reportIntegrity();
  const counts = failureCounts(reconciled);
  await replacePrivateFile(directory, 'achados.json', guardReportText(`${JSON.stringify({achados: reconciled}, null, 2)}\n`));
  for (const finding of reconciled) {
    await replacePrivateFile(findingsDirectory, `${finding.id}.md`, guardReportText(achadoMarkdown(finding)));
  }
  await syncReportDirectory(findingsDirectory);
  await replacePrivateFile(directory, 'README.md', guardReportText(renderModuleReadme({
    module: summary.module, runId: summary.id, directoryName: summary.directoryName,
    createdAt: new Date(summary.createdAt), commit: summary.commit, note: summary.note,
    total: reconciled.length, counts, discarded: reconciled.filter(item => item.status === 'descartado').length,
    toolCoverage: raw.coverage,
  })));
  // Initial publication is a single rename of run.json after the files above
  // are ready. Rechecks rebuild these files only from committed database state.
  if (!published || JSON.stringify(summary.counts) !== JSON.stringify(counts)) {
    await replacePrivateFile(directory, 'run.json', guardReportText(`${JSON.stringify({...summary, counts}, null, 2)}\n`));
  }
  await syncReportDirectory(directory);
}

export async function reconcileReports(
  ledger: Ledger, principal: string, authority: Authority, dataDirectory: string, projectId: string, publishedRunId?: string,
  recheck?: {runId: string; intentId?: string; signal?: AbortSignal; validateReplay?: (client: pg.PoolClient) => Promise<void>},
): Promise<void> {
  await ledger.tx(async client => {
    if (recheck) {
      await authorizeModuleRecheck(client, ledger, principal, authority, projectId);
    } else {
      const context = await ledger.authorize(client, principal, authority.contextId);
      await ledger.fence(client, authority);
      if (context.project_id !== projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    }
    recheck?.signal?.throwIfAborted();
    await recheck?.validateReplay?.(client);
    const rows = (await client.query<PersistedModuleReport>(
      `SELECT id, module, commit_id, report_dir, report_prepared_dir, report_legacy_missing FROM ac_verify_runs
       WHERE project_id=$1 AND context_id=$2 AND status IN ('done','failed') AND module <> 'verify'
       AND ($3::uuid IS NULL OR id=$3) ORDER BY id FOR UPDATE`,
      [projectId, authority.contextId, recheck?.runId ?? null],
    )).rows;
    if (publishedRunId && !rows.some(row => row.id === publishedRunId && row.report_dir === row.report_prepared_dir)) {
      throw new Refusal('VERIFY_RUN_MISSING', 404);
    }
    if (!rows.length) {
      if (recheck) throw new Refusal('VERIFY_RUN_MISSING', 404);
      return;
    }
    const projectDir = await resolveProjectVerificationsDir(dataDirectory, projectId);
    const parent = projectDir ?? join(await requireDataDirectory(dataDirectory), 'verificacoes', projectId);
    for (const row of rows) {
      if (row.report_dir === 'pending' || row.report_dir === 'discarded' || row.report_dir.startsWith('discarded:')) {
        if (recheck) throw new Refusal('VERIFY_RUN_MISSING', 404);
        await removePersistedModuleReport(client, parent, row);
        continue;
      }
      assertPersistedReportPath(parent, row.report_dir, row);
      if (row.report_prepared_dir && row.report_dir !== row.report_prepared_dir) throw reportIntegrity();
      if (!projectDir || !await reportDirectoryExists(row.report_dir)) {
        if (row.report_prepared_dir || recheck) throw reportIntegrity();
        if (!row.report_legacy_missing) await client.query('UPDATE ac_verify_runs SET report_legacy_missing=true WHERE id=$1', [row.id]);
        continue;
      }
      try {
        await publishModuleReport(client, row);
      } catch (error) {
        // A historical partial restore has no durable reservation. Preserve
        // the files and let unrelated runs reconcile. Reject unsafe paths.
        const incomplete = error instanceof SyntaxError || error instanceof z.ZodError ||
          (error instanceof Refusal && ['VERIFY_REPORT_INTEGRITY', 'VERIFY_REPORT_INVALID'].includes(error.code));
        if (row.report_prepared_dir || recheck || !incomplete) throw error;
        await client.query('UPDATE ac_verify_runs SET report_legacy_missing=true WHERE id=$1', [row.id]);
        continue;
      }
      if (row.report_legacy_missing) await client.query('UPDATE ac_verify_runs SET report_legacy_missing=false WHERE id=$1', [row.id]);
    }
    recheck?.signal?.throwIfAborted();
    if (recheck?.intentId) {
      await ledger.fence(client, authority);
      await client.query(
        `INSERT INTO ac_audit(context_id,kind,detail)
         SELECT $1,'module.recheck_report_published',$2::jsonb WHERE NOT EXISTS (
           SELECT 1 FROM ac_audit WHERE context_id=$1 AND kind='module.recheck_report_published' AND detail=$2::jsonb
         )`,
        [authority.contextId, {runId: recheck.runId, intentId: recheck.intentId}],
      );
      recheck.signal?.throwIfAborted();
    }
  });
}

export async function recoverModuleContainers(
  ledger: Ledger, principal: string, authority: Authority, projectId: string, execute: CollectorProcess, module?: VerificationModule,
  dataDirectory?: string,
): Promise<void> {
  const abandonedRuns: string[] = [];
  const pending = await ledger.tx(async client => {
    abandonedRuns.length = 0;
    const context = await ledger.authorize(client, principal, authority.contextId);
    await ledger.fence(client, authority);
    if (context.project_id !== projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    if (module && !(await client.query(
      'SELECT 1 FROM ac_exam_contexts WHERE project_id=$1 AND context_id=$2 AND module=$3', [projectId, authority.contextId, module],
    )).rowCount) throw new Refusal('EXAM_CONTEXT_MISMATCH', 403);
    const abandoned = await client.query<{id: string; intent_id: string}>(
      `UPDATE ac_verify_runs r SET status='failed', finished_at=clock_timestamp() FROM ac_intents i
       WHERE r.intent_id=i.id AND r.context_id=$1 AND r.module <> 'verify'
       AND r.status='running' AND i.manager_epoch<>$2 RETURNING r.id, r.intent_id`, [authority.contextId, authority.epoch],
    );
    for (const row of abandoned.rows) {
      await finishExamIntentTx(client, ledger, {intentId: row.intent_id, contextId: authority.contextId}, 'failed');
      abandonedRuns.push(row.id);
    }
    return (await client.query<{id: string; collector_container_token: string}>(
      `SELECT id, collector_container_token FROM ac_verify_runs WHERE context_id=$1 AND module <> 'verify'
       AND status IN ('done','failed') AND collector_container_token IS NOT NULL ORDER BY id`, [authority.contextId],
    )).rows;
  });
  // A run the product itself moved from running to failed has ended: its leftover temporaries may now age out.
  if (dataDirectory !== undefined) for (const roundId of abandonedRuns) await endRound({dataDirectory, projectId, roundId});
  for (const row of pending) {
    await moduleContainerJournal(ledger, principal, authority, row.id, execute).cleanup(row.collector_container_token, undefined, {recovering: true});
  }
}

/** Recover reports and collector cleanup under the current project/context authority. */
export async function reconcileModuleReports(
  ledger: Ledger, principal: string, authority: Authority, dataDirectory: string, projectId: string,
): Promise<void> {
  await assertPersonalActivation(ledger);
  await recoverModuleContainers(ledger, principal, authority, projectId, runBoundedCollectorProcess, undefined, dataDirectory);
  await reconcileReports(ledger, principal, authority, dataDirectory, projectId);
}

export async function authorizeModuleRecheck(
  client: pg.PoolClient, ledger: Ledger, principal: string, authority: Authority, projectId: string,
) {
  const context = await ledger.authorize(client, principal, authority.contextId);
  await ledger.fence(client, authority);
  if (context.project_id !== projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
  const membership = await client.query(
    "SELECT 1 FROM ac_memberships WHERE project_id=$1 AND principal_id=$2 AND role='owner' FOR SHARE", [projectId, principal],
  );
  if (!membership.rowCount) throw new Refusal('PROJECT_FORBIDDEN', 403);
  return context;
}
