import {containFailure} from './failure-log.ts';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {lstat, realpath} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {z} from 'zod';
import {digest, Id, Refusal, type Authority} from './contracts.ts';
import {finishExamIntentTx} from './exam-intent.ts';
import type {Ledger, VerificationModule} from './ledger.ts';
import {hasModuleReviewProof, moduleCollectorHypothesis, moduleReviewTask, readModuleReviewVerdict} from './module-exam-proof.ts';
import {readRecheckBlob, recheckHead, sameRecheckHistory} from './module-recheck-git.ts';
import {attestDistinctExamSessions, attestExamExecution, distinctExamSessions, examFindingIdentity, examSubjectDigest, HIGH_REVIEWER_MODEL, HIGH_REVIEWER_PROVIDER, HIGH_SESSION_UNPROVEN} from './module-exam-sessions.ts';
import {moduleMeasurementCriterion} from './module-recheck-criteria.ts';
import {measureLocalRegression} from './module-recheck-local.ts';
import {latestModuleMeasurement, RECHECK_PROOF_VERSION, type MeasurementScope} from './module-recheck-measurement.ts';
import {COVERAGE_REVIEW_INSTRUCTION, FUNCTION_COVERAGE_CRITERION, measureRecheckRegression, readFunctionalRecheckVerdict, recheckCorrectionMatches, supportsFunctionalRecheck, type BoundScope, type FunctionalRegression} from './module-recheck-regression.ts';
import {assertPersonalActivation} from './verify-intent.ts';
import {hasKnownSecret, isSecretClassBasename} from './verify-redact.ts';
import {Achado} from './verify-types.ts';
import {ACHADO_ID, EXCERPT_LIMIT, MULTILINE_CONTROL_CHAR, ModuleCollectorOutput, assertInside, assertModuleRepoRelativePath, assertVerificationModule, isErrno, isProtectedLocation, protectedLocation} from './verification-modules-contracts.ts';
import {sanitizeText} from './verification-modules-collector.ts';
import {assertPinnedModuleImage} from './verification-modules-container.ts';
import {readTextInside, resolveProjectVerificationsDir} from './verification-modules-report.ts';
import {parseModuleReviewJson} from './verification-modules-run.ts';
import {moduleRegressionPath, sameIdSet, uniqueSortedIds} from './verification-modules-correction.ts';
import {authorizeModuleRecheck, reconcileReports} from './verification-modules-persistence.ts';

type ModuleRecheckExaminer = {provider: string; model: string; accountId: string | null; profileId: string | null;
  grantId?: string; sessionId?: string};
type ModuleRecheckReviewer = {provider: string; model: string; accountId: string; profileId: string; grantId: string; sessionId?: string};
export type ModuleRecheckReview = (request: {
  intentId: string;
  commit: string;
  task: string;
  examiner: ModuleRecheckExaminer | null;
  severity?: Achado['severity'];
  fromExaminer?: boolean;
  /** Host digest of what the reviewer job examines; the native worker binds its session to it. */
  subject?: string;
  signal?: AbortSignal;
}) => Promise<{output: string; reviewer: ModuleRecheckReviewer} | {reason: string; reviewer?: ModuleRecheckReviewer}>;

const ModuleRecheckResult = z.discriminatedUnion('status', [
  z.object({id: ACHADO_ID, status: z.enum(['fechado', 'reaberto'])}),
  z.object({id: ACHADO_ID, status: z.literal('pendente'), reason: z.string()}),
]);
type ModuleRecheckResult = z.infer<typeof ModuleRecheckResult>;
const RecheckDigest = z.string().regex(/^[a-f0-9]{64}$/);
const RecheckCommit = z.string().regex(/^[a-f0-9]{40}$/);
const ModuleRecheckPublication = z.object({
  runId: Id, intentId: Id, commit: RecheckCommit, results: z.array(ModuleRecheckResult).min(1).max(20),
  proofRunId: Id.optional(), proofVersion: z.number().int().optional(),
  receiptDigests: z.partialRecord(ACHADO_ID, RecheckDigest).optional(),
});
type ModuleRecheckPublication = z.infer<typeof ModuleRecheckPublication>;
const RecheckAuditProof = z.object({
  id: ACHADO_ID, status: z.enum(['fechado', 'reaberto']), commit: RecheckCommit, reviewerBinding: RecheckDigest,
  proofDigest: RecheckDigest, reviewerReason: z.string().min(1),
  reviewer: z.object({provider: z.string().min(1), model: z.string().min(1), accountId: Id, profileId: Id, grantId: Id, sessionId: Id.optional()}),
  source: z.object({file: z.string(), line: z.number().int().positive(), tool: z.string(), rule: z.string(),
    origin: z.literal('collector'), commit: RecheckCommit, evidenceDigest: RecheckDigest}),
  moduleProof: z.object({runId: Id, tool: z.string(), version: z.string().min(1), origin: z.literal('collector'), collectorImage: z.string()}),
  regressionProof: z.looseObject({
    proofVersion: z.literal(RECHECK_PROOF_VERSION), receiptDigest: RecheckDigest, moduleProofRunId: Id,
    criterion: z.string().min(1), recordedRule: z.string().optional(),
    scope: z.looseObject({id: ACHADO_ID, runId: Id, file: z.string(), line: z.number().int().positive(), tool: z.string(),
      rule: z.string(), evidenceDigest: RecheckDigest}),
    observations: z.looseObject({original: z.looseObject({commit: RecheckCommit}), corrected: z.looseObject({commit: RecheckCommit})}),
  }),
});
type ModuleRecheckOutcome = {
  results: ModuleRecheckResult[];
  publication: 'published' | 'pending';
};
type RecheckCoverage = {
  file: string; examiner_provider: string; examiner_model: string; profile_id: string | null;
  account_id: string | null; provenance: string; checklist: string[];
  examiner_grant_id: string | null; examiner_session_id: string | null;
};

