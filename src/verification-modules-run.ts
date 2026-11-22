import {containFailure} from './failure-log.ts';
import {withInstallationImageLock} from './personal-image-lock.ts';
import {assertDiskSpaceForLaunch, launchVolumesOf} from './personal-disk.ts';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {previousPerformanceMeasurements} from './module-performance-history.ts';
import {Capacity} from './capacity.ts';
import {digest, Id, Refusal, type Authority} from './contracts.ts';
import {finishExamIntentTx} from './exam-intent.ts';
import {clearExamContextCapacityWaits, reserveSpecialistExamSeat} from './exam-provider.ts';
import type {Ledger, VerificationModule} from './ledger.ts';
import {moduleContainerJournal, runBoundedCollectorProcess} from './module-container-cleanup.ts';
import {moduleCollectorCandidate, moduleExamReadBinding, moduleExamReviewEvidence, type ModuleExamCollectorReview, type ModuleExamResult} from './module-exam.ts';
import {mapModuleSnapshot, readModuleExamFile} from './module-exam-map.ts';
import {isPublicModuleRule} from './module-exam-collector-proof.ts';
import {hasModuleReviewProof, moduleReviewObservationTitle, moduleReviewTask, readModuleReviewVerdict} from './module-exam-proof.ts';
import {attestDistinctExamSessions, distinctExamSessions, examFindingIdentity, examSubjectDigest, HIGH_REVIEWER_MODEL, HIGH_REVIEWER_PROVIDER, type ExamExecutionIdentity} from './module-exam-sessions.ts';
import {validatePassiveTlsEvidence} from './prontidao-target.ts';
import {endRound} from './personal-artifact-hooks.ts';
import {assertPersonalActivation} from './verify-intent.ts';
import {isSecretClassBasename} from './verify-redact.ts';
import {Achado, CoverageRow, REMEDIATION_ACCEPTANCE, VerifyWorkerCall} from './verify-types.ts';
import {DEFAULT_COLLECTOR_TIMEOUT_MS, EXCERPT_LIMIT, MAX_COLLECTOR_STDOUT_BYTES, MULTILINE_CONTROL_CHAR, ModuleCollectorOutput, ModuleRawFinding, ModuleToolCoverage, type VerificationModuleRunInput, type VerificationModuleRunResult, assertModuleRepoRelativePath, assertReportOutsideRepo, assertVerificationModule, collectorMeasuredDetailFile, documentationCoverage, isErrno, isProtectedLocation, locateRepoFile, resolveInsideRepo} from './verification-modules-contracts.ts';
import {parseModuleCollectorOutput, sanitizeText, validateModuleCollectorObject} from './verification-modules-collector.ts';
import {type ModuleRetention, assertPinnedModuleImage, prepareModuleSnapshot, readPinnedModuleImage, removeModuleSnapshot, runModuleCollectorContainer} from './verification-modules-container.ts';
import {assertNoLiveAccessKey, moduleReportDirectoryName, moduleReviewPromptEvidence, requireDataDirectory, writeModuleReport} from './verification-modules-report.ts';
import {reconcileReports, recoverModuleContainers} from './verification-modules-persistence.ts';

type HighSessionAttestation = (examiner: ExamExecutionIdentity, verifier: ExamExecutionIdentity,
  subject: {file: string; line: number; finding: string}) => Promise<boolean>;

