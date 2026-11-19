import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {executionAllowed, runBoundedProcess} from '../execute-tests.mjs';

const port = '5432';
const binaries = '/usr/lib/postgresql/16/bin';
const pgVersion = '160015';
const pgTapVersion = '1.3.2';
export const bancoLocalVersion = 'PostgreSQL 16.15 / pgTAP 1.3.2';
const admin = 'qa_admin';
const project = 'qa_project';
const attestation = 'qa_attestation';
const databases = ['fresh', 'previous', 'upgraded'];
const tapLabel = 'invariante funcional';
const booleanColumn = '{16}'; // OID do tipo boolean nativo em pg_catalog.pg_type.
const firstNormalObjectOid = 16384; // OIDs reservados ao initdb ficam abaixo desse limite no PostgreSQL 16.
// O schema public padrão pertence implicitamente ao dono do banco.
const fixtureScope = `
  fixture_schemas AS (
    SELECT oid, nspname FROM pg_namespace
    WHERE nspowner = '${project}'::regrole
       OR (nspname = 'public' AND nspowner = 'pg_database_owner'::regrole AND EXISTS (
         SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = '${project}'::regrole
       ))
  ),
  fixture_relations AS (
    SELECT c.oid, n.nspname, c.relname FROM pg_class c JOIN fixture_schemas n ON n.oid = c.relnamespace
    WHERE c.relowner = '${project}'::regrole AND c.relkind IN ('r', 'p', 'v', 'm')
  )`;

async function readerScopeConfirmed(psql, db, reader) {
  try {
    const result = await psql(db, [
      'BEGIN READ ONLY',
      'SET LOCAL search_path TO pg_catalog, pg_temp',
      // O SELECT no pai pode alcançar descendentes sem consultar as ACLs deles.
      `WITH RECURSIVE ${fixtureScope},
      reachable_relations AS (
        SELECT oid FROM fixture_relations
        UNION
        SELECT i.inhrelid FROM pg_catalog.pg_inherits i
        JOIN reachable_relations r ON r.oid = i.inhparent
      )
      SELECT NOT EXISTS (
        SELECT 1 FROM reachable_relations r
        WHERE NOT EXISTS (SELECT 1 FROM fixture_relations f WHERE f.oid = r.oid)
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_class c
        WHERE c.oid >= ${firstNormalObjectOid}
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND NOT EXISTS (SELECT 1 FROM fixture_relations f WHERE f.oid = c.oid)
          AND (
            has_schema_privilege('${reader}'::regrole::oid, c.relnamespace, 'USAGE')
            AND CASE WHEN c.relkind = 'S' THEN
              has_sequence_privilege('${reader}'::regrole::oid, c.oid, 'SELECT')
            ELSE
              has_table_privilege('${reader}'::regrole::oid, c.oid, 'SELECT')
              OR has_any_column_privilege('${reader}'::regrole::oid, c.oid, 'SELECT')
            END
          ) IS NOT FALSE
      )`,
      'ROLLBACK',
    ], admin);
    return result === 't\n';
  } catch {
    return false;
  }
}

export function parseTap(output) {
  const [plan, result, ...diagnostics] = output.trim().split('\n');
  if (plan !== '1..1') return 'invalid';
  if (result === `ok 1 - ${tapLabel}` && diagnostics.length === 0) return 'passed';
  if (result === `not ok 1 - ${tapLabel}` && diagnostics.every(line => line.startsWith('#'))) return 'failed';
  return 'invalid';
}

export async function setupPostgres(psql) {
  await psql('postgres', [
    `CREATE ROLE ${project} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
    ...databases.map(db => `CREATE DATABASE ${db} OWNER ${project}`),
    ...['postgres', 'template0', 'template1', ...databases].map(db =>
      `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC`),
    `CREATE DATABASE ${attestation} WITH TEMPLATE template0`,
    `REVOKE ALL ON DATABASE ${attestation} FROM PUBLIC`,
  ], admin);
  const installed = await psql(attestation, [
    'CREATE SCHEMA qa_tap',
    'CREATE EXTENSION pgtap WITH SCHEMA qa_tap',
    "SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'pgtap'",
  ], admin);
  if (installed.trim() !== pgTapVersion) throw new Error('unexpected pgTAP version');
}

export async function attestPostgres(psql, db, predicate) {
  if (!databases.includes(db)) throw new Error('invalid fixture database');
  const reader = `qa_reader_${randomBytes(12).toString('hex')}`;
  let scalar;
  try {
    await psql(db, [
      'BEGIN',
      'SET LOCAL search_path TO pg_catalog, pg_temp',
      `CREATE ROLE ${reader} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
      `GRANT CONNECT ON DATABASE ${db} TO ${reader}`,
      `DO $scope$
      DECLARE grant_sql text;
      BEGIN
        FOR grant_sql IN
          WITH ${fixtureScope}
          SELECT format('GRANT USAGE ON SCHEMA %I TO %I', nspname, '${reader}')
          FROM fixture_schemas
          UNION ALL
          SELECT format('GRANT SELECT ON TABLE %I.%I TO %I', nspname, relname, '${reader}')
          FROM fixture_relations
        LOOP
          EXECUTE grant_sql;
        END LOOP;
      END
      $scope$`,
      'COMMIT',
    ], admin);
    if (!await readerScopeConfirmed(psql, db, reader)) return 'scope-unconfirmed';

    scalar = await psql(db, [
      'BEGIN READ ONLY',
      'SET LOCAL search_path TO pg_catalog, public',
      // Com -c, \bind envia somente o próximo comando pelo protocolo estendido.
      '\\bind',
      `PREPARE qa_scalar AS\n${predicate}`,
      "SELECT result_types::pg_catalog.oid[] FROM pg_catalog.pg_prepared_statements WHERE name = 'qa_scalar'",
      'EXECUTE qa_scalar',
      'ROLLBACK',
    ], reader);
  } finally {
    await psql(db, [
      'BEGIN',
      'SET LOCAL search_path TO pg_catalog, pg_temp',
      `DO $scope$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${reader}') THEN
          DROP OWNED BY ${reader};
          DROP ROLE ${reader};
        END IF;
      END
      $scope$`,
      'COMMIT',
    ], admin);
  }
  // A primeira linha é a lista de tipos. A segunda é o único valor retornado.
  if (scalar !== `${booleanColumn}\nt\n` && scalar !== `${booleanColumn}\nf\n`) return 'invalid';

  return parseTap(await psql(attestation, [
    'BEGIN',
    'SET LOCAL search_path TO pg_catalog, qa_tap, pg_temp',
    'SELECT qa_tap.plan(1)',
    `SELECT qa_tap.ok(${scalar === `${booleanColumn}\nt\n` ? 'TRUE' : 'FALSE'}, '${tapLabel}')`,
    'SELECT * FROM qa_tap.finish()',
    'ROLLBACK',
  ], admin));
}