function protectedRecheckFile(file: string): boolean {
  return isProtectedLocation(file) || isSecretClassBasename(file) || /(?:^|\/)(?:logs?|\.ssh|\.aws|\.config)(?:\/|$)/i.test(file)
    || /\.log(?:[.\d_-].*)?$|(?:^|[._-])(?:secrets?|credentials?|password|senha)(?:[._-]|$)|^\.pypirc$/i.test(basename(file))
    || sanitizeRecheckText(file) !== file;
}

function sanitizeRecheckText(text: string): string {
  // Drop lines containing old persisted secret previews or newly detected secrets.
  return sanitizeText(text).split('\n').map(line =>
    /…|\[REDACTED\]|\[removido: alta entropia\]/i.test(line) ? '[trecho omitido]' : line,
  ).join('\n');
}

function safeRecheckTestTitle(title: string): boolean {
  // This value comes from a Git blob, so a literal ellipsis may be punctuation.
  // Normalize before screening so it cannot suppress a redaction match.
  const screened = title.replaceAll('…', '...');
  return sanitizeRecheckText(screened) === screened;
}

async function readRecheckLine(repo: string, commit: string, file: string, line: number, signal?: AbortSignal) {
  const blob = await readRecheckBlob(repo, commit, file, signal);
  const target = blob && sanitizeRecheckText(blob.text).split('\n')[line - 1]?.trim();
  return target && target !== '[trecho omitido]' && target.length <= EXCERPT_LIMIT / 2
    && !MULTILINE_CONTROL_CHAR.test(target) ? target : '';
}

function sanitizedRecheckReason(reason: string): string {
  const safe = sanitizeRecheckText(reason).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return hasKnownSecret(safe) ? '[trecho omitido]' : safe;
}

function recheckOriginalImage(image: string | null): string | undefined {
  if (image === null) return;
  try {
    return assertPinnedModuleImage(image);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
  }
}

async function validRecheckJournal(client: pg.PoolClient, contextId: string, run: {
  id: string; module: VerificationModule; commit_id: string; collector_image: string | null;
}, journal: ModuleRecheckPublication) {
  if (journal.runId !== run.id) return false;
  const {proofRunId, proofVersion, receiptDigests} = journal;
  const closes = journal.results.filter(result => result.status === 'fechado');
  if (!proofRunId && !proofVersion && !receiptDigests) return closes.length === 0;
  if (!proofRunId || proofVersion !== RECHECK_PROOF_VERSION || !receiptDigests) return false;
  const ids = Object.keys(receiptDigests);
  if (!ids.length || ids.length > journal.results.length || closes.some(result => !ids.includes(result.id))) return false;
  const {rows} = await client.query<{detail: unknown; status: string}>(
    `SELECT a.detail, f.status FROM ac_audit a JOIN ac_verify_findings f
     ON f.run_id=$2 AND f.achado_id=a.detail->>'id'
     WHERE a.context_id=$1 AND a.kind='module.finding_rechecked' AND a.detail->>'runId'=$2::uuid::text
     AND a.detail->>'intentId'=$3 AND f.achado_id=ANY($4::text[])`,
    [contextId, run.id, journal.intentId, ids],
  );
  const proofs = rows.map(row => ({...row, proof: RecheckAuditProof.safeParse(row.detail).data}));
  return proofs.length === ids.length && ids.every(id => {
    const decisions = journal.results.filter(result => result.id === id && result.status !== 'pendente');
    const matches = proofs.filter(row => row.proof?.id === id);
    const entry = matches[0];
    if (matches.length !== 1 || decisions.length !== 1 || !entry?.proof) return false;
    const {proof, status} = entry;
    const {regressionProof, moduleProof, source} = proof;
    const {receiptDigest, ...receipt} = regressionProof;
    const criterion = supportsFunctionalRecheck(run.module, receipt.scope) ? FUNCTION_COVERAGE_CRITERION
      : moduleMeasurementCriterion(run.module, receipt.scope)?.id;
    return receipt.criterion === criterion && receiptDigest === receiptDigests[id] && digest(receipt) === receiptDigest
      && proof.status === decisions[0]!.status && status === proof.status && proof.commit === journal.commit
      && receipt.moduleProofRunId === proofRunId && moduleProof.runId === proofRunId
      && moduleProof.collectorImage === run.collector_image && moduleProof.tool === source.tool
      && receipt.scope.id === id && receipt.scope.runId === run.id && receipt.scope.file === source.file
      && receipt.scope.line === source.line && receipt.scope.tool === source.tool
      && sanitizeRecheckText(receipt.recordedRule ?? receipt.scope.rule) === source.rule
      && receipt.scope.evidenceDigest === source.evidenceDigest
      && receipt.observations.original.commit === run.commit_id && source.commit === run.commit_id
      && receipt.observations.corrected.commit === journal.commit;
  });
}

