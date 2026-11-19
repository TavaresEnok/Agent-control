import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {executionAllowed, runBoundedProcess} from '../execute-tests.mjs';

const port = '5432';
const binaries = '/usr/lib/postgresql/16/bin';
const pgVersion = '160014';
const pgTapVersion = '1.3.2';
export const bancoLocalVersion = 'PostgreSQL 16.14 / pgTAP 1.3.2';
const admin = 'qa_admin';
const project = 'qa_project';
const databases = ['fresh', 'previous', 'upgraded'];
const tapLabel = 'invariante funcional';

export function parseTap(output) {
  const [plan, result, ...diagnostics] = output.trim().split('\n');
  if (plan !== '1..1') return 'invalid';
  if (result === `ok 1 - ${tapLabel}` && diagnostics.length === 0) return 'passed';
  if (result === `not ok 1 - ${tapLabel}` && diagnostics.every(line => line.startsWith('#'))) return 'failed';
  return 'invalid';
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
    if (db !== 'postgres' && !databases.includes(db)) throw new Error('invalid database');
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
      await psql('postgres', [
        `CREATE ROLE ${project} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`,
        ...databases.map(db => `CREATE DATABASE ${db} OWNER ${project}`),
      ], admin);
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

  async function assert(db, predicate) {
    const installed = await psql(db, [
      'BEGIN',
      'CREATE SCHEMA qa_tap',
      'CREATE EXTENSION pgtap WITH SCHEMA qa_tap',
      `GRANT USAGE ON SCHEMA qa_tap TO ${project}`,
      "SELECT extversion FROM pg_catalog.pg_extension WHERE extname = 'pgtap'",
      'COMMIT',
    ], admin);
    try {
      if (installed.trim() !== pgTapVersion) throw new Error('unexpected pgTAP version');
      return parseTap(await psql(db, [
        'BEGIN',
        'SET LOCAL search_path TO qa_tap, public',
        'SELECT qa_tap.plan(1)',
        `SELECT qa_tap.ok((\n${predicate}\n), '${tapLabel}')`,
        'SELECT * FROM qa_tap.finish()',
        'ROLLBACK',
      ]));
    } finally {
      await psql(db, ['BEGIN', 'DROP EXTENSION pgtap', 'DROP SCHEMA qa_tap', 'COMMIT'], admin);
    }
  }

  return {
    start,
    stop,
    // O prefixo fixo torna -c uma consulta SQL, inclusive quando a fixture começa por barra invertida.
    sql: (db, sql) => psql(db, [`SET client_min_messages = warning;\n${sql}`]),
    assert,
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
