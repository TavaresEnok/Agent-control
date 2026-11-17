import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {assertTargetOnly, dynamicScanPlan} from '../src/verify-dynamic.ts';

function refusal(error: unknown): string {
  assert.ok(error instanceof Refusal);
  return error.code;
}

test('127.0.0.1 passa e outro host é recusado', () => {
  assert.doesNotThrow(() => assertTargetOnly('http://127.0.0.1:4311/saude', '127.0.0.1:4311'));
  assert.doesNotThrow(() => assertTargetOnly('http://127.0.0.1:4311/saude', '127.0.0.1'));
  assert.doesNotThrow(() => assertTargetOnly('https://localhost/saude', 'localhost:443'));
  assert.doesNotThrow(() => assertTargetOnly('http://app.local:9/saude', 'app.local:9'));
  assert.equal(refusal(catchRefusal(() => assertTargetOnly('https://exemplo.com/saude', 'exemplo.com'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => assertTargetOnly('http://127.0.0.2:4311/saude', '127.0.0.2:4311'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => assertTargetOnly('http://[::1]:4311/saude', '[::1]:4311'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => assertTargetOnly('http://127.0.0.1:4311/saude', '127.0.0.2:4311'))), 'VERIFY_TARGET_ESCAPE');
  assert.equal(refusal(catchRefusal(() => assertTargetOnly('http://127.0.0.1:4311/saude', '127.0.0.1:4312'))), 'VERIFY_TARGET_ESCAPE');
  assert.equal(refusal(catchRefusal(() => assertTargetOnly('ftp://127.0.0.1/saude', '127.0.0.1'))), 'VERIFY_EXTERNAL_TARGET');
});

test('o plano fica na origem declarada, sem varredura ampla', () => {
  const target = 'http://127.0.0.1:18080/api';
  const plan = dynamicScanPlan(target);
  assert.equal(plan.network, 'verify-homologation');
  assert.equal(plan.allowedHost, '127.0.0.1');
  assert.equal(plan.allowedPort, 18080);
  assert.deepEqual(plan.tools.map(tool => tool.name), ['zap', 'schemathesis', 'nuclei']);
  assert.equal(plan.tools[0].mode, 'baseline-passivo');
  assert.deepEqual(plan.tools[0].args, ['zap-baseline.py', '-t', target]);
  assert.deepEqual(plan.tools[1].args, ['schemathesis', 'run', 'http://127.0.0.1:18080/openapi.json', '--base-url', 'http://127.0.0.1:18080']);
  assert.deepEqual(plan.tools[2].args, ['nuclei', '-u', target, '-tags', 'cve,exposure,misconfig']);
  const blob = JSON.stringify(plan);
  assert.equal(blob.includes('ffuf'), false);
  assert.equal(blob.includes('sqlmap'), false);
  assert.equal(blob.includes('exemplo.com'), false);
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan('https://exemplo.com/api'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan('http://127.0.0.2:9/api'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan('http://127.0.0.1:9/?next=http://exemplo.com/'))), 'VERIFY_TARGET_ESCAPE');
});

function catchRefusal(fn: () => void): unknown {
  try { fn(); }
  catch (error) { return error; }
  throw new Error('deveria recusar');
}
