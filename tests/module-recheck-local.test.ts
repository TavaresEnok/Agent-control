import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {digest, Refusal} from '../src/contracts.ts';
import {VERIFICATION_MODULES, type VerificationModule} from '../src/ledger.ts';
import {parsePersonalModuleArgs, runPersonalModuleCli} from '../src/personal-module-cli.ts';
import {runPersonalQaCli} from '../src/personal-qa-cli.ts';
import {
  readModuleReport, recheckModuleFindings, runVerificationModule, type ModuleCollectorOutput, type ModuleRawFinding,
  type ModuleRecheckReview, type ModuleToolCoverage,
} from '../src/verification-modules.ts';
import {withModuleRecoveryFixture} from './fixtures/module-recovery.ts';

const base = process.env.AC_TEST_DATABASE_URL;
const image = `sha256:${'a'.repeat(64)}`;
const otherImage = `sha256:${'b'.repeat(64)}`;
const toolRow = (tool: string, detail = 'medição local', status: ModuleToolCoverage['status'] = 'ok'): ModuleToolCoverage =>
  ({tool, version: '1', status, detail});
const lock = (license: string, version = '1.0.0') =>
  JSON.stringify({lockfileVersion: 3, packages: {'node_modules/sample': {version, license}}}, null, 2) + '\n';

type Case = {
  module: Exclude<VerificationModule, 'qa'>; file: string; tool: string; rule: string; line: number; message?: string;
  evidence: string; before: string; after: string; object: string; desired: string; replaced: string;
  scopeTool: string; originalRecord: string; correctedRecord: string;
};

const cases: Case[] = [
  {
    module: 'arquitetura', file: 'value.ts', tool: 'knip', rule: 'KNIP-UNUSED-FILE', line: 1, evidence: 'knip files: value.ts',
    before: 'export function value() { return 10; }\n', after: 'export function value() { return 10; }\n',
    object: 'value', desired: 'modulo', replaced: 'export function other() { return 10; }\n',
    scopeTool: 'knip:file', originalRecord: 'arquivo=value.ts; papel=nao_alcancado; problemas=1',
    correctedRecord: 'arquivo=value.ts; papel=modulo; problemas=0',
  },
  {
    module: 'dependencias', file: 'routes.ts', tool: 'ast-grep', rule: 'ASTGREP-EXPRESS5-APP-DEL', line: 1,
    evidence: "Revisão necessária: app.del('/catalog', handler)", before: "app.del('/catalog', handler);\n",
    after: "app.delete('/catalog', handler);\n", object: 'app /catalog', desired: 'delete', replaced: "app.delete('/inventory', handler);\n",
    scopeTool: 'ast-grep', originalRecord: 'arquivo=routes.ts; achados=1', correctedRecord: 'arquivo=routes.ts; achados=0',
  },
  {
    module: 'banco', file: 'db/migrations/001_items.sql', tool: 'squawk', rule: 'SQUAWK-BAN-DROP-COLUMN', line: 1,
    evidence: 'Regra ban-drop-column; coluna 1; migração analisada em modo transacional.',
    before: 'ALTER TABLE items DROP COLUMN label;', after: 'ALTER TABLE items RENAME COLUMN label TO label_old;',
    object: 'items.label', desired: 'rename', replaced: 'ALTER TABLE stock RENAME COLUMN label TO label_old;',
    scopeTool: 'squawk', originalRecord: 'squawk:file:db/migrations/001_items.sql: 1 alertas',
    correctedRecord: 'squawk:file:db/migrations/001_items.sql: 0 alertas',
  },
  {
    module: 'prontidao', file: 'options.ts', tool: 'prontidao-audit', rule: 'PRONTIDAO-TLS-VERIFICACAO-DESABILITADA',
    line: 1, evidence: 'Diretiva de validação de certificado TLS desabilitada.',
    before: 'export const opts = { rejectUnauthorized: false };\n', after: 'export const opts = { rejectUnauthorized: true };\n',
    object: 'opts.rejectUnauthorized', desired: 'true', replaced: 'export const other = { rejectUnauthorized: true };\n',
    scopeTool: 'prontidao:arquivo', originalRecord: 'options.ts: verificações [tls-verify], 1 achado(s).',
    correctedRecord: 'options.ts: verificações [tls-verify], 0 achado(s).',
  },
  {
    module: 'desempenho', file: 'cost.ts', tool: 'node-cpu-prof', rule: 'CPU-PROF-HOTSPOT', line: 1,
    evidence: 'arquivo=cost.ts:1; função=cost; tempo próprio amostral=12.0ms; amostras próprias=9/14; limiar=10ms',
    before: 'export function cost() { let total = 0; for (let i = 0; i < 5; i++) total += i; return total; }\n',
    after: '\nexport function cost() { return 10; }\n', object: 'cost', desired: 'abaixo-do-limiar',
    replaced: '\nexport function other() { return 10; }\n',
    scopeTool: 'node-cpu-prof:arquivo',
    originalRecord: 'arquivo=cost.ts:1; função=cost; tempo próprio amostral=12.0ms; amostras próprias=9/14; limiar=10ms; recorte: uma chamada isolada sem argumentos',
    correctedRecord: 'arquivo=cost.ts:2; função=cost; tempo próprio amostral=1.0ms; amostras próprias=1/3; limiar=10ms; recorte: uma chamada isolada sem argumentos',
  },
  {
    module: 'documentacao', file: 'value.ts', tool: 'typedoc', rule: 'DOC-TYPEDOC-SIMBOLO-SEM-DOC', line: 1,
    message: 'Símbolo público exportado "value" em value.ts não possui documentação JSDoc/TSDoc.',
    evidence: 'TypeDoc reflection kind=64 name=value (value.ts:1) sem summary/blockTags',
    before: 'export function value() { return 10; }\n', after: '/** Valor inicial. */\nexport function value() { return 10; }\n',
    object: 'value', desired: 'documentado', replaced: '/** Valor inicial. */\nexport function other() { return 10; }\n',
    scopeTool: 'typedoc:file', originalRecord: 'arquivo=value.ts; simbolos=1; documentados=0; exports=value',
    correctedRecord: 'arquivo=value.ts; simbolos=1; documentados=1; exports=value',
  },
  {
    module: 'conformidade', file: 'package-lock.json', tool: 'ort', rule: 'ORT_STRONG_COPYLEFT_DECLARED', line: 4,
    evidence: 'ORT processou a declaração em packages como GPL-3.0-only.',
    before: lock('GPL-3.0-only'), after: lock('MIT'), object: 'node_modules/sample', desired: 'MIT', replaced: lock('MIT', '2.0.0'),
    scopeTool: 'ort:file', originalRecord: 'package-lock.json | 1/1 declarações SPDX processadas no ORT.',
    correctedRecord: 'package-lock.json | 1/1 declarações SPDX processadas no ORT.',
  },
];

