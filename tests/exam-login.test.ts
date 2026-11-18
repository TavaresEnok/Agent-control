import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Refusal} from '../src/contracts.ts';
import {loadDesignChecklist} from '../src/design-checklist.ts';
import {examineDesignScreens} from '../src/design-examine.ts';
import {runDesignModule} from '../src/design-module.ts';
import type {DesignWorker} from '../src/design-types.ts';
import {rememberExamRecoveryNote} from '../src/exam-strip-note.ts';
import type {Installation} from '../src/installation.ts';
import {
  EXAM_LOGIN_BUSY_TEXT,
  EXAM_LOGIN_MARGIN_MS,
  EXAM_LOGIN_RECOVERY_TEXT,
  EXAM_LOGIN_STALE_TEXT,
  applyReturnedExamCredential,
  classifyReturnedCredential,
  claudeAccessExpiresAt,
  ensureExamLoginFresh,
  examLoginBusyNote,
  examLoginFreshAfterRenew,
  examLoginNeedsRefresh,
  examLoginRecoveryNote,
  examLoginStaleNote,
  hashExamRefreshToken,
  markExamRecoverySaved,
  postgresAccountLoginLock,
  providerFailureCode,
  readClaudeRefreshTokenHash,
  readExamCredentialReturn,
  recoverAccountCredentialCommand,
  recoverExamCredential,
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
  organizationUuid?: string;
  accountUuid?: string;
  uuid?: string;
} = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: input.access ?? 'fixture-access-token',
      refreshToken: input.refresh ?? 'fixture-refresh-token',
      expiresAt: input.expiresAt ?? Date.now() - 60_000,
      scopes: input.scopes ?? ['user:inference', 'user:profile'],
      ...(input.organizationUuid === undefined ? {} : {organizationUuid: input.organizationUuid}),
      ...(input.accountUuid === undefined ? {} : {accountUuid: input.accountUuid}),
      ...(input.uuid === undefined ? {} : {uuid: input.uuid}),
    },
  });
}

async function loginFile(body: string, mode = 0o600): Promise<{dir: string; file: string}> {
  const dir = await mkdtemp(join(tmpdir(), 'ac-exam-login-'));
  const file = join(dir, '.credentials.json');
  await writeFile(file, body, {mode: 0o600});
  await chmod(file, mode);
  return {dir, file};
}

