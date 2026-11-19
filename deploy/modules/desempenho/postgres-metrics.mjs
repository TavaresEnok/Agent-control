/** Medição local descartável. Apenas código fixo usa a conexão administrativa. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants, closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {DEFAULT_THRESHOLDS, normalizeCoverageRow, normalizeFinding, normalizeRepoRelativePath} from './lib.mjs';

const TOOL = 'pg_stat_statements';
const SAMPLES = 3;
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 80;
const MAX_STATEMENTS = 100;
const DEADLINE_MS = 120_000;
const ENV = {PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C', LC_ALL: 'C'};

/** Divisor conservador: sem execução de comandos psql, strings e comentários intactos. */
export function splitSql(sql) {
  const statements = [];
  let start = 0, line = 1, firstLine = null, i = 0, block = 0, quote = null, dollar = null;
  const add = end => {
    if (firstLine !== null) statements.push({sql: sql.slice(start, end).trim(), line: firstLine});
    start = end; firstLine = null;
  };
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === '\n') line++;
    if (block) {
      if (c === '/' && n === '*') { block++; i += 2; continue; }
      if (c === '*' && n === '/') { block--; i += 2; continue; }
      i++; continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) { i += dollar.length; dollar = null; } else i++;
      continue;
    }
    if (quote) {
      if (c === quote) {
        if (n === quote) { i += 2; continue; }
        quote = null;
      } else if (c === '\\' && quote === "'") {
        // Conservative for both standard and escape strings: ambiguous input is rejected later by PostgreSQL.
        if (n === '\n') line++;
        i += 2; continue;
      }
      i++; continue;
    }
    if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { block = 1; i += 2; continue; }
    if (c === '\\') throw new Error('meta-comando ou barra fora de literal recusado');
    if (!/\s/.test(c) && c !== ';' && firstLine === null) firstLine = line;
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === '$') {
      const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);
      if (match) { dollar = match[0]; i += dollar.length; continue; }
    }
    if (c === ';') { add(i + 1); i++; continue; }
    i++;
  }
  if (block || quote || dollar) throw new Error('literal ou comentário SQL não terminado');
  add(sql.length);
  return statements;
}

// Strip only leading comments for statement classification; actual SQL stays unchanged.
function command(sql) {
  return sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)+/g, '').match(/^[A-Za-z]+(?:\s+[A-Za-z]+)?/)?.[0].toUpperCase().replace(/\s+/g, ' ') ?? '';
}
function allowed(sql, migration) {
  const c = command(sql);
  return migration ? /^(?:CREATE (?:TABLE|INDEX|UNIQUE)|INSERT INTO|ALTER TABLE|ANALYZE(?: |$)|UPDATE |DELETE FROM)/.test(c)
    : /^(?:SELECT(?: |$)|WITH(?: |$))/.test(c);
}
function readSource(root, file) {
  if (normalizeRepoRelativePath(file) !== file) throw new Error('caminho SQL inválido');
  let path = root;
  for (const part of file.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error('link simbólico recusado');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('arquivo SQL inválido ou maior que 256 KiB');
    const data = readFileSync(fd);
    if (data.length > MAX_BYTES || data.includes(0)) throw new Error('conteúdo SQL inválido');
    return new TextDecoder('utf-8', {fatal: true}).decode(data);
  } finally { closeSync(fd); }
}
function run(bin, args, timeout = 30_000) {
  const result = spawnSync(bin, args, {env: ENV, cwd: '/tmp', encoding: 'utf8', timeout, maxBuffer: 64 * 1024});
  if (result.error || result.status !== 0) throw new Error(`${bin.split('/').pop()} falhou (${result.error?.code || result.status || 'sinal'})`);
  return result.stdout;
}
function client(socket, user) {
  return new pg.Client({host: socket, port: 5432, database: 'postgres', user, connectionTimeoutMillis: 4000, ssl: false, password: '', options: user === 'metrics_admin' ? '-c search_path=pg_catalog' : '-c search_path=project,pg_catalog', application_name: 'desempenho-local', types: {getTypeParser(oid, format) { return oid === 114 || oid === 3802 ? value => value : pg.types.getTypeParser(oid, format); }}});
}
// Extended protocol enforces exactly one statement. Consume rows without retaining them.
function executeOne(db, text) {
  return new Promise((resolve, reject) => {
    const query = db.query(new pg.Query({text, values: [], queryMode: 'extended'}));
    const timer = setTimeout(() => {
      db.connection.stream.destroy();
      reject(new Error('tempo de execução excedido'));
    }, 6000);
    query.on('row', () => {});
    query.on('error', error => { clearTimeout(timer); reject(error); });
    query.on('end', result => { clearTimeout(timer); resolve(result); });
  });
}
async function fixed(db, sql, values = []) { return db.query({text: sql, values, queryMode: 'extended', query_timeout: 6000}); }
function code(error) { return /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? `SQLSTATE ${error.code}` : 'erro de execução ou conexão'; }