export function createLocalPostgres(repoDir) {
  if (!executionAllowed(repoDir)) throw new Error('QA isolation required');
  const deadline = performance.now() + 45_000;
  const directory = mkdtempSync('/tmp/qa-pg-');
  const data = join(directory, 'data');
  const archive = join(directory, 'previous.dump');
  const env = {
    PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8', TZ: 'UTC',
    PGCONNECT_TIMEOUT: '2',
  };
  let server;
  let closed;
  let exited = false;

  async function run(name, args, timeoutMs = 8_000) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error('postgres measurement timeout');
    const {code, output} = await runBoundedProcess(join(binaries, name), args, directory, {
      env, timeoutMs: Math.min(timeoutMs, remaining), maxBytes: 64 * 1024,
    });
    if (code !== 0) throw new Error('postgres command failed');
    return output;
  }

  function connection(db, user = project) {
    if (!databases.includes(db) && !(user === admin && (db === 'postgres' || db === attestation))) {
      throw new Error('invalid database');
    }
    return ['--host', directory, '--port', port, '--username', user, '--dbname', db];
  }

  function psql(db, commands, user = project) {
    return run('psql', ['-XAtqw', '-v', 'ON_ERROR_STOP=1', ...connection(db, user),
      ...commands.flatMap(sql => ['-c', sql])]);
  }

  async function start() {
    await run('initdb', ['-D', data, '-U', admin, '--no-locale', '--encoding=UTF8',
      '--auth-local=trust', '--auth-host=reject'], 15_000);
    server = spawn(join(binaries, 'postgres'), ['-D', data, '-h', '', '-k', directory, '-p', port,
      '-c', 'unix_socket_permissions=0700', '-c', 'shared_buffers=16MB',
      '-c', 'dynamic_shared_memory_type=mmap', '-c', 'max_connections=8',
      '-c', 'temp_file_limit=16MB', '-c', 'statement_timeout=5000',
      '-c', 'lock_timeout=2000', '-c', 'idle_in_transaction_session_timeout=5000',
      '-c', 'autovacuum=off', '-c', 'jit=off'], {cwd: directory, env, stdio: 'ignore'});
    server.on('error', () => { exited = true; });
    closed = new Promise(resolve => server.once('close', () => {
      exited = true;
      resolve();
    }));
    const startupDeadline = performance.now() + 8_000;
    while (!exited && performance.now() < startupDeadline) {
      let version;
      try {
        version = await psql('postgres', ['SHOW server_version_num'], admin);
      } catch {
        await delay(100);
        continue;
      }
      if (version.trim() !== pgVersion) throw new Error('unexpected PostgreSQL version');
      await setupPostgres(psql);
      return;
    }
    throw new Error('local postgres unavailable');
  }

  async function stop() {
    try {
      if (server && !exited) {
        server.kill('SIGINT');
        const killTimer = setTimeout(() => server.kill('SIGQUIT'), 2_000);
        const abort = new AbortController();
        try {
          if (!await Promise.race([closed.then(() => true), delay(5_000, false, {signal: abort.signal})])) {
            throw new Error('postgres shutdown timeout');
          }
        } finally {
          clearTimeout(killTimer);
          abort.abort();
        }
      }
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  }

  return {
    start,
    stop,
    // O prefixo fixo torna -c uma consulta SQL, inclusive quando a fixture começa por barra invertida.
    sql: (db, sql) => psql(db, [`SET client_min_messages = warning;\n${sql}`]),
    assert: (db, predicate) => attestPostgres(psql, db, predicate),
    async dump() {
      await run('pg_dump', [...connection('previous'), '--format=custom',
        '--no-owner', '--no-privileges', '--file', archive]);
    },
    async restore() {
      await run('pg_restore', [...connection('upgraded'), '--no-owner', '--no-privileges',
        '--exit-on-error', '--single-transaction', archive]);
    },
  };
}