const testSource = (file: string, object: string, desired: string) => [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { readFileSync } from 'node:fs';",
  `test("mede a correção", () => assert.deepStrictEqual(JSON.parse(readFileSync(0, 'utf8')), ${JSON.stringify([file, object, desired])}));`, '',
].join('\n');

const reviewer = {provider: 'reviewer', model: 'fixture', accountId: randomUUID(), profileId: randomUUID(), grantId: randomUUID()};
const refuseReview: ModuleRecheckReview = async () => { throw new Error('Revisão inesperada'); };

test('CLI direciona --medir-correcao para os oito módulos e valida a seleção', async () => {
  const runId = randomUUID();
  for (const module of VERIFICATION_MODULES) {
    assert.equal(parsePersonalModuleArgs(module, ['fixture.json', 'project', '--medir-correcao', runId]).kind, 'measure');
    assert.throws(() => parsePersonalModuleArgs(module, ['fixture.json', 'project', '--medir-correcao', runId, 'ACH-001']), /VERIFY_USAGE/);
  }
  await assert.rejects(runPersonalQaCli(['fixture.json', 'project', '--medir-correcao', 'invalid']), /VERIFY_USAGE/);
  assert.throws(() => parsePersonalModuleArgs('prontidao', ['fixture.json', 'project', '--medir-correcao', runId, '--origem=https://example.invalid']), /VERIFY_USAGE/);
});

