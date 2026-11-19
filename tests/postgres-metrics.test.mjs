import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {splitSql, computeMeasurement, runPostgresMetrics} from '../deploy/modules/desempenho/postgres-metrics.mjs';

const thresholds = {sqlMeanMs: 50, sqlMaxMs: 120};

test('separa instruções e linhas sem interpretar literais, comentários ou meta-comandos', () => {
  assert.deepEqual(splitSql("-- comentário ;\nSELECT ';' AS x;\n/* a /* ; */ b */\nSELECT $$;$$;"), [
    {line: 2, sql: "-- comentário ;\nSELECT ';' AS x;"},
    {line: 4, sql: '/* a /* ; */ b */\nSELECT $$;$$;'},
  ]);
  assert.throws(() => splitSql('SELECT 1;\n\\i arquivo'), /meta-comando/);
  assert.throws(() => splitSql("SELECT 'não terminado"), /não terminado/);
});

test('exige contadores independentes e rejeita deltas incompletos', () => {
  assert.deepEqual(computeMeasurement({calls: '0', total_exec_time: '0'}, {calls: '3', total_exec_time: '210', max_exec_time: '100'}), {calls: 3, totalMs: 210, meanMs: 70, maxMs: 100});
  assert.throws(() => computeMeasurement({calls: '1', total_exec_time: '10'}, {calls: '4', total_exec_time: '100', max_exec_time: '50'}), /inconsistentes/);
  assert.throws(() => computeMeasurement({calls: '0', total_exec_time: '0'}, {calls: '2', total_exec_time: '20', max_exec_time: '10'}), /inconsistentes/);
});

test('fluxo sintético preserva identidade inteira e separa consultas com queryid igual', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c7-sql-test-'));
  const bin = join(dir, 'bin'), root = join(dir, 'repo'); mkdirSync(bin); mkdirSync(root);
  for (const name of ['postgres', 'initdb', 'pg_ctl']) {
    writeFileSync(join(bin, name), name === 'postgres' ? '#!/bin/sh\necho "postgres (PostgreSQL) 16.2"\n' : '#!/bin/sh\nexit 0\n', {mode: 0o755});
  }
  writeFileSync(join(root, 'queries.sql'), '-- rápido\nSELECT 1;\n-- lento\nSELECT 2;\nDROP TABLE project.t;\n');
  const previousClient = pg.Client, actions = [], id = '9223372036854775806';
  let calls = 0, total = 0, max = 0, resets = 0;
  class FakeClient {
    constructor(options) { this.user = options.user; this.connection = {stream: {destroy() {}}}; }
    async connect() {}
    async end() {}
    query(input) {
      if (input instanceof pg.Query) {
        actions.push([this.user, input.text, input.queryMode]);
        queueMicrotask(() => {
          const time = input.text.includes('SELECT 2') ? 80 : 1;
          calls++; total += time; max = Math.max(max, time);
          input.emit('end', {});
        });
        return input;
      }
      const sql = input.text;
      actions.push([this.user, sql, input.queryMode]);
      if (sql === 'SHOW server_version_num') return Promise.resolve({rows: [{server_version_num: '160002'}]});
      if (sql.startsWith('EXPLAIN')) return Promise.resolve({rows: [{'QUERY PLAN': `[{"Query Identifier": ${id}}]`}]});
      if (sql.includes('FROM pg_roles')) return Promise.resolve({rows: [{uid: '100', dbid: '5'}]});
      if (sql.includes('pg_stat_statements_reset')) { assert.deepEqual(input.values, ['100', '5', id]); calls = 0; total = 0; max = 0; resets++; }
      if (sql.startsWith('SELECT calls,')) return Promise.resolve({rows: calls ? [{calls: String(calls), total_exec_time: String(total), max_exec_time: String(max)}] : []});
      return Promise.resolve({rows: []});
    }
  }
  pg.Client = FakeClient;
  try {
    const output = await runPostgresMetrics({workRoot: root, sqlInfo: {migrations: [], queries: ['queries.sql'], snapshotFile: 'outro.json'}, pgBinDir: bin, thresholds, version: '16.2'});
    assert.equal(output.summary.status, 'ok');
    assert.equal(resets, 2);
    assert.deepEqual(output.analyzedQueries.map(q => [q.line, q.meanMs]), [[2, 1], [4, 80]]);
    assert.equal(output.findings.length, 1);
    assert.ok(output.extraCoverage.some(row => row.status === 'skipped' && row.detail.includes('queries.sql:5')));
    assert.ok(!actions.some(([, sql]) => sql.includes('DROP TABLE')));
    assert.equal(output.findings[0].line, 4);
    assert.equal(output.findings[0].rule, 'PG-QUERY-SLOW-MEAN');
    assert.match(output.findings[0].evidence, new RegExp(`queryid=${id}`));
    assert.ok(output.extraCoverage.some(row => row.status === 'skipped' && row.detail.includes('Snapshot externo')));
    assert.ok(actions.filter(([, sql]) => /SELECT [12]/.test(sql)).every(([user, , mode]) => user === 'metrics_project' && mode === 'extended'));
    assert.equal(actions.filter(([, sql]) => sql === 'ROLLBACK').length, 8);
  } finally { pg.Client = previousClient; rmSync(dir, {recursive: true, force: true}); }
});

test('falha de inicialização é coverage, nunca achado', async () => {
  const output = await runPostgresMetrics({workRoot: '/inexistente', sqlInfo: {migrations: [], queries: ['consulta.sql']}, pgBinDir: '/inexistente', thresholds});
  assert.equal(output.summary.status, 'failed');
  assert.deepEqual(output.findings, []);
});

const pgBin = '/usr/lib/postgresql/16/bin';
test('prova local com PostgreSQL 16 descartável, quando disponível', {skip: !existsSync(join(pgBin, 'initdb')) || !existsSync(join(pgBin, 'pg_ctl'))}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'c7-sql-real-'));
  const before = new Set(readdirSync('/tmp').filter(name => name.startsWith('ac-pg-metrics-')));
  try {
    writeFileSync(join(root, 'queries.sql'), 'SELECT pg_sleep(0.001);\nSELECT pg_sleep(0.08);\n');
    const output = await runPostgresMetrics({workRoot: root, sqlInfo: {migrations: [], queries: ['queries.sql']}, pgBinDir: pgBin, thresholds: {sqlMeanMs: 40, sqlMaxMs: 150}});
    assert.equal(output.summary.status, 'ok', JSON.stringify(output));
    assert.deepEqual(output.analyzedQueries.map(q => q.line), [1, 2]);
    assert.deepEqual(output.findings.map(q => q.line), [2]);
    assert.deepEqual(readdirSync('/tmp').filter(name => name.startsWith('ac-pg-metrics-') && !before.has(name)), []);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
