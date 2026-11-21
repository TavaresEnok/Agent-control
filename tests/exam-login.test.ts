import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {examineDesignScreens} from '../src/design-examine.ts';
import type {DesignWorker} from '../src/design-types.ts';
import {
  DEFAULT_EXAM_MAX_MS,
  EXAM_LOGIN_BUSY_TEXT,
  EXAM_LOGIN_MARGIN_MS,
  EXAM_LOGIN_RESTORE_FAILED_TEXT,
  EXAM_LOGIN_STALE_TEXT,
  claudeAccessExpiresAt,
  ensureExamLoginFresh,
  examLoginBusyNote,
  examLoginFreshAfterRenew,
  examLoginNeedsRefresh,
  examLoginRestoreFailedNote,
  examLoginStaleNote,
  postgresAccountLoginLock,
  prepareClaudeExamAccessToken,
  providerFailureCode,
  renewClaudeLoginInPlace,
  safeFailureCode,
  type AccountLoginLock,
} from '../src/exam-login.ts';
import {Ledger} from '../src/ledger.ts';
import {isolatedDatabase} from './fixtures/isolated-database.ts';
import {designCliFailureText, designExamStatus} from '../src/personal-design-cli.ts';
import {verifyCliFailureText} from '../src/personal-verify-cli.ts';
import {readonlyExamIsolation} from '../src/native-execution-supervisor.ts';

const SECRET = 'sk-SUPERSECRETTOKENVALUE';

function document(input: {
  expiresAt?: number;
  access?: string;
  refresh?: string;
  scopes?: string[];
  extraTop?: Record<string, unknown>;
  extraOauth?: Record<string, unknown>;
} = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: input.access ?? 'fixture-access-token',
      refreshToken: input.refresh ?? 'fixture-refresh-token',
      expiresAt: input.expiresAt ?? Date.now() - 60_000,
      scopes: input.scopes ?? ['user:inference', 'user:profile'],
      ...(input.extraOauth ?? {}),
    },
    ...(input.extraTop ?? {}),
  });
}

async function loginFile(body: string, mode = 0o600): Promise<{dir: string; file: string}> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-exam-login-'));
  const file = join(dir, '.credentials.json');
  await writeFile(file, body, {mode: 0o600});
  await chmod(file, mode);
  return {dir, file};
}

