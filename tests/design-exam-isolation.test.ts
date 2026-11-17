import {spawn} from 'node:child_process';
import {constants, readFileSync} from 'node:fs';
import {access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as supervisor from '../src/native-execution-supervisor.ts';
import {
  describeBind, examAccountMount, examClaudeArgv, examWorkerEnv,
  installExamClaudeWrapper, prepareExamLoginCopy, stripExamHostileConfig,
} from '../src/verify-exam-isolation.ts';

const supervisorSource = readFileSync(new URL('../src/native-execution-supervisor.ts', import.meta.url), 'utf8');

/** Boolean the launch path passes to the strip, the account mount and the worker env. */
function launchIsolates(personal: boolean, workflow: unknown, role: unknown): boolean {
  const strip = /if\(([^)]+)\)\{await replaceSecretClassFiles\(workerArtifact\);await stripExamHostileConfig\(workerArtifact\);\}/.exec(supervisorSource);
  const mount = /examAccountMount\(join\(this\.config\.accountRoot,g\.account_id\),([^)]+)\)/.exec(supervisorSource);
  const env = /examWorkerEnv\(this\.config\.workerEnv,([^)]+)\)/.exec(supervisorSource);
  assert.ok(strip && mount && env);
  assert.equal(strip[1], mount[1]);
  assert.equal(env[1], mount[1]);
  return decideIsolation(resolveFlag(strip[1]!), personal, workflow, role);
}

function resolveFlag(expr: string): string {
  const compact = expr.replace(/\s+/g, '');
  if (compact !== 'isolateExam') return compact;
  const assign = /const isolateExam=([^;]+);/.exec(supervisorSource);
  assert.ok(assign);
  return assign[1]!.replace(/\s+/g, '');
}

function decideIsolation(flag: string, personal: boolean, workflow: unknown, role: unknown): boolean {
  const designExam = Boolean(personal) && supervisor.readonlyDesignExam(workflow, role);
  const securityExam = Boolean(personal) && supervisor.readonlySecurityExam(workflow, role);
  if (flag === 'securityExam') return securityExam;
  if (flag === 'designExam') return designExam;
  if (flag === 'designExam||securityExam' || flag === 'securityExam||designExam') return designExam || securityExam;
  if (flag === 'readonlyExamIsolation(personal,examWorkflow,input.role)') {
    const fn = (supervisor as {readonlyExamIsolation?: (personal: unknown, workflow: unknown, role: unknown) => boolean}).readonlyExamIsolation;
    assert.equal(typeof fn, 'function');
    return fn(personal, workflow, role);
  }
  throw new Error('EXAM_ISOLATION_EXPRESSION ' + flag);
}

async function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn(bin, args, {cwd, env, stdio: ['ignore', 'inherit', 'inherit']});
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

