import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import {moduleCollectorArguments, parseModuleCollectorOutput} from '../src/verification-modules.ts';
import {join} from 'node:path';
import test from 'node:test';
// @ts-expect-error Os coletores usam JavaScript nativo.
import {collectQaBancoLocal, measureBancoPlan} from '../deploy/modules/qa/banco-local/index.mjs';
// @ts-expect-error Os coletores usam JavaScript nativo.
import {manifestPath, planBancoLocal} from '../deploy/modules/qa/banco-local/plan.mjs';
// @ts-expect-error Os coletores usam JavaScript nativo.
import {createLocalPostgres, parseTap} from '../deploy/modules/qa/banco-local/postgres.mjs';

function snapshot(name = 'controle') {
  const workspace = join(import.meta.dirname, 'fixtures', 'module-qa-banco-local', name);
  const copiedFiles = readdirSync(workspace, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(workspace.length + 1));
  return {workspace, copiedFiles, incomplete: false};
}

function syntheticDatabase(options: {fail?: string, changed?: boolean} = {}) {
  const events: string[] = [];
  const command = async (event: string) => {
    events.push(event);
    if (options.fail === event) throw new Error('diagnóstico bruto deliberadamente omitido');
  };
  return {
    events,
    start: () => command('start'),
    stop: () => command('stop'),
    dump: () => command('dump'),
    restore: () => command('restore'),
    sql(db: string, sql: string) {
      const kind = sql.startsWith('CREATE TABLE') ? 'prefix' : sql.startsWith('INSERT') ? 'seed' : 'tail';
      if (db === 'upgraded') {
        assert.equal(sql.includes('conteudo-substituido'), options.changed === true);
      }
      return command(`${db}:${kind}`);
    },
    async assert(db: string, predicate: string) {
      assert.match(predicate, db === 'fresh' ? /information_schema\.columns/ : /dado-sintetico/);
      await command(`${db}:assert`);
      const changed = options.changed && db === 'upgraded' && events.includes('upgraded:tail');
      return parseTap(`1..1\n${changed ? 'not ok' : 'ok'} 1 - invariante funcional\n`);
    },
  };
}

test('exige declaração sintética e a ordem completa das migrações copiadas', () => {
  const fixture = snapshot();
  const plan = planBancoLocal(fixture);
  assert.deepEqual(plan.migrations?.map(({file}: {file: string}) => file), [
    'db/migrations/001_items.sql', 'db/migrations/002_revision.sql',
  ]);
  const without = (file: string) => ({...fixture, copiedFiles: fixture.copiedFiles.filter(path => path !== file)});
  assert.match(planBancoLocal(without(manifestPath)).reason, /nenhuma fixture sintética/);
  assert.match(planBancoLocal(without('db/migrations/001_items.sql')).reason, /divergem do inventário/);
  assert.match(planBancoLocal({...fixture, incomplete: true}).reason, /snapshot parcial/);
  assert.match(planBancoLocal({...fixture, copiedFiles: [...fixture.copiedFiles, 'db/migrations/003_pending.sql']}).reason,
    /divergem do inventário/);
});

test('controle percorre banco novo, origem, restauração e atualização em ordem', async () => {
  const driver = syntheticDatabase();
  const report = await measureBancoPlan(planBancoLocal(snapshot()), driver);
  assert.deepEqual(driver.events, [
    'start', 'fresh:prefix', 'fresh:tail', 'fresh:assert', 'previous:prefix', 'previous:seed',
    'previous:assert', 'dump', 'restore', 'upgraded:assert', 'upgraded:tail', 'upgraded:assert', 'stop',
  ]);
  assert.equal(report.steps.length, driver.events.length);
  assert.ok(report.steps.every(({status}: {status: string}) => status === 'ok'));
  assert.deepEqual(report.findings, []);
});

test('defeito em dados históricos aparece somente após a migração final', async () => {
  const driver = syntheticDatabase({changed: true});
  const report = await measureBancoPlan(planBancoLocal(snapshot('defeito')), driver);
  assert.deepEqual(report.steps.filter(({status}: {status: string}) => status === 'failed'),
    [{name: 'historico-atualizado', status: 'failed', detail: 'banco/assert.sql; pgTAP reprovou 1/1'}]);
  assert.deepEqual(report.findings.map(({rule, file, line}: {rule: string, file: string, line: number}) => [rule, file, line]),
    [['QA-BANCO-PGTAP', 'banco/assert.sql', 2]]);
});

