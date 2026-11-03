import {readdir, readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import {QuotaInput} from '../src/capacity.ts';
import {COLLECTOR_TTL, parseProviderCollector, PROVIDER_COLLECTOR_PARSERS, PROVIDER_QUOTA_SCHEMA, toProbeResult, toQuotaInput} from '../src/provider-collector-parsers.ts';

const dir = new URL('./fixtures/provider-collectors/', import.meta.url);
const observedAt = '2026-11-03T12:00:00.000Z';
const resetAt = '2026-11-03T14:00:00.000Z';
const providers = {
  codex: PROVIDER_COLLECTOR_PARSERS.codex,
  claude: PROVIDER_COLLECTOR_PARSERS.claude,
  grok: PROVIDER_COLLECTOR_PARSERS.grok,
  antigravity: PROVIDER_COLLECTOR_PARSERS.antigravity,
} as const;
type Expectation = {provider: keyof typeof providers; class: 'available' | 'exhausted' | 'recovery' | 'unknown'; failure: 'none' | 'transport' | 'auth' | 'invalid_response'; truncated?: boolean};
const cases: Record<string, Expectation> = {
  'codex-available.json': {provider: 'codex', class: 'available', failure: 'none'},
  'codex-exhausted.json': {provider: 'codex', class: 'exhausted', failure: 'none'},
  'codex-recovery.json': {provider: 'codex', class: 'recovery', failure: 'none'},
  'codex-mixed-exhausted.json': {provider: 'codex', class: 'exhausted', failure: 'none'},
  'codex-extra.json': {provider: 'codex', class: 'unknown', failure: 'invalid_response'},
  'codex-truncated.txt': {provider: 'codex', class: 'unknown', failure: 'invalid_response', truncated: true},
  'codex-version.json': {provider: 'codex', class: 'unknown', failure: 'invalid_response'},
  'codex-null-secondary.json': {provider: 'codex', class: 'unknown', failure: 'invalid_response'},
  'codex-stale.json': {provider: 'codex', class: 'unknown', failure: 'invalid_response'},
  'claude-available.json': {provider: 'claude', class: 'available', failure: 'none'},
  'claude-exhausted.json': {provider: 'claude', class: 'exhausted', failure: 'none'},
  'claude-recovery.json': {provider: 'claude', class: 'recovery', failure: 'none'},
  'claude-overage-rejected.json': {provider: 'claude', class: 'available', failure: 'none'},
  'claude-overage-active.json': {provider: 'claude', class: 'unknown', failure: 'invalid_response'},
  'claude-partial.json': {provider: 'claude', class: 'unknown', failure: 'invalid_response'},
  'claude-extra.json': {provider: 'claude', class: 'unknown', failure: 'invalid_response'},
  'claude-truncated.txt': {provider: 'claude', class: 'unknown', failure: 'invalid_response', truncated: true},
  'claude-version.json': {provider: 'claude', class: 'unknown', failure: 'invalid_response'},
  'grok-available.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'grok-exhausted.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'grok-recovery.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'grok-extra.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'grok-truncated.txt': {provider: 'grok', class: 'unknown', failure: 'invalid_response', truncated: true},
  'grok-version.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'grok-billing-available.json': {provider: 'grok', class: 'available', failure: 'none'},
  'grok-billing-exhausted.json': {provider: 'grok', class: 'exhausted', failure: 'none'},
  'grok-billing-recovery.json': {provider: 'grok', class: 'recovery', failure: 'none'},
  'grok-billing-stale.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'grok-billing-topup.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'grok-billing-auth.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'grok-billing-extra.json': {provider: 'grok', class: 'unknown', failure: 'invalid_response'},
  'antigravity-available.json': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response'},
  'antigravity-exhausted.json': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response'},
  'antigravity-recovery.json': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response'},
  'antigravity-health-available.json': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response'},
  'antigravity-health-exhausted.json': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response'},
  'antigravity-extra.json': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response'},
  'antigravity-truncated.txt': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response', truncated: true},
  'antigravity-version.json': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response'},
  'antigravity-turn-usage.json': {provider: 'antigravity', class: 'unknown', failure: 'invalid_response'},
  'prose-limit.txt': {provider: 'codex', class: 'unknown', failure: 'invalid_response'},
};
const sensitive = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(xox[baprs]-|ghp_|github_pat_|glpat-)/,
  /bearer\s+[A-Za-z0-9._-]{8,}/i,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*\S+/i,
];
const copiedIdentities = ['5b7e1c2a-9d34-4f6e-8a10-2c3d4e5f6a70', '74eebad6-eca5-4949-88da-a067e36a3785', 'user@example.test', 'other@example.test'];

