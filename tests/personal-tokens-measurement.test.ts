import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Ledger} from '../src/ledger.ts';
import {PersonalManagerChat} from '../src/personal-manager-chat.ts';
import {effectiveBatchLines, groupRows, readManagerRows, renderReport, SECURITY_FILE_LIMIT, type Row} from '../src/personal-tokens-cli.ts';
import {planSecuritySlices} from '../src/verify-slices.ts';

async function fakeDocker(script: string): Promise<{dir: string; docker: string}> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-med-docker-'));
  const docker = join(dir, 'docker');
  await writeFile(docker, '#!/bin/sh\n' + script + '\n');
  await chmod(docker, 0o755);
  return {dir, docker};
}
type Insert = unknown[];
/** Ledger double. `failInsert(n)` rejects the n-th (1-based) INSERT with a database-like error. */
function ledgerDouble(provider: string, failInsert: (n: number) => boolean = () => false) {
  const inserts: Insert[] = [];
  let attempts = 0;
  const ledger = {pool: {async query(sql: string, params: unknown[]) {
    if (sql.includes('FROM ac_profiles')) return {rows: [{account_id: 'acc', provider, model: 'm', effort: 'medium'}]};
    if (sql.includes('INSERT INTO ac_manager_chat_usage')) {
      attempts += 1;
      if (failInsert(attempts)) throw Object.assign(new Error('relation does not exist: segredo-do-prompt'), {code: '42P01'});
      inserts.push(params);
      return {rows: []};
    }
    return {rows: []};
  }}} as unknown as Ledger;
  return {ledger, inserts};
}
// Parameter positions of the usage INSERT: 5 input, 6 output, 7 total, 8 estimated, 10 outcome, 11 measurement, 12 collection_error.
const P = {input: 5, total: 7, estimated: 8, outcome: 10, measurement: 11, error: 12};

test('gerente: tentativa que falha e tentativa no limite de uso também são registradas, sem números', async () => {
  const {dir, docker} = await fakeDocker('echo "erro interno" >&2\nexit 1');
  const limit = await fakeDocker('echo "You have hit your usage limit. Try again later." >&2\nexit 1');
  try {
    const failing = ledgerDouble('claude');
    assert.equal(await new PersonalManagerChat(failing.ledger, {imageId: 'i', accountRoot: '/x', docker}).decide('oi', 'CTX', {measure: true}), null);
    assert.equal(failing.inserts.length, 1, 'a tentativa fracassada deixa linha');
    assert.deepEqual([failing.inserts[0]![P.outcome], failing.inserts[0]![P.measurement], failing.inserts[0]![P.input], failing.inserts[0]![P.estimated]], ['falha', 'desconhecido', null, false]);

    const limited = ledgerDouble('codex');
    await new PersonalManagerChat(limited.ledger, {imageId: 'i', accountRoot: '/x', docker: limit.docker}).decide('oi', 'CTX', {measure: true});
    assert.equal(limited.inserts[0]![P.outcome], 'limite');
    assert.equal(limited.inserts[0]![P.measurement], 'desconhecido');

    const off = ledgerDouble('claude');
    await new PersonalManagerChat(off.ledger, {imageId: 'i', accountRoot: '/x', docker}).decide('oi', 'CTX', {measure: false});
    assert.equal(off.inserts.length, 0, 'medição desligada não grava');
  } finally { await rm(dir, {recursive: true, force: true}); await rm(limit.dir, {recursive: true, force: true}); }
});

