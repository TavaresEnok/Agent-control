import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateQaWaiverGate, qaWaiverStageReceipt, type QaWaiverBindingRecord } from '../src/qa-waiver-binding.ts';
import { ControlCommand } from '../src/control.ts';

const digest = 'ab'.repeat(32);
const waiver: QaWaiverBindingRecord = {
  policyRevision: 3,
  policyDigest: digest,
  templateId: '11111111-1111-4111-8111-111111111111',
  templateRevision: 2,
  templateDigest: digest,
  riskRule: 'explicit-low',
  taskId: 'docs',
  artifactDigest: digest,
};
const base = {
  allowLowRiskQaWaiver: true,
  risk: 'low',
  evidence: [] as { kind: string; status: string }[],
  policyRevision: 3,
  policyDigest: digest,
  artifactDigest: digest,
  waiver,
  templateDigest: digest,
};

test('a complete explicit waiver is not_required and does not invent a passed receipt', () => {
  assert.deepEqual(evaluateQaWaiverGate(base), { ok: true, basis: 'not_required' });
});

test('passed QA satisfies the gate without a waiver', () => {
  assert.deepEqual(evaluateQaWaiverGate({ ...base, waiver: null, evidence: [{ kind: 'qa', status: 'passed' }] }), { ok: true, basis: 'passed' });
});

test('failed, canceled, missing and stale evidence block even when the waiver matches', () => {
  for (const status of ['failed', 'canceled', 'missing_result', 'stale']) {
    const decision = evaluateQaWaiverGate({ ...base, evidence: [{ kind: 'qa', status }] });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.code, 'VERIFICATION_NOT_PASSED');
  }
});

test('another artifact digest, another policy or a missing template does not inherit the waiver', () => {
  const absent = evaluateQaWaiverGate({ ...base, waiver: null });
  assert.deepEqual(absent, { ok: false, code: 'QA_MISSING' });
  const moved = evaluateQaWaiverGate({ ...base, artifactDigest: 'cd'.repeat(32) });
  assert.equal(moved.ok, false);
  if (!moved.ok) assert.equal(moved.code, 'QA_WAIVER_STALE');
  const retargeted = evaluateQaWaiverGate({ ...base, policyRevision: 4 });
  assert.equal(retargeted.ok, false);
  if (!retargeted.ok) assert.equal(retargeted.code, 'QA_WAIVER_STALE');
  const missingTemplate = evaluateQaWaiverGate({ ...base, templateDigest: null });
  assert.equal(missingTemplate.ok, false);
  if (!missingTemplate.ok) assert.equal(missingTemplate.code, 'QA_WAIVER_STALE');
});

test('a stage waiver receipt is not a passed verification receipt', () => {
  const receipt = { qaWaiver: { schemaVersion: 1, basis: 'not_required', artifactId: '11111111-1111-4111-8111-111111111111', authorizationId: '22222222-2222-4222-8222-222222222222', taskId: 'docs' } };
  assert.equal(qaWaiverStageReceipt(receipt)?.basis, 'not_required');
  assert.equal(qaWaiverStageReceipt({ ...receipt, verification: { status: 'passed' } }), null);
  assert.equal(qaWaiverStageReceipt({ qaWaiver: { ...receipt.qaWaiver, basis: 'passed' } }), null);
});

test('the signed control command accepts an owner QA waiver authorization', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const parsed = ControlCommand.parse({ schemaVersion: 1, intentId: id, deliveryAttemptId: id, contextId: id, action: 'qa.waiver.authorize', payload: { policyRevision: 1, templateId: id, templateRevision: 1, taskId: 'docs', riskRule: 'explicit-low' } });
  assert.equal(parsed.action, 'qa.waiver.authorize');
  assert.throws(() => ControlCommand.parse({ schemaVersion: 1, intentId: id, deliveryAttemptId: id, contextId: id, action: 'qa.waiver.authorize', payload: { policyRevision: 1, templateId: id, templateRevision: 1, taskId: 'docs', riskRule: 'explicit-low', note: 'não precisa testar' } }));
});

test('high risk and a disabled policy stay missing instead of becoming not_required', () => {
  const high = evaluateQaWaiverGate({ ...base, risk: 'high' });
  assert.deepEqual(high, { ok: false, code: 'QA_MISSING' });
  const closed = evaluateQaWaiverGate({ ...base, allowLowRiskQaWaiver: false });
  assert.deepEqual(closed, { ok: false, code: 'QA_MISSING' });
});
