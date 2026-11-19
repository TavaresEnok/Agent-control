import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {examineFunctionalModule, type ModuleExamSeat} from '../src/module-exam.ts';
import {recheckModuleFindings, runVerificationModule, type VerificationModuleRunInput} from '../src/verification-modules.ts';
import {qaStaticFinding, qaStaticTool, reviewFixtureVerdict, skipQuestion} from './fixtures/module-exam-review.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const collectorOutput = {
  coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'leitura local'}],
  findings: [{tool: 'fixture', rule: 'FIXTURE-01', file: 'fixture.txt', line: 1, severity: 'baixa',
    message: 'Conferir a primeira linha.', evidence: 'synthetic'}],
};
const testFile = 'checkout.test.ts';
const skipped = 'test.skip("calcula o total", () => {})';
const random = 'Math.random()';
const wait = 'page.waitForTimeout(250)';
const observedOutput = {
  coverage: [{tool: qaStaticTool, version: '1', status: 'ok', detail: 'leitura local'}],
  findings: [qaStaticFinding(testFile, 1, skipped + ';'), qaStaticFinding(testFile, 2, random, 'nondeterminism'),
    qaStaticFinding(testFile, 2, wait, 'nondeterminism')],
};

async function withExamFixture(run: (input: VerificationModuleRunInput) => Promise<void>) {
  await withModuleRecoveryFixture(databaseUrl!, async input => {
    await writeFile(join(input.repoPath, testFile), [skipped + ';',
      `test("calcula preço", () => ${random}); test("espera", () => ${wait});`,
      'router.get("/item/<slug>", handler);', 'router.get("/item/slug", handler);', ''].join('\n'));
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', input.repoPath, ...args], {encoding: 'utf8', stdio: 'pipe'}).trim();
    git('add', testFile);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Observações funcionais sintéticas');
    await run({...input, commit: git('rev-parse', 'HEAD')});
  });
}

test('exame indisponível conserva a evidência do coletor sem atribuir confirmação', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async input => {
    const withoutExam = await runVerificationModule({...input, collectorOutput});
    assert.equal(withoutExam.achados[0]?.status, 'provavel');
    assert.equal(withoutExam.achados[0]?.verifier, null);
    assert.match(await readFile(join(withoutExam.directory, 'cobertura.md'), 'utf8'), /fixture@1/);
    const result = await runVerificationModule({...input, collectorOutput, async examinar(req) {
      const map = await mapModuleSnapshot(req.snapshot);
      const result = await examineFunctionalModule({...req, map});
      Object.assign(result.findings[0]!, {status: 'confirmado', proof: 'synthetic',
        verifier: {provider: 'fixture', model: 'medição determinística'}});
      return result;
    }});
    assert.equal(result.achados.length, 1);
    assert.equal(result.achados[0]?.status, 'provavel');
    assert.equal(result.achados[0]?.verifier, null);
    assert.equal(result.achados[0]?.proof, 'synthetic');
    const coverage = await readFile(join(result.directory, 'cobertura.md'), 'utf8');
    assert.match(coverage, /fixture\.txt \| nao_julgado/);
    assert.match(coverage, /somente_ferramentas/);
    assert.equal((await input.ledger.pool.query('select status from ac_verify_findings where run_id=$1', [result.runId])).rows[0].status, 'provavel');
  });
});