test('gerente: sucesso distingue estimativa de total informado', async () => {
  const est = await fakeDocker('echo \'{"kind":"answer","answer":"ok"}\'');
  const rep = await fakeDocker('echo \'{"kind":"answer","answer":"ok"}\'\necho "tokens used" >&2\necho "4,321" >&2');
  try {
    const a = ledgerDouble('claude');
    await new PersonalManagerChat(a.ledger, {imageId: 'i', accountRoot: '/x', docker: est.docker}).decide('oi', 'CTX', {measure: true});
    assert.deepEqual([a.inserts[0]![P.outcome], a.inserts[0]![P.measurement], a.inserts[0]![P.estimated]], ['sucesso', 'estimado', true]);
    const b = ledgerDouble('codex');
    await new PersonalManagerChat(b.ledger, {imageId: 'i', accountRoot: '/x', docker: rep.docker}).decide('oi', 'CTX', {measure: true});
    assert.deepEqual([b.inserts[0]![P.outcome], b.inserts[0]![P.measurement], b.inserts[0]![P.total]], ['sucesso', 'informado', 4321]);
  } finally { await rm(est.dir, {recursive: true, force: true}); await rm(rep.dir, {recursive: true, force: true}); }
});

test('gerente: falha ao gravar a medição é contada, avisada e tentada de novo sem números; a decisão segue', async () => {
  const {dir, docker} = await fakeDocker('echo \'{"kind":"answer","answer":"ok"}\'');
  try {
    const seen: string[] = [];
    const first = ledgerDouble('claude', n => n === 1);
    const chat = new PersonalManagerChat(first.ledger, {imageId: 'i', accountRoot: '/x', docker, onMeasurementError: code => seen.push(code)});
    assert.deepEqual(await chat.decide('oi', 'CTX', {measure: true}), {kind: 'answer', answer: 'ok'});
    assert.deepEqual(chat.measurementStatus(), {attempts: 1, recorded: 0, degraded: 1, failed: 0, lastError: '42P01'});
    assert.deepEqual(seen, ['42P01']);
    assert.equal(first.inserts.length, 1);
    assert.deepEqual([first.inserts[0]![P.measurement], first.inserts[0]![P.error], first.inserts[0]![P.input]], ['desconhecido', '42P01', null]);

    const both = ledgerDouble('claude', () => true);
    const quiet: string[] = [];
    const chat2 = new PersonalManagerChat(both.ledger, {imageId: 'i', accountRoot: '/x', docker, onMeasurementError: code => quiet.push(code)});
    assert.deepEqual(await chat2.decide('oi', 'CTX', {measure: true}), {kind: 'answer', answer: 'ok'});
    assert.deepEqual(chat2.measurementStatus(), {attempts: 1, recorded: 0, degraded: 0, failed: 1, lastError: '42P01'});
    assert.ok(!JSON.stringify(chat2.measurementStatus()).includes('segredo'), 'o aviso não carrega o texto do erro');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('CLI: tabela do gerente ilegível não vira lista vazia; o relatório declara cobertura parcial', async () => {
  const broken = {query: async () => { throw Object.assign(new Error('permission denied'), {code: '42501'}); }};
  const result = await readManagerRows(broken, {});
  assert.deepEqual(result.rows, []);
  assert.match(result.problem ?? '', /ac_manager_chat_usage ilegível \(42501\)/);
  const partial = renderReport([], [result.problem!], []);
  assert.match(partial[0]!, /^COBERTURA PARCIAL: 1 fonte/);
  assert.match(renderReport([], [], [])[0]!, /^Cobertura: todas as fontes/);
});

test('CLI: linhas do gerente separam estimado, informado e desconhecido, e desfecho', async () => {
  const row = (measurement: string, outcome: string, tokens: number | null, collection_error: string | null = null) => ({provider: 'claude', model: 'm', effort: 'medium', role: 'manager',
    input_tokens: measurement === 'estimado' ? tokens : null, output_tokens: null, total_tokens: measurement === 'informado' ? tokens : null, estimated: measurement === 'estimado', outcome, measurement, collection_error});
  const rows = [row('estimado', 'sucesso', 10), row('estimado', 'sucesso', 5), row('informado', 'sucesso', 900), row('desconhecido', 'falha', null), row('desconhecido', 'falha', null, '42P01')];
  const result = await readManagerRows({query: async () => ({rows})}, {});
  const grouped = groupRows(result.rows);
  assert.equal(grouped.length, 4, 'estimado, informado, falha e falha com erro de coleta ficam em linhas próprias');
  assert.deepEqual(grouped.map(r => [r.source, r.outcome, r.input, r.total]), [['estimado', 'sucesso', 15, null], ['nativo', 'sucesso', null, 900], ['desconhecido', 'falha', null, null], ['desconhecido', 'falha', null, null]]);
  assert.ok(grouped[3]!.measurement!.includes('erro de coleta'));
  const text = renderReport(grouped, [], []).join('\n');
  assert.match(text, /\tdesfecho\tmedição/);
});

test('CLI: linha de Codex com base desconhecida sai como medição insuficiente, não como zero', () => {
  const rows: Row[] = [{source: 'externo', provider: 'codex', model: 'm', effort: 'high', role: 'desconhecido', input: null, cache: null, output: null, calls: null, state: 'medição insuficiente'}];
  const text = renderReport(groupRows(rows), [], []).join('\n');
  assert.match(text, /codex\tm\thigh\tdesconhecido\tnão medido\tnão medido\tnão medido\tnão medido\tnão medido\t-\tmedição insuficiente/);
});

test('lotes: configuração efetiva por módulo, com o limite histórico do módulo 1 e o batchFiles dos demais', async () => {
  const padrao = effectiveBatchLines({}, 'p').join('\n');
  assert.match(padrao, /módulo 1 \(segurança\): até 15 arquivos por chamada \(limite histórico fixo; batchFiles não se aplica\) e orçamento de leitura de 160000 tokens/);
  assert.match(padrao, /módulos 2 a 9: até 20 arquivos e 40000 tokens por chamada/);
  assert.match(padrao, /módulo 10 \(design\): até 8 arquivos e 20000 tokens por chamada \(teto do design: 20000\)/);
  const um = effectiveBatchLines({batchFiles: 1, batchTokens: 10000}, 'p').join('\n');
  assert.match(um, /módulo 1 .*até 15 arquivos.*batchFiles não se aplica/);
  assert.match(um, /módulos 2 a 9: 1 arquivo por chamada \(lote exige batchFiles >= 2\)/);
  assert.match(effectiveBatchLines({batch: false}, 'p').join('\n'), /módulos 1 a 10: 1 arquivo por chamada/);
  assert.match(effectiveBatchLines({batchFiles: 99}, 'p')[0]!, /inválida/);
  // The module 1 limit printed must be the one the planner applies, and batchFiles must not change it.
  const files = Array.from({length: 40}, (_, i) => `src/f${i}.ts`);
  for (const batchFiles of [2, 32]) {
    const slices = planSecuritySlices(files, [], new Map(files.map(f => [f, 1])), {tokens: 40000, files: batchFiles});
    assert.equal(Math.max(...slices.map(s => s.files.length)), SECURITY_FILE_LIMIT);
  }
});

test('banco real: a migração 120 grava desfecho e medição e rejeita combinação incoerente', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  if (!url) throw Error('ISOLATED_DATABASE_REQUIRED');
  const db = new Ledger(url);
  const tag = 'med-' + randomUUID();
  try {
    await db.migrate();
    const insert = (estimated: boolean, measurement: string, outcome: string, tokens: number | null) => db.pool.query(
      `INSERT INTO ac_manager_chat_usage(account_id,provider,model,effort,total_tokens,estimated,prompt_chars,outcome,measurement) VALUES($1,'codex',$2,'high',$3,$4,10,$5,$6)`,
      [randomUUID(), tag, tokens, estimated, outcome, measurement]);
    await insert(false, 'informado', 'sucesso', 100);
    await insert(true, 'estimado', 'sucesso', null);
    await insert(false, 'desconhecido', 'falha', null);
    await assert.rejects(insert(true, 'informado', 'sucesso', 5), /ac_manager_chat_usage_measurement/);
    await assert.rejects(insert(false, 'desconhecido', 'falha', 5), /ac_manager_chat_usage_unknown_empty/);
    await assert.rejects(insert(false, 'informado', 'quebrado', 5), /outcome/);
    const rows = (await db.pool.query('SELECT outcome,measurement FROM ac_manager_chat_usage WHERE model=$1 ORDER BY id', [tag])).rows;
    assert.deepEqual(rows.map(r => `${r.outcome}/${r.measurement}`), ['sucesso/informado', 'sucesso/estimado', 'falha/desconhecido']);
    // The reader sees them through the real query.
    const read = await readManagerRows(db.pool as never, {});
    assert.equal(read.problem, null);
    assert.ok(read.rows.some(r => r.model === tag && r.source === 'desconhecido' && r.outcome === 'falha'));
  } finally {
    await db.pool.query('DELETE FROM ac_manager_chat_usage WHERE model=$1', [tag]);
    await db.close();
  }
});

test('CLI de ponta a ponta: com a leitura da tabela desabilitada, declara cobertura parcial e sai com código 3', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  if (!url) throw Error('ISOLATED_DATABASE_REQUIRED');
  const db = new Ledger(url);
  const dir = await mkdtemp(join(tmpdir(), 'ac-med-cli-'));
  const install = join(dir, 'install.json');
  const empty = join(dir, 'vazio');
  await writeFile(install, JSON.stringify({databaseUrl: url, dataDirectory: dir, project: {label: 'proj', economy: {batchFiles: 3}}}));
  const run = () => spawnSync('node', ['--import', 'tsx', 'src/personal-tokens-cli.ts', install, '--codex', empty, '--claude', empty], {encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname});
  try {
    await db.migrate();
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^Cobertura: todas as fontes foram lidas\./);
    assert.match(ok.stdout, /Configuração efetiva de lotes por módulo:\nprojeto proj: lotes ligados, batchTokens=40000, batchFiles=3\n  módulo 1 \(segurança\): até 15 arquivos/);
    try {
      await db.pool.query('ALTER TABLE ac_manager_chat_usage RENAME TO ac_manager_chat_usage_off');
      const partial = run();
      assert.equal(partial.status, 3, partial.stderr);
      assert.match(partial.stdout, /^COBERTURA PARCIAL: 1 fonte/);
      assert.match(partial.stdout, /ac_manager_chat_usage ilegível \(42P01\)/);
      assert.match(partial.stderr, /Cobertura parcial/);
    } finally {
      await db.pool.query('ALTER TABLE IF EXISTS ac_manager_chat_usage_off RENAME TO ac_manager_chat_usage');
    }
  } finally {
    await db.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test('banco real: o gerente grava a tentativa de ponta a ponta (informado do Codex e falha sem números)', async () => {
  const url = process.env.AC_TEST_DATABASE_URL;
  if (!url) throw Error('ISOLATED_DATABASE_REQUIRED');
  const db = new Ledger(url);
  const ok = await fakeDocker('echo \'{"kind":"plan","answer":"resumo"}\'\necho "tokens used" >&2\necho "4,321" >&2');
  const bad = await fakeDocker('exit 1');
  const account = randomUUID();
  const model = 'med-' + randomUUID();
  try {
    await db.migrate();
    const profiles = {rows: [{account_id: account, provider: 'codex', model, effort: 'high'}]};
    const wrapped = {pool: {query: (sql: string, params?: unknown[]) => sql.includes('FROM ac_profiles') ? Promise.resolve(profiles) : db.pool.query(sql, params)}} as unknown as Ledger;
    await new PersonalManagerChat(wrapped, {imageId: 'i', accountRoot: '/x', docker: ok.docker}).decide('mude a cor', 'CTX', {measure: true, projectId: randomUUID()});
    await new PersonalManagerChat(wrapped, {imageId: 'i', accountRoot: '/x', docker: bad.docker}).decide('mude a cor', 'CTX', {measure: true});
    const rows = (await db.pool.query('SELECT outcome,measurement,estimated,total_tokens,collection_error FROM ac_manager_chat_usage WHERE model=$1 ORDER BY id', [model])).rows;
    assert.deepEqual(rows.map(r => [r.outcome, r.measurement, r.estimated, r.total_tokens === null ? null : Number(r.total_tokens), r.collection_error]),
      [['sucesso', 'informado', false, 4321, null], ['falha', 'desconhecido', false, null, null]]);
  } finally {
    await db.pool.query('DELETE FROM ac_manager_chat_usage WHERE model=$1', [model]);
    await db.close();
    await rm(ok.dir, {recursive: true, force: true}); await rm(bad.dir, {recursive: true, force: true});
  }
});

test('the report shows cache read, cache write and the share of input served from the cache', async () => {
  const {cacheColumns} = await import('../src/personal-tokens-cli.ts');
  const claude: Row = {source: 'externo', provider: 'claude', model: 'm', effort: 'high', role: 'desconhecido', input: 100, cache: 1000, output: 10, calls: 2, cacheRead: 900, cacheWrite: 100};
  assert.deepEqual(cacheColumns(claude), {read: 900, write: 100, hit: '82%'});
  const codex: Row = {source: 'externo', provider: 'codex', model: 'm', effort: 'high', role: 'desconhecido', input: 1000, cache: 600, output: 10, calls: 1};
  assert.deepEqual(cacheColumns(codex), {read: 600, write: null, hit: '60%'});
  const text = renderReport(groupRows([claude, {...claude}]), [], []).join('\n');
  assert.match(text, /\tmedição\tcache lido\tcache gravado\tacerto do cache\n/);
  assert.match(text, /\tinformado\t1800\t200\t82%$/m);
});

test('native Claude counters keep cache read and cache write apart and sum them across attempts', async () => {
  const {usageCountersFromEvent, sumUsageAttempts} = await import('../src/native-usage.ts');
  const {UsageCounters} = await import('../src/usage.ts');
  const one = usageCountersFromEvent({input: 10, output: 5, cacheRead: 900, cacheWrite: 100});
  assert.deepEqual(one, {input: 10, output: 5, cache: 1000, reasoning: null, cacheRead: 900, cacheWrite: 100});
  assert.deepEqual(UsageCounters.parse(one), one);
  const both = sumUsageAttempts(one, usageCountersFromEvent({input: 1, output: 1, cacheRead: 50, cacheWrite: 0}));
  assert.equal(both.cacheRead, 950);
  assert.equal(both.cacheWrite, 100);
  // Codex reports cache read only: no split fields, as before.
  assert.equal('cacheRead' in usageCountersFromEvent({input: 10, output: 5, cacheRead: 4}, true), false);
  // An older observation without the split keeps the sum and leaves the split unknown.
  assert.equal(sumUsageAttempts({input: 1, output: 1, cache: 2, reasoning: null}, one).cacheRead, null);
});

test('uma chamada sem número não apaga as medidas do grupo: a soma fica e as faltantes são contadas', () => {
  const base = {source: 'nativo', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high', role: 'specialist', calls: 1};
  const rows: Row[] = [
    {...base, input: 2, cache: 30_000, output: 6_000},
    {...base, input: 3, cache: 10_000, output: 1_000},
    {...base, input: null, cache: null, output: null},
  ];
  const [only] = groupRows(rows);
  assert.deepEqual([only?.input, only?.cache, only?.output, only?.calls], [5, 40_000, 7_000, 3]);
  assert.deepEqual(only?.missing, {input: 1, cache: 1, output: 1});
  const text = renderReport([only!], [], []).join('\n');
  assert.match(text, /\t5 \(\+1 sem número\)\t40000 \(\+1 sem número\)\t7000 \(\+1 sem número\)\t3\t/);
  const [none] = groupRows([{...base, input: null, cache: null, output: null}]);
  assert.equal(none?.input, null);
});