async function independentVerifier(exam: ModuleExamResult, id: string, finding: ModuleExamResult['findings'][number],
  collectorReview: ModuleExamCollectorReview, raw?: ModuleRawFinding, attestHigh?: HighSessionAttestation): Promise<Achado['verifier']> {
  const {snapshot, collector} = collectorReview;
  const {module, commit} = collector;
  if (exam.mode !== 'exame' || finding.reviewCommit !== commit || finding.status === 'provavel'
    || !finding.verifier || !finding.binding || isProtectedLocation(finding.file)) return null;
  const {binding: reviewBinding, decision, observation, proof, reviewReason, status} = finding;
  if (!reviewReason || reviewReason !== finding.reason) return null;
  const coverage = exam.coverage.find(row => row.file === finding.file && row.status === 'lido');
  const examiner = coverage?.examiner;
  const verifier = finding.verifier;
  if (!examiner || !verifier.accountId || !verifier.profileId) return null;
  const highExaminerFinding = raw === undefined && finding.source === 'examinador' && finding.severity === 'alta';
  if (highExaminerFinding) {
    // Grants and sessions in the result are claims. Publication accepts them only when the
    // ledger binds each one to a distinct completed native execution, on any account.
    if (verifier.provider !== HIGH_REVIEWER_PROVIDER || verifier.model !== HIGH_REVIEWER_MODEL
      || !distinctExamSessions(examiner, verifier) || !attestHigh
      || !await attestHigh(examiner, verifier, {file: finding.file, line: finding.line,
        finding: examFindingIdentity({id, source: finding.source, file: finding.file, line: finding.line,
          severity: finding.severity, evidence: finding.evidence, hypothesis: finding.hypothesis})})) {
      return null;
    }
  } else if (examiner.provider === verifier.provider || examiner.accountId === verifier.accountId || examiner.profileId === verifier.profileId) {
    return null;
  }
  if (finding.examiner && (finding.examiner.profileId !== examiner.profileId || finding.examiner.accountId !== examiner.accountId ||
      finding.examiner.provider !== examiner.provider)) return null;
  const located = await locateRepoFile(snapshot, finding.file);
  if (!located) return null;
  const {code} = await readModuleExamFile(located, finding.file);
  if (code === null) return null;
  const binding = moduleExamReadBinding(coverage, collector, finding.file, code);
  const evidence = binding ? moduleExamReviewEvidence(module, finding, code, raw, raw ? collectorReview : undefined, binding) : null;
  if (!evidence || !hasModuleReviewProof(evidence, {binding: reviewBinding, decision, observation, proof, reason: reviewReason, status})) return null;
  return {provider: verifier.provider, model: verifier.model};
}

async function readBoundedExcerpt(repo: string, relativeFile: string, line: number): Promise<string> {
  const located = await locateRepoFile(repo, relativeFile);
  if (!located || isSecretClassBasename(relativeFile) || isProtectedLocation(relativeFile)) return '';
  const handle = await open(located, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (info.size > 1024 * 1024) return '';
    const lines = (await handle.readFile({encoding: 'utf8'})).split('\n');
    const target = lines[line - 1];
    if (target === undefined || target.length > EXCERPT_LIMIT / 2 || MULTILINE_CONTROL_CHAR.test(target)) return '';
    const selected = sanitizeText(target).trim();
    return selected === target.trim() && /[\p{L}\p{N}]/u.test(selected) ? selected : '';
  } finally {
    await handle.close();
  }
}

async function confirmFindingWithReviewer(
  input: VerificationModuleRunInput,
  intentId: string,
  finding: ModuleRawFinding,
): Promise<{status: 'confirmado' | 'provavel' | 'descartado'; title?: string; proof: string; verifier: Achado['verifier']}> {
  const pending = {status: 'provavel' as const, proof: sanitizeText(finding.evidence), verifier: null};
  const excerpt = await readBoundedExcerpt(input.repoPath, finding.file, finding.line);
  if (!excerpt) return pending;
  const evidence = moduleReviewPromptEvidence({...finding, module: input.module, codeExcerpt: excerpt});
  const capacity = new Capacity(input.ledger);
  let seat;
  try {
    seat = await reserveSpecialistExamSeat({
      capacity,
      ledger: input.ledger,
      principal: input.principal,
      authority: input.authority,
      intentId,
      purpose: 'reviewer',
      ...(input.allowedAccountIds ? {allowedAccounts: input.allowedAccountIds} : {}),
      capacityWait: {enabled: true, ...(input.signal ? {signal: input.signal} : {})},
      releaseGrant: grantId => capacity.transition(input.principal, grantId, input.authority, 'released', {processId: 'module-confirm', state: 'not_started'}),
    });
  } catch (error) {
    if (error instanceof Refusal && ['CAPACITY_NOT_CONFIGURED', 'CAPACITY_POLICY_REQUIRED', 'DESIGN_REVIEWER_UNAVAILABLE',
      'NO_ELIGIBLE_CAPACITY', 'ROLE_NOT_CONFIGURED', 'PROVIDER_USAGE_LIMIT', 'CAPACITY_BUSY', 'CAPACITY_QUEUED'].includes(error.code)) return pending;
    throw error;
  }
  try {
    const call = VerifyWorkerCall.parse({
      role: 'reviewer',
      provider: seat.provider,
      accountId: seat.accountId,
      profileId: seat.profileId,
      model: seat.model,
      grantId: seat.grantId,
      intentId,
      task: moduleReviewTask(evidence),
      repo: input.repoPath,
      writePaths: [],
    });
    const output = await input.worker!.run(call);
    const confirm = parseModuleReviewOutput(output);
    if (!confirm || confirm.status === 'provavel' || !hasModuleReviewProof(evidence, confirm)) return pending;
    return {
      status: confirm.status,
      title: confirm.status === 'confirmado' ? moduleReviewObservationTitle(confirm.observation) : undefined,
      proof: localizedProof(evidence.code, confirm.reason),
      verifier: {model: call.model, provider: call.provider},
    };
  } finally {
    await capacity.transition(input.principal, seat.grantId, input.authority, 'released', {processId: 'module-confirm', state: 'not_started'}).catch(containFailure('MODULE_EXAM_GRANT_NOT_RELEASED', undefined));
  }
}

