// The host disk is not what this file proves: a fixed reading keeps a server disk near 95% from refusing these flows.
import {useFixedDisk} from './fixtures/fixed-disk.ts';
useFixedDisk();
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {digest, Refusal} from '../src/contracts.ts';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {examineFunctionalModule, type ModuleExamResult, type ModuleExamSeat} from '../src/module-exam.ts';
import {moduleRunLines} from '../src/personal-module-cli.ts';
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
      "import {Router} from 'express'; const router = Router(); router.get(\"/item/<slug>\", handler);",
      'router.get("/item/slug", handler);', ''].join('\n'));
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
          ? {kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], routesReviewed: task.routes,
            findings: task.file === testFile ? [{line: 1, snippet: skipped + ';', title: 'Trecho encontrado', severity: 'baixa',
              hypothesis: skipQuestion}] : []}
          : reviewFixtureVerdict(task, skipped));
      }}});
    }});
    assert.deepEqual(result.achados.map(a => [a.status, a.verifier?.provider]), [['confirmado','revisor'],['confirmado','revisor']]);
    assert.ok(result.achados.every(a => a.title === 'Declaração de teste com modificador skip ou todo'));
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
    let examReviews = 0;
    const recheck = (hypothesis: string) => recheckModuleFindings(input.ledger, input.principal, input.authority, {
      dataDirectory: input.dataDirectory, projectId: input.projectId, runId: result.runId, achadoIds: ['ACH-002'],
      async review(request) {
        examReviews++;
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
    const generation = async () => (await input.ledger.pool.query(
      'SELECT recheck_generation::text FROM ac_verify_runs WHERE id=$1', [result.runId],
    )).rows[0].recheck_generation;
    const verdicts = async () => (await input.ledger.pool.query(
      `SELECT id, detail FROM ac_audit WHERE kind='module.finding_rechecked' AND detail->>'runId'=$1 ORDER BY id`,
      [result.runId],
    )).rows;
    const validVerdicts = await verdicts();
    assert.ok(validVerdicts.length > 0);
    const validExamReviews = examReviews;
    const validGeneration = await generation();
    await unlink(originFile);
    await assert.rejects(recheck(recorded[0].hypothesis), /VERIFY_REPORT_INVALID/);
    await assert.rejects(collectorOnly(), /VERIFY_REPORT_INVALID/);
    await writeFile(originFile, JSON.stringify([{...recorded[0], hypothesis: 'alterada'}]));
    await assert.rejects(recheck(recorded[0].hypothesis), /VERIFY_REPORT_INVALID/);
    await assert.rejects(collectorOnly(), /VERIFY_REPORT_INVALID/);
    assert.equal(await generation(), validGeneration);
    assert.deepEqual(await verdicts(), validVerdicts);
    assert.equal(examReviews, validExamReviews);
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

test('runner revalida o vínculo e a prova antes da publicação', {skip: !databaseUrl}, async t => {
  await withExamFixture(async input => {
    const examiner: ModuleExamSeat = {provider: 'claude', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
    const reviewer: ModuleExamSeat = {provider: 'codex', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
    const run = (alter: (result: ModuleExamResult, snapshotSource: string) => void, changedSource = false) => runVerificationModule({...input,
      collectorOutput: observedOutput,
      async examinar(req) {
        const map = await mapModuleSnapshot(req.snapshot);
        const file = map.files.find(row => row.file === testFile)!;
        const snapshotSource = file.code!;
        if (changedSource) file.code = snapshotSource + '\nexport const subtotal = 5;\n';
        // One review per finding: this test is about revalidating each verdict at publication.
        const result = await examineFunctionalModule({...req, commit: input.commit, map, reviewTriage: false,
          reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
          worker: {async run(call) {
            const task = JSON.parse(call.task);
            return JSON.stringify(task.checklist
              ? {kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], findings: []}
              : reviewFixtureVerdict(task, task.line === 1 ? skipped : task.criterion === 'math-random-call' ? random : wait));
          }},
        });
        assert.ok(result.findings.every(finding => finding.status === 'confirmado'));
        alter(result, snapshotSource);
        return result;
      },
    });
    const assertPublished = async (result: Awaited<ReturnType<typeof run>>, expected: string[]) => {
      assert.deepEqual(result.achados.map(finding => finding.status), expected);
      const persisted = await input.ledger.pool.query('SELECT status, payload FROM ac_verify_findings WHERE run_id=$1 ORDER BY achado_id', [result.runId]);
      assert.deepEqual(persisted.rows.map(row => [row.status, row.payload.verifier?.provider]),
        expected.map(status => [status, status === 'confirmado' ? 'codex' : undefined]));
      for (const [index, status] of expected.entries()) {
        if (status !== 'provavel') continue;
        const {rule, message, evidence} = observedOutput.findings[index]!;
        const finding = result.achados[index]!;
        assert.equal(finding.title, `${rule}: ${message}`);
        assert.equal(finding.verifier, null);
        assert.equal(finding.proof, evidence);
        assert.equal(persisted.rows[index]?.payload.proof, evidence);
      }
    };
    await t.test('publica somente o veredito com decisão e motivo compatíveis', async () => {
      const result = await run(exam => {
        exam.findings[1]!.decision = 'contradiz';
        Object.assign(exam.findings[2]!, {kind: 'confirmacao', reviewReason: 'A chamada registrada contradiz a hipótese.'});
      });
      await assertPublished(result, ['confirmado', 'provavel', 'provavel']);
    });
    await t.test('conserva a evidência original quando falta a prova do veredito', async () => {
      const result = await run(exam => {
        Reflect.deleteProperty(exam.findings[1]!, 'proof');
      });
      await assertPublished(result, ['confirmado', 'provavel', 'confirmado']);
    });
    await t.test('recusa o vínculo de outro conteúdo com digest do snapshot atual', async () => {
      const result = await run((exam, snapshotSource) => {
        const read = exam.coverage.find(row => row.file === testFile)!.read!;
        assert.notEqual(read.sourceDigest, digest(snapshotSource));
        read.sourceDigest = digest(snapshotSource);
      }, true);
      await assertPublished(result, ['provavel', 'provavel', 'provavel']);
    });
    await t.test('recusa um vínculo de leitura diferente do que foi revisado', async () => {
      const result = await run(exam => {
        const coverage = exam.coverage.find(row => row.file === testFile)!;
        coverage.read!.binding = 'b'.repeat(64);
      });
      await assertPublished(result, ['provavel', 'provavel', 'provavel']);
    });
    await t.test('conserva registros incompletos como histórico sem nova confirmação', async () => {
      const oldRead = await run(exam => {
        const read = exam.coverage.find(row => row.file === testFile)!.read!;
        delete read.requestId;
        delete read.promptDigest;
      });
      await assertPublished(oldRead, ['provavel', 'provavel', 'provavel']);
      assert.match(await readFile(join(oldRead.directory, 'mapa.md'), 'utf8'), /checkout\.test\.ts \| lido/);

      const oldVerdict = await run(exam => {
        delete exam.findings[2]!.reviewReason;
      });
      await assertPublished(oldVerdict, ['confirmado', 'confirmado', 'provavel']);
    });
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

test('a revisão em amostra da mesma regra publica cada veredito com a prova revalidada', {skip: !databaseUrl}, async () => {
  await withExamFixture(async input => {
    const examiner: ModuleExamSeat = {provider: 'claude', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
    const reviewer: ModuleExamSeat = {provider: 'codex', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
    const calls: any[] = [];
    const result = await runVerificationModule({...input, collectorOutput: observedOutput, async examinar(req) {
      const map = await mapModuleSnapshot(req.snapshot);
      return examineFunctionalModule({...req, commit: input.commit, map,
        reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
        worker: {async run(call) {
          const task = JSON.parse(call.task);
          calls.push(task);
          if (task.checklist) return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], findings: []});
          const verdict = (item: any) => reviewFixtureVerdict(item, item.line === 1 ? skipped : item.criterion === 'math-random-call' ? random : wait);
          return JSON.stringify(task.items ? {kind: 'confirmacao-lote', results: task.items.map(verdict)} : verdict(task));
        }}});
    }});
    // The two findings of the nondeterminism rule share one reviewer call.
    assert.deepEqual(calls.filter(task => !task.checklist).map(task => task.items?.length ?? 1), [1, 2]);
    assert.deepEqual(result.achados.map(a => [a.status, a.verifier?.provider]), [['confirmado', 'codex'], ['confirmado', 'codex'], ['confirmado', 'codex']]);
    assert.equal((await input.ledger.pool.query('SELECT status FROM ac_verify_runs WHERE id=$1', [result.runId])).rows[0].status, 'done');
    assert.equal(result.examIncomplete, null);
    assert.equal(result.unreviewed, null);
  });
});

test('exame que para por login vencido falha a execução, grava o relatório parcial e conta os achados sem revisão', {skip: !databaseUrl}, async () => {
  await withExamFixture(async input => {
    const examiner: ModuleExamSeat = {provider: 'claude', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
    const result = await runVerificationModule({...input, collectorOutput: observedOutput, async examinar(req) {
      const map = await mapModuleSnapshot(req.snapshot);
      return examineFunctionalModule({...req, commit: input.commit, map, reserve: async () => examiner, release: async () => {},
        worker: {async run() { throw new Refusal('EXAM_LOGIN_STALE'); }}});
    }});
    const run = (await input.ledger.pool.query('SELECT r.status, i.state FROM ac_verify_runs r JOIN ac_intents i ON i.id=r.intent_id WHERE r.id=$1', [result.runId])).rows[0];
    assert.deepEqual([run.status, run.state], ['failed', 'failed']);
    assert.equal(result.examIncomplete?.code, 'EXAM_LOGIN_STALE');
    assert.ok(result.examIncomplete!.unjudged > 0);
    assert.equal(result.examIncomplete!.total, result.examIncomplete!.unjudged);
    assert.deepEqual(result.unreviewed, {count: 3, codes: ['EXAM_LOGIN_STALE']});
    assert.match(moduleRunLines(result).at(-1)!, /^Achados sem revisão: 3 \(código EXAM_LOGIN_STALE\)$/);
    const coverage = await readFile(join(result.directory, 'cobertura.md'), 'utf8');
    assert.match(coverage, /Modo: somente_ferramentas/);
    assert.match(coverage, /Login da conta Claude da instalação vencido/);
    // A run without model exam (remeasurement, tools only) keeps finishing as done.
    const measured = await runVerificationModule({...input, collectorOutput: observedOutput});
    assert.equal((await input.ledger.pool.query('SELECT status FROM ac_verify_runs WHERE id=$1', [measured.runId])).rows[0].status, 'done');
    assert.equal(measured.examIncomplete, null);
  });
});

test('arquivo sem julgamento por falha pontual mantém a execução done e a medição, e a CLI recebe o exame incompleto', {skip: !databaseUrl}, async () => {
  await withExamFixture(async input => {
    const examiner: ModuleExamSeat = {provider: 'claude', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
    const result = await runVerificationModule({...input, collectorOutput: observedOutput, async examinar(req) {
      const map = await mapModuleSnapshot(req.snapshot);
      return examineFunctionalModule({...req, commit: input.commit, map, reviewCap: 0, reserve: async () => examiner, release: async () => {},
        worker: {async run(call) {
          const task = JSON.parse(call.task);
          // One file gets an answer that does not parse; the others are examined.
          if (task.file === testFile) return 'sem json';
          return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['qa'], routesReviewed: [], findings: []});
        }}});
    }});
    assert.equal((await input.ledger.pool.query('SELECT status FROM ac_verify_runs WHERE id=$1', [result.runId])).rows[0].status, 'done');
    assert.deepEqual(result.examIncomplete && [result.examIncomplete.code, result.examIncomplete.unjudged], ['MODULE_EXAM_RESPONSE_INVALID', 1]);
    assert.ok(result.examIncomplete!.total >= result.examIncomplete!.unjudged);
  });
});