test('explica entradas ausentes e mantém a prova do zero independente', async () => {
  const fixture = snapshot();
  const driver = syntheticDatabase();
  const report = await measureBancoPlan(planBancoLocal({...fixture,
    copiedFiles: fixture.copiedFiles.filter(file => !['banco/seed.sql', 'banco/pgtap-fresh.sql'].includes(file)),
  }), driver);
  assert.deepEqual(driver.events, ['start', 'fresh:prefix', 'fresh:tail', 'stop']);
  assert.deepEqual(report.steps.filter(({status}: {status: string}) => status === 'skipped').map(
    ({detail}: {detail: string}) => detail), ['banco/pgtap-fresh.sql ausente', 'entradas históricas ausentes (banco/seed.sql)']);
});

test('falha de restauração interrompe a atualização, higieniza a saída e limpa a instância', async () => {
  const driver = syntheticDatabase({fail: 'restore'});
  const report = await measureBancoPlan(planBancoLocal(snapshot()), driver);
  assert.deepEqual(driver.events.slice(-3), ['dump', 'restore', 'stop']);
  assert.equal(report.steps.find(({name}: {name: string}) => name === 'historico-restauracao')?.status, 'failed');
  assert.equal(report.steps.find(({name}: {name: string}) => name === 'historico-atualizado')?.status, 'skipped');
  assert.doesNotMatch(JSON.stringify(report), /diagnóstico bruto/);
  assert.deepEqual(report.findings, []);
});

test('sempre encerra tentativa de inicialização malsucedida', async () => {
  const driver = syntheticDatabase({fail: 'start'});
  const report = await measureBancoPlan(planBancoLocal(snapshot()), driver);
  assert.deepEqual(driver.events, ['start', 'stop']);
  assert.deepEqual(report.steps.map(({status}: {status: string}) => status), ['failed', 'skipped', 'skipped', 'ok']);
});

test('pgTAP exige plano e resultado inequívocos', () => {
  assert.equal(parseTap('1..1\nok 1 - invariante funcional\n'), 'passed');
  assert.equal(parseTap('1..1\nnot ok 1 - invariante funcional\n# diagnóstico\n'), 'failed');
  for (const output of ['', 'ok 1 - invariante funcional', '1..0 # SKIP', '1..1\nok 1 - invariante funcional # TODO',
    '1..1\nok 1 - invariante funcional\nBail out!', '1..1\nok 1 - invariante funcional\n# resultado contraditório', '1..2\nok 1 - invariante funcional']) {
    assert.equal(parseTap(output), 'invalid');
  }
});

test('coletor e driver recusam execução fora do isolamento QA', async () => {
  assert.throws(() => createLocalPostgres('/repo'), /QA isolation required/);
  const result = await collectQaBancoLocal({...snapshot(), repoDir: '/repo',
    row: (tool: string, version: string, status: string, detail: string) => ({tool, version, status, detail}),
  });
  assert.equal(result.coverageRow.status, 'skipped');
  assert.match(result.coverageRow.detail, /contêiner QA offline/);
  assert.deepEqual(result.extraRows, []);
  assert.deepEqual(result.findings, []);
});

test('o entrypoint de QA mede a restauração e atribui a regressão ao arquivo de invariante', {
  skip: process.env.AC_MODULE_LAB !== '1',
  timeout: 180_000,
}, () => {
  const image = readFileSync(join(import.meta.dirname, '../deploy/modules/qa/digest.txt'), 'utf8').trim();
  for (const variant of ['controle', 'defeito']) {
    const [runtime, ...args] = moduleCollectorArguments({image, repository: snapshot(variant).workspace});
    const stdout = execFileSync(runtime!, args, {encoding: 'utf8', timeout: 80_000, maxBuffer: 16 * 1024 * 1024});
    const report = parseModuleCollectorOutput(stdout, {module: 'qa'});
    const status = (phase: string) => report.coverage.find(row => row.tool === 'qa-banco-local:' + phase)?.status;
    for (const phase of ['do-zero-assertiva', 'historico-antes-do-dump', 'historico-dump',
      'historico-restauracao', 'historico-restaurado', 'atualizacao-migracao-1', 'limpeza']) {
      assert.equal(status(phase), 'ok', variant + ' ' + phase);
    }
    assert.equal(status('historico-atualizado'), variant === 'controle' ? 'ok' : 'failed');
    const findings = report.findings.filter(finding => finding.tool === 'qa-banco-local');
    assert.deepEqual(findings.map(finding => [finding.rule, finding.file, finding.line]),
      variant === 'controle' ? [] : [['QA-BANCO-PGTAP', 'banco/assert.sql', 2]]);
  }
});