test('expiresAt em segundos vira milissegundos e o limite exato não renova', () => {
  assert.equal(claudeAccessExpiresAt(1_700_000_000), 1_700_000_000_000);
  assert.equal(claudeAccessExpiresAt(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(claudeAccessExpiresAt('1700000000000'), null);
  assert.equal(claudeAccessExpiresAt(Number.NaN), null);
  const now = 1_700_000_000_000;
  const examMax = 900_000;
  const edge = now + EXAM_LOGIN_MARGIN_MS;
  assert.equal(EXAM_LOGIN_MARGIN_MS, 5 * 60 * 1000);
  assert.equal(examLoginNeedsRefresh(edge, now, examMax), false);
  assert.equal(examLoginNeedsRefresh(edge - 1, now, examMax), true);
  assert.equal(examLoginNeedsRefresh(null, now, examMax), true);
  assert.equal(examLoginFreshAfterRenew(edge, now), false);
  assert.equal(examLoginFreshAfterRenew(edge + 1, now), true);
  assert.equal(examLoginFreshAfterRenew(null, now), false);
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

test('login vencido chama a renovação e o arquivo fica 0600 com o mesmo dono', async () => {
  const now = Date.now();
  const original = document({expiresAt: now - 60_000});
  const {dir, file} = await loginFile(original);
  const before = await lstat(file);
  let called = 0;
  try {
    const state = await ensureExamLoginFresh({
      accountDir: dir,
      now,
      examMaxMs: 900_000,
      renew: async accountDir => {
        called += 1;
        assert.equal(accountDir, dir);
        const next = document({expiresAt: now + 3 * 60 * 60 * 1000, access: 'fixture-access-token-new', refresh: 'fixture-refresh-token-new'});
        await writeFile(file, `${next}\n`, {mode: 0o600});
        await chmod(file, 0o644);
      },
    });
    assert.equal(state, 'renewed');
    assert.equal(called, 1);
    const after = await lstat(file);
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal(after.uid, before.uid);
    assert.equal(after.isSymbolicLink(), false);
    const written = JSON.parse(await readFile(file, 'utf8')) as {claudeAiOauth: {accessToken: string; expiresAt: number}};
    assert.equal(written.claudeAiOauth.accessToken, 'fixture-access-token-new');
    assert.equal(written.claudeAiOauth.expiresAt > now, true);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('renovação que falha e deixa o arquivo vencido recusa com EXAM_LOGIN_STALE', async () => {
  const now = Date.now();
  const original = document({expiresAt: now - 60_000});
  const {dir, file} = await loginFile(original);
  try {
    await assert.rejects(
      () => ensureExamLoginFresh({
        accountDir: dir,
        now,
        examMaxMs: 900_000,
        renew: async () => {
          throw new Error('EXAM_LOGIN_RENEW_FAILED');
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
    assert.equal(await readFile(file, 'utf8'), original);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('renovação que grava e sai com erro ainda normaliza o login fresco', async () => {
  const now = Date.now();
  const {dir, file} = await loginFile(document({expiresAt: now - 1}));
  try {
    const state = await ensureExamLoginFresh({
      accountDir: dir,
      now,
      examMaxMs: 1_000,
      renew: async () => {
        await writeFile(file, document({expiresAt: now + EXAM_LOGIN_MARGIN_MS + 60_000}), {mode: 0o600});
        throw new Error('EXAM_LOGIN_RENEW_FAILED');
      },
    });
    assert.equal(state, 'renewed');
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('token com 20 min restantes não chama o renovador e não recusa', async () => {
  const now = Date.now();
  const original = document({expiresAt: now + 20 * 60 * 1000});
  const {dir, file} = await loginFile(original);
  let called = 0;
  try {
    const state = await ensureExamLoginFresh({
      accountDir: dir,
      now,
      examMaxMs: 900_000,
      renew: async () => {
        called += 1;
      },
    });
    assert.equal(state, 'fresh');
    assert.equal(called, 0);
    assert.equal(await readFile(file, 'utf8'), original);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('renovação que deixa expiresAt com 5 min exatos no futuro recusa com EXAM_LOGIN_STALE', async () => {
  const now = Date.now();
  const {dir, file} = await loginFile(document({expiresAt: now + 60_000}));
  try {
    await assert.rejects(
      () => ensureExamLoginFresh({
        accountDir: dir,
        now,
        renew: async () => {
          await writeFile(file, document({expiresAt: now + EXAM_LOGIN_MARGIN_MS}), {mode: 0o600});
        },
      }),
      (error: unknown) => error instanceof Refusal && error.code === 'EXAM_LOGIN_STALE',
    );
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('login folgado não reescreve o arquivo e não chama a renovação', async () => {
  const now = Date.now();
  const original = document({expiresAt: now + 6 * 60 * 60 * 1000});
  const {dir, file} = await loginFile(`${original}\n`);
  let called = 0;
  try {
    const state = await ensureExamLoginFresh({
      accountDir: dir,
      now,
      examMaxMs: 900_000,
      renew: async () => {
        called += 1;
      },
    });
    assert.equal(state, 'fresh');
    assert.equal(called, 0);
    assert.equal(await readFile(file, 'utf8'), `${original}\n`);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('cópia alterada da mesma conta volta para o arquivo e JSON inválido ou outra conta não grava', async () => {
  const now = Date.now();
  const original = document({expiresAt: now - 1, organizationUuid: 'org-conta', uuid: 'user-conta'});
  const changed = document({
    expiresAt: now + 3 * 60 * 60 * 1000,
    access: 'fixture-access-token-rotated',
    refresh: 'fixture-refresh-token-rotated',
    organizationUuid: 'org-conta',
    uuid: 'user-conta',
  });
  const {dir, file} = await loginFile(original);
  const copyDir = await mkdtemp(join(tmpdir(), 'ac-exam-copy-'));
  const copy = join(copyDir, '.credentials.json');
  const startMark = hashExamRefreshToken('fixture-refresh-token');
  try {
    await writeFile(copy, changed, {mode: 0o600});
    const returned = await readExamCredentialReturn(file, copy);
    assert.equal(returned?.claudeAiOauth && (returned.claudeAiOauth as {accessToken: string}).accessToken, 'fixture-access-token-rotated');
    assert.equal(await applyReturnedExamCredential(dir, changed, {expectedRefreshTokenHash: startMark}), 'written');
    const written = JSON.parse(await readFile(file, 'utf8')) as {claudeAiOauth: {refreshToken: string}};
    assert.equal(written.claudeAiOauth.refreshToken, 'fixture-refresh-token-rotated');
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.equal(await readExamCredentialReturn(file, file), undefined);

    const rotatedMark = hashExamRefreshToken('fixture-refresh-token-rotated');
    const invalid = '{';
    assert.equal(classifyReturnedCredential(original, invalid), 'invalid');
    assert.equal(await applyReturnedExamCredential(dir, invalid, {expectedRefreshTokenHash: rotatedMark}), 'rejected');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).claudeAiOauth.refreshToken, 'fixture-refresh-token-rotated');

    const other = document({
      expiresAt: now + 3 * 60 * 60 * 1000,
      access: 'fixture-access-token-other',
      refresh: 'fixture-refresh-token-other',
      organizationUuid: 'org-outra',
      uuid: 'user-conta',
    });
    assert.equal(classifyReturnedCredential(await readFile(file, 'utf8'), other), 'other-account');
    assert.equal(await applyReturnedExamCredential(dir, other, {expectedRefreshTokenHash: rotatedMark}), 'rejected');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).claudeAiOauth.refreshToken, 'fixture-refresh-token-rotated');

    const otherScopes = document({
      expiresAt: now + 3 * 60 * 60 * 1000,
      refresh: 'fixture-refresh-token-other-scopes',
      scopes: ['user:profile'],
      organizationUuid: 'org-conta',
      uuid: 'user-conta',
    });
    assert.equal(classifyReturnedCredential(await readFile(file, 'utf8'), otherScopes), 'other-account');
    assert.equal(await applyReturnedExamCredential(dir, otherScopes, {expectedRefreshTokenHash: rotatedMark}), 'rejected');

    const kept = await readFile(file, 'utf8');
    const target = join(dir, 'alvo.json');
    await writeFile(target, kept, {mode: 0o600});
    await rm(file);
    await symlink(target, file);
    assert.equal(await applyReturnedExamCredential(dir, changed, {expectedRefreshTokenHash: rotatedMark}), 'rejected');
    assert.equal(await readFile(target, 'utf8'), kept);
    assert.equal((await lstat(file)).isSymbolicLink(), true);
    assert.equal(await readExamCredentialReturn(file, copy), undefined);
  } finally {
    await rm(dir, {recursive: true, force: true});
    await rm(copyDir, {recursive: true, force: true});
  }
});

function createAsyncMutexLock(): AccountLoginLock {
  const queues = new Map<string, Promise<void>>();
  return async (accountId, fn) => {
    const prev = queues.get(accountId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = prev.then(() => gate, () => gate);
    queues.set(accountId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (queues.get(accountId) === tail) queues.delete(accountId);
    }
  };
}

test('devolução no formato real (sem accountUuid/uuid): grava válido, preserva chaves e recusa trocas, expiresAt menor e chaves extras', async () => {
  const now = Date.now();
  const realBase = {
    claudeAiOauth: {
      accessToken: 'fixture-access-0',
      refreshToken: 'fixture-refresh-0',
      expiresAt: now + 6 * 60 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      nestedKeep: {flag: true},
    },
    mcpOAuth: {server: 'keep-me'},
  };
  const {dir, file} = await loginFile(JSON.stringify(realBase));
  try {
    const mark0 = await readClaudeRefreshTokenHash(dir);
    assert.equal(mark0, hashExamRefreshToken('fixture-refresh-0'));

    // Chave extra (topo e aninhada) no devolvido não entra no arquivo; chaves atuais permanecem.
    const validReturn = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-1',
        refreshToken: 'fixture-refresh-1',
        expiresAt: now + 8 * 60 * 60 * 1000,
        scopes: ['user:profile', 'user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
        injectedNested: 'evil-nested',
      },
      injectedTop: 'evil-top',
    });
    assert.equal(await applyReturnedExamCredential(dir, validReturn, {expectedRefreshTokenHash: mark0!}), 'written');
    const afterValid = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const afterOauth = afterValid.claudeAiOauth as Record<string, unknown>;
    assert.equal(afterOauth.accessToken, 'fixture-access-1');
    assert.equal(afterOauth.refreshToken, 'fixture-refresh-1');
    assert.equal(afterOauth.expiresAt, now + 8 * 60 * 60 * 1000);
    assert.deepEqual(afterOauth.nestedKeep, {flag: true});
    assert.deepEqual(afterValid.mcpOAuth, {server: 'keep-me'});
    assert.equal('injectedTop' in afterValid, false);
    assert.equal('injectedNested' in afterOauth, false);
    assert.equal('accountUuid' in afterOauth, false);
    assert.equal('uuid' in afterOauth, false);

    // expiresAt menor ou igual recusa sem gravar.
    const mark1 = hashExamRefreshToken('fixture-refresh-1');
    const smallerExpiry = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-smaller',
        refreshToken: 'fixture-refresh-smaller',
        expiresAt: now + 7 * 60 * 60 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    });
    assert.equal(await applyReturnedExamCredential(dir, smallerExpiry, {expectedRefreshTokenHash: mark1}), 'rejected');
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as typeof realBase).claudeAiOauth.refreshToken, 'fixture-refresh-1');

    // subscriptionType ou rateLimitTier diferente recusa.
    const otherTier = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-tier',
        refreshToken: 'fixture-refresh-tier',
        expiresAt: now + 9 * 60 * 60 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_pro',
      },
    });
    assert.equal(await applyReturnedExamCredential(dir, otherTier, {expectedRefreshTokenHash: mark1}), 'rejected');

    // Arquivo trocado no meio por outro processo (marca de partida não bate mais): recusa sem gravar.
    const swapped = {
      ...realBase,
      claudeAiOauth: {
        ...realBase.claudeAiOauth,
        accessToken: 'fixture-access-external',
        refreshToken: 'fixture-refresh-external',
        expiresAt: now + 9 * 60 * 60 * 1000,
      },
    };
    await writeFile(file, JSON.stringify(swapped), {mode: 0o600});
    const staleWorkerReturn = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-stale-worker',
        refreshToken: 'fixture-refresh-stale-worker',
        expiresAt: now + 10 * 60 * 60 * 1000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    });
    assert.equal(await applyReturnedExamCredential(dir, staleWorkerReturn, {expectedRefreshTokenHash: mark1}), 'rejected');
    assert.equal((JSON.parse(await readFile(file, 'utf8')) as typeof realBase).claudeAiOauth.refreshToken, 'fixture-refresh-external');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('duas devoluções concorrentes sob trava por conta: só uma grava', async () => {
  const now = Date.now();
  const base = {
    claudeAiOauth: {
      accessToken: 'fixture-access-0',
      refreshToken: 'fixture-refresh-0',
      expiresAt: now + 6 * 60 * 1000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
  };
  const {dir, file} = await loginFile(JSON.stringify(base));
  const lock = createAsyncMutexLock();
  const accountId = randomUUID();
  const mark0 = hashExamRefreshToken('fixture-refresh-0');
  const firstReturn = JSON.stringify({
    claudeAiOauth: {
      ...base.claudeAiOauth,
      accessToken: 'fixture-access-win-1',
      refreshToken: 'fixture-refresh-win-1',
      expiresAt: now + 8 * 60 * 60 * 1000,
    },
  });
  const secondReturn = JSON.stringify({
    claudeAiOauth: {
      ...base.claudeAiOauth,
      accessToken: 'fixture-access-win-2',
      refreshToken: 'fixture-refresh-win-2',
      expiresAt: now + 9 * 60 * 60 * 1000,
    },
  });
  try {
    const outcomes = await Promise.all([
      applyReturnedExamCredential(dir, firstReturn, {expectedRefreshTokenHash: mark0, accountId, lock}),
      applyReturnedExamCredential(dir, secondReturn, {expectedRefreshTokenHash: mark0, accountId, lock}),
    ]);
    assert.deepEqual([...outcomes].sort(), ['rejected', 'written']);
    const saved = JSON.parse(await readFile(file, 'utf8')) as {claudeAiOauth: {refreshToken: string}};
    assert.equal(saved.claudeAiOauth.refreshToken, outcomes[0] === 'written' ? 'fixture-refresh-win-1' : 'fixture-refresh-win-2');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('ao pegar a trava, ensureExamLoginFresh relê o arquivo e não renova se outro processo já renovou', async () => {
  const now = Date.now();
  const stale = document({expiresAt: now - 60_000, refresh: 'fixture-refresh-old'});
  const {dir, file} = await loginFile(stale);
  const accountId = randomUUID();
  let renewCalls = 0;
  try {
    const lock: AccountLoginLock = async (_id, fn) => {
      // Simula outro processo concluindo a renovação antes desta chamada obter a trava.
      await writeFile(file, document({expiresAt: now + 3 * 60 * 60 * 1000, refresh: 'fixture-refresh-other-proc'}), {mode: 0o600});
      return fn();
    };
    const state = await ensureExamLoginFresh({
      accountDir: dir,
      accountId,
      now,
      renew: async () => {
        renewCalls += 1;
      },
      lock,
    });
    assert.equal(state, 'fresh');
    assert.equal(renewCalls, 0);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('postgresAccountLoginLock serializa duas devoluções concorrentes entre conexões Postgres reais', {skip: !process.env.AC_TEST_DATABASE_URL}, async () => {
  const baseUrl = process.env.AC_TEST_DATABASE_URL!;
  const fixture = await isolatedDatabase(baseUrl, 'examloginlock');
  const dbGateway = new Ledger(fixture.url);
  const dbCli = new Ledger(fixture.url);
  const now = Date.now();
  const base = {
    claudeAiOauth: {
      accessToken: 'fixture-access-0',
      refreshToken: 'fixture-refresh-0',
      expiresAt: now + 6 * 60 * 1000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
  };
  const {dir} = await loginFile(JSON.stringify(base));
  const accountId = randomUUID();
  const mark0 = hashExamRefreshToken('fixture-refresh-0');
  const r1 = JSON.stringify({claudeAiOauth: {...base.claudeAiOauth, accessToken: 'a1', refreshToken: 'r1', expiresAt: now + 8 * 3600_000}});
  const r2 = JSON.stringify({claudeAiOauth: {...base.claudeAiOauth, accessToken: 'a2', refreshToken: 'r2', expiresAt: now + 9 * 3600_000}});
  try {
    const outcomes = await Promise.all([
      applyReturnedExamCredential(dir, r1, {expectedRefreshTokenHash: mark0, accountId, lock: postgresAccountLoginLock(dbGateway)}),
      applyReturnedExamCredential(dir, r2, {expectedRefreshTokenHash: mark0, accountId, lock: postgresAccountLoginLock(dbCli)}),
    ]);
    assert.deepEqual([...outcomes].sort(), ['rejected', 'written']);
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
    const {mkdir} = await import('node:fs/promises');
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

test('cada motivo de recusa grava recuperação 0600 sem seguir symlink; documento inválido é descartado; account-recover aplica a maior e limpa tudo', async () => {
  const now = Date.now();
  const baseDoc = {
    claudeAiOauth: {
      accessToken: 'fixture-access-base',
      refreshToken: 'fixture-refresh-base',
      expiresAt: now + 6 * 60 * 1000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      keepNested: {v: 1},
    },
    mcpOAuth: {keepTop: true},
  };
  const baseText = JSON.stringify(baseDoc);
  const baseMark = hashExamRefreshToken('fixture-refresh-base');
  const {dir, file} = await loginFile(baseText);
  try {
    // Documento inválido (JSON ruim, sem accessToken, sem refreshToken) não gera arquivo de recuperação.
    for (const bad of [
      '{',
      JSON.stringify({claudeAiOauth: {accessToken: '', refreshToken: 'r', expiresAt: now + 1000, scopes: ['user:inference']}}),
      JSON.stringify({claudeAiOauth: {accessToken: 'a', expiresAt: now + 1000, scopes: ['user:inference']}}),
    ]) {
      const badId = randomUUID();
      assert.equal(await applyReturnedExamCredential(dir, bad, {expectedRefreshTokenHash: baseMark, jobId: badId}), 'rejected');
      await assert.rejects(() => lstat(join(dir, `.exam-credential-recovery-${badId}.json`)), {code: 'ENOENT'});
    }

    // 1) Hash diferente da marca -> arquivo de recuperação 0600.
    const jobHash = 'job-hash-mismatch';
    const docHash = JSON.stringify({
      claudeAiOauth: {
        ...baseDoc.claudeAiOauth,
        accessToken: 'fixture-access-hash-mismatch',
        refreshToken: 'fixture-refresh-hash-mismatch',
        expiresAt: now + 8 * 3600_000,
      },
    });
    assert.equal(
      await applyReturnedExamCredential(dir, docHash, {expectedRefreshTokenHash: hashExamRefreshToken('other-token'), jobId: jobHash}),
      'rejected',
    );
    const hashRecovery = join(dir, `.exam-credential-recovery-${jobHash}.json`);
    assert.equal((await lstat(hashRecovery)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(hashRecovery, 'utf8')).claudeAiOauth.refreshToken, 'fixture-refresh-hash-mismatch');

    // 2) Marca ausente -> arquivo de recuperação 0600.
    const jobMissing = 'job-missing-mark';
    const docMissing = JSON.stringify({
      claudeAiOauth: {
        ...baseDoc.claudeAiOauth,
        accessToken: 'fixture-access-missing-mark',
        refreshToken: 'fixture-refresh-missing-mark',
        expiresAt: now + 10 * 3600_000,
      },
    });
    assert.equal(
      await applyReturnedExamCredential(dir, docMissing, {expectedRefreshTokenHash: null, jobId: jobMissing}),
      'rejected',
    );
    const missingRecovery = join(dir, `.exam-credential-recovery-${jobMissing}.json`);
    assert.equal((await lstat(missingRecovery)).mode & 0o777, 0o600);

    // 3) expiresAt não maior -> arquivo de recuperação 0600.
    const jobExpires = 'job-expires-not-greater';
    const docExpires = JSON.stringify({
      claudeAiOauth: {
        ...baseDoc.claudeAiOauth,
        accessToken: 'fixture-access-smaller-exp',
        refreshToken: 'fixture-refresh-smaller-exp',
        expiresAt: baseDoc.claudeAiOauth.expiresAt,
      },
    });
    assert.equal(
      await applyReturnedExamCredential(dir, docExpires, {expectedRefreshTokenHash: baseMark, jobId: jobExpires}),
      'rejected',
    );
    const expiresRecovery = join(dir, `.exam-credential-recovery-${jobExpires}.json`);
    assert.equal((await lstat(expiresRecovery)).mode & 0o777, 0o600);

    // 4) Falha de escrita (.credentials.json vira symlink ou arquivo com falha) -> grava recuperação sem seguir symlink.
    const backup = await readFile(file, 'utf8');
    const symlinkTarget = join(dir, 'outside-target.json');
    await writeFile(symlinkTarget, backup, {mode: 0o600});
    await rm(file);
    await symlink(symlinkTarget, file);
    const jobWriteFail = 'job-write-fail';
    const docWriteFail = JSON.stringify({
      claudeAiOauth: {
        ...baseDoc.claudeAiOauth,
        accessToken: 'fixture-access-write-fail',
        refreshToken: 'fixture-refresh-write-fail',
        expiresAt: now + 12 * 3600_000,
      },
      extraTopEvil: 'drop-me',
    });
    assert.equal(
      await applyReturnedExamCredential(dir, docWriteFail, {expectedRefreshTokenHash: baseMark, jobId: jobWriteFail}),
      'rejected',
    );
    const writeFailRecovery = join(dir, `.exam-credential-recovery-${jobWriteFail}.json`);
    assert.equal((await lstat(writeFailRecovery)).mode & 0o777, 0o600);
    assert.equal(await readFile(symlinkTarget, 'utf8'), backup);

    // Symlink pré-existente no próprio arquivo de recuperação é recusado (não segue symlink).
    const trapTarget = join(dir, 'trap.json');
    await writeFile(trapTarget, 'untouched', {mode: 0o600});
    const trapRecovery = join(dir, '.exam-credential-recovery-job-symlink-trap.json');
    await symlink(trapTarget, trapRecovery);
    await assert.rejects(
      () => applyReturnedExamCredential(dir, docMissing, {expectedRefreshTokenHash: null, jobId: 'job-symlink-trap'}),
      /EXAM_LOGIN_WRITE_REFUSED/,
    );
    assert.equal(await readFile(trapTarget, 'utf8'), 'untouched');
    await rm(trapRecovery);

    // Restaura arquivo regular e aplica account-recover: escolhe maior expiresAt (job-write-fail = +12h), aplica só os 3 campos e apaga recuperações.
    await rm(file);
    await writeFile(file, backup, {mode: 0o600});
    const recovered = await recoverExamCredential(dir);
    assert.equal(recovered.status, 'recovered');
    assert.equal(recovered.filesRemoved, 4);
    const afterRecover = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    const afterOauth = afterRecover.claudeAiOauth as Record<string, unknown>;
    assert.equal(afterOauth.accessToken, 'fixture-access-write-fail');
    assert.equal(afterOauth.refreshToken, 'fixture-refresh-write-fail');
    assert.equal(afterOauth.expiresAt, now + 12 * 3600_000);
    assert.deepEqual(afterOauth.keepNested, {v: 1});
    assert.deepEqual(afterRecover.mcpOAuth, {keepTop: true});
    assert.equal('extraTopEvil' in afterRecover, false);
    const remaining = (await readdir(dir)).filter(name => name.startsWith('.exam-credential-recovery-'));
    assert.deepEqual(remaining, []);

    // Segunda execução sem arquivos de recuperação não altera nada.
    const second = await recoverExamCredential(dir);
    assert.equal(second.status, 'none');
    assert.equal(second.filesRemoved, 0);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('recoverAccountCredentialCommand aplica recuperação sob trava para account-recover CLI', async () => {
  const area = await mkdtemp(join(tmpdir(), 'ac-account-recover-cli-'));
  const dataDir = join(area, 'data');
  const accountsRoot = join(dataDir, 'accounts');
  const accountId = randomUUID();
  const accountDir = join(accountsRoot, accountId);
  const now = Date.now();
  try {
    await mkdir(accountDir, {recursive: true, mode: 0o700});
    await writeFile(join(accountDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-old',
        refreshToken: 'fixture-refresh-old',
        expiresAt: now + 1000,
        scopes: ['user:inference'],
      },
    }), {mode: 0o600});
    await writeFile(join(accountDir, '.exam-credential-recovery-job-a.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-older-rec',
        refreshToken: 'fixture-refresh-older-rec',
        expiresAt: now + 2000,
        scopes: ['user:inference'],
      },
    }), {mode: 0o600});
    await writeFile(join(accountDir, '.exam-credential-recovery-job-b.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fixture-access-newest-rec',
        refreshToken: 'fixture-refresh-newest-rec',
        expiresAt: now + 9000,
        scopes: ['user:inference'],
      },
    }), {mode: 0o600});
    let lockQueries = 0;
    const fakeLedger = {
      async tx<T>(fn: (c: {query: (sql: string, params?: unknown[]) => Promise<{rows: unknown[]; rowCount: number}>}) => Promise<T>): Promise<T> {
        return fn({
          async query(sql: string) {
            if (sql.includes('pg_advisory_xact_lock') || sql.includes('lock_timeout')) lockQueries += 1;
            return {rows: [], rowCount: 0};
          },
        });
      },
    };
    const fakeConfig = {
      activation: 'personal',
      dataDirectory: dataDir,
      accountHomesDirectory: accountsRoot,
    } as unknown as Installation;
    const result = await recoverAccountCredentialCommand(fakeConfig, fakeLedger as unknown as Ledger, accountId);
    assert.deepEqual(result, {status: 'recovered', accountId, filesRemoved: 2});
    assert.equal(lockQueries, 2);
    assert.equal(JSON.stringify(result).includes('fixture-refresh-newest-rec'), false);
    const saved = JSON.parse(await readFile(join(accountDir, '.credentials.json'), 'utf8')) as {claudeAiOauth: {refreshToken: string}};
    assert.equal(saved.claudeAiOauth.refreshToken, 'fixture-refresh-newest-rec');
  } finally {
    await rm(area, {recursive: true, force: true});
  }
});

test('relatório do exame e CLI exibem frase fixa de recuperação sem vazar o token', async () => {
  const err = new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
  markExamRecoverySaved(err);
  assert.equal(examLoginRecoveryNote(err), EXAM_LOGIN_RECOVERY_TEXT);
  assert.equal(verifyCliFailureText(err), EXAM_LOGIN_RECOVERY_TEXT);
  assert.equal(designCliFailureText(err), EXAM_LOGIN_RECOVERY_TEXT);
  assert.deepEqual(designExamStatus({loginRecovery: true}), {code: 1, lines: [EXAM_LOGIN_RECOVERY_TEXT]});
  assert.equal(EXAM_LOGIN_RECOVERY_TEXT.includes('account-recover'), true);
  assert.equal(EXAM_LOGIN_RECOVERY_TEXT.includes(SECRET), false);

  const area = await mkdtemp(join(tmpdir(), 'ac-exam-recovery-report-'));
  const repo = join(area, 'repo');
  const dataDir = join(area, 'data');
  try {
    await mkdir(repo, {mode: 0o700});
    await mkdir(dataDir, {mode: 0o700});
    const intentId = randomUUID();
    const runId = randomUUID();
    const result = await runDesignModule({
      activation: 'personal',
      projectId: randomUUID(),
      repo,
      targetUrl: 'http://127.0.0.1:3000',
      dataDirectory: dataDir,
      intentId,
      runId,
      createdAt: new Date(),
      commit: 'a'.repeat(40),
      files: [{path: 'index.html', text: '<html><body><main><h1>Oi</h1></main></body></html>'}],
      worker: {
        async run() {
          const failure = new Refusal('NATIVE_EXECUTION_OUTPUT_INVALID');
          markExamRecoverySaved(failure);
          rememberExamRecoveryNote(intentId, EXAM_LOGIN_RECOVERY_TEXT);
          throw failure;
        },
      },
      reserve: async () => ({
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        accountId: randomUUID(),
        profileId: randomUUID(),
        grantId: randomUUID(),
      }),
      release: async () => {},
    });
    assert.equal(result.loginRecovery, true);
    assert.deepEqual(designExamStatus(result), {code: 1, lines: [EXAM_LOGIN_RECOVERY_TEXT]});
    const reportMd = await readFile(join(result.directory, 'README.md'), 'utf8');
    assert.equal(reportMd.includes(EXAM_LOGIN_RECOVERY_TEXT), true);
    assert.equal(reportMd.includes(SECRET), false);
  } finally {
    await rm(area, {recursive: true, force: true});
  }
});

test('identidade: subscriptionType e rateLimitTier só divergem quando existem nos dois lados e diferem; scopes exige igualdade', async () => {
  const now = Date.now();
  const baseWithoutSoft = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-0',
      refreshToken: 'fixture-refresh-0',
      expiresAt: now + 60_000,
      scopes: ['user:inference', 'user:profile'],
    },
  });
  const withSoft = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-1',
      refreshToken: 'fixture-refresh-1',
      expiresAt: now + 8 * 3600_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
  });
  // Aparecem no retorno -> ok
  assert.equal(classifyReturnedCredential(baseWithoutSoft, withSoft), 'ok');
  // Somem no retorno -> ok
  assert.equal(classifyReturnedCredential(withSoft, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-2',
      refreshToken: 'fixture-refresh-2',
      expiresAt: now + 9 * 3600_000,
      scopes: ['user:inference', 'user:profile'],
    },
  })), 'ok');
  // Existem nos dois lados e diferem -> other-account
  assert.equal(classifyReturnedCredential(withSoft, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-3',
      refreshToken: 'fixture-refresh-3',
      expiresAt: now + 9 * 3600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_max_20x',
    },
  })), 'other-account');
  // Scopes diferentes -> other-account
  assert.equal(classifyReturnedCredential(baseWithoutSoft, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-access-4',
      refreshToken: 'fixture-refresh-4',
      expiresAt: now + 9 * 3600_000,
      scopes: ['user:inference'],
    },
  })), 'other-account');

  // applyReturnedExamCredential grava quando campos aparecem/somem e preserva campos do arquivo atual
  const {dir, file} = await loginFile(baseWithoutSoft);
  try {
    const mark0 = hashExamRefreshToken('fixture-refresh-0');
    assert.equal(await applyReturnedExamCredential(dir, withSoft, {expectedRefreshTokenHash: mark0, jobId: 'id-appear'}), 'written');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).claudeAiOauth.refreshToken, 'fixture-refresh-1');
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('renewClaudeLoginInPlace envia SIGTERM, espera grace e manda SIGKILL esperando exit antes de apagar tmpdir e soltar trava', async () => {
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
const trace = ${JSON.stringify(traceFile)};
fs.appendFileSync(trace, 'start:' + process.cwd() + '\\n');
process.on('SIGTERM', () => {
  const cwdExists = fs.existsSync(process.cwd());
  fs.appendFileSync(trace, 'sigterm:cwd=' + cwdExists + '\\n');
});
setInterval(() => {
  fs.appendFileSync(trace, 'alive:cwd=' + fs.existsSync(process.cwd()) + '\\n');
}, 40);
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
      () => lock('acc-1', () => renewClaudeLoginInPlace(accountDir, {timeoutMs: 120, killGraceMs: 150})),
      /EXAM_LOGIN_RENEW_FAILED/,
    );
    assert.equal(lockReleased, true);
    const lines = eventsAtLockRelease.trim().split('\n');
    const startLine = lines.find(line => line.startsWith('start:'));
    assert.ok(startLine);
    const scratchDir = startLine.slice('start:'.length);
    // Enquanto o filho estava vivo recebendo SIGTERM/ticks, o scratch ainda existia; depois do exit, foi apagado.
    assert.equal(lines.some(line => line === 'sigterm:cwd=true'), true);
    assert.equal(lines.some(line => line === 'alive:cwd=false'), false);
    await assert.rejects(() => lstat(scratchDir), {code: 'ENOENT'});
    // Garante que o filho realmente morreu após o retorno (nenhuma nova linha aparece).
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(await readFile(traceFile, 'utf8'), eventsAtLockRelease);
  } finally {
    if (prevBin === undefined) delete process.env.AC_NATIVE_CLAUDE_BIN;
    else process.env.AC_NATIVE_CLAUDE_BIN = prevBin;
    await rm(area, {recursive: true, force: true});
  }
});

test('ensureExamLoginFresh recalcula Date.now() dentro da trava e postgresAccountLoginLock usa lock_timeout 120s -> EXAM_LOGIN_BUSY', async () => {
  let clock = 1_700_000_000_000;
  const stale = document({expiresAt: clock - 10_000, refresh: 'fixture-refresh-clock-0'});
  const {dir, file} = await loginFile(stale);
  let renewed = 0;
  try {
    const lock: AccountLoginLock = async (_id, fn) => {
      // Outro processo renovou para clock + 5m + 5s, mas a espera na trava durou 30s.
      await writeFile(file, document({expiresAt: clock + EXAM_LOGIN_MARGIN_MS + 5_000, refresh: 'fixture-refresh-clock-1'}), {mode: 0o600});
      clock += 30_000;
      return fn();
    };
    const state = await ensureExamLoginFresh({
      accountDir: dir,
      accountId: randomUUID(),
      now: () => clock,
      lock,
      renew: async () => {
        renewed += 1;
        await writeFile(file, document({expiresAt: clock + 3 * 3600_000, refresh: 'fixture-refresh-clock-2'}), {mode: 0o600});
      },
    });
    assert.equal(state, 'renewed');
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
