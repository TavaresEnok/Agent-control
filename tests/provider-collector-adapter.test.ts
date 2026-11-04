import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {COLLECTOR_TTL} from '../src/provider-collector-parsers.ts';
import {createProviderCollectorAdapter, PROVIDER_COLLECTOR_STDOUT_MAX, type ProviderCollectorRunner} from '../src/provider-collector-adapter.ts';
import type {ProviderProbeResult} from '../src/providers.ts';

const dir = new URL('./fixtures/provider-collectors/', import.meta.url);
const observedAt = '2026-11-03T12:00:00.000Z';
const resetAt = '2026-11-03T14:00:00.000Z';
const quotaStatuses = new Set(['available', 'exhausted', 'rate_limited']);

type ProviderName = 'codex' | 'claude' | 'grok' | 'antigravity';
type Row = {provider: ProviderName; label: string; file: string; status: ProviderProbeResult['status']; remaining: number | null; reset: string | null; ttl: number};

const rows: Row[] = [
  {provider: 'codex', label: 'available', file: 'codex-available.json', status: 'available', remaining: 65, reset: resetAt, ttl: COLLECTOR_TTL.available},
  {provider: 'codex', label: 'exhausted', file: 'codex-exhausted.json', status: 'exhausted', remaining: 0, reset: null, ttl: COLLECTOR_TTL.exhausted},
  {provider: 'codex', label: 'recovery', file: 'codex-recovery.json', status: 'rate_limited', remaining: 0, reset: resetAt, ttl: COLLECTOR_TTL.max},
  {provider: 'codex', label: 'unknown', file: 'codex-version.json', status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown},
  {provider: 'claude', label: 'available', file: 'claude-available.json', status: 'available', remaining: 65, reset: resetAt, ttl: COLLECTOR_TTL.available},
  {provider: 'claude', label: 'exhausted', file: 'claude-exhausted.json', status: 'exhausted', remaining: 0, reset: null, ttl: COLLECTOR_TTL.exhausted},
  {provider: 'claude', label: 'recovery', file: 'claude-recovery.json', status: 'rate_limited', remaining: 0, reset: resetAt, ttl: COLLECTOR_TTL.max},
  {provider: 'claude', label: 'unknown', file: 'claude-version.json', status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown},
  {provider: 'grok', label: 'available', file: 'grok-billing-available.json', status: 'available', remaining: 65, reset: resetAt, ttl: COLLECTOR_TTL.available},
  {provider: 'grok', label: 'exhausted', file: 'grok-billing-exhausted.json', status: 'exhausted', remaining: 0, reset: null, ttl: COLLECTOR_TTL.exhausted},
  {provider: 'grok', label: 'recovery', file: 'grok-billing-recovery.json', status: 'rate_limited', remaining: 0, reset: resetAt, ttl: COLLECTOR_TTL.max},
  {provider: 'grok', label: 'unknown', file: 'grok-version.json', status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown},
  {provider: 'antigravity', label: 'available', file: 'antigravity-available.json', status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown},
  {provider: 'antigravity', label: 'exhausted', file: 'antigravity-exhausted.json', status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown},
  {provider: 'antigravity', label: 'recovery', file: 'antigravity-recovery.json', status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown},
  {provider: 'antigravity', label: 'unknown', file: 'antigravity-version.json', status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown},
];

function adapterFor(provider: ProviderName, runner: ProviderCollectorRunner, timeoutMs = 1000) {
  return createProviderCollectorAdapter({provider, runner, timeoutMs, now: () => new Date(observedAt)});
}

function assertProbe(result: ProviderProbeResult, expected: Pick<Row, 'status' | 'remaining' | 'reset' | 'ttl'>, accountId: string) {
  assert.deepEqual(result, {status: expected.status, ttlSeconds: expected.ttl, remainingPercent: expected.remaining, resetAt: expected.reset});
  assert.deepEqual(Object.keys(result).sort(), ['remainingPercent', 'resetAt', 'status', 'ttlSeconds']);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(accountId), false);
  assert.equal(encoded.includes('rpc-1'), false);
  assert.equal(encoded.includes('DO_NOT_COPY_MARKER'), false);
  assert.equal(encoded.includes('@'), false);
  assert.equal(encoded.includes('secret'), false);
  assert.equal(encoded.includes('SECRET_GIANT'), false);
  if (expected.status === 'unknown' || expected.status === 'unreachable') {
    assert.equal(quotaStatuses.has(result.status), false);
    assert.equal(result.remainingPercent, null);
    assert.equal(result.resetAt, null);
  }
}

test('injected runners map each provider fixture class to the probe contract', async () => {
  const seen = new Set<string>();
  for (const row of rows) {
    const stdout = await readFile(new URL(row.file, dir), 'utf8');
    const accountId = `synthetic-${row.provider}-account`;
    let calls = 0;
    const adapter = adapterFor(row.provider, ({accountId: seenId, signal}) => {
      calls += 1;
      assert.equal(seenId, accountId);
      assert.equal(signal.aborted, false);
      return {stdout, exitCode: 0};
    });
    assert.equal(adapter.manifest.provider, row.provider);
    assert.equal(adapter.manifest.mode, 'synthetic');
    assert.equal(adapter.manifest.eligibility, 'documented_supported');
    assert.equal(adapter.manifest.source, `synthetic://collector/${row.provider}/${adapter.manifest.version}`);
    const result = await adapter.probe({accountId, signal: new AbortController().signal});
    assertProbe(result, row, accountId);
    assert.equal(calls, 1);
    seen.add(`${row.provider}:${row.label}:${result.status}`);
  }
  for (const provider of ['codex', 'claude', 'grok'] as const) {
    assert.equal(seen.has(`${provider}:available:available`), true);
    assert.equal(seen.has(`${provider}:exhausted:exhausted`), true);
    assert.equal(seen.has(`${provider}:recovery:rate_limited`), true);
    assert.equal(seen.has(`${provider}:unknown:unknown`), true);
  }
  for (const label of ['available', 'exhausted', 'recovery', 'unknown']) {
    assert.equal(seen.has(`antigravity:${label}:unknown`), true);
  }
});

