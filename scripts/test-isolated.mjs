// A deliberately narrow integration bench: real Happier light + disposable PG.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, symlink, rm, open, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import pg from 'pg';

const root = resolve(import.meta.dirname, '..');
const server = join(root, 'upstream/happier/apps/server');
const project = `ac-r2-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const compose = ['compose', '-p', project, '-f', join(root, 'deploy/compose.round2-test.yml')];
const logDir = process.env.AC_ISOLATED_LOG_DIR ? resolve(process.env.AC_ISOLATED_LOG_DIR) : null;
let scratch, child, started = false;
let safeEnv;
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', env: safeEnv, ...options });
  if (result.error || result.status !== 0) throw Error(`${cmd} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout?.trim() ?? '';
}
async function freePort() {
  const listener = net.createServer();
  await new Promise((ok, fail) => listener.once('error', fail).listen(0, '127.0.0.1', ok));
  const port = listener.address().port;
  await new Promise(ok => listener.close(ok));
  if (port === 5432 || port === 18401) return freePort();
  return port;
}
async function waitFor(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child && child.exitCode !== null) throw Error(`Happier exited (${child.exitCode}); see server log`);
    try { if (await fn()) return; } catch {}
    await new Promise(ok => setTimeout(ok, 250));
  }
  throw Error(`Timed out waiting for ${what}`);
}
try {
  if (Number(process.versions.node.split('.')[0]) !== 22 || process.versions.node.localeCompare('22.23.3', undefined, {numeric:true}) < 0) throw Error('Node >=22.23.3 <23 required');
  scratch = await mkdtemp(join(tmpdir(), 'ac-isolated-'));
  safeEnv = {HOME:scratch, PATH:process.env.PATH ?? '/usr/bin:/bin'};
  for (const name of ['LANG','TZ','TMPDIR']) if (process.env[name]) safeEnv[name] = process.env[name];
  for (const [cmd, args] of [['docker', ['compose', 'version']], ['git', ['--version']], ['yarn', ['--version']]]) run(cmd, args);
  run('docker', ['image', 'inspect', 'postgres:16-alpine']);
  // The boundary bundle alone cannot run the canonical server.
  if (!existsSync(join(root, 'upstream/happier/node_modules/.bin/tsx')) || !existsSync(join(root, 'upstream/happier/apps/server/node_modules/fastify-type-provider-zod')) || !existsSync(join(server, 'generated/sqlite-client/index.js'))) throw Error('Happier server dependencies absent; install the pinned upstream workspace dependencies and generated SQLite client before retrying');
  if (logDir) await mkdir(logDir, {recursive:true});
  const logs = await mkdtemp(join(logDir ?? tmpdir(), 'ac-isolated-logs-'));
  console.log(`project=${project} scratch=${scratch} logs=${logs}`);
  for (const name of ['src','tests','db','adapters','upstream','node_modules','package.json']) await symlink(join(root,name), join(scratch,name));
  await mkdir(join(scratch,'.state/projects'), {recursive:true});
  await mkdir(join(scratch,'docs/validation/evidence'), {recursive:true});
  const port = await freePort();
  safeEnv.AC_ISOLATED_PG_PORT = String(port);
  const dbLog = await open(join(logs,'postgres.log'),'w');
  started = true; run('docker', [...compose, 'up', '-d', '--no-build'], {stdio:['ignore', dbLog.fd, dbLog.fd]}); await dbLog.close();
  const database = `postgresql://ac_test:synthetic-test-only@127.0.0.1:${port}/ac_implementation_test`;
  await waitFor(async () => {
    const id = run('docker', [...compose,'ps','-q','db']);
    if (!id || run('docker',['inspect','-f','{{.State.Running}}',id]) !== 'true') return false;
    const logResult = spawnSync('docker',['logs',id],{encoding:'utf8',env:safeEnv});
    const pgLogs = (logResult.stdout ?? '') + (logResult.stderr ?? '');
    if (logResult.status !== 0 || !pgLogs.includes(`listening on IPv4 address "127.0.0.1", port ${port}`) || !pgLogs.includes('database system is ready to accept connections')) return false;
    const c = new pg.Client({connectionString:database, connectionTimeoutMillis:500}); try {await c.connect(); return true;} finally {await c.end().catch(()=>{});}}, 'PostgreSQL');
  const httpPort = await freePort();
  const data = join(scratch,'happier'); await mkdir(data);
  const env = {...safeEnv, CI:'1', EXPO_NO_TELEMETRY:'1', DO_NOT_TRACK:'1', PORT:String(httpPort), METRICS_ENABLED:'false', AUTH_ANONYMOUS_SIGNUP_ENABLED:'true', HAPPIER_FILES_BACKEND:'local', HAPPIER_DB_PROVIDER:'sqlite', HAPPY_DB_PROVIDER:'sqlite', HAPPIER_SERVER_LIGHT_DATA_DIR:data, HAPPIER_SERVER_HOST:'127.0.0.1', HAPPY_SERVER_HOST:'127.0.0.1', DATABASE_URL:`file:${data}/server.sqlite?socket_timeout=30&connection_limit=1`, HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY:'required_e2ee'};
  const serverLog = await open(join(logs,'happier.log'),'w');
  run('yarn',['-s','migrate:sqlite:deploy'],{cwd:server,env,stdio:['ignore',serverLog.fd,serverLog.fd]});
  child = spawn('yarn',['-s','start:light'],{cwd:server,env,stdio:['ignore',serverLog.fd,serverLog.fd],detached:true});
  child.on('error', e => console.error('Happier spawn error:',e));
  await waitFor(async () => {if (!(await readFile(join(logs,'happier.log'),'utf8')).includes(`Server listening at http://127.0.0.1:${httpPort}`)) return false; const r=await fetch(`http://127.0.0.1:${httpPort}/v1/account/profile`); return r.status === 401;}, 'Happier HTTP');
  const testLog = await open(join(logs,'tests.log'),'w');
  const files = process.env.AC_ISOLATED_EXPORT_ONLY === '1' ? [join(root,'scripts/fixtures/export-context.test.ts')] : [join(root,'tests/happier.test.ts'),join(root,'tests/import.test.ts'),join(root,'scripts/fixtures/export-context.test.ts')];
  const result = spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1',...files],{cwd:scratch,env:{...safeEnv,AC_TEST_DATABASE_URL:database,AC_TEST_HAPPIER_URL:`http://127.0.0.1:${httpPort}`},stdio:['ignore',testLog.fd,testLog.fd]});
  await testLog.close(); await serverLog.close();
  if (result.error || result.status !== 0) throw Error(`integration tests failed (${result.error?.message ?? result.status}); see ${join(logs,'tests.log')}`);
  const output = await readFile(join(logs,'tests.log'), 'utf8');
  if (/^# skipped [1-9]/m.test(output) || /# SKIP\b/i.test(output)) throw Error(`integration tests skipped cases; see ${join(logs,'tests.log')}`);
  console.log('Happier + import integration passed; see tests.log');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  if (child?.pid) {
    try { process.kill(-child.pid,'SIGTERM'); } catch {}
    await Promise.race([new Promise(ok => child.once('exit',ok)), new Promise(ok => setTimeout(ok,3000))]);
    try { process.kill(-child.pid,'SIGKILL'); } catch {}
  }
  if (started) { const r=spawnSync('docker',[...compose,'down','--volumes','--remove-orphans'],{stdio:'inherit',env:safeEnv}); if (r.status !== 0) { console.error(`Cleanup failed; inspect project ${project}`); process.exitCode=1; } }
  if (scratch) await rm(scratch,{recursive:true,force:true});
}