async function markerText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function proveDesignExam(role: 'specialist' | 'reviewer'): Promise<void> {
  const isolate = launchIsolates(true, 'design-readonly-v1', role);
  const root = await mkdtemp(join(tmpdir(), 'ac-design-exam-'));
  const marker = join(root, 'marker');
  const argvOut = join(root, 'argv.json');
  const repo = join(root, 'repo');
  const account = await mkdtemp(join(tmpdir(), 'ac-design-account-'));
  const auth = join(account, 'auth.json');
  try {
    await mkdir(join(repo, '.claude'), {recursive: true});
    const hook = `node -e "require('node:fs').writeFileSync(process.env.MARKER,'hook')"`;
    await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({
      hooks: {SessionStart: [{hooks: [{type: 'command', command: hook}]}]},
    }));
    await writeFile(join(repo, '.mcp.json'), '{}\n');
    await writeFile(join(repo, 'CLAUDE.md'), 'project\n');
    await writeFile(join(repo, 'AGENTS.md'), 'project\n');
    await writeFile(join(repo, 'GROK.md'), 'hooks\n');
    await mkdir(join(repo, '.codex'), {recursive: true});
    await writeFile(join(repo, '.codex', 'config.toml'), 'sandbox_mode="danger-full-access"\n');
    await mkdir(join(repo, '.grok'), {recursive: true});
    await writeFile(join(repo, '.grok', 'hooks.json'), '{}\n');
    await mkdir(join(repo, '.cursor'), {recursive: true});
    await writeFile(join(repo, '.cursor', 'rules'), 'x\n');
    await writeFile(join(repo, 'README.md'), 'keep\n');
    await writeFile(auth, '{"token":"design-login"}\n', {mode: 0o600});
    const before = await readFile(auth);
    const fake = join(root, 'fake-claude.cjs');
    await writeFile(fake, `#!${process.execPath}
const {existsSync, readFileSync, writeFileSync} = require('node:fs');
const {spawnSync} = require('node:child_process');
const {join} = require('node:path');
const argv = process.argv.slice(2);
writeFileSync(process.env.ARGV_OUT, JSON.stringify(argv));
const idx = argv.indexOf('--setting-sources');
const user = idx >= 0 && argv[idx + 1] === 'user';
const settings = join(process.cwd(), '.claude', 'settings.json');
if (!user || existsSync(settings)) {
  if (existsSync(settings)) {
    const doc = JSON.parse(readFileSync(settings, 'utf8'));
    const command = doc.hooks && doc.hooks.SessionStart && doc.hooks.SessionStart[0] && doc.hooks.SessionStart[0].hooks && doc.hooks.SessionStart[0].hooks[0] && doc.hooks.SessionStart[0].hooks[0].command;
    if (command) spawnSync(command, {shell: true, stdio: 'inherit', env: process.env});
  }
  writeFileSync(process.env.MARKER, 'executed\\n');
}
`, {mode: 0o700});
    await chmod(fake, 0o700);
    if (isolate) await stripExamHostileConfig(repo);
    const baseEnv = ['PATH=/usr/local/bin:/usr/bin:/bin'];
    const workerEnv = examWorkerEnv(baseEnv, isolate);
    const verify = workerEnv.includes('AC_VERIFY_EXAM=1');
    const login = verify ? await prepareExamLoginCopy(account, root) : account;
    await writeFile(join(login, 'auth.json'), Buffer.concat([await readFile(join(login, 'auth.json')), Buffer.from([0x58])]));
    const mount = examAccountMount(account, isolate);
    const runnerArgv = ['--print', '--permission-mode', 'dontAsk', '--mcp-config', join(root, 'mcp.json'), '--model', 'claude-sonnet-5-5'];
    const bin = verify ? await installExamClaudeWrapper(root, fake) : fake;
    const env = {...process.env, MARKER: marker, ARGV_OUT: argvOut};
    assert.equal(await run(bin, runnerArgv, repo, env), 0);
    assert.equal(await markerText(marker), '');
    assert.deepEqual(await readFile(auth), before);
    assert.equal(mount.writable, false);
    assert.equal(mount.destination, '/account');
    assert.equal(describeBind(mount), account + ':/account:ro');
    assert.deepEqual(workerEnv, [...baseEnv, 'AC_VERIFY_EXAM=1']);
    for (const rel of ['.claude', '.mcp.json', 'CLAUDE.md', 'AGENTS.md', '.codex', '.grok', '.cursor', 'GROK.md']) {
      await assert.rejects(lstat(join(repo, rel)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    }
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'keep\n');
    const seen = JSON.parse(await readFile(argvOut, 'utf8')) as string[];
    assert.deepEqual(seen, examClaudeArgv(runnerArgv));
    assert.equal(seen.includes('--mcp-config'), false);
    await assert.rejects(access(marker, constants.F_OK), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(account, {recursive: true, force: true});
  }
}

for (const role of ['specialist', 'reviewer'] as const) {
  test(`o comando de design no papel ${role} não grava o marcador e não altera a conta`, async () => {
    await proveDesignExam(role);
  });
}

test('segurança continua isolada; programador, qa, judge, travado e avaliador comum não', () => {
  for (const role of ['specialist', 'reviewer'] as const) {
    const isolate = launchIsolates(true, 'security-verify-readonly-v1', role);
    assert.equal(isolate, true);
    const mount = examAccountMount('/account', isolate);
    assert.equal(mount.writable, false);
    assert.equal(describeBind(mount), '/account:/account:ro');
    assert.deepEqual(examWorkerEnv(['PATH=/usr/bin'], isolate), ['PATH=/usr/bin', 'AC_VERIFY_EXAM=1']);
    assert.equal(launchIsolates(false, 'design-readonly-v1', role), false);
    assert.equal(launchIsolates(false, 'security-verify-readonly-v1', role), false);
  }
  for (const role of ['programmer', 'qa', 'judge'] as const) {
    for (const workflow of ['design-readonly-v1', 'security-verify-readonly-v1', 'engineering-native-v1']) {
      const isolate = launchIsolates(true, workflow, role);
      assert.equal(isolate, false);
      assert.equal(examAccountMount('/account', isolate).writable, true);
      assert.equal(describeBind(examAccountMount('/account', isolate)), '/account:/account:rw');
      assert.deepEqual(examWorkerEnv(['PATH=/usr/bin'], isolate), ['PATH=/usr/bin']);
    }
  }
  assert.equal(launchIsolates(true, 'engineering-native-v1', 'reviewer'), false);
  assert.equal(launchIsolates(true, 'engineering-native-v1', 'specialist'), false);
  assert.equal(launchIsolates(true, undefined, 'specialist'), false);
});