test('runner failure, abort, empty, malformed, unknown version and oversize stay uncertain', async () => {
  const accountId = 'user@example.test';
  const secretStdout = 'login user@example.com token=secret';
  const multibyteOver = 'é'.repeat((PROVIDER_COLLECTOR_STDOUT_MAX / 2) + 1);
  assert.ok(multibyteOver.length <= PROVIDER_COLLECTOR_STDOUT_MAX);
  assert.ok(Buffer.byteLength(multibyteOver, 'utf8') > PROVIDER_COLLECTOR_STDOUT_MAX);
  const cases: Array<{name: string; runner: ProviderCollectorRunner; status: 'unknown' | 'unreachable'; abort?: boolean; timeoutMs?: number}> = [
    {name: 'throw', runner: () => { throw new Error('cli token=secret'); }, status: 'unreachable'},
    {name: 'reject', runner: async () => { throw new Error('cli token=secret'); }, status: 'unreachable'},
    {name: 'abort', runner: ({signal}) => new Promise(resolve => { signal.addEventListener('abort', () => resolve(`token=secret ${'SHOULD_NOT_WIN'}`)); }), status: 'unreachable', abort: true},
    {name: 'empty', runner: () => '', status: 'unknown'},
    {name: 'blank-object', runner: () => ({stdout: ''}), status: 'unknown'},
    {name: 'malformed', runner: () => secretStdout, status: 'unknown'},
    {name: 'version', runner: async () => readFile(new URL('codex-version.json', dir), 'utf8'), status: 'unknown'},
    {name: 'nonzero', runner: async () => ({stdout: await readFile(new URL('codex-available.json', dir), 'utf8'), exitCode: 1}), status: 'unknown'},
    {name: 'giant', runner: () => `SECRET_GIANT${'x'.repeat(PROVIDER_COLLECTOR_STDOUT_MAX)}`, status: 'unknown'},
    {name: 'multibyte', runner: () => `SECRET_GIANT${multibyteOver}`, status: 'unknown'},
  ];
  for (const item of cases) {
    const controller = new AbortController();
    const adapter = adapterFor('codex', item.runner, item.timeoutMs ?? 1000);
    const pending = adapter.probe({accountId, signal: controller.signal});
    if (item.abort) controller.abort();
    const result = await pending;
    assertProbe(result, {status: item.status, remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown}, accountId);
    assert.equal(JSON.stringify(result).includes('SHOULD_NOT_WIN'), false, item.name);
  }
  const already = new AbortController();
  already.abort();
  let called = 0;
  const skipped = adapterFor('claude', () => { called += 1; return 'token=secret'; });
  const skippedResult = await skipped.probe({accountId, signal: already.signal});
  assert.equal(called, 0);
  assertProbe(skippedResult, {status: 'unreachable', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown}, accountId);

  const source = await readFile(new URL('../src/provider-collector-adapter.ts', import.meta.url), 'utf8');
  assert.equal(/from ['"]node:child_process['"]|from ['"]child_process['"]|\bspawn\(/.test(source), false);
  assert.equal(source.includes('provider-collector-parsers'), true);

  const exact = 'é'.repeat(PROVIDER_COLLECTOR_STDOUT_MAX / 2);
  assert.equal(Buffer.byteLength(exact, 'utf8'), PROVIDER_COLLECTOR_STDOUT_MAX);
  let clocks = 0;
  const counted = createProviderCollectorAdapter({
    provider: 'codex',
    runner: () => exact,
    timeoutMs: 1000,
    now: () => { clocks += 1; return new Date(observedAt); },
  });
  const exactResult = await counted.probe({accountId, signal: new AbortController().signal});
  assert.equal(clocks, 1);
  assertProbe(exactResult, {status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown}, accountId);
  clocks = 0;
  const blocked = createProviderCollectorAdapter({
    provider: 'codex',
    runner: () => multibyteOver,
    timeoutMs: 1000,
    now: () => { clocks += 1; return new Date(observedAt); },
  });
  const blockedResult = await blocked.probe({accountId, signal: new AbortController().signal});
  assert.equal(clocks, 0);
  assertProbe(blockedResult, {status: 'unknown', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown}, accountId);

  const available = await readFile(new URL('codex-available.json', dir), 'utf8');
  const slow = adapterFor('codex', () => new Promise(resolve => { setTimeout(() => resolve(available), 40); }), 20);
  const slowResult = await slow.probe({accountId: 'synthetic-codex-account', signal: new AbortController().signal});
  assertProbe(slowResult, {status: 'available', remaining: 65, reset: resetAt, ttl: COLLECTOR_TTL.available}, 'synthetic-codex-account');

  let hangingSettled = false;
  const hangingController = new AbortController();
  const hanging = adapterFor('codex', () => new Promise(() => {}), 30);
  const hangingProbe = hanging.probe({accountId, signal: hangingController.signal}).then(result => {
    hangingSettled = true;
    return result;
  });
  await new Promise(resolve => { setTimeout(resolve, 80); });
  assert.equal(hangingSettled, false);
  hangingController.abort();
  const hangingResult = await hangingProbe;
  assertProbe(hangingResult, {status: 'unreachable', remaining: null, reset: null, ttl: COLLECTOR_TTL.unknown}, accountId);
});