function capture(provider: keyof typeof providers, stdout: string, patch: Record<string, unknown> = {}) {
  return {kind: 'stdout' as const, provider, parserId: providers[provider], exitCode: 0, stdout, observedAt, ...patch};
}

test('sanitized collector fixtures cover quota classes without secrets or skips', async () => {
  const names = (await readdir(dir)).sort();
  assert.deepEqual(names, Object.keys(cases).sort());
  const seen = new Set<string>();
  for (const name of names) {
    const expected = cases[name]!;
    const stdout = await readFile(new URL(name, dir), 'utf8');
    assert.ok(stdout.length > 0 && stdout.length <= 8192);
    for (const pattern of sensitive) assert.equal(pattern.test(stdout), false, name);
    for (const identity of copiedIdentities) assert.equal(stdout.includes(identity), false, name);
    const observation = parseProviderCollector(capture(expected.provider, stdout, expected.truncated ? {truncated: true} : {}));
    seen.add(`${expected.provider}:${observation.class}`);
    assert.equal(observation.class, expected.class, name);
    assert.equal(observation.failure, expected.failure, name);
    assert.equal(observation.provider, expected.provider, name);
    assert.equal(observation.parserId, providers[expected.provider], name);
    assert.equal(JSON.stringify(observation).includes('rpc-1'), false, name);
    assert.equal(JSON.stringify(observation).includes('00000000-0000-4000-8000'), false, name);
    assert.equal(JSON.stringify(observation).includes('DO_NOT_COPY_MARKER'), false, name);
    assert.equal(JSON.stringify(observation).includes('@'), false, name);
    assert.deepEqual(Object.keys(observation).sort(), ['class', 'failure', 'parserId', 'provider', 'remainingPercent', 'resetAt', 'schemaVersion', 'source', 'status', 'ttlSeconds']);
    const quota = toQuotaInput(observation);
    assert.equal(quota.status, observation.status);
    assert.equal(quota.source, `collector:${providers[expected.provider]}`);
    const probe = toProbeResult(observation);
    assert.deepEqual(probe, {status: observation.status, ttlSeconds: observation.ttlSeconds, remainingPercent: observation.remainingPercent, resetAt: observation.resetAt});
    if (observation.resetAt !== null) assert.equal(z.iso.datetime().safeParse(observation.resetAt).success, true);
    if (expected.class === 'available') {
      assert.equal(observation.status, 'available');
      assert.equal(observation.ttlSeconds, COLLECTOR_TTL.available);
      assert.equal(observation.remainingPercent, 65);
      assert.equal(observation.resetAt, resetAt);
    } else if (expected.class === 'exhausted') {
      assert.equal(observation.status, 'exhausted');
      assert.equal(observation.ttlSeconds, COLLECTOR_TTL.exhausted);
      assert.equal(observation.remainingPercent, 0);
      assert.equal(observation.resetAt, null);
    } else if (expected.class === 'recovery') {
      assert.equal(observation.status, 'rate_limited');
      assert.equal(observation.ttlSeconds, COLLECTOR_TTL.max);
      assert.equal(observation.remainingPercent, 0);
      assert.equal(observation.resetAt, resetAt);
    } else {
      assert.equal(observation.status, 'unknown');
      assert.equal(observation.ttlSeconds, COLLECTOR_TTL.unknown);
      assert.equal(observation.remainingPercent, null);
      assert.equal(observation.resetAt, null);
    }
    // Capacity admits only fresh status available. This in-memory check is not a PostgreSQL proof.
    assert.equal(observation.status === 'available', expected.class === 'available');
    if (PROVIDER_QUOTA_SCHEMA[expected.provider] === 'unproven') {
      assert.equal(observation.class, 'unknown');
      assert.notEqual(observation.status, 'available');
      assert.notEqual(observation.status, 'exhausted');
      assert.notEqual(observation.status, 'rate_limited');
    }
  }
  for (const provider of ['codex', 'claude', 'grok'] as const) {
    assert.equal(PROVIDER_QUOTA_SCHEMA[provider], 'bound');
    for (const kind of ['available', 'exhausted', 'recovery', 'unknown'] as const) assert.equal(seen.has(`${provider}:${kind}`), true, `${provider}:${kind}`);
  }
  // Antigravity health and turn usage do not carry a verifiable remaining fraction.
  assert.equal(PROVIDER_QUOTA_SCHEMA.antigravity, 'unproven');
  assert.equal(seen.has('antigravity:unknown'), true);
  for (const kind of ['available', 'exhausted', 'recovery'] as const) assert.equal(seen.has(`antigravity:${kind}`), false, kind);
});