test('grava o examinador, o verificador distinto e a origem do achado da fatia', {skip: !databaseUrl}, async () => {
  await withExamFixture(async input => {
    const seat = (provider: string): ModuleExamSeat => ({provider, model: provider + '-fixture',
      accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
    const author = seat('autor');
    const reviewer = seat('revisor');
    const result = await runVerificationModule({...input, collectorOutput: {...observedOutput, findings: observedOutput.findings.slice(0, 1)}, async examinar(req) {
      const map = await mapModuleSnapshot(req.snapshot);
      return examineFunctionalModule({...req, commit: input.commit, map, async reserve(purpose) {
        return purpose === 'examiner' ? author : reviewer;
      }, async release() {}, worker: {async run(call) {
        const task = JSON.parse(call.task);
        return JSON.stringify(call.provider === 'autor'
          ? {kind: 'exame', filesRead: [task.file], checklist: ['qa'], routesReviewed: task.routes,
            findings: task.file === testFile ? [{line: 1, snippet: skipped + ';', title: 'Trecho encontrado', severity: 'baixa',
              hypothesis: skipQuestion}] : []}
          : reviewFixtureVerdict(task, skipped));
      }}});
    }});
    assert.deepEqual(result.achados.map(a => [a.status, a.verifier?.provider]), [['confirmado','revisor'],['confirmado','revisor']]);
    assert.deepEqual(result.achados[1]?.sources, ['examinador', 'exame-de-arquivo']);
    const row = (await input.ledger.pool.query('select provenance,profile_id,collector_measurements from ac_verify_coverage where run_id=$1 and file=$2', [result.runId, testFile])).rows[0];
    assert.equal(row.provenance, 'examiner');
    assert.equal(row.profile_id, author.profileId);
    assert.deepEqual(row.collector_measurements, [{tool: qaStaticTool, version:'1'}]);
    assert.match(await readFile(join(result.directory,'cobertura.md'),'utf8'), /qa-auditoria-estatica-testes@1/);
    const originFile = join(result.directory, 'bruto', 'exame.json');
    const recorded = JSON.parse(await readFile(originFile,'utf8'));
    assert.deepEqual(recorded, [{id:'ACH-002',file:testFile,line:1,evidence:skipped + ';', hypothesis:skipQuestion}]);
    const inventory = await readFile(join(result.directory, 'mapa.md'), 'utf8');
    assert.match(inventory, /checkout\.test\.ts \| lido/);
    assert.match(inventory, /GET \| \/item\/&lt;slug&gt; \| checkout\.test\.ts#3 \| lido/);
    assert.match(inventory, /GET \| \/item\/slug \| checkout\.test\.ts#4 \| lido/);
    const recheck = (hypothesis: string) => recheckModuleFindings(input.ledger, input.principal, input.authority, {
      dataDirectory: input.dataDirectory, projectId: input.projectId, runId: result.runId, achadoIds: ['ACH-002'],
      async review(request) {
        const task = JSON.parse(request.task);
        assert.equal(task.hypothesis, hypothesis);
        assert.equal(task.evidence, skipped + ';');
        assert.equal(task.rule, 'exame-de-arquivo');
        assert.doesNotMatch(request.task, /Trecho encontrado|CONCLUSAO_DO_AUTOR/);
        return {reviewer, output: JSON.stringify(reviewFixtureVerdict(task, skipped))};
      },
    });
    assert.deepEqual((await recheck(recorded[0].hypothesis)).results, [{id: 'ACH-002', status: 'reaberto'}]);
    let collectorReviews = 0;
    const collectorOnly = () => recheckModuleFindings(input.ledger, input.principal, input.authority, {
      dataDirectory: input.dataDirectory, projectId: input.projectId, runId: result.runId, achadoIds: ['ACH-001'],
      async review() { collectorReviews++; throw new Error('Origem inválida precede a chamada ao revisor'); },
    });
    await unlink(originFile);
    await assert.rejects(recheck(recorded[0].hypothesis), /VERIFY_REPORT_INVALID/);
    await assert.rejects(collectorOnly(), /VERIFY_REPORT_INVALID/);
    await writeFile(originFile, JSON.stringify([{...recorded[0], hypothesis: 'alterada'}]));
    await assert.rejects(recheck(recorded[0].hypothesis), /VERIFY_REPORT_INVALID/);
    await assert.rejects(collectorOnly(), /VERIFY_REPORT_INVALID/);
    assert.equal(collectorReviews, 0);
    // Um run anterior à migração não tem o hash de origem.
    await input.ledger.pool.query('UPDATE ac_verify_runs SET exam_origin_sha256=NULL WHERE id=$1', [result.runId]);
    for (const entries of [[recorded[0], {...recorded[0], evidence: 'outra'}], [{...recorded[0], evidence: 'outra'}, recorded[0]]]) {
      await writeFile(originFile, JSON.stringify(entries));
      await assert.rejects(recheck(recorded[0].hypothesis), /VERIFY_REPORT_INVALID/);
    }
    const {hypothesis: _hypothesis, ...legacyOrigin} = recorded[0];
    await writeFile(originFile, JSON.stringify([legacyOrigin]));
    assert.deepEqual((await recheck(skipQuestion)).results, [{id: 'ACH-002', status: 'reaberto'}]);
    await unlink(originFile);
    assert.deepEqual((await recheck(skipQuestion)).results, [{id: 'ACH-002', status: 'reaberto'}]);
    const {rows: [legacyAudit]} = await input.ledger.pool.query(
      `SELECT detail FROM ac_audit WHERE kind='module.finding_rechecked' AND detail->>'runId'=$1
       ORDER BY id DESC LIMIT 1`, [result.runId],
    );
    assert.equal(legacyAudit.detail.source.origin, 'legacy-git');
    assert.equal(legacyAudit.detail.source.commit, input.commit);
    assert.equal(legacyAudit.detail.regressionProof, null);
  });
});

test('runner revalida o vínculo e a prova antes da publicação', {skip: !databaseUrl}, async () => {
  await withExamFixture(async input => {
    const examiner: ModuleExamSeat = {provider: 'claude', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
    const reviewer: ModuleExamSeat = {provider: 'codex', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
    const result = await runVerificationModule({...input,
      collectorOutput: observedOutput,
      async examinar(req) {
        const map = await mapModuleSnapshot(req.snapshot);
        const result = await examineFunctionalModule({...req, map,
          reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
          worker: {async run(call) {
            const task = JSON.parse(call.task);
            return JSON.stringify(task.checklist
              ? {kind: 'exame', filesRead: [task.file], checklist: ['qa'], findings: []}
              : reviewFixtureVerdict(task, task.line === 1 ? skipped : task.criterion === 'math-random-call' ? random : wait));
          }},
        });
        assert.ok(result.findings.every(finding => finding.status === 'confirmado'));
        result.findings[1]!.observation = result.findings[2]!.observation;
        result.findings[2]!.proof = wait;
        return result;
      },
    });
    assert.deepEqual(result.achados.map(finding => [finding.status, finding.verifier?.provider]),
      [['confirmado', 'codex'], ['provavel', undefined], ['provavel', undefined]]);
  });
});

test('recusa a troca de evidência entre dois candidatos da mesma regra e linha', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async input => {
    const raw = collectorOutput.findings[0]!;
    const both = {...collectorOutput, findings: [raw, {...raw, evidence: 'outra observação sintética'}]};
    await assert.rejects(runVerificationModule({...input, collectorOutput: both, async examinar(req) {
      const map = await mapModuleSnapshot(req.snapshot);
      const result = await examineFunctionalModule({...req, map});
      result.findings.reverse();
      return result;
    }}), /MODULE_EXAM_FINDINGS_INVALID/);
  });
});