async function currentRecheckJournal(client: pg.PoolClient, journal: ModuleRecheckPublication, scope: Omit<MeasurementScope, 'head'>,
  image: string | null, repo: string, signal?: AbortSignal) {
  if (await recheckHead(repo, signal) !== journal.commit) return false;
  if (!journal.proofRunId) return true;
  const latest = await latestModuleMeasurement(client, {...scope, head: journal.commit});
  return latest?.runId === journal.proofRunId && latest.status === 'done' && latest.usable && latest.collectorImage === image;
}

export async function moduleRemeasurementTarget(ledger: Ledger, principal: string, authority: Authority, input: {
  projectId: string; module: VerificationModule; runId: string; repo: string; signal?: AbortSignal;
}) {
  await assertPersonalActivation(ledger);
  return ledger.tx(async client => {
    await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
    input.signal?.throwIfAborted();
    const {rows: [origin]} = await client.query<{commit_id: string; collector_image: string | null; repo: string}>(
      `SELECT r.commit_id, r.collector_image, p.repo FROM ac_verify_runs r
       JOIN ac_project_repositories p ON p.project_id=r.project_id
       WHERE r.id=$1 AND r.project_id=$2 AND r.context_id=$3 AND r.module=$4 AND r.status IN ('done','failed')
       AND r.report_dir NOT IN ('pending','discarded') AND r.report_dir NOT LIKE 'discarded:%' FOR SHARE`,
      [input.runId, input.projectId, authority.contextId, input.module],
    );
    if (!origin) throw new Refusal('VERIFY_RUN_MISSING', 404);
    if (await realpath(origin.repo) !== await realpath(input.repo)) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    const image = assertPinnedModuleImage(origin.collector_image ?? '');
    const commit = await recheckHead(input.repo, input.signal);
    if (commit === origin.commit_id || !await sameRecheckHistory(input.repo, origin.commit_id, commit, input.signal)) {
      throw new Refusal('VERIFY_RECHECK_CHANGE_UNPROVEN', 409);
    }
    return {image, commit};
  });
}

