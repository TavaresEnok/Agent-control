import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {examineFunctionalModule, type ModuleExamSeat} from '../src/module-exam.ts';
import {runVerificationModule, type ModuleRawFinding, type ModuleToolCoverage} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

test('a medição real de pg_stat_statements só confirma os bytes da consulta executada', {
  skip: process.env.AC_MODULE_LAB !== '1' || !process.env.AC_TEST_DATABASE_URL, timeout: 150_000,
}, async () => {
  const image = (await readFile(new URL('../deploy/modules/banco/digest.txt', import.meta.url), 'utf8')).trim();
  await withModuleRecoveryFixture(process.env.AC_TEST_DATABASE_URL!, async base => {
    await cp(new URL('./fixtures/module-banco/defective/', import.meta.url), base.repoPath, {recursive: true});
    const git = (...args: string[]) => execFileSync('git', ['-C', base.repoPath, ...args], {encoding: 'utf8'}).trim();
    const commitSnapshot = () => {
      git('add', '.');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Consulta de laboratório');
      return git('rev-parse', 'HEAD');
    };
    const target = 'banco/queries/latency.sql';
    const {contextId} = await base.ledger.ensureExamContext(base.principal, base.projectId, 'banco');
    const authority = await base.ledger.acquire(base.principal, contextId, randomUUID(), 'fixture-banco', 60);
    const seat = (provider: string): ModuleExamSeat => ({provider, model: 'sintetico', accountId: randomUUID(),
      profileId: randomUUID(), grantId: randomUUID()});
    const examiner = seat('examinador-local'), reviewer = seat('revisor-local');
    type Output = {coverage: ModuleToolCoverage[]; findings: ModuleRawFinding[]};
    let measured: Output | undefined;
    const run = (commit: string, collectorOutput?: Output) => runVerificationModule({...base, authority, module: 'banco',
      image, commit, collectorOutput, async examinar(request) {
        const collected = request.collector!;
        measured = {coverage: [...collected.coverage], findings: [...collected.findings]};
        const slow = collected.findings.find(row => row.file === target && row.rule === 'BANCO-CONSULTA-LENTA');
        assert.ok(slow);
        const metrics = /^queryid=(-?\d+); amostras=(\d+); média=(\d+\.\d{3}) ms;/u.exec(slow.evidence);
        assert.ok(metrics);
        const [, queryId, samples, mean] = metrics;
        const map = await mapModuleSnapshot(request.snapshot);
        return examineFunctionalModule({...request, map, commit,
          collectorReview: {collector: collected, intentId: request.intentId, snapshot: request.snapshot},
          reserve: async purpose => purpose === 'examiner' ? examiner : reviewer, release: async () => {},
          worker: {run: async call => {
            const task = JSON.parse(call.task);
            if (task.checklist) return JSON.stringify({kind: 'exame', binding: task.binding, filesRead: [task.file], checklist: ['banco'], findings: []});
            if (task.criterion !== 'sql-query-mean-exceeded' || task.file !== target) {
              return JSON.stringify({kind: 'confirmacao', status: 'provavel', proof: '', reason: 'Sem avaliação neste ensaio.'});
            }
            const expression = 'SELECT pg_sleep(0.14);';
            return JSON.stringify({kind: 'confirmacao', status: 'confirmado', decision: 'sustenta', binding: task.binding,
              proof: task.code, reason: `O SELECT localizado teve média de ${mean} ms em ${samples} amostras da consulta ${queryId}. O limiar foi de 100 ms.`,
              observation: {criterion: task.criterion, file: task.file, line: task.line, tool: task.tool, rule: task.rule,
                commit, expression, column: 1, facts: [queryId, samples, mean, '100']}});
          }},
        });
      }});
    const result = await run(commitSnapshot());
    const atQuery = result.achados.filter(row => row.where.file === target && row.where.line === 2);
    assert.equal(atQuery.length, 1);
    const finding = atQuery[0]!;
    assert.equal(finding?.status, 'confirmado');
    assert.equal(finding.verifier?.provider, reviewer.provider);
    const saved = await base.ledger.pool.query('SELECT status FROM ac_verify_findings WHERE run_id=$1 AND achado_id=$2',
      [result.runId, finding.id]);
    assert.equal(saved.rows[0]?.status, 'confirmado');
    assert.ok(measured);
    await writeFile(join(base.repoPath, target), '-- Consulta alterada\nSELECT 1;\n');
    const changed = await run(commitSnapshot(), measured);
    const rejected = changed.achados.find(row => row.where.file === target && row.where.line === 2);
    assert.equal(rejected?.status, 'provavel');
    assert.equal(rejected.verifier, null);
  });
});