function localizedProof(code: string, reason: string): string {
  return sanitizeText(`${code}\n${reason}`).slice(0, 2000).trim();
}

async function beginModuleRunTx(input: {
  ledger: Ledger;
  principal: string;
  authority: Authority;
  projectId: string;
  module: VerificationModule;
  commit: string;
  runId: string;
  repoPath: string;
  preparedDir: string;
  image: string | undefined;
}): Promise<string> {
  const intentId = randomUUID();
  await input.ledger.tx(async c => {
    const context = await input.ledger.authorize(c, input.principal, input.authority.contextId);
    await input.ledger.fence(c, input.authority);
    if (context.project_id !== input.projectId) throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    const repoRow = (await c.query<{repo: string}>(
      'SELECT repo FROM ac_project_repositories WHERE project_id=$1 FOR SHARE', [input.projectId],
    )).rows[0];
    if (!repoRow || await realpath(repoRow.repo) !== await realpath(input.repoPath)) {
      throw new Refusal('PROJECT_SCOPE_MISMATCH', 403);
    }
    const examBinding = await c.query<{module: string}>(
      'SELECT module FROM ac_exam_contexts WHERE project_id=$1 AND context_id=$2',
      [input.projectId, input.authority.contextId],
    );
    if (!examBinding.rowCount || examBinding.rows[0]?.module !== input.module) {
      throw new Refusal('EXAM_CONTEXT_MISMATCH', 403);
    }
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.projectId, input.module]);
    const alreadyRunning = await c.query(
      "SELECT 1 FROM ac_verify_runs WHERE project_id=$1 AND module=$2 AND status='running' LIMIT 1",
      [input.projectId, input.module],
    );
    if (alreadyRunning.rowCount) throw new Refusal('VERIFY_ALREADY_RUNNING', 409);
    const command = {
      schemaVersion: 1 as const,
      intentId,
      deliveryAttemptId: randomUUID(),
      contextId: input.authority.contextId,
      policyRevision: Number(context.policy_revision),
      action: 'plan.start' as const,
      payload: {
        workflow: 'security-verify-readonly-v1' as const,
        messageRef: `${input.module}:${input.projectId}:${input.commit}`.slice(0, 200),
        projectId: input.projectId,
        commit: input.commit,
      },
    };
    await c.query(
      `INSERT INTO ac_intents (id, context_id, principal_id, digest, command, operation_id, run_id, manager_epoch, plan_revision)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,
      [
        intentId,
        input.authority.contextId,
        input.principal,
        digest(command),
        JSON.stringify(command),
        randomUUID(),
        randomUUID(),
        input.authority.epoch,
        Number(context.plan_revision),
      ],
    );
    await c.query(
      `INSERT INTO ac_verify_runs (id, project_id, context_id, intent_id, principal_id, commit_id, status, report_dir, module, report_prepared_dir, collector_image)
       VALUES ($1,$2,$3,$4,$5,$6,'running','pending',$7,$8,$9)`,
      [input.runId, input.projectId, input.authority.contextId, intentId, input.principal, input.commit, input.module, input.preparedDir, input.image ?? null],
    );
  });
  return intentId;
}

export async function validateModuleCollectorPublication(snapshot: string, collector: ModuleCollectorOutput): Promise<void> {
  for (const finding of collector.findings) {
    await resolveInsideRepo(snapshot, finding.file);
    if (!collector.coverage.some(row => row.tool === finding.tool && row.status === 'ok'
      && (row.files === undefined || row.files.includes(finding.file)))) {
      throw new Refusal('VERIFY_COLLECTOR_INVALID', 400);
    }
  }
  for (const row of collector.coverage) {
    for (const file of row.files ?? []) await resolveInsideRepo(snapshot, file);
  }
}

/**
 * Full execution path for verification modules 2 to 9 (`qa`, `arquitetura`, `dependencias`,
 * `banco`, `prontidao`, `desempenho`, `documentacao`, `conformidade`).
 */
export async function runVerificationModule(input: VerificationModuleRunInput): Promise<VerificationModuleRunResult> {
  assertVerificationModule(input.module);
  if (!Id.safeParse(input.projectId).success) throw new Refusal('NOT_FOUND', 404);
  if (typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)) {
    throw new Refusal('VERIFY_COMMIT_INVALID', 400);
  }
  await assertPersonalActivation(input.ledger);
  await assertReportOutsideRepo(input.repoPath, input.dataDirectory);
  const execute = input.executeCollectorProcess ?? runBoundedCollectorProcess;
  await recoverModuleContainers(input.ledger, input.principal, input.authority, input.projectId, execute, input.module, input.dataDirectory);
  await reconcileReports(input.ledger, input.principal, input.authority, input.dataDirectory, input.projectId);
  const parsedRunId = Id.safeParse(input.runId ?? randomUUID());
  if (!parsedRunId.success) throw new Refusal('INVALID_CONTRACT', 400);
  const runId = parsedRunId.data.toLowerCase();
  // The run is the round of its temporaries. The round is closed only where this function proves the run ended.
  const retention: ModuleRetention = {dataDirectory: input.dataDirectory, projectId: input.projectId, roundId: runId};
  const createdAt = input.createdAt ?? new Date();
  await assertDiskSpaceForLaunch(launchVolumesOf(input.ledger, input.dataDirectory));
  const preparedDir = join(await requireDataDirectory(input.dataDirectory), 'verificacoes', input.projectId,
    moduleReportDirectoryName(createdAt, runId, input.module));
  const timeoutMs = input.timeoutMs ?? DEFAULT_COLLECTOR_TIMEOUT_MS;
  const maxStdoutBytes = input.maxStdoutBytes ?? MAX_COLLECTOR_STDOUT_BYTES;
  const needImage = input.collectorOutput === undefined && input.runCollector === undefined;
  const {image,intentId}=await withInstallationImageLock(input.dataDirectory,true,async()=>{
    const image = input.image !== undefined
      ? assertPinnedModuleImage(input.image)
      : needImage
        ? await readPinnedModuleImage(input.module, input.rootDir)
        : undefined;

    const intentId = await beginModuleRunTx({
      ledger: input.ledger,
      principal: input.principal,
      authority: input.authority,
      projectId: input.projectId,
      module: input.module,
      commit: input.commit,
      runId,
      repoPath: input.repoPath,
      preparedDir,
      image,
    });
    return {image,intentId};
  });

  let snapshot: string | undefined;
  let sourceCoverage: ModuleToolCoverage[] | undefined;
  try {
    if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
    snapshot = await prepareModuleSnapshot(input.repoPath, input.commit, retention);
    const passiveTlsEvidence = input.passiveTlsEvidence !== undefined
      ? (() => {
          if (input.module !== 'prontidao') throw new Refusal('INVALID_CONTRACT', 400);
          return validatePassiveTlsEvidence(input.passiveTlsEvidence);
        })()
      : undefined;
    let previousPerformanceRunId: string | undefined;
    let performanceMeasurement: Record<string, unknown> | undefined;
    let collectorCode = 0;
    let collectorData: ModuleCollectorOutput;
    try {
    if (input.collectorOutput !== undefined) {
      collectorData = typeof input.collectorOutput === 'string' || Buffer.isBuffer(input.collectorOutput)
        ? parseModuleCollectorOutput(input.collectorOutput, {maxStdoutBytes, module: input.module})
        : validateModuleCollectorObject(input.collectorOutput, input.module);
    } else if (input.runCollector !== undefined) {
      const raw = await input.runCollector({
        module: input.module,
        image,
        repoPath: input.repoPath,
        commit: input.commit,
        timeoutMs,
        maxStdoutBytes,
        signal: input.signal,
        ...(passiveTlsEvidence !== undefined ? {passiveTlsEvidence} : {}),
      });
      collectorData = typeof raw === 'string' || Buffer.isBuffer(raw)
        ? parseModuleCollectorOutput(raw, {maxStdoutBytes, module: input.module})
        : validateModuleCollectorObject(raw, input.module);
    } else if (input.module === 'desempenho') {
      const {runPerformanceModule, reconcilePerformanceResources} = await import('../deploy/modules/desempenho/orchestrator.mjs');
      const recoveryDirectory = join(await requireDataDirectory(input.dataDirectory), 'performance-docker');
      await reconcilePerformanceResources({recoveryDirectory, signal: input.signal});
      const {coverage, findings, measurement, comparedExamId} = await runPerformanceModule({
        snapshotPath: snapshot, imageDigest: image!, signal: input.signal, timeoutMs, maxStdoutBytes,
        recoveryDirectory, previousMeasurements: signal => previousPerformanceMeasurements(input, runId, image!, signal),
      });
      collectorData = validateModuleCollectorObject({coverage, findings}, input.module);
      assertNoLiveAccessKey(measurement);
      performanceMeasurement = measurement;
      previousPerformanceRunId = comparedExamId;
    } else {
      const executed = await runModuleCollectorContainer({
        image: image!,
        module: input.module,
        repoPath: input.repoPath,
        commit: input.commit,
        timeoutMs,
        maxStdoutBytes,
        signal: input.signal,
        executeProcess: execute,
        journal: moduleContainerJournal(input.ledger, input.principal, input.authority, runId, execute),
        retention,
        ...(passiveTlsEvidence !== undefined ? {passiveTlsEvidence} : {}),
      });
      collectorCode = executed.code;
      collectorData = executed.output;
    }
    if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
    if (input.module === 'documentacao') {
      sourceCoverage = collectorData.coverage;
      collectorData = {...collectorData, coverage: documentationCoverage(sourceCoverage).coverage};
    } else if (collectorData.coverage.some(row => row.tool.endsWith(':artefato'))) {
      throw new Refusal('VERIFY_REPORT_INVALID', 400);
    }
    assertNoLiveAccessKey(collectorData);
    await validateModuleCollectorPublication(snapshot, collectorData);
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Refusal && error.code === 'VERIFY_CONTAINER_CLEANUP_PENDING')) throw error;
      sourceCoverage = undefined;
      performanceMeasurement = undefined;
      previousPerformanceRunId = undefined;
      const reason = error instanceof Refusal ? error.code
        : input.module === 'desempenho' && isErrno(error, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') ? 'VERIFY_STDOUT_LIMIT'
          : 'VERIFY_TOOLS_FAILED';
      collectorCode = 1;
      const detail = reason === 'VERIFY_MODULE_IMAGE_MISSING'
        ? 'Imagem fixada do módulo ausente no Docker local (VERIFY_MODULE_IMAGE_MISSING).'
        : `Falha de processo ou leitura da saída: ${reason}`;
      collectorData = {coverage: [{tool: 'coletor', version: 'indisponível', status: 'failed', detail}], findings: []};
    }
    if (collectorCode !== 0 && !collectorData.coverage.some(row => row.status === 'failed')) {
      const failure: ModuleToolCoverage = {tool: 'coletor', version: 'indisponível', status: 'failed', detail: `Processo terminou com código ${collectorCode}.`};
      collectorData.coverage.push(failure);
      sourceCoverage?.push(failure);
    }

    const collector = {module: input.module, intentId, snapshot, commit: input.commit, exitCode: collectorCode,
      coverage: sourceCoverage ?? collectorData.coverage, findings: collectorData.findings};
    const exam = await input.examinar?.({intentId, snapshot, module: input.module,
      findings: structuredClone(collectorData.findings), collector: structuredClone(collector), signal: input.signal});
    if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
    if (exam && (exam.findings.length < collectorData.findings.length || exam.findings.length > 999)) {
      throw new Refusal('MODULE_EXAM_FINDINGS_INVALID', 400);
    }
    // Rebuild the source inventory from the host snapshot for graph proofs.
    // A reviewer response never supplies the file map or the collector records.
    const needsGraph = input.module === 'arquitetura' && exam?.mode === 'exame' &&
      exam.findings.some(finding => finding.status !== 'provavel');
    const relatedSources = needsGraph ? new Map((await mapModuleSnapshot(snapshot, input.signal)).files
      .map(file => [file.file, file.code] as const)) : undefined;
    const coverage = new Map(exam?.coverage.map(row => [row.file, row] as const));
    const collectorReview = {collector, intentId, snapshot, relatedSources, coverage};
    // Each job must be the one the host launched for this finding's file, so the subjects
    // come from the host's own run, never from the result.
    const attestHigh: HighSessionAttestation = (examiner, verifier, {file, line, finding}) => attestDistinctExamSessions(input.ledger.pool, {
      contextId: input.authority.contextId, examiner, examinerIntentId: intentId, reviewer: verifier, reviewerIntentId: intentId,
      examinerSubject: examSubjectDigest({purpose: 'examiner', module: input.module, intentId, commit: input.commit, file}),
      reviewerSubject: examSubjectDigest({purpose: 'reviewer', module: input.module, intentId, commit: input.commit, file, line, finding}),
    });
    const achados: Achado[] = [];
    for (const finding of collectorData.findings) {
      const achadoId = `ACH-${String(achados.length + 1).padStart(3, '0')}`;
      let title = sanitizeText(`${finding.rule}: ${finding.message}`).slice(0, 200) || finding.rule;
      const toolRule = `${finding.tool}:${finding.rule}`;
      const reference = (isPublicModuleRule(input.module, finding.tool, finding.rule) ? toolRule : sanitizeText(toolRule)).slice(0, 200);
      let status: 'confirmado' | 'provavel' | 'descartado' = 'provavel';
      let proof = sanitizeText(finding.evidence).slice(0, 2000);
      let verifier: Achado['verifier'] = null;
      const audited = exam?.findings[achados.length];
      if (audited) {
        const origin = moduleCollectorCandidate(finding);
        if (audited.file !== origin.file || audited.line !== origin.line || audited.source !== origin.source ||
          audited.evidence !== origin.evidence || audited.title !== origin.title || audited.severity !== origin.severity) {
          throw new Refusal('MODULE_EXAM_FINDINGS_INVALID', 400);
        }
        verifier = await independentVerifier(exam!, achadoId, audited, collectorReview, finding, attestHigh);
        status = verifier ? audited.status : 'provavel';
        if (verifier) {
          proof = localizedProof(audited.proof, audited.reason);
          if (status === 'confirmado') title = moduleReviewObservationTitle(audited.observation) ?? title;
        }
      } else if (input.worker && !(input.module === 'prontidao' && isProtectedLocation(finding.file))) {
        const confirmed = await confirmFindingWithReviewer({...input, repoPath: snapshot}, intentId, finding);
        status = confirmed.status;
        title = confirmed.title ?? title;
        proof = confirmed.proof;
        verifier = confirmed.verifier;
      }
      achados.push(Achado.parse({
        id: achadoId,
        title,
        severity: finding.severity,
        status,
        verifier,
        reference,
        where: {file: finding.file, line: finding.line},
        scenario: sanitizeText(finding.message).slice(0, 2000),
        proof,
        suggestion: isProtectedLocation(finding.file) && input.module === 'prontidao'
          ? 'O responsável deve tratar manualmente o arquivo protegido e executar novamente o módulo.'
          : 'Corrigir o ponto indicado no arquivo, adicionar teste de regressão e executar novamente o módulo.',
        acceptance: REMEDIATION_ACCEPTANCE,
        sources: [finding.tool.slice(0, 200), finding.rule.slice(0, 200)],
        secretPreview: null,
      }));
    }

    for (const judged of exam?.findings.slice(collectorData.findings.length) ?? []) {
      if (judged.source !== 'examinador' || isProtectedLocation(judged.file) ||
        !exam?.coverage.some(row => row.file === judged.file && row.status === 'lido' && row.examiner)) {
        throw new Refusal('MODULE_EXAM_FINDINGS_INVALID', 400);
      }
      await resolveInsideRepo(snapshot, judged.file);
      const judgedId = `ACH-${String(achados.length + 1).padStart(3, '0')}`;
      const verifier = await independentVerifier(exam!, judgedId, judged, collectorReview, undefined, attestHigh);
      achados.push(Achado.parse({
        id: judgedId, title: sanitizeText(judged.title), severity: judged.severity,
        status: verifier ? judged.status : 'provavel', verifier,
        reference: 'exame-de-arquivo', where: {file: judged.file, line: judged.line}, scenario: sanitizeText(judged.evidence),
        proof: verifier ? localizedProof(judged.proof, judged.reason) : '', suggestion: 'Revisar o trecho indicado e verificar a correção.',
        acceptance: REMEDIATION_ACCEPTANCE, sources: ['examinador', 'exame-de-arquivo'], secretPreview: null,
      }));
    }
    const measured = new Map<string, ModuleToolCoverage[]>();
    for (const row of collectorData.coverage.filter(row => row.status === 'ok')) {
      const files = new Set([...(row.files ?? []), ...collectorData.findings.filter(f => f.tool === row.tool).map(f => f.file)]);
      const detailFile = collectorMeasuredDetailFile(row);
      if (detailFile) {
        // A text field is not trusted as a filesystem path until resolved in the snapshot.
        try { await resolveInsideRepo(snapshot, detailFile); files.add(detailFile); } catch { /* no positive file evidence */ }
      }
      for (const file of files) measured.set(file, [...(measured.get(file) ?? []), row]);
    }
    const fileCoverage: CoverageRow[] = [...measured.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, rows]) =>
      CoverageRow.parse({
        file,
        examinerProvider: 'ferramenta',
        examinerModel: `${rows[0]!.tool}@${rows[0]!.version}`.slice(0, 100),
        profileId: null,
        checklist: [...new Set(rows.map(row => row.tool.slice(0, 80)))].slice(0, 80),
      }),
    );

    // The examiner's native execution per file, kept so a recheck can prove a distinct session.
    const examinerExecutions = new Map<string, {grantId: string; sessionId: string}>();
    if (exam) {
      const byFile = new Map(fileCoverage.map(row => [row.file, row]));
      for (const row of exam.coverage) {
        if (row.status !== 'lido' || !row.examiner) continue;
        await resolveInsideRepo(snapshot, assertModuleRepoRelativePath(row.file));
        const {grantId, sessionId} = row.examiner;
        if (grantId && sessionId && Id.safeParse(grantId).success && Id.safeParse(sessionId).success) {
          examinerExecutions.set(row.file, {grantId, sessionId});
        }
        byFile.set(row.file, CoverageRow.parse({file: row.file, examinerProvider: row.examiner.provider,
          examinerModel: row.examiner.model, profileId: row.examiner.profileId, checklist: row.checklist}));
      }
      fileCoverage.length = 0;
      for (const row of byFile.values()) fileCoverage.push(row);
    }
    const hasToolFailure = collectorCode !== 0 || collectorData.coverage.some(row => row.status === 'failed');
    const notes: string[] = [...(input.notes ?? [])];
    if (exam) notes.push(...exam.notes);
    else notes.push('Cobertura por arquivo limitada aos arquivos informados pelos coletores ou com achados; ausência de registro não comprova exame. O snapshot é gerado por git archive.');
    for (const failed of collectorData.coverage.filter(row => row.status === 'failed')) {
      notes.push(`Falha em ${failed.tool} (${failed.version}): ${failed.detail}`);
    }
    if (collectorCode !== 0 && !collectorData.coverage.some(row => row.status === 'failed')) {
      notes.push(`O coletor saiu com código ${collectorCode}.`);
    }
    const finalState: 'done' | 'failed' = hasToolFailure ? 'failed' : 'done';
    const report = await input.ledger.tx(async c => {
      await input.ledger.authorize(c, input.principal, input.authority.contextId);
      await input.ledger.fence(c, input.authority);
      const active = await c.query(
        "SELECT 1 FROM ac_verify_runs WHERE id=$1 AND context_id=$2 AND status='running' AND report_prepared_dir=$3 FOR UPDATE",
        [runId, input.authority.contextId, preparedDir],
      );
      if (!active.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT');
      if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
      const prepared = await writeModuleReport({
        dataDirectory: input.dataDirectory,
        projectId: input.projectId,
        module: input.module,
        runId,
        createdAt,
        commit: input.commit,
        image,
        deferPublication: true,
        exam, measuredFiles: measured, previousPerformanceRunId,
        toolCoverage: sourceCoverage ?? collectorData.coverage,
        fileCoverage,
        achados,
        raw: {...collectorData, coverage: sourceCoverage ?? collectorData.coverage},
        ...(notes.length > 0 ? {note: notes.join(' ')} : {}),
      });
      if (prepared.directory !== preparedDir) throw new Refusal('VERIFY_REPORT_INTEGRITY', 409);
      if (input.signal?.aborted) throw new Refusal('EXAM_INTERRUPTED');
      for (const achado of achados) {
        await c.query(
          `INSERT INTO ac_verify_findings (run_id, achado_id, status, severity, file, line, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
          [
            runId,
            achado.id,
            achado.status,
            achado.severity,
            achado.where.file,
            achado.where.line,
            JSON.stringify({
              ...achado,
              snippet: achado.proof.slice(0, 240),
            }),
          ],
        );
      }
      for (const row of fileCoverage) {
        await c.query(
          `INSERT INTO ac_verify_coverage (run_id, file, examiner_provider, examiner_model, profile_id, checklist, provenance, collector_measurements,
             examiner_grant_id, examiner_session_id)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10)`,
          [runId, row.file, row.examinerProvider, row.examinerModel, row.profileId, JSON.stringify(row.checklist), row.profileId === null ? 'collector' : 'examiner',
            JSON.stringify((measured.get(row.file) ?? []).map(({tool, version}) => ({tool, version}))),
            row.profileId === null ? null : examinerExecutions.get(row.file)?.grantId ?? null,
            row.profileId === null ? null : examinerExecutions.get(row.file)?.sessionId ?? null],
        );
      }
      for (let index = 0; index < collectorData.coverage.length; index += 1) {
        const item = collectorData.coverage[index]!;
        await c.query(
          `INSERT INTO ac_verify_tool_coverage (run_id, seq, tool, version, status, detail)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [runId, index + 1, item.tool, item.version, item.status, item.detail],
        );
      }
      await input.ledger.fence(c, input.authority);
      const updated = await c.query(
        `UPDATE ac_verify_runs SET status=$2, report_dir=$3, finished_at=clock_timestamp(), collector_image=$5, performance_measurement=$6::jsonb
         WHERE id=$1 AND context_id=$4 AND status='running'`,
        [runId, finalState, prepared.directory, input.authority.contextId, image ?? null,
          performanceMeasurement && finalState === 'done' ? JSON.stringify({...performanceMeasurement, previousPerformanceRunId}) : null],
      );
      if (!updated.rowCount) throw new Refusal('VERIFY_RUN_CONFLICT');
      if (prepared.examOriginSha256) {
        await c.query('UPDATE ac_verify_runs SET exam_origin_sha256=$2 WHERE id=$1', [runId, prepared.examOriginSha256]);
      }
      await finishExamIntentTx(c, input.ledger, {intentId, contextId: input.authority.contextId}, finalState);
      return prepared;
    });
    await reconcileReports(input.ledger, input.principal, input.authority, input.dataDirectory, input.projectId, runId);
    // The run is committed as finished: its snapshot is removed below, and any leftover now has proof of round end.
    await endRound(retention);

    return {
      runId,
      intentId,
      module: input.module,
      directory: report.directory,
      directoryName: report.directoryName,
      achados,
      coverage: fileCoverage,
      toolCoverage: collectorData.coverage,
      hasToolFailure,
      summary: report.summary,
    };
  } catch (error) {
    let rolledBackRun = false;
    try {
      rolledBackRun = await input.ledger.tx(async c => {
        await input.ledger.authorize(c, input.principal, input.authority.contextId);
        await input.ledger.fence(c, input.authority);
        const updated = await c.query("UPDATE ac_verify_runs SET status='failed', finished_at=clock_timestamp() WHERE id=$1 AND status='running'", [runId]);
        if (updated.rowCount) await finishExamIntentTx(c, input.ledger, {intentId, contextId: input.authority.contextId}, 'failed');
        return Boolean(updated.rowCount);
      });
    } catch { /* preserve original failure */ }
    // Only a confirmed failure transition permits cleanup here. After an
    // ambiguous COMMIT recovery consults the persisted reservation and outcome.
    if (rolledBackRun) {
      await endRound(retention);
      await reconcileReports(input.ledger, input.principal, input.authority, input.dataDirectory, input.projectId)
        .catch(containFailure('MODULE_REPORT_RECONCILE_FAILED', undefined));
    }
    throw error;
  } finally {
    await clearExamContextCapacityWaits(input.ledger.pool, input.authority.contextId, intentId, input.authority.epoch);
    if (snapshot) await removeModuleSnapshot(snapshot);
  }
}

export function parseModuleReviewJson(output: string): unknown {
  try {
    return JSON.parse(output.trim().replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

function parseModuleReviewOutput(output: string) {
  return readModuleReviewVerdict(parseModuleReviewJson(output));
}