test('transport, authentication, exit, version and oversize output never become quota', async () => {
  const available = await readFile(new URL('codex-available.json', dir), 'utf8');
  const refused = [
    parseProviderCollector({kind: 'transport_error', provider: 'grok', parserId: providers.grok, observedAt}),
    parseProviderCollector({kind: 'auth_error', provider: 'claude', parserId: providers.claude, observedAt}),
    parseProviderCollector({kind: 'transport_error', provider: 'codex', parserId: providers.codex, observedAt, stdout: `${available}user@example.com`}),
    parseProviderCollector(capture('codex', available, {exitCode: 1})),
    parseProviderCollector(capture('codex', available, {parserId: 'codex-rate-limits-v2'})),
    parseProviderCollector(capture('codex', 'x'.repeat(8193))),
    parseProviderCollector(capture('codex', 'login user@example.com token=secret')),
    parseProviderCollector(null),
  ];
  assert.equal(refused[0]!.failure, 'transport');
  assert.equal(refused[1]!.failure, 'auth');
  for (const observation of refused) {
    assert.equal(observation.class, 'unknown');
    assert.equal(observation.status, 'unknown');
    assert.equal(observation.remainingPercent, null);
    assert.equal(JSON.stringify(observation).includes('@'), false);
    assert.equal(JSON.stringify(observation).includes('secret'), false);
    toQuotaInput(observation);
  }
  const truncated = await readFile(new URL('codex-truncated.txt', dir), 'utf8');
  assert.equal(parseProviderCollector(capture('codex', truncated)).status, 'unknown');
  const grokInvented = await readFile(new URL('grok-available.json', dir), 'utf8');
  const grokBlocked = await readFile(new URL('grok-exhausted.json', dir), 'utf8');
  const agyInvented = await readFile(new URL('antigravity-recovery.json', dir), 'utf8');
  const agyUsage = await readFile(new URL('antigravity-turn-usage.json', dir), 'utf8');
  const prose = await readFile(new URL('prose-limit.txt', dir), 'utf8');
  const unproven = [
    parseProviderCollector(capture('grok', grokInvented)),
    parseProviderCollector(capture('grok', grokBlocked)),
    parseProviderCollector(capture('grok', prose)),
    parseProviderCollector(capture('antigravity', agyInvented)),
    parseProviderCollector(capture('antigravity', agyUsage)),
    parseProviderCollector(capture('grok', grokInvented, {parserId: 'grok-subscription-status-v1'})),
    parseProviderCollector(capture('antigravity', agyInvented, {parserId: 'antigravity-quota-event-v1'})),
  ];
  for (const observation of unproven) {
    assert.equal(observation.class, 'unknown');
    assert.equal(observation.status, 'unknown');
    assert.equal(observation.remainingPercent, null);
    assert.equal(observation.resetAt, null);
    assert.notEqual(observation.status, 'exhausted');
    toQuotaInput(observation);
  }
});