/** Calcula somente deltas válidos da instrução corrente; max é válido após reset seletivo. */
export function computeMeasurement(before, after, expected = SAMPLES) {
  const calls = Number(after?.calls ?? 0) - Number(before?.calls ?? 0);
  const totalMs = Number(after?.total_exec_time ?? 0) - Number(before?.total_exec_time ?? 0);
  const maxMs = Number(after?.max_exec_time);
  if (Number(before?.calls ?? 0) !== 0 || calls !== expected || !Number.isFinite(totalMs) || totalMs < 0 || !Number.isFinite(maxMs) || maxMs < 0) throw new Error('contadores de medição inconsistentes');
  return {calls, totalMs, meanMs: totalMs / calls, maxMs};
}

/** Mede somente as consultas do snapshot que completaram a coleta local. */
export async function runPostgresMetrics({workRoot, sqlInfo, pgBinDir, thresholds = DEFAULT_THRESHOLDS, version = '16'}) {
  const extraCoverage = [], findings = [], analyzedQueries = [];
  const cover = (status, detail, file) => extraCoverage.push(normalizeCoverageRow({
    tool: file ? `${TOOL}:consulta` : `${TOOL}:etapa`, version, status, detail, ...(file ? {files: [file]} : {}),
  }));
  let summaryStatus = 'ok', summaryDetail = '', directory, started = false, admin, project;
  let cleanupFailed = false;
  const finish = () => ({summary: normalizeCoverageRow({tool: TOOL, version, status: summaryStatus, detail: summaryDetail}), extraCoverage, findings, analyzedQueries});
  const migrations = sqlInfo?.migrations ?? [], queries = sqlInfo?.queries ?? [];
  if (sqlInfo?.snapshotFile) cover('skipped', 'Snapshot externo ignorado: sem proveniência de medição local.');
  if (!queries.length) { summaryStatus = 'skipped'; summaryDetail = 'Nenhuma consulta SQL local disponível.'; return finish(); }
  try {
    if (!Array.isArray(migrations) || !Array.isArray(queries) || migrations.length + queries.length > MAX_FILES) throw new Error('limite ou lista de arquivos SQL inválida');
    if (!pgBinDir || !/^postgres \(PostgreSQL\) 16(?:\.|\s|$)/.test(run(join(pgBinDir, 'postgres'), ['--version']))) throw new Error('binários PostgreSQL 16 indisponíveis');
    const load = files => files.map(file => ({file, statements: splitSql(readSource(workRoot, file))}));
    const migrationFiles = load(migrations), queryFiles = load(queries);
    const count = [...migrationFiles, ...queryFiles].reduce((n, f) => n + f.statements.length, 0);
    if (count > MAX_STATEMENTS) throw new Error('limite de 100 instruções SQL excedido');
    if (!queryFiles.some(f => f.statements.length)) { summaryStatus = 'skipped'; summaryDetail = 'Arquivos de consulta sem instruções.'; return finish(); }
    directory = mkdtempSync('/tmp/ac-pg-metrics-');
    const data = join(directory, 'data');
    run(join(pgBinDir, 'initdb'), ['-D', data, '-U', 'metrics_admin', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject']);
    const options = [`-c listen_addresses=''`, `-c unix_socket_directories=${directory}`, '-c unix_socket_permissions=0700', '-c shared_preload_libraries=pg_stat_statements', '-c compute_query_id=on', '-c shared_buffers=32MB', '-c max_connections=8', '-c temp_file_limit=64MB', '-c work_mem=4MB', '-c maintenance_work_mem=32MB', '-c max_parallel_workers_per_gather=0', '-c autovacuum=off', '-c jit=off'].join(' ');
    // Stop in finally even if pg_ctl times out after starting the server.
    started = true;
    run(join(pgBinDir, 'pg_ctl'), ['-D', data, '-l', join(directory, 'server.log'), '-w', '-t', '15', '-o', options, 'start']);
    admin = client(directory, 'metrics_admin'); await admin.connect();
    const server = await fixed(admin, 'SHOW server_version_num');
    if (Math.floor(Number(server.rows[0].server_version_num) / 10000) !== 16) throw new Error('servidor não é PostgreSQL 16');
    await fixed(admin, 'CREATE ROLE metrics_project LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION');
    await fixed(admin, 'REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await fixed(admin, 'CREATE SCHEMA project AUTHORIZATION metrics_project');
    await fixed(admin, 'CREATE SCHEMA metrics_private');
    await fixed(admin, 'CREATE EXTENSION pg_stat_statements WITH SCHEMA metrics_private');
    await fixed(admin, 'REVOKE ALL ON SCHEMA metrics_private FROM PUBLIC');
    await fixed(admin, "ALTER ROLE metrics_project SET search_path TO project, pg_catalog");
    await fixed(admin, "ALTER ROLE metrics_project SET statement_timeout TO '4s'");
    await fixed(admin, "ALTER ROLE metrics_project SET lock_timeout TO '1s'");
    await fixed(admin, "ALTER ROLE metrics_project SET idle_in_transaction_session_timeout TO '5s'");
    project = client(directory, 'metrics_project'); await project.connect();
    const deadline = Date.now() + DEADLINE_MS;
    const checkDeadline = () => { if (Date.now() > deadline) throw new Error('tempo total de medição excedido'); };
    await fixed(project, 'BEGIN');
    try {
      for (const file of migrationFiles) for (const statement of file.statements) {
        checkDeadline();
        if (!allowed(statement.sql, true)) throw new Error(`migração fora do contrato: ${file.file}:${statement.line}`);
        await executeOne(project, statement.sql);
      }
      await fixed(project, 'COMMIT');
    } catch (error) { try { await fixed(project, 'ROLLBACK'); } catch {} throw error; }
    const identity = await fixed(admin, "SELECT (SELECT oid FROM pg_roles WHERE rolname='metrics_project')::text AS uid, (SELECT oid FROM pg_database WHERE datname=current_database())::text AS dbid");
    const {uid, dbid} = identity.rows[0];
    const stats = async id => {
      await fixed(admin, 'SELECT pg_stat_clear_snapshot()');
      const result = await fixed(admin, 'SELECT calls, total_exec_time, max_exec_time FROM metrics_private.pg_stat_statements WHERE userid=$1::oid AND dbid=$2::oid AND queryid=$3::bigint AND toplevel', [uid, dbid, id]);
      if (result.rows.length > 1) throw new Error('múltiplos registros para a instrução');
      return result.rows[0] ?? {calls: 0, total_exec_time: 0};
    };
    for (const file of queryFiles) {
      if (!file.statements.length) cover('skipped', `${file.file}: arquivo sem instruções.`, file.file);
      for (const statement of file.statements) {
        checkDeadline();
        const location = `${file.file}:${statement.line}`;
        if (!allowed(statement.sql, false)) { cover('skipped', `${location}: somente SELECT ou WITH em transação somente leitura.`, file.file); continue; }
        try {
          await fixed(project, 'BEGIN READ ONLY');
          let plan;
          try { plan = await fixed(project, `EXPLAIN (VERBOSE, FORMAT JSON) ${statement.sql}`); }
          finally { await fixed(project, 'ROLLBACK'); }
          const planText = plan.rows[0]?.['QUERY PLAN'];
          const identifier = typeof planText === 'string' ? (planText.match(/"Query Identifier"\s*:\s*(-?\d+)/)?.[1] ?? '') : '';
          if (!/^-?\d+$/.test(identifier) || identifier === '0') throw new Error('identificador do plano indisponível');
          await fixed(admin, 'SELECT metrics_private.pg_stat_statements_reset($1::oid, $2::oid, $3::bigint)', [uid, dbid, identifier]);
          const before = await stats(identifier);
          for (let i = 0; i < SAMPLES; i++) {
            checkDeadline();
            await fixed(project, 'BEGIN READ ONLY');
            try { await executeOne(project, statement.sql); }
            finally { await fixed(project, 'ROLLBACK'); }
          }
          const after = await stats(identifier);
          const measurement = computeMeasurement(before, after);
          const hash = createHash('sha256').update(statement.sql).digest('hex').slice(0, 16);
          const evidence = `arquivo=${location}; sha256=${hash}; queryid=${identifier}`;
          const details = `${evidence}; antes=${Number(before.calls)} chamadas/${Number(before.total_exec_time).toFixed(3)}ms; depois=${Number(after.calls)} chamadas/${Number(after.total_exec_time).toFixed(3)}ms; média=${measurement.meanMs.toFixed(3)}ms; máximo=${measurement.maxMs.toFixed(3)}ms`;
          analyzedQueries.push({file: file.file, line: statement.line, statementHash: hash, ...measurement});
          cover('ok', details, file.file);
          if (measurement.meanMs > thresholds.sqlMeanMs || measurement.maxMs > thresholds.sqlMaxMs) findings.push(normalizeFinding({tool: TOOL, rule: measurement.meanMs > thresholds.sqlMeanMs ? 'PG-QUERY-SLOW-MEAN' : 'PG-QUERY-SLOW-MAX', file: file.file, line: statement.line, severity: measurement.meanMs > thresholds.sqlMeanMs * 2 || measurement.maxMs > thresholds.sqlMaxMs * 2 ? 'alta' : 'media', message: 'Consulta SQL lenta na medição local descartável.', evidence: details}));
        } catch (error) { cover('failed', `${location}: medição indisponível (${code(error)}).`, file.file); }
      }
    }
    summaryStatus = analyzedQueries.length ? 'ok' : (extraCoverage.some(row => row.status === 'failed') ? 'failed' : 'skipped');
    summaryDetail = `${analyzedQueries.length} instrução(ões) medida(s) independentemente; ${findings.length} consulta(s) lenta(s).`;
  } catch (error) {
    summaryStatus = 'failed'; summaryDetail = `Coletor SQL indisponível: ${error instanceof Error ? error.message.slice(0, 180) : 'erro inesperado'}.`;
    if (analyzedQueries.length) {
      cover('failed', summaryDetail);
      summaryStatus = 'ok';
      summaryDetail = `${analyzedQueries.length} instrução(ões) medida(s) antes da interrupção.`;
    }
  } finally {
    if (project) try { await project.end(); } catch { cleanupFailed = true; cover('failed', 'Falha ao fechar conexão de projeto.'); }
    if (admin) try { await admin.end(); } catch { cleanupFailed = true; cover('failed', 'Falha ao fechar conexão administrativa.'); }
    let stopped = !started;
    if (started) try { run(join(pgBinDir, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', '-t', '15', 'stop'], 20_000); stopped = true; } catch { cleanupFailed = true; cover('failed', 'Falha ao confirmar parada do PostgreSQL descartável; contêiner será removido.'); }
    if (directory && stopped) try { rmSync(directory, {recursive: true, force: true}); } catch { cleanupFailed = true; cover('failed', 'Falha ao remover diretório temporário PostgreSQL.'); }
  }
  if (cleanupFailed) {
    summaryStatus = 'failed';
    summaryDetail = 'Limpeza PostgreSQL não confirmada dentro do coletor.';
    findings.length = 0;
    analyzedQueries.length = 0;
  }
  return finish();
}