/** Recheck only committed, sanitized evidence. A pending result preserves the persisted finding status. */
export async function recheckModuleFindings(
  ledger: Ledger,
  principal: string,
  authority: Authority,
  input: {
    module?: VerificationModule;
    runId: string;
    achadoIds: readonly string[];
    dataDirectory: string;
    projectId: string;
    review: ModuleRecheckReview;
    signal?: AbortSignal;
  },
): Promise<ModuleRecheckOutcome> {
  const {signal} = input;
  signal?.throwIfAborted();
  if (input.module !== undefined) assertVerificationModule(input.module);
  if (!Id.safeParse(input.runId).success || !Id.safeParse(input.projectId).success) {
    throw new Refusal('VERIFY_RUN_MISSING', 404);
  }
  await assertPersonalActivation(ledger);
  const requested = uniqueSortedIds(input.achadoIds);
  const loaded = await ledger.tx(async client => {
    await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
    signal?.throwIfAborted();
    const run = (await client.query<{id: string; module: VerificationModule; commit_id: string; report_dir: string; exam_origin_sha256: string | null;
      collector_image: string | null; status: string}>(
      `SELECT r.id, r.module, r.commit_id, r.report_dir, r.exam_origin_sha256, r.collector_image, r.status FROM ac_verify_runs r
       JOIN ac_exam_contexts e ON (e.project_id,e.context_id,e.module)=(r.project_id,r.context_id,r.module)
       WHERE r.id=$1 AND r.project_id=$2 AND r.context_id=$3
       AND ($4::text IS NULL OR r.module=$4) AND r.module <> 'verify' AND r.status IN ('done','failed')
       AND r.report_dir NOT IN ('pending','discarded') AND r.report_dir NOT LIKE 'discarded:%' FOR UPDATE OF r`,
      [input.runId, input.projectId, authority.contextId, input.module ?? null],
    )).rows[0];
    if (!run) throw new Refusal('VERIFY_RUN_MISSING', 404);
    const rows = (await client.query<{achado_id: string; file: string; line: number | null; payload: Achado}>(
      'SELECT achado_id, file, line, payload FROM ac_verify_findings WHERE run_id=$1 AND achado_id = ANY($2::text[])',
      [run.id, requested],
    )).rows;
    const byId = new Map(rows.map(row => [row.achado_id, row]));
    const items = requested.map(id => {
      const row = byId.get(id);
      if (!row) throw new Refusal('VERIFY_FINDING_MISSING', 404);
      const file = run.module === 'prontidao' && isProtectedLocation(row.file)
        ? protectedLocation(row.file) : assertModuleRepoRelativePath(row.file);
      const {sources, reference, scenario, proof, verifier, severity} = row.payload;
      return {id, file, line: row.line ?? 1, hasOriginalLine: row.line !== null, tool: sources?.[0] ?? run.module,
        rule: sources?.[1] ?? reference ?? id, scenario, proof, verifier, severity};
    });
    const repo = (await client.query<{repo: string}>('SELECT repo FROM ac_project_repositories WHERE project_id=$1', [input.projectId])).rows[0]?.repo;
    const latest = (await client.query<{detail: unknown; published: boolean}>(
      `SELECT a.detail, EXISTS (
         SELECT 1 FROM ac_audit p WHERE p.context_id=a.context_id AND p.kind='module.recheck_report_published'
         AND p.detail->>'runId'=$2 AND p.detail->>'intentId'=a.detail->>'intentId'
       ) AS published FROM ac_audit a WHERE a.context_id=$1 AND a.kind='module.recheck_report_pending'
       AND a.detail->>'runId'=$2 ORDER BY a.id DESC LIMIT 1`, [authority.contextId, run.id],
    )).rows[0];
    const previous = latest && ModuleRecheckPublication.safeParse(latest.detail).data;
    const validJournal = previous && await validRecheckJournal(client, authority.contextId, run, previous) ? previous : undefined;
    const journal = latest?.published ? undefined : validJournal;
    const legacyExamOrigin = !run.exam_origin_sha256 && items.some(item => item.tool === 'examinador' && item.rule === 'exame-de-arquivo');
    const matchingJournal = validJournal && sameIdSet(requested, validJournal.results.map(result => result.id)) ? validJournal : undefined;
    const scope = {projectId: input.projectId, contextId: authority.contextId, module: run.module};
    const replay = matchingJournal && (!latest!.published || !legacyExamOrigin) && repo
      && await currentRecheckJournal(client, matchingJournal, scope, run.collector_image, repo, signal).catch(error => {
        // A pending publication can still be recovered when its checkout is unavailable.
        if (journal && error instanceof Refusal && error.code === 'VERIFY_COMMIT_INVALID') return false;
        throw error;
      });
    let verifiedOrigin: string | undefined;
    if (run.exam_origin_sha256) {
      try {
        const projectDir = await resolveProjectVerificationsDir(input.dataDirectory, input.projectId);
        if (!projectDir) throw new Refusal('VERIFY_REPORT_INVALID', 400);
        assertInside(projectDir, run.report_dir);
        verifiedOrigin = await readTextInside(projectDir, join(run.report_dir, 'bruto', 'exame.json'),
          'VERIFY_REPORT_INVALID', run.exam_origin_sha256);
      } catch (error) {
        // Preserve a committed verdict until its original archive can be restored.
        if (replay && !latest!.published) return {journal: matchingJournal, replay: true as const, archivePending: true as const};
        throw error;
      }
    }
    if (replay) return {journal: matchingJournal, run, repo, scope, replay: true as const, archivePending: false as const};
    if (!repo && !journal) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
    const generation = await client.query<{recheck_generation: string}>(
      'UPDATE ac_verify_runs SET recheck_generation=recheck_generation+1 WHERE id=$1 RETURNING recheck_generation::text',
      [run.id],
    );
    return {run, items, repo, journal, verifiedOrigin, generation: generation.rows[0]!.recheck_generation,
      reconcile: !latest || latest.published || Boolean(journal), replay: false as const};
  });

  const publish = async (journal: ModuleRecheckPublication, validateReplay?: (client: pg.PoolClient) => Promise<void>): Promise<ModuleRecheckOutcome> => {
    try {
      await reconcileReports(ledger, principal, authority, input.dataDirectory, input.projectId, undefined,
        {runId: journal.runId, intentId: journal.intentId, signal, validateReplay});
      return {results: journal.results, publication: 'published'};
    } catch (error) {
      if (validateReplay && error instanceof Refusal && error.code === 'VERIFY_RUN_CONFLICT') throw error;
      return {results: journal.results, publication: 'pending'};
    }
  };
  if (loaded.replay) {
    if (loaded.archivePending) return {results: loaded.journal.results, publication: 'pending'};
    return publish(loaded.journal, async client => {
      if (!await validRecheckJournal(client, authority.contextId, loaded.run, loaded.journal)
        || !await currentRecheckJournal(client, loaded.journal, loaded.scope, loaded.run.collector_image, loaded.repo, signal)) {
        throw new Refusal('VERIFY_RUN_CONFLICT', 409);
      }
    });
  }
  const directory = loaded.run.report_dir;
  const sourceFile = join(directory, 'bruto', 'exame.json');
  const {verifiedOrigin} = loaded;
  if (loaded.journal) {
    const recovered = await publish(loaded.journal);
    if (recovered.publication === 'pending') {
      throw new Refusal('VERIFY_RECHECK_PREVIOUS_PUBLICATION_PENDING', 503);
    }
  } else if (loaded.reconcile) {
    await reconcileReports(ledger, principal, authority, input.dataDirectory, input.projectId, undefined, {runId: loaded.run.id, signal});
  }
  const {repo} = loaded;
  if (!repo) throw new Refusal('VERIFY_PATH_FORBIDDEN', 400);
  const projectDir = await resolveProjectVerificationsDir(input.dataDirectory, input.projectId);
  if (!projectDir) throw new Refusal('VERIFY_REPORT_INVALID', 400);
  assertInside(projectDir, directory);
  const raw = ModuleCollectorOutput.parse(JSON.parse(await readTextInside(directory, join(directory, 'bruto', 'achados-brutos.json'), 'VERIFY_REPORT_INVALID')));
  const coverage = await ledger.pool.query<RecheckCoverage>(
    `SELECT v.file, v.examiner_provider, v.examiner_model, v.profile_id, p.account_id, v.provenance, v.checklist,
            v.examiner_grant_id::text AS examiner_grant_id, v.examiner_session_id::text AS examiner_session_id
     FROM ac_verify_coverage v LEFT JOIN ac_profiles p ON p.id=v.profile_id WHERE v.run_id=$1`,
    [loaded.run.id],
  );
  const byFile = new Map(coverage.rows.map(row => [row.file, row]));
  const examinerIntentId = (await ledger.pool.query<{intent_id: string}>(
    'SELECT intent_id::text AS intent_id FROM ac_verify_runs WHERE id=$1 AND context_id=$2', [loaded.run.id, authority.contextId],
  )).rows[0]?.intent_id;
  const head = await recheckHead(repo, signal);
  const originalCommit = loaded.run.commit_id;
  const sameHistory = head !== originalCommit && await sameRecheckHistory(repo, originalCommit, head, signal);
  const moduleName = assertVerificationModule(loaded.run.module);
  const measurementScope = {projectId: input.projectId, contextId: authority.contextId, module: moduleName, head};
  const originalImage = recheckOriginalImage(loaded.run.collector_image);
  let measurement: BoundScope['measurement'];
  if (sameHistory && loaded.run.status === 'done' && originalImage && loaded.items.some(item =>
    supportsFunctionalRecheck(moduleName, item) || moduleMeasurementCriterion(moduleName, item))) {
    const latest = await latestModuleMeasurement(ledger.pool, measurementScope);
    if (latest?.status === 'done' && latest.usable && latest.collectorImage === originalImage) {
      measurement = {runId: latest.runId, collectorImage: originalImage};
    }
  }
  const intentId = randomUUID();
  await ledger.tx(async client => {
    const context = await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
    signal?.throwIfAborted();
    const command = {
      schemaVersion: 1 as const, intentId, deliveryAttemptId: randomUUID(),
      contextId: authority.contextId, policyRevision: Number(context.policy_revision), action: 'plan.start' as const,
      payload: {workflow: 'security-verify-readonly-v1' as const, messageRef: `recheck:${loaded.run.id}`, projectId: input.projectId, commit: head},
    };
    await client.query(
      `INSERT INTO ac_intents (id, context_id, principal_id, digest, command, operation_id, run_id, manager_epoch, plan_revision)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [intentId, authority.contextId, principal, digest(command), JSON.stringify(command), randomUUID(), randomUUID(), authority.epoch, Number(context.plan_revision)],
    );
  });

  const results: ModuleRecheckResult[] = [];
  let completed = false;
  try {
    const audit: (ModuleRecheckResult & {
      examiner: ModuleRecheckExaminer | null; reviewer: ModuleRecheckReviewer | null; proofDigest: string | null;
      reviewerReason: string | null;
      reviewerBinding: string | null;
      source: {file: string; line: number; tool: string; rule: string; commit: string; origin: string; evidenceDigest: string} | null;
      moduleProof: FunctionalRegression['moduleProof'] | null; regressionProof: FunctionalRegression['receipt'] | null;
    })[] = [];
    const hasExamFindings = loaded.items.some(item => item.tool === 'examinador' && item.rule === 'exame-de-arquivo');
    const archived = verifiedOrigin !== undefined || (hasExamFindings && await lstat(sourceFile).then(() => true, error => {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }));
    const originText = verifiedOrigin ?? (archived ? await readTextInside(directory, sourceFile, 'VERIFY_REPORT_INVALID') : undefined);
    const origin = z.object({id: ACHADO_ID, file: z.string(), line: z.number().int().positive(),
      evidence: z.string(), hypothesis: z.string().max(300).optional()});
    const reviewedSources = new Map<string, z.infer<typeof origin>>();
    if (originText !== undefined) {
      try {
        for (const entry of z.array(origin).max(999).parse(JSON.parse(originText))) {
          if (reviewedSources.has(entry.id)) throw new Error();
          reviewedSources.set(entry.id, entry);
        }
      } catch { throw new Refusal('VERIFY_REPORT_INVALID', 400); }
    }
    for (const item of loaded.items) {
      signal?.throwIfAborted();
      const row = byFile.get(item.file);
      const examiner: ModuleRecheckExaminer | null = row?.provenance === 'examiner' ? {
        provider: row.examiner_provider, model: row.examiner_model, profileId: row.profile_id, accountId: row.account_id,
        ...(row.examiner_grant_id && row.examiner_session_id
          ? {grantId: row.examiner_grant_id, sessionId: row.examiner_session_id} : {}),
      } : item.verifier ? {...item.verifier, profileId: null, accountId: null} : null;
      const logOrProtected = protectedRecheckFile(item.file);
      const fromExaminer = item.tool === 'examinador' && item.rule === 'exame-de-arquivo';
      const highExaminer = fromExaminer && item.severity === 'alta';
      const observed = fromExaminer ? reviewedSources.get(item.id) : undefined;
      const historicalLine = !logOrProtected && (sameHistory || (fromExaminer && !archived)) && /^[0-9a-f]{40}$/.test(originalCommit)
        ? await readRecheckLine(repo, originalCommit, item.file, item.line, signal) : '';
      const legacyEvidence = historicalLine && item.scenario.trim() && historicalLine.trim() === item.scenario.trim();
      const original = fromExaminer
        ? (archived ? observed : legacyEvidence ? {file: item.file, line: item.line, evidence: item.scenario} : undefined)
        : raw.findings[Number(item.id.slice(4)) - 1];
      if ((archived || !fromExaminer) && (!original || original.file !== item.file || original.line !== item.line ||
          (fromExaminer ? original.evidence !== item.scenario : !('tool' in original) || original.tool !== item.tool || original.rule !== item.rule))) {
        throw new Refusal('VERIFY_REPORT_INVALID', 400);
      }
      const sourceKnown = original && (row?.provenance === 'examiner' || (row?.provenance === 'collector' && !fromExaminer));
      const evidence = !original || logOrProtected ? '' : sanitizeRecheckText(original.evidence);
      const qaRegression = supportsFunctionalRecheck(moduleName, item);
      const functional = qaRegression || moduleMeasurementCriterion(moduleName, item);
      let line = !functional && !logOrProtected && sourceKnown
        ? await readRecheckLine(repo, head, item.file, item.line, signal) : '';
      let result: ModuleRecheckResult | undefined;
      let reviewer: ModuleRecheckReviewer | undefined;
      let proofDigest: string | undefined;
      let reviewerReason: string | undefined;
      let reviewerBinding: string | undefined;
      let regression: FunctionalRegression | undefined;
      const pending = (reason: string): ModuleRecheckResult => ({id: item.id, status: 'pendente', reason});
      if (logOrProtected) {
        result = pending('MODULE_RECHECK_PROTECTED');
      } else if (!sourceKnown) {
        result = pending('MODULE_RECHECK_ORIGINAL_UNKNOWN');
      } else if (!evidence.replaceAll('[trecho omitido]', '').trim()) {
        result = pending('MODULE_RECHECK_EVIDENCE_UNAVAILABLE');
      } else if (functional) {
        if (!item.hasOriginalLine || !original || !('message' in original)
          || item.scenario !== sanitizeText(original.message) || item.severity !== original.severity
          || (!item.verifier && item.proof !== evidence)) {
          result = pending('MODULE_RECHECK_FUNCTIONAL_ORIGIN_UNPROVEN');
        } else if (!sameHistory) {
          result = pending(head === originalCommit ? 'MODULE_RECHECK_SAME_COMMIT' : 'MODULE_RECHECK_CHANGE_UNPROVEN');
        } else {
          const scope: BoundScope = {
            module: moduleName, repo, runId: loaded.run.id, measurement,
            originalCommit, head, item: {id: item.id, file: item.file, line: item.line, tool: item.tool, rule: item.rule},
            evidence, originalMessage: item.scenario, testFile: moduleRegressionPath(moduleName, item.id), signal,
          };
          const measured = qaRegression ? await measureRecheckRegression(ledger, scope)
            : await measureLocalRegression(ledger, scope, original, text =>
              !MULTILINE_CONTROL_CHAR.test(text) && sanitizeRecheckText(text) === text);
          if (measured.reason !== undefined) result = pending(measured.reason);
          else if ([measured.before.code, measured.after.code, measured.assertion, measured.moduleProof.version,
            ...('verdict' in measured ? Object.values(measured.receipt.observations)
              .flatMap(side => side.uncovered.map(finding => finding.name)) : [])]
            .some(value => value !== null && sanitizeRecheckText(value) !== value)
            || (measured.receipt.testTitle !== undefined && !safeRecheckTestTitle(measured.receipt.testTitle))) {
            result = pending('MODULE_RECHECK_EVIDENCE_UNAVAILABLE');
          } else {
            regression = measured;
            line = measured.after.code;
          }
        }
      } else if (!line) {
        result = pending('MODULE_RECHECK_EVIDENCE_UNAVAILABLE');
      }

      if (!result) {
        const rule = regression?.receipt.scope.rule ?? sanitizeRecheckText(item.rule);
        const hypothesis = observed?.hypothesis ? sanitizeRecheckText(observed.hypothesis)
          : fromExaminer ? 'A linha atual ainda sustenta a observação original?' : moduleCollectorHypothesis(rule);
        let skipSnapshot: {originalCommit: string; original: string; current: string} | undefined;
        if (sameHistory && moduleName === 'qa' && !regression && (fromExaminer || rule === 'QA-TESTE-PULADO')) {
          const [original, current] = await Promise.all([originalCommit, head].map(commit =>
            readRecheckBlob(repo, commit, item.file, signal)));
          if (original && current && [original.text, current.text].every(text =>
            Buffer.byteLength(text) <= 16000 && sanitizeRecheckText(text) === text)) {
            skipSnapshot = {originalCommit, original: original.text, current: current.text};
          }
        }
        const reviewEvidence = {
          module: moduleName, file: item.file, line: regression?.after.line ?? item.line, code: line, commit: head,
          tool: sanitizeRecheckText(item.tool), rule, hypothesis, evidence,
          skipSnapshot, originalCommit, originalCode: regression?.before.code ?? (historicalLine || null),
          moduleProof: regression?.moduleProof ?? null, regressionProof: regression?.receipt ?? null,
          regressionAssertion: regression?.assertion ?? null,
        };
        const task = JSON.parse(moduleReviewTask(reviewEvidence));
        if (regression && !('verdict' in regression)) {
          task.instruction = 'Compare a identidade e as duas medições locais de regressionProof. Sem ferramentas, rede ou escrita. '
            + 'Responda JSON com kind confirmacao, binding, status provavel ou descartado, reason e proof. '
            + 'Para descartar a hipótese, copie code em proof e inclua correction com rule, criterion e object (de regressionProof), '
            + 'original e corrected (de regressionProof.observations). Explique como a mesma regressão verifica a correção. '
            + 'Cite entre crases o objeto e os valores actual das duas revisões.';
        } else if (regression) {
          task.instruction = COVERAGE_REVIEW_INSTRUCTION;
        }
        // History without a ledger-bound examiner execution for this file cannot prove a distinct
        // reviewer session, so it stays pending and no reviewer seat is spent. Reports before
        // migration 115 or before the per-file session binding need a new exam.
        const examinerSubject = highExaminer && examinerIntentId ? examSubjectDigest({purpose: 'examiner', module: moduleName,
          intentId: examinerIntentId, commit: originalCommit, file: item.file}) : undefined;
        // The reviewer is bound to the original finding, not only to its line, by immutable fields
        // of the original request, so it holds when the commit changed and the title was rewritten.
        const reviewerSubject = examSubjectDigest({purpose: 'reviewer', module: moduleName, intentId, commit: head,
          file: item.file, line: item.line, finding: examFindingIdentity({id: item.id, source: item.tool, file: item.file,
            line: item.line, severity: item.severity, evidence, hypothesis: observed?.hypothesis ?? null})});
        const unsupported = !regression && task.criterion === null && head !== originalCommit;
        const examinerProven = unsupported || !highExaminer || Boolean(examiner?.grantId && examiner.sessionId && examinerSubject
          && await attestExamExecution(ledger.pool, {contextId: authority.contextId, intentId: examinerIntentId!,
            execution: examiner, subject: examinerSubject}));
        signal?.throwIfAborted();
        const reviewed = unsupported
          ? {reason: 'MODULE_RECHECK_FUNCTIONAL_RULE_UNSUPPORTED'}
          : !examinerProven
            ? {reason: 'MODULE_RECHECK_EXAMINER_SESSION_UNPROVEN'}
          : await input.review({intentId, commit: head, task: JSON.stringify(task), examiner, severity: item.severity, fromExaminer,
            subject: reviewerSubject, signal});
        signal?.throwIfAborted();
        reviewer = 'reviewer' in reviewed ? reviewed.reviewer : undefined;
        if ('reason' in reviewed) {
          result = pending(/^[A-Z][A-Z0-9_]{0,79}$/.test(reviewed.reason) ? reviewed.reason : 'MODULE_RECHECK_PROOF_UNAVAILABLE');
        } else {
          if (highExaminer) {
            if (reviewed.reviewer.provider !== HIGH_REVIEWER_PROVIDER || reviewed.reviewer.model !== HIGH_REVIEWER_MODEL
              || (examiner && reviewed.reviewer.profileId === examiner.profileId)) {
              throw new Refusal('MODULE_EXAM_HIGH_REVIEWER_UNAVAILABLE');
            }
          } else if (examiner && (reviewed.reviewer.provider === examiner.provider || reviewed.reviewer.profileId === examiner.profileId
            || reviewed.reviewer.accountId === examiner.accountId)) {
            throw new Refusal('MODULE_EXAM_PROVIDER_NOT_DISTINCT');
          }
          const parsed = parseModuleReviewJson(reviewed.output);
          const verdict = regression ? readFunctionalRecheckVerdict(parsed) : readModuleReviewVerdict(parsed);
          if (verdict) reviewerReason = sanitizedRecheckReason(verdict.reason);
          const sessionsProven = !highExaminer || (distinctExamSessions(examiner, reviewed.reviewer)
            && await attestDistinctExamSessions(ledger.pool, {
              contextId: authority.contextId, examiner, examinerIntentId: examinerIntentId!, examinerSubject: examinerSubject!,
              reviewer: reviewed.reviewer, reviewerIntentId: intentId, reviewerSubject,
            }));
          signal?.throwIfAborted();
          if (!sessionsProven) {
            result = pending(HIGH_SESSION_UNPROVEN);
            reviewerReason = undefined;
          } else if (regression) {
            const status = 'verdict' in regression ? regression.verdict : 'fechado';
            if (!verdict || verdict.status !== (status === 'fechado' ? 'descartado' : 'confirmado')
              || verdict.binding !== task.binding || verdict.proof.trim() !== line) {
              result = pending('MODULE_RECHECK_PROOF_UNAVAILABLE');
            } else if (!recheckCorrectionMatches(parsed, reviewerReason ?? '', regression)) {
              result = pending('MODULE_RECHECK_CORRECTION_UNEXPLAINED');
            } else {
              result = {id: item.id, status};
              proofDigest = digest(line);
              reviewerBinding = verdict.binding;
            }
          } else if (!verdict || verdict.status === 'provavel' || !hasModuleReviewProof(reviewEvidence, verdict)) {
            result = pending('MODULE_RECHECK_PROOF_UNAVAILABLE');
          } else if (verdict.status === 'confirmado') {
            result = {id: item.id, status: 'reaberto'};
            proofDigest = digest(line);
          } else if (head === originalCommit) {
            result = pending('MODULE_RECHECK_SAME_COMMIT');
          } else if (!sameHistory || !historicalLine || historicalLine === line) {
            result = pending('MODULE_RECHECK_CHANGE_UNPROVEN');
          } else {
            result = pending('MODULE_RECHECK_FUNCTIONAL_RULE_UNSUPPORTED');
          }
        }
      }
      results.push(result);
      audit.push({...result, examiner, reviewer: reviewer ?? null, proofDigest: proofDigest ?? null,
        reviewerReason: reviewerReason ?? null, reviewerBinding: reviewerBinding ?? null,
        source: sourceKnown && evidence ? {file: item.file, line: item.line, tool: sanitizeRecheckText(item.tool),
          rule: sanitizeRecheckText(item.rule), commit: originalCommit,
          origin: fromExaminer ? (archived ? 'examiner' : 'legacy-git') : 'collector', evidenceDigest: digest(evidence)} : null,
        moduleProof: regression?.moduleProof ?? null, regressionProof: regression?.receipt ?? null,
      });
    }

    const decisionsWithProof = audit.filter(item => item.status !== 'pendente' && item.regressionProof !== null);
    const proofRunId = decisionsWithProof[0]?.moduleProof?.runId;
    const publication: ModuleRecheckPublication = {intentId, runId: loaded.run.id, commit: head, results,
      ...(proofRunId && {proofRunId, proofVersion: RECHECK_PROOF_VERSION,
        receiptDigests: Object.fromEntries(decisionsWithProof.map(item => [item.id, item.regressionProof!.receiptDigest]))})};
    await ledger.tx(async client => {
      await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
      await ledger.assertIntentActive(client, authority.contextId, intentId);
      const {rows: [liveRun]} = await client.query<{recheck_generation: string}>(
        "SELECT recheck_generation::text FROM ac_verify_runs WHERE id=$1 AND report_dir NOT IN ('pending','discarded') AND report_dir NOT LIKE 'discarded:%' FOR UPDATE",
        [loaded.run.id],
      );
      if (!liveRun) throw new Refusal('VERIFY_RUN_MISSING', 404);
      const currentRepo = (await client.query<{repo: string}>('SELECT repo FROM ac_project_repositories WHERE project_id=$1 FOR SHARE',
        [input.projectId])).rows[0]?.repo;
      if (liveRun.recheck_generation !== loaded.generation || currentRepo !== repo
        || await recheckHead(repo, signal) !== head) {
        throw new Refusal('VERIFY_RUN_CONFLICT', 409);
      }
      if (proofRunId) {
        const liveProof = await latestModuleMeasurement(client, measurementScope);
        if (liveProof?.runId !== proofRunId || liveProof.status !== 'done' || !liveProof.usable
          || liveProof.collectorImage !== measurement?.collectorImage) {
          throw new Refusal('VERIFY_RUN_CONFLICT', 409);
        }
      }
      for (const result of audit) {
        signal?.throwIfAborted();
        if (result.status !== 'pendente') {
          const updated = await client.query(
            'UPDATE ac_verify_findings SET status=$3 WHERE run_id=$1 AND achado_id=$2',
            [loaded.run.id, result.id, result.status],
          );
          if (!updated.rowCount) throw new Refusal('VERIFY_FINDING_MISSING', 404);
        }
        await client.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'module.finding_rechecked',$2)",
          [authority.contextId, {...result, intentId, runId: loaded.run.id, commit: head}]);
      }
      signal?.throwIfAborted();
      if (results.some(result => result.status !== 'pendente')) {
        await client.query("INSERT INTO ac_audit(context_id,kind,detail) VALUES($1,'module.recheck_report_pending',$2)",
          [authority.contextId, publication]);
      }
      await finishExamIntentTx(client, ledger, {intentId, contextId: authority.contextId}, 'done');
      signal?.throwIfAborted();
    });
    completed = true;
    return results.some(result => result.status !== 'pendente')
      ? publish(publication) : {results, publication: 'published'};
  } finally {
    if (!completed) {
      await ledger.tx(async client => {
        await authorizeModuleRecheck(client, ledger, principal, authority, input.projectId);
        await finishExamIntentTx(client, ledger, {intentId, contextId: authority.contextId}, 'failed');
      }).catch(containFailure('EXAM_INTENT_NOT_CLOSED', undefined));
    }
  }
}
