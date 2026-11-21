import test from 'node:test';
import assert from 'node:assert/strict';
import {EXECUTION_PROVIDER_OVERLOADED, isTransientProviderFailure, runWithTransientRetry, transientRetryDelay} from '../src/provider-failure.ts';
import {claudeLimitFromText, codexLimitFromText, futureResetMs, SHORT_RATE_LIMIT_WAIT_MS} from '../src/quota-exhaustion.ts';

test('only a passing outage is transient', () => {
  assert.equal(isTransientProviderFailure(['API Error: 529 {"type":"overloaded_error"}']), true);
  assert.equal(isTransientProviderFailure(['API Error: 503 upstream connect error']), true);
  assert.equal(isTransientProviderFailure(['stream disconnected before completion']), true);
  assert.equal(isTransientProviderFailure(['Claude AI usage limit reached|1763700000']), false);
  assert.equal(isTransientProviderFailure(['Invalid API key · Please run /login']), false);
  assert.equal(isTransientProviderFailure(['TypeError: x is not a function', '', null]), false);
});

test('the retry wait spreads and never eats the last minute of the job', () => {
  assert.equal(transientRetryDelay(0, 10 * 60_000, () => 0.5), 30_000);
  assert.equal(transientRetryDelay(1, 10 * 60_000, () => 0), 96_000);
  assert.equal(transientRetryDelay(2, 10 * 60_000, () => 0.5), null);
  assert.equal(transientRetryDelay(0, 80_000, () => 0.5), null);
});

test('evaluators retry an overload twice; the programmer and other failures do not retry', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  let calls = 0;
  const flaky = async () => (++calls < 3 ? {failure: EXECUTION_PROVIDER_OVERLOADED} : {failure: null});
  assert.deepEqual(await runWithTransientRetry({enabled: true, deadlineMs: Date.now() + 3_600_000, aborted: () => false, once: flaky, sleep, random: () => 0.5}), {failure: null});
  assert.equal(calls, 3);
  assert.deepEqual(waits, [30_000, 120_000]);
  calls = 0;
  assert.deepEqual(await runWithTransientRetry({enabled: false, deadlineMs: Date.now() + 3_600_000, aborted: () => false, once: flaky, sleep}), {failure: EXECUTION_PROVIDER_OVERLOADED});
  assert.equal(calls, 1);
  calls = 0;
  const thrown = async () => { calls++; throw Object.assign(new Error('x'), {code: EXECUTION_PROVIDER_OVERLOADED}); };
  await assert.rejects(runWithTransientRetry({enabled: true, deadlineMs: Date.now() + 3_600_000, aborted: () => false, once: thrown, sleep}), {code: EXECUTION_PROVIDER_OVERLOADED});
  assert.equal(calls, 3);
  calls = 0;
  const other = async () => { calls++; return {failure: 'EXECUTION_NATIVE_TURN_FAILED'}; };
  await runWithTransientRetry({enabled: true, deadlineMs: Date.now() + 3_600_000, aborted: () => false, once: other, sleep});
  assert.equal(calls, 1);
});

test('a bare rate limit waits five minutes; a usage limit with no reset keeps the one-hour default', () => {
  const now = 1_763_700_000_000;
  const short = claudeLimitFromText(['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'], now);
  assert.equal(futureResetMs(short!.usageWindows, now), now + SHORT_RATE_LIMIT_WAIT_MS);
  const codexShort = codexLimitFromText(['stream error: 429 Too Many Requests: rate limit exceeded'], now);
  assert.equal(futureResetMs(codexShort!.usageWindows, now), now + SHORT_RATE_LIMIT_WAIT_MS);
  const long = claudeLimitFromText(['You have reached your weekly usage limit'], now);
  assert.equal(long!.usageWindows, null);
  const stated = claudeLimitFromText(['rate limit, try again in 20 minutes'], now);
  assert.equal(futureResetMs(stated!.usageWindows, now), now + 20 * 60_000);
});