test('expiresAt em segundos vira milissegundos e a margem usa tempo máximo do job + 10 min', () => {
  assert.equal(claudeAccessExpiresAt(1_700_000_000), 1_700_000_000_000);
  assert.equal(claudeAccessExpiresAt(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(claudeAccessExpiresAt('1700000000000'), null);
  assert.equal(claudeAccessExpiresAt(Number.NaN), null);
  const now = 1_700_000_000_000;
  const examMax = 900_000;
  assert.equal(EXAM_LOGIN_MARGIN_MS, 10 * 60 * 1000);
  assert.equal(DEFAULT_EXAM_MAX_MS, 15 * 60 * 1000);
  const edge = now + examMax + EXAM_LOGIN_MARGIN_MS;
  assert.equal(examLoginNeedsRefresh(edge + 1, now, examMax), false);
  assert.equal(examLoginNeedsRefresh(edge, now, examMax), true);
  assert.equal(examLoginNeedsRefresh(edge - 1, now, examMax), true);
  assert.equal(examLoginNeedsRefresh(null, now, examMax), true);
  assert.equal(examLoginFreshAfterRenew(edge, now, examMax), false);
  assert.equal(examLoginFreshAfterRenew(edge + 1, now, examMax), true);
  assert.equal(examLoginFreshAfterRenew(null, now, examMax), false);
  assert.equal(providerFailureCode(`Failed to authenticate: OAuth session expired ${SECRET}`), 'PROVIDER_AUTH_FAILED');
  assert.equal(providerFailureCode('could not be refreshed'), 'PROVIDER_AUTH_FAILED');
  assert.equal(providerFailureCode('EXECUTION_NATIVE_FAILED'), null);
  assert.equal(providerFailureCode(SECRET), null);
  assert.equal(safeFailureCode('PROVIDER_AUTH_FAILED'), 'PROVIDER_AUTH_FAILED');
  assert.equal(safeFailureCode(SECRET), 'EXECUTION_NATIVE_FAILED');
  assert.equal(examLoginStaleNote(new Refusal('EXAM_LOGIN_STALE')), EXAM_LOGIN_STALE_TEXT);
  assert.equal(examLoginStaleNote(new Refusal('OTHER')), undefined);
  assert.equal(readonlyExamIsolation(true, 'design-readonly-v1', 'specialist'), true);
  assert.equal(readonlyExamIsolation(true, 'security-verify-readonly-v1', 'reviewer'), true);
  assert.equal(readonlyExamIsolation(true, 'design-readonly-v1', 'programmer'), false);
});

test('token com 3 h de validade não chama o renovador e devolve o accessToken atual', async () => {
  const now = Date.now();
  const original = `${document({expiresAt: now + 3 * 60 * 60 * 1000, access: 'fixture-access-3h', refresh: 'fixture-refresh-3h'})}\n`;
  const {dir, file} = await loginFile(original);
  let called = 0;
  try {
    const result = await prepareClaudeExamAccessToken({
      accountDir: dir,
      now,
      examMaxMs: 900_000,
      renew: async () => {
        called += 1;
      },
    });
    assert.equal(result.status, 'fresh');
    assert.equal(result.accessToken, 'fixture-access-3h');
    assert.equal(called, 0);
    assert.equal(await readFile(file, 'utf8'), original);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('token perto de vencer grava expiresAt 0 mantendo o resto, chama renovador, exige refreshToken novo e devolve token novo', async () => {
  const now = Date.now();
  const original = document({
    expiresAt: now + 20 * 60 * 1000,
    access: 'fixture-access-old',
    refresh: 'fixture-refresh-old',
    extraTop: {mcpOAuth: {keep: true}},
    extraOauth: {subscriptionType: 'max', nestedKeep: {v: 1}},
  });
  const {dir, file} = await loginFile(original);
  const before = await lstat(file);
  let seenAtRenew: Record<string, unknown> | undefined;
  try {
    const result = await prepareClaudeExamAccessToken({
      accountDir: dir,
      now,
      examMaxMs: 900_000,
      renew: async accountDir => {
        assert.equal(accountDir, dir);
        const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        seenAtRenew = onDisk;
        const statDuring = await lstat(file);
        assert.equal(statDuring.mode & 0o777, 0o600);
        assert.equal(statDuring.uid, before.uid);
        assert.equal(statDuring.isSymbolicLink(), false);
        const next = document({
          expiresAt: now + 3 * 60 * 60 * 1000,
          access: 'fixture-access-new',
          refresh: 'fixture-refresh-new',
          extraTop: {mcpOAuth: {keep: true}},
          extraOauth: {subscriptionType: 'max', nestedKeep: {v: 1}},
        });
        await writeFile(file, `${next}\n`, {mode: 0o600});
        await chmod(file, 0o644);
      },
    });
    assert.equal(result.status, 'renewed');
    assert.equal(result.accessToken, 'fixture-access-new');
    const oauthDuring = seenAtRenew?.claudeAiOauth as Record<string, unknown>;
    assert.equal(oauthDuring.expiresAt, 0);
    assert.equal(oauthDuring.refreshToken, 'fixture-refresh-old');
    assert.deepEqual(oauthDuring.nestedKeep, {v: 1});
    assert.deepEqual(seenAtRenew?.mcpOAuth, {keep: true});
    const after = await lstat(file);
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal(after.uid, before.uid);
    assert.equal(after.isSymbolicLink(), false);
    const saved = JSON.parse(await readFile(file, 'utf8')) as {claudeAiOauth: {accessToken: string; refreshToken: string}};
    assert.equal(saved.claudeAiOauth.accessToken, 'fixture-access-new');
    assert.equal(saved.claudeAiOauth.refreshToken, 'fixture-refresh-new');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('renovador que falha com o mesmo refreshToken restaura o expiresAt original e recusa com EXAM_LOGIN_STALE', async () => {
  const now = Date.now();
  const originalExpires = now + 20 * 60 * 1000;
  const original = document({
    expiresAt: originalExpires,
    access: 'fixture-access-keep',
    refresh: 'fixture-refresh-keep',
    extraTop: {mcpOAuth: {keep: true}},
  });
  const {dir, file} = await loginFile(original);
  try {
    await assert.rejects(
      () => ensureExamLoginFresh({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => {
          const forced = JSON.parse(await readFile(file, 'utf8')) as {claudeAiOauth: {expiresAt: number}};
          assert.equal(forced.claudeAiOauth.expiresAt, 0);
          throw new Error('EXAM_LOGIN_RENEW_FAILED');
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    const restored = JSON.parse(await readFile(file, 'utf8')) as {claudeAiOauth: {expiresAt: number; refreshToken: string}; mcpOAuth: {keep: boolean}};
    assert.equal(restored.claudeAiOauth.expiresAt, originalExpires);
    assert.equal(restored.claudeAiOauth.refreshToken, 'fixture-refresh-keep');
    assert.deepEqual(restored.mcpOAuth, {keep: true});
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('renovador que gira refreshToken mas deixa expiresAt insuficiente restaura o documento original e recusa com EXAM_LOGIN_STALE', async () => {
  const now = Date.now();
  const original = document({expiresAt: now - 10_000, access: 'fixture-access-0', refresh: 'fixture-refresh-0'});
  const {dir, file} = await loginFile(original);
  const rotatedBody = document({
    expiresAt: now + 900_000 + EXAM_LOGIN_MARGIN_MS,
    access: 'fixture-access-short',
    refresh: 'fixture-refresh-rotated-short',
  });
  try {
    await assert.rejects(
      () => ensureExamLoginFresh({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => {
          await writeFile(file, rotatedBody, {mode: 0o600});
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('renovador que grava accessToken e refreshToken vazios restaura o documento original inteiro em 0600 e recusa com EXAM_LOGIN_STALE', async () => {
  const now = Date.now();
  const original = document({
    expiresAt: now - 30_000,
    access: 'fixture-access-original',
    refresh: 'fixture-refresh-original',
    extraTop: {mcpOAuth: {keep: true}},
    extraOauth: {subscriptionType: 'max', organizationUuid: 'org-123'},
  });
  const {dir, file} = await loginFile(original);
  try {
    await assert.rejects(
      () => prepareClaudeExamAccessToken({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => {
          await writeFile(
            file,
            JSON.stringify({
              claudeAiOauth: {
                accessToken: '',
                refreshToken: '',
                expiresAt: 0,
              },
            }),
            {mode: 0o600},
          );
          await chmod(file, 0o644);
          throw new Error('EXAM_LOGIN_RENEW_FAILED');
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('renovador que gira refreshToken com expiresAt bom e sai com erro ainda normaliza e entrega o token novo', async () => {
  const now = Date.now();
  const {dir, file} = await loginFile(document({expiresAt: now - 1, refresh: 'fixture-refresh-0'}));
  try {
    const res = await prepareClaudeExamAccessToken({
      accountDir: dir,
      now,
      examMaxMs: 1_000,
      renew: async () => {
        await writeFile(
          file,
          document({
            expiresAt: now + 1_000 + EXAM_LOGIN_MARGIN_MS + 60_000,
            access: 'fixture-access-rotated-on-nonzero',
            refresh: 'fixture-refresh-1',
          }),
          {mode: 0o600},
        );
        await chmod(file, 0o644);
        throw new Error('EXAM_LOGIN_RENEW_FAILED');
      },
    });
    assert.equal(res.status, 'renewed');
    assert.equal(res.accessToken, 'fixture-access-rotated-on-nonzero');
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('symlink em .credentials.json é recusado com EXAM_LOGIN_STALE sem seguir o alvo', async () => {
  const area = await mkdtemp(join(tmpdir(), 'ac-exam-symlink-'));
  const accountDir = join(area, 'account');
  const outside = join(area, 'outside.json');
  try {
    await mkdir(accountDir, {mode: 0o700});
    const body = document({expiresAt: Date.now() + 3 * 3600_000, access: 'outside-secret'});
    await writeFile(outside, body, {mode: 0o600});
    await symlink(outside, join(accountDir, '.credentials.json'));
    let renewCalled = 0;
    await assert.rejects(
      () => prepareClaudeExamAccessToken({
        accountDir,
        renew: async () => {
          renewCalled += 1;
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(renewCalled, 0);
    assert.equal(await readFile(outside, 'utf8'), body);
  } finally {
    await rm(area, {recursive: true, force: true});
  }
});

test('ao pegar a trava, prepareClaudeExamAccessToken relê o arquivo e não renova se outro processo já renovou', async () => {
  const now = Date.now();
  const stale = document({expiresAt: now - 60_000, access: 'fixture-access-old', refresh: 'fixture-refresh-old'});
  const {dir, file} = await loginFile(stale);
  const accountId = randomUUID();
  let renewCalls = 0;
  try {
    const lock: AccountLoginLock = async (_id, fn) => {
      await writeFile(
        file,
        document({expiresAt: now + 3 * 60 * 60 * 1000, access: 'fixture-access-other-proc', refresh: 'fixture-refresh-other-proc'}),
        {mode: 0o600},
      );
      return fn();
    };
    const res = await prepareClaudeExamAccessToken({
      accountDir: dir,
      accountId,
      now,
      renew: async () => {
        renewCalls += 1;
      },
      lock,
    });
    assert.equal(res.status, 'fresh');
    assert.equal(res.accessToken, 'fixture-access-other-proc');
    assert.equal(renewCalls, 0);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('postgresAccountLoginLock serializa duas preparações concorrentes em conexões Postgres reais', {skip: !process.env.AC_TEST_DATABASE_URL}, async () => {
  const baseUrl = process.env.AC_TEST_DATABASE_URL!;
  const fixture = await isolatedDatabase(baseUrl, 'examloginlock');
  const dbGateway = new Ledger(fixture.url);
  const dbCli = new Ledger(fixture.url);
  const now = Date.now();
  const {dir, file} = await loginFile(document({expiresAt: now - 60_000, access: 'a0', refresh: 'r0'}));
  const accountId = randomUUID();
  let renewCalls = 0;
  try {
    const outcomes = await Promise.all([
      prepareClaudeExamAccessToken({
        accountDir: dir,
        accountId,
        now,
        lock: postgresAccountLoginLock(dbGateway),
        renew: async () => {
          renewCalls += 1;
          await new Promise(resolve => setTimeout(resolve, 40));
          await writeFile(file, document({expiresAt: now + 3 * 3600_000, access: 'a1', refresh: 'r1'}), {mode: 0o600});
        },
      }),
      prepareClaudeExamAccessToken({
        accountDir: dir,
        accountId,
        now,
        lock: postgresAccountLoginLock(dbCli),
        renew: async () => {
          renewCalls += 1;
          await writeFile(file, document({expiresAt: now + 3 * 3600_000, access: 'a2', refresh: 'r2'}), {mode: 0o600});
        },
      }),
    ]);
    assert.equal(renewCalls, 1);
    assert.deepEqual(outcomes.map(o => o.status).sort(), ['fresh', 'renewed']);
    assert.equal(outcomes[0]!.accessToken, outcomes[1]!.accessToken);
    assert.equal(['a1', 'a2'].includes(outcomes[0]!.accessToken), true);
  } finally {
    await dbGateway.close();
    await dbCli.close();
    await fixture.close();
    await rm(dir, {recursive: true, force: true});
  }
});

test('renewClaudeLoginInPlace usa cwd temporário vazio 0700, flags isoladas e ambiente mínimo', async () => {
  const area = await mkdtemp(join(tmpdir(), 'ac-renew-fake-'));
  const accountDir = join(area, 'account');
  const bin = join(area, 'fake-claude');
  const traceFile = join(area, 'trace.json');
  const prevBin = process.env.AC_NATIVE_CLAUDE_BIN;
  try {
    await writeFile(
      bin,
      `#!${process.execPath}
const fs = require('node:fs');
const cwd = process.cwd();
const info = fs.statSync(cwd);
const entries = fs.readdirSync(cwd);
fs.writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify({
  cwd,
  mode: info.mode & 0o777,
  entries,
  argv: process.argv.slice(2),
  env: process.env,
}));
if (process.env.HOME && fs.existsSync(process.env.HOME)) {
  const flag = process.env.HOME + '/fail';
  if (fs.existsSync(flag)) process.exit(1);
}
`,
      {mode: 0o700},
    );
    await chmod(bin, 0o700);
    await mkdir(accountDir, {mode: 0o700});
    process.env.AC_NATIVE_CLAUDE_BIN = bin;
    await renewClaudeLoginInPlace(accountDir);
    const trace = JSON.parse(await readFile(traceFile, 'utf8')) as {
      cwd: string;
      mode: number;
      entries: string[];
      argv: string[];
      env: Record<string, string>;
    };
    assert.notEqual(trace.cwd, process.cwd());
    assert.equal(trace.mode, 0o700);
    assert.deepEqual(trace.entries, []);
    assert.deepEqual(trace.argv, [
      '-p',
      'ok',
      '--output-format',
      'text',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--settings',
      '{"disableAllHooks":true}',
      '--max-turns',
      '1',
    ]);
    assert.deepEqual(Object.keys(trace.env).sort(), ['CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'TMPDIR']);
    assert.equal(trace.env.HOME, accountDir);
    assert.equal(trace.env.CLAUDE_CONFIG_DIR, accountDir);
    assert.equal(trace.env.TMPDIR, trace.cwd);
    await assert.rejects(() => lstat(trace.cwd), {code: 'ENOENT'});

    await writeFile(join(accountDir, 'fail'), '1', {mode: 0o600});
    await assert.rejects(() => renewClaudeLoginInPlace(accountDir), /EXAM_LOGIN_RENEW_FAILED/);
    const failedTrace = JSON.parse(await readFile(traceFile, 'utf8')) as {cwd: string};
    await assert.rejects(() => lstat(failedTrace.cwd), {code: 'ENOENT'});
  } finally {
    if (prevBin === undefined) delete process.env.AC_NATIVE_CLAUDE_BIN;
    else process.env.AC_NATIVE_CLAUDE_BIN = prevBin;
    await rm(area, {recursive: true, force: true});
  }
});

test('a CLI e o exame dizem para entrar de novo quando o login vence', async () => {
  assert.deepEqual(designExamStatus({loginStale: true}), {code: 1, lines: [EXAM_LOGIN_STALE_TEXT]});
  assert.deepEqual(designExamStatus({}), {code: 0, lines: []});
  assert.equal(verifyCliFailureText(new Refusal('EXAM_LOGIN_STALE')), EXAM_LOGIN_STALE_TEXT);
  assert.equal(EXAM_LOGIN_STALE_TEXT.includes(SECRET), false);
  const calls: string[] = [];
  const worker: DesignWorker = {
    async run(call) {
      calls.push(call.role);
      throw new Refusal('EXAM_LOGIN_STALE');
    },
  };
  const result = await examineDesignScreens({
    repo: '/tmp/repo-design',
    intentId: randomUUID(),
    screens: [
      {file: 'index.html', route: '/', code: '<html><body>oi</body></html>', captureNote: ''},
      {file: 'outra.html', route: '/outra', code: '<html><body>duas</body></html>', captureNote: ''},
    ],
    checklist: loadDesignChecklist(),
    rawFindings: [],
    worker,
    reserve: async () => ({
      provider: 'claude',
      model: 'modelo',
      accountId: randomUUID(),
      profileId: randomUUID(),
      grantId: randomUUID(),
    }),
    release: async () => {
      calls.push('release');
    },
  });
  assert.equal(result.loginStale, true);
  assert.deepEqual(calls, ['specialist', 'release']);
  assert.equal(result.notes.includes(EXAM_LOGIN_STALE_TEXT), true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('renewClaudeLoginInPlace envia SIGTERM ao grupo, espera grace e manda SIGKILL ao grupo esperando exit antes de apagar tmpdir e soltar trava', async () => {
  const area = await mkdtemp(join(tmpdir(), 'ac-renew-sigkill-'));
  const accountDir = join(area, 'account');
  const bin = join(area, 'stubborn-claude');
  const traceFile = join(area, 'events.log');
  const prevBin = process.env.AC_NATIVE_CLAUDE_BIN;
  try {
    await mkdir(accountDir, {mode: 0o700});
    await writeFile(
      bin,
      `#!${process.execPath}
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const trace = ${JSON.stringify(traceFile)};
fs.appendFileSync(trace, 'start:' + process.cwd() + '\\n');
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(`
const fs = require('node:fs');
const trace = ${JSON.stringify(traceFile)};
process.on('SIGTERM', () => fs.appendFileSync(trace, 'child-sigterm\\n'));
setInterval(() => fs.appendFileSync(trace, 'child-alive\\n'), 40);
`)}], {stdio: 'ignore'});
process.on('SIGTERM', () => {
  const cwdExists = fs.existsSync(process.cwd());
  fs.appendFileSync(trace, 'sigterm:cwd=' + cwdExists + '\\n');
});
setInterval(() => {
  fs.appendFileSync(trace, 'alive:cwd=' + fs.existsSync(process.cwd()) + '\\n');
}, 40);
grandchild.on('exit', () => {});
`,
      {mode: 0o700},
    );
    await chmod(bin, 0o700);
    process.env.AC_NATIVE_CLAUDE_BIN = bin;
    let lockReleased = false;
    let eventsAtLockRelease = '';
    const lock: AccountLoginLock = async (_id, fn) => {
      try {
        return await fn();
      } finally {
        lockReleased = true;
        eventsAtLockRelease = await readFile(traceFile, 'utf8');
      }
    };
    await assert.rejects(
      () => lock('acc-1', () => renewClaudeLoginInPlace(accountDir, {timeoutMs: 140, killGraceMs: 150})),
      /EXAM_LOGIN_RENEW_FAILED/,
    );
    assert.equal(lockReleased, true);
    const lines = eventsAtLockRelease.trim().split('\n');
    const startLine = lines.find(line => line.startsWith('start:'));
    assert.ok(startLine);
    const scratchDir = startLine.slice('start:'.length);
    assert.equal(lines.some(line => line === 'sigterm:cwd=true'), true);
    assert.equal(lines.some(line => line === 'child-sigterm'), true);
    assert.equal(lines.some(line => line === 'alive:cwd=false'), false);
    await assert.rejects(() => lstat(scratchDir), {code: 'ENOENT'});
    await new Promise(resolve => setTimeout(resolve, 140));
    assert.equal(await readFile(traceFile, 'utf8'), eventsAtLockRelease);
  } finally {
    if (prevBin === undefined) delete process.env.AC_NATIVE_CLAUDE_BIN;
    else process.env.AC_NATIVE_CLAUDE_BIN = prevBin;
    await rm(area, {recursive: true, force: true});
  }
});

test('prepareClaudeExamAccessToken recalcula Date.now() dentro da trava e postgresAccountLoginLock usa lock_timeout 120s -> EXAM_LOGIN_BUSY', async () => {
  let clock = 1_700_000_000_000;
  const stale = document({expiresAt: clock - 10_000, access: 'a0', refresh: 'fixture-refresh-clock-0'});
  const {dir, file} = await loginFile(stale);
  let renewed = 0;
  try {
    const lock: AccountLoginLock = async (_id, fn) => {
      await writeFile(file, document({expiresAt: clock + 900_000 + EXAM_LOGIN_MARGIN_MS + 5_000, access: 'a1', refresh: 'fixture-refresh-clock-1'}), {mode: 0o600});
      clock += 30_000;
      return fn();
    };
    const res = await prepareClaudeExamAccessToken({
      accountDir: dir,
      accountId: randomUUID(),
      examMaxMs: 900_000,
      now: () => clock,
      lock,
      renew: async () => {
        renewed += 1;
        await writeFile(file, document({expiresAt: clock + 3 * 3600_000, access: 'a2', refresh: 'fixture-refresh-clock-2'}), {mode: 0o600});
      },
    });
    assert.equal(res.status, 'renewed');
    assert.equal(res.accessToken, 'a2');
    assert.equal(renewed, 1);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }

  const queries: string[] = [];
  const busyLedger = {
    async tx<T>(fn: (c: {query: (sql: string, params?: unknown[]) => Promise<unknown>}) => Promise<T>): Promise<T> {
      return fn({
        async query(sql: string) {
          queries.push(sql);
          if (sql.includes('pg_advisory_xact_lock')) {
            const err = Object.assign(new Error('canceling statement due to lock timeout'), {code: '55P03'});
            throw err;
          }
          return {rows: [], rowCount: 0};
        },
      });
    },
  };
  const pgLock = postgresAccountLoginLock(busyLedger as unknown as Ledger);
  await assert.rejects(
    () => pgLock(randomUUID(), async () => 'never'),
    (error: unknown) => {
      assert.ok(error instanceof Refusal && error.code === 'EXAM_LOGIN_BUSY');
      assert.equal(examLoginBusyNote(error), EXAM_LOGIN_BUSY_TEXT);
      assert.equal(designCliFailureText(error), EXAM_LOGIN_BUSY_TEXT);
      assert.equal(verifyCliFailureText(error), EXAM_LOGIN_BUSY_TEXT);
      return true;
    },
  );
  assert.equal(queries[0], "SET LOCAL lock_timeout = '120s'");
  assert.match(queries[1] ?? '', /pg_advisory_xact_lock/);
});

test('renovação vale com accessToken novo e expiresAt bom mesmo sem girar refreshToken, e falha se accessToken não mudar', async () => {
  const now = Date.now();
  const {dir, file} = await loginFile(document({
    expiresAt: now + 5 * 60 * 1000,
    access: 'fixture-access-before',
    refresh: 'fixture-refresh-same',
  }));
  try {
    const res = await prepareClaudeExamAccessToken({
      accountDir: dir,
      now,
      examMaxMs: 900_000,
      renew: async () => {
        await writeFile(
          file,
          document({
            expiresAt: now + 3 * 3600_000,
            access: 'fixture-access-after',
            refresh: 'fixture-refresh-same',
          }),
          {mode: 0o600},
        );
      },
    });
    assert.equal(res.status, 'renewed');
    assert.equal(res.accessToken, 'fixture-access-after');

    const originalExpires = now + 5 * 60 * 1000;
    await writeFile(
      file,
      document({
        expiresAt: originalExpires,
        access: 'fixture-access-unchanged',
        refresh: 'fixture-refresh-same-2',
      }),
      {mode: 0o600},
    );
    await assert.rejects(
      () => prepareClaudeExamAccessToken({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => {
          await writeFile(
            file,
            document({
              expiresAt: now + 3 * 3600_000,
              access: 'fixture-access-unchanged',
              refresh: 'fixture-refresh-same-2',
            }),
            {mode: 0o600},
          );
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    const restored = JSON.parse(await readFile(file, 'utf8')) as {claudeAiOauth: {expiresAt: number}};
    assert.equal(restored.claudeAiOauth.expiresAt, originalExpires);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('prepareClaudeExamAccessToken compara antes de gravar expiresAt=0 e antes de restaurar, e não engole falha na restauração', async () => {
  const now = Date.now();
  const staleDoc = document({expiresAt: now - 60_000, access: 'fixture-access-stale', refresh: 'fixture-refresh-stale'});
  const {dir, file} = await loginFile(staleDoc);
  let renewCalls = 0;
  try {
    // 1) Se o arquivo mudar para um token bom antes de gravar expiresAt=0, reavalia sem gravar nem renovar.
    const freshAfterChange = document({expiresAt: now + 3 * 3600_000, access: 'fixture-access-concurrent-fresh', refresh: 'fixture-refresh-concurrent'});
    let hooked = false;
    const res = await prepareClaudeExamAccessToken({
      accountDir: dir,
      now,
      examMaxMs: 900_000,
      renew: async () => { renewCalls += 1; },
      hooks: {
        beforeForceExpire: async () => {
          if (hooked) return;
          hooked = true;
          await writeFile(file, freshAfterChange, {mode: 0o600});
        },
      },
    });
    assert.equal(res.status, 'fresh');
    assert.equal(res.accessToken, 'fixture-access-concurrent-fresh');
    assert.equal(renewCalls, 0);
    assert.equal(await readFile(file, 'utf8'), freshAfterChange);

    // 2) Na restauração, se accessToken ou refreshToken tiver mudado no arquivo, não restaura por cima.
    const oldExpires = now - 10_000;
    await writeFile(file, document({expiresAt: oldExpires, access: 'a-orig', refresh: 'r-orig'}), {mode: 0o600});
    const externalDoc = document({expiresAt: 0, access: 'a-external', refresh: 'r-orig'});
    await assert.rejects(
      () => prepareClaudeExamAccessToken({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => { throw new Error('RENEW_FAILED'); },
        hooks: {
          beforeRestore: async () => {
            await writeFile(file, externalDoc, {mode: 0o600});
          },
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(await readFile(file, 'utf8'), externalDoc);

    // 3) Se a gravação da restauração falhar, propaga EXAM_LOGIN_RESTORE_FAILED com frase fixa sem token.
    await writeFile(file, document({expiresAt: oldExpires, access: 'a-orig-2', refresh: 'r-orig-2'}), {mode: 0o600});
    await assert.rejects(
      () => prepareClaudeExamAccessToken({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => { throw new Error('RENEW_FAILED'); },
        hooks: {
          beforeRestore: async () => {
            await chmod(dir, 0o500);
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Refusal && error.code === 'EXAM_LOGIN_RESTORE_FAILED');
        const note = examLoginRestoreFailedNote(error);
        assert.equal(note, EXAM_LOGIN_RESTORE_FAILED_TEXT);
        assert.equal(designCliFailureText(error), EXAM_LOGIN_RESTORE_FAILED_TEXT);
        assert.equal(verifyCliFailureText(error), EXAM_LOGIN_RESTORE_FAILED_TEXT);
        assert.equal(EXAM_LOGIN_RESTORE_FAILED_TEXT.includes('a-orig-2'), false);
        assert.equal(EXAM_LOGIN_RESTORE_FAILED_TEXT.includes('r-orig-2'), false);
        return true;
      },
    );

    // 4) Se o renovador apagar .credentials.json, recria o original em 0600 (sem seguir symlink) e recusa com EXAM_LOGIN_STALE.
    await chmod(dir, 0o700);
    const deletedDoc = document({expiresAt: oldExpires, access: 'a-deleted', refresh: 'r-deleted'});
    await writeFile(file, deletedDoc, {mode: 0o600});
    await assert.rejects(
      () => prepareClaudeExamAccessToken({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => {
          await unlink(file);
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    const recreatedStat = await lstat(file);
    assert.equal(recreatedStat.isSymbolicLink(), false);
    assert.equal(recreatedStat.isFile(), true);
    assert.equal(recreatedStat.mode & 0o777, 0o600);
    assert.equal(await readFile(file, 'utf8'), deletedDoc);

    // 5) Se o arquivo sumir e um symlink for plantado antes da restauração, não segue nem sobrescreve o alvo.
    const symlinkTarget = join(dir, 'outside-target.txt');
    await writeFile(symlinkTarget, 'keep-outside', {mode: 0o600});
    await assert.rejects(
      () => prepareClaudeExamAccessToken({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => {
          await unlink(file);
        },
        hooks: {
          beforeRestore: async () => {
            await symlink(symlinkTarget, file);
          },
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_RESTORE_FAILED',
    );
    assert.equal((await lstat(file)).isSymbolicLink(), true);
    assert.equal(await readFile(symlinkTarget, 'utf8'), 'keep-outside');
  } finally {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, {recursive: true, force: true});
  }
});

test('renewClaudeLoginInPlace envia SIGKILL ao grupo após exit normal do líder que deixou filho vivo antes de soltar trava', async () => {
  const area = await mkdtemp(join(tmpdir(), 'ac-renew-orphan-'));
  const accountDir = join(area, 'account');
  const bin = join(area, 'parent-exits-fast');
  const childPidFile = join(area, 'child.pid');
  const heartbeatFile = join(area, 'child-heartbeat.log');
  const prevBin = process.env.AC_NATIVE_CLAUDE_BIN;
  try {
    await mkdir(accountDir, {mode: 0o700});
    await writeFile(
      bin,
      `#!${process.execPath}
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));
setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeatFile)}, 'tick\\n'), 25);
`)}], {stdio: 'ignore'});
child.unref();
setTimeout(() => process.exit(0), 60);
`,
      {mode: 0o700},
    );
    await chmod(bin, 0o700);
    process.env.AC_NATIVE_CLAUDE_BIN = bin;
    let childAliveInsideLock = true;
    let beatsAtLockRelease = '';
    const lock: AccountLoginLock = async (_id, fn) => {
      try {
        return await fn();
      } finally {
        const pid = Number((await readFile(childPidFile, 'utf8')).trim());
        await new Promise(resolve => setTimeout(resolve, 40));
        try {
          process.kill(pid, 0);
          childAliveInsideLock = true;
        } catch (error) {
          childAliveInsideLock = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        beatsAtLockRelease = await readFile(heartbeatFile, 'utf8').catch(() => '');
      }
    };
    await lock('acc-orphan', () => renewClaudeLoginInPlace(accountDir));
    assert.equal(childAliveInsideLock, false);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await readFile(heartbeatFile, 'utf8').catch(() => ''), beatsAtLockRelease);
  } finally {
    if (prevBin === undefined) delete process.env.AC_NATIVE_CLAUDE_BIN;
    else process.env.AC_NATIVE_CLAUDE_BIN = prevBin;
    await rm(area, {recursive: true, force: true});
  }
});
