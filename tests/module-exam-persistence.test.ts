import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {mapModuleSnapshot} from '../src/module-exam-map.ts';
import {examineFunctionalModule, type ModuleExamSeat} from '../src/module-exam.ts';
import {runVerificationModule} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

const databaseUrl = process.env.AC_TEST_DATABASE_URL;
const collectorOutput = {
  coverage: [{tool: 'fixture', version: '1', status: 'ok', detail: 'leitura local'}],
  findings: [{tool: 'fixture', rule: 'FIXTURE-01', file: 'fixture.txt', line: 1, severity: 'baixa',
    message: 'Conferir a primeira linha.', evidence: 'synthetic'}],
};

test('exame indisponível conserva a evidência do coletor sem atribuir confirmação', {skip: !databaseUrl}, async () => {
  await withModuleRecoveryFixture(databaseUrl!, async input => {
    const result = await runVerificationModule({...input, collectorOutput, async examinar(req) {
      const map = await mapModuleSnapshot(req.snapshot);
      return examineFunctionalModule({...req, repo: req.snapshot, map});
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
  await withModuleRecoveryFixture(databaseUrl!, async input => {
    const seat = (provider: string): ModuleExamSeat => ({provider, model: provider + '-fixture',
      accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()});
    const author = seat('autor');
    const reviewer = seat('revisor');
    const result = await runVerificationModule({...input, collectorOutput, async examinar(req) {
      const map = await mapModuleSnapshot(req.snapshot);
      return examineFunctionalModule({...req, repo: req.snapshot, map, async reserve(purpose) {
        return purpose === 'examiner' ? author : reviewer;
      }, async release() {}, worker: {async run(call) {
        return JSON.stringify(call.provider === 'autor'
          ? {kind: 'exame', filesRead: ['fixture.txt'], checklist: ['qa'],
            findings: [{line: 1, snippet: 'synthetic', title: 'Trecho encontrado', severity: 'baixa'}]}
          : {kind: 'confirmacao', status: 'confirmado', proof: 'Trecho sintético observado', reason: 'Linha conferida'});
      }}});
    }});
    assert.deepEqual(result.achados.map(a => [a.status, a.verifier?.provider]), [['confirmado','revisor'],['confirmado','revisor']]);
    assert.deepEqual(result.achados[1]?.sources, ['examinador', 'exame-de-arquivo']);
    const row = (await input.ledger.pool.query('select provenance,profile_id from ac_verify_coverage where run_id=$1 and file=$2', [result.runId, 'fixture.txt'])).rows[0];
    assert.equal(row.provenance, 'examiner');
    assert.equal(row.profile_id, author.profileId);
    assert.match(await readFile(join(result.directory, 'mapa.md'), 'utf8'), /fixture\.txt \| lido/);
  });
});
