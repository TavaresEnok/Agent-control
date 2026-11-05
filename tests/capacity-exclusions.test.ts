import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAPACITY_EXCLUSION_REASONS, classifyProfileExclusion, orderedProfileExclusions, type ChainProfileFacts,
} from '../src/capacity-exclusions.ts';

const id = '00000000-0000-4000-8000-000000000001';
function facts(over: Partial<ChainProfileFacts> = {}): ChainProfileFacts {
  return {
    profileId: id, profilePresent: true, projectAccess: true, mode: 'synthetic', accountEnabled: true,
    profileEnabled: true, eligibility: 'documented_supported', freshQuotaStatus: 'available', ...over,
  };
}

test('selectable synthetic profile has no exclusion', () => {
  assert.equal(classifyProfileExclusion(facts()), null);
});

test('closed reasons stay the documented set', () => {
  assert.deepEqual(CAPACITY_EXCLUSION_REASONS, [
    'profile_missing', 'access_removed', 'account_disabled', 'profile_disabled',
    'not_synthetic', 'ineligible', 'quota_exhausted', 'quota_unknown',
    'quota_rate_limited','authentication_required','provider_unreachable','provider_configuration_error','quota_disabled',
  ]);
});

test('each gate maps to one reason and earlier gates win', () => {
  assert.equal(classifyProfileExclusion(facts({ profilePresent: false, projectAccess: false, mode: 'api', accountEnabled: false })), 'profile_missing');
  assert.equal(classifyProfileExclusion(facts({ projectAccess: false, mode: 'subscription_cli', accountEnabled: false })), 'access_removed');
  assert.equal(classifyProfileExclusion(facts({ mode: 'subscription_cli', accountEnabled: false, profileEnabled: false })), 'not_synthetic');
  assert.equal(classifyProfileExclusion(facts({ mode: 'api', accountEnabled: false })), 'not_synthetic');
  assert.equal(classifyProfileExclusion(facts({ accountEnabled: false, profileEnabled: false, eligibility: 'not_assessed' })), 'account_disabled');
  assert.equal(classifyProfileExclusion(facts({ profileEnabled: false, eligibility: 'unsupported_for_mode', freshQuotaStatus: 'exhausted' })), 'profile_disabled');
  assert.equal(classifyProfileExclusion(facts({ eligibility: 'requires_clarification', freshQuotaStatus: 'exhausted' })), 'ineligible');
  assert.equal(classifyProfileExclusion(facts({ eligibility: 'not_assessed', freshQuotaStatus: null })), 'ineligible');
  assert.equal(classifyProfileExclusion(facts({ freshQuotaStatus: 'exhausted' })), 'quota_exhausted');
  assert.equal(classifyProfileExclusion(facts({ freshQuotaStatus: null })), 'quota_unknown');
  assert.equal(classifyProfileExclusion(facts({ freshQuotaStatus: 'unknown' })), 'quota_unknown');
  assert.equal(classifyProfileExclusion(facts({ freshQuotaStatus: 'rate_limited' })), 'quota_rate_limited');
  assert.equal(classifyProfileExclusion(facts({ freshQuotaStatus: 'disabled' })), 'quota_disabled');
});

test('expired quota is unknown, never exhausted, and an eligible profile is not listed', () => {
  const missing = '00000000-0000-4000-8000-000000000002';
  const expired = '00000000-0000-4000-8000-000000000003';
  const ready = '00000000-0000-4000-8000-000000000004';
  const chain = [
    facts({ profileId: missing, profilePresent: false }),
    facts({ profileId: expired, freshQuotaStatus: null }),
    facts({ profileId: ready, freshQuotaStatus: 'available' }),
  ];
  assert.deepEqual(orderedProfileExclusions(chain), [
    { profileId: missing, reason: 'profile_missing' },
    { profileId: expired, reason: 'quota_unknown' },
  ]);
});