for (const fixture of cases) {
  test(`${fixture.module}: mede a correção no snapshot e recusa cobertura ausente, substituição e teste alheio`,
    {skip: !base}, async () => {
      await withModuleRecoveryFixture(base!, async input => {
        const {ledger, principal, projectId, repoPath, dataDirectory} = input;
        const {module, file} = fixture;
        const {contextId} = await ledger.ensureExamContext(principal, projectId, module);
        const acquire = () => ledger.acquire(principal, contextId, randomUUID(), 'recheck-fixture', 60);
        let authority = await acquire();
        const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', repoPath, ...args],
          {encoding: 'utf8', stdio: 'pipe'}).trim();
        const write = async (name: string, text: string) => {
          const path = join(repoPath, name);
          await mkdir(dirname(path), {recursive: true});
          await writeFile(path, text);
        };
        const commit = (label: string) => {
          git('add', '.');
          git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', label);
          return git('rev-parse', 'HEAD');
        };
        const testFile = `tests/${module}/ach-001.test.ts`;
        const probe = (object = fixture.object) => write(testFile, testSource(file, object, fixture.desired));
        await write(file, fixture.before);
        const originalCommit = commit('original');
        const raw: ModuleRawFinding = {tool: fixture.tool, rule: fixture.rule, file, line: fixture.line, severity: 'media',
          message: fixture.message ?? 'Condição medida no arquivo.', evidence: fixture.evidence};
        const coverage = (detail: string, status: ModuleToolCoverage['status'] = 'ok') => [
          ...(fixture.tool === 'squawk' ? [] : [toolRow(fixture.tool)]), {...toolRow(fixture.scopeTool, detail, status), files: [file]},
        ];
        const run = (commit: string, collectorOutput: ModuleCollectorOutput, pin = image) => runVerificationModule({
          ...input, module, authority, commit, collectorOutput, image: pin,
        });
        const origin = await run(originalCommit, {coverage: coverage(fixture.originalRecord), findings: [raw]});
        const recheck = (review: ModuleRecheckReview = refuseReview, signal?: AbortSignal) =>
          recheckModuleFindings(ledger, principal, authority, {
            module, runId: origin.runId, achadoIds: ['ACH-001'], projectId, dataDirectory, review, signal,
          });
        const pending = async (reason: string, review?: ModuleRecheckReview) => {
          assert.deepEqual((await recheck(review)).results, [{id: 'ACH-001', status: 'pendente', reason}]);
          assert.equal((await readModuleReport(dataDirectory, projectId, origin.runId, module)).achados[0]?.status, 'provavel');
        };
        const correctedOutput = {coverage: coverage(fixture.correctedRecord), findings: []};
        await pending('MODULE_RECHECK_SAME_COMMIT');
        await probe();
        await write(file, fixture.replaced);
        await run(commit('different object'), correctedOutput);
        await pending('MODULE_RECHECK_MEASUREMENT_UNPROVEN');
        await write(file, fixture.after);
        if (module === 'arquitetura') await write('index.ts', "import {value} from './value.ts';\nexport const answer = value();\n");
        await probe('unrelated');
        await run(commit('unrelated test'), correctedOutput);
        await pending('MODULE_RECHECK_FUNCTIONAL_TEST_UNAVAILABLE');

        await probe();
        const correctedCommit = commit('integrated correction');
        await run(correctedCommit, correctedOutput, otherImage);
        await pending('MODULE_RECHECK_MODULE_PROOF_MISSING');
        await run(correctedCommit, {coverage: coverage(fixture.correctedRecord, 'skipped'), findings: []});
        await pending('MODULE_RECHECK_MEASUREMENT_UNPROVEN');
        await run(correctedCommit, {coverage: [toolRow(fixture.tool)], findings: []});
        await pending('MODULE_RECHECK_MEASUREMENT_UNPROVEN');
        if (module === 'desempenho') {
          await run(correctedCommit, {coverage: coverage(fixture.correctedRecord.replace('limiar=10ms', 'limiar=20ms')), findings: []});
          await pending('MODULE_RECHECK_MEASUREMENT_UNPROVEN');
        }

        const installation = join(dataDirectory, 'installation.json');
        await writeFile(installation, JSON.stringify({schemaVersion: 1, mode: 'administration-only', activation: 'personal',
          databaseUrl: ledger.pool.options.connectionString, dataDirectory,
          project: {id: projectId, label: 'Fixture', repo: repoPath, owner: principal,
            publishedOrigins: ['https://127.0.0.1:1']},
          http: {listen: '127.0.0.1', port: 8765, publicOrigin: 'http://127.0.0.1:8765'},
        }), {mode: 0o600});
        await ledger.releaseLease(authority);
        let [proofRun] = await runPersonalModuleCli(module, [installation, projectId, '--medir-correcao', origin.runId], {
          image: otherImage,
          prontidaoProbeOptions: {timeoutMs: 1}, // A sonda recusaria este limite antes de abrir a conexão.
          async runCollector(spec) {
            assert.equal(spec.image, image);
            assert.equal(spec.commit, correctedCommit);
            assert.equal(spec.passiveTlsEvidence, undefined);
            return correctedOutput;
          },
          async moduleExamRuntime() { throw new Error('A medição não reserva revisor'); },
        });
        authority = await acquire();
        const sourceProvider = {provider: 'author', model: 'fixture'};
        await ledger.pool.query(
          "UPDATE ac_verify_findings SET payload=jsonb_set(payload, '{verifier}', $2::jsonb) WHERE run_id=$1",
          [origin.runId, sourceProvider],
        );
        await pending('MODULE_EXAM_REVIEWER_UNAVAILABLE', async () => ({reason: 'MODULE_EXAM_REVIEWER_UNAVAILABLE'}));
        let reviews = 0;
        const answer = (provider = reviewer.provider, alter = false): ModuleRecheckReview => async request => {
          reviews++;
          assert.equal(request.examiner?.provider, sourceProvider.provider);
          const task = JSON.parse(request.task);
          const receipt = task.regressionProof;
          assert.equal(task.file, file);
          assert.equal(receipt.object, fixture.object);
          assert.equal(receipt.testFile, testFile);
          assert.equal(receipt.observations.original.commit, originalCommit);
          assert.equal(receipt.observations.corrected.commit, correctedCommit);
          assert.equal(receipt.observations.original.status, 'assertion-failed');
          assert.equal(receipt.observations.corrected.status, 'passed');
          assert.equal(task.moduleProof.runId, proofRun);
          const {original, corrected} = receipt.observations;
          return {reviewer: {...reviewer, provider}, output: JSON.stringify({
            kind: 'confirmacao', status: 'descartado', binding: task.binding, proof: task.code,
            reason: `A mesma regressão para \`${receipt.object}\` passou de \`${original.actual}\` para \`${corrected.actual}\`.`,
            correction: {rule: task.rule, criterion: receipt.criterion, object: alter ? 'wrong' : receipt.object, original, corrected},
          })};
        };
        await assert.rejects(recheck(answer(sourceProvider.provider)), /MODULE_EXAM_PROVIDER_NOT_DISTINCT/);
        await pending('MODULE_RECHECK_CORRECTION_UNEXPLAINED', answer(reviewer.provider, true));
        if (module === 'arquitetura') {
          const controller = new AbortController();
          const respond = answer();
          await assert.rejects(recheck(async request => {
            const response = await respond(request);
            controller.abort(new Refusal('EXAM_INTERRUPTED'));
            return response;
          }, controller.signal), /EXAM_INTERRUPTED/);
          const respondStale = answer();
          await assert.rejects(recheck(async request => {
            const response = await respondStale(request);
            await run(correctedCommit, correctedOutput, otherImage);
            return response;
          }), /VERIFY_RUN_CONFLICT/);
          await pending('MODULE_RECHECK_MODULE_PROOF_MISSING');
          proofRun = (await run(correctedCommit, correctedOutput)).runId;
          await write(file, fixture.replaced);
        }
        assert.deepEqual(await recheck(answer()), {results: [{id: 'ACH-001', status: 'fechado'}], publication: 'published'});
        assert.equal((await readModuleReport(dataDirectory, projectId, origin.runId, module)).achados[0]?.status, 'fechado');
        const priorReviews = reviews;
        assert.equal((await recheck()).results[0]?.status, 'fechado');
        assert.equal(reviews, priorReviews);
        const {rows: [saved]} = await ledger.pool.query(
          "SELECT detail FROM ac_audit WHERE kind='module.finding_rechecked' AND detail->>'status'='fechado' AND detail->>'runId'=$1",
          [origin.runId],
        );
        const {receiptDigest, ...receipt} = saved.detail.regressionProof;
        assert.equal(receiptDigest, digest(receipt));
        assert.equal(saved.detail.moduleProof.collectorImage, image);
        assert.equal(saved.detail.source.commit, originalCommit);
        assert.equal(saved.detail.source.file, file);
        assert.equal(saved.detail.reviewer.provider, reviewer.provider);
        assert.equal(saved.detail.regressionProof.moduleProofRunId, proofRun);
        await run(correctedCommit, {coverage: [toolRow(fixture.tool, 'desativada', 'failed')], findings: []});
        assert.deepEqual((await recheck()).results, [{id: 'ACH-001', status: 'pendente', reason: 'MODULE_RECHECK_MODULE_PROOF_MISSING'}]);
      });
    });
}
