import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Refusal} from '../src/contracts.ts';
import {assertTargetOnly, dynamicScanPlan} from '../src/verify-dynamic.ts';
import {VERIFY_RUNTIME_BIN} from '../src/verify-image.ts';

function refusal(error: unknown): string {
  assert.ok(error instanceof Refusal);
  return error.code;
}

test('127.0.0.1 passa e outro host é recusado', () => {
  assert.doesNotThrow(() => assertTargetOnly('http://127.0.0.1:4311/saude', '127.0.0.1:4311'));
  assert.doesNotThrow(() => assertTargetOnly('http://127.0.0.1:4311/saude', '127.0.0.1'));
  assert.doesNotThrow(() => assertTargetOnly('https://localhost/saude', 'localhost:443'));
  assert.doesNotThrow(() => assertTargetOnly('http://verify-alvo:9/saude', 'verify-alvo:9'));
  assert.equal(refusal(catchRefusal(() => assertTargetOnly('http://app.local:9/saude', 'app.local:9'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan('http://app.local:9/saude'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan('http://alvo.interno:9/saude'))), 'VERIFY_EXTERNAL_TARGET');
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
  assert.deepEqual(plan.tools[0].args, [
    'zap-baseline.py',
    '-t',
    target,
    '-z',
    '-config contexts.context.0.include=http://127.0.0.1:18080.*',
  ]);
  assert.deepEqual(plan.tools[1].args, ['schemathesis', 'run', 'http://127.0.0.1:18080/openapi.json', '--base-url', 'http://127.0.0.1:18080']);
  assert.deepEqual(plan.tools[2].args, ['nuclei', '-u', target, '-tags', 'cve,exposure,misconfig', '-follow-redirects=false']);
  const container = dynamicScanPlan('http://verify-alvo:9/app');
  assert.equal(container.network, 'verify-homologation');
  assert.equal(container.allowedHost, 'verify-alvo');
  assert.equal(container.allowedPort, 9);
  assert.ok(container.tools[0].args.includes('zap-baseline.py'));
  assert.ok(container.tools[0].args.includes('-t'));
  assert.ok(container.tools[0].args.includes('http://verify-alvo:9/app'));
  assert.ok(container.tools[0].args.includes('-config contexts.context.0.include=http://verify-alvo:9.*'));
  assert.equal(container.tools[2].args.includes('-follow-redirects=false'), true);
  const blob = JSON.stringify(plan);
  assert.equal(blob.includes('ffuf'), false);
  assert.equal(blob.includes('sqlmap'), false);
  assert.equal(blob.includes('exemplo.com'), false);
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan('https://exemplo.com/api'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan('http://127.0.0.2:9/api'))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan('http://127.0.0.1:9/?next=http://exemplo.com/'))), 'VERIFY_TARGET_ESCAPE');
  assert.equal(refusal(catchRefusal(() => dynamicScanPlan(`http://${'a'.repeat(64)}:9/`))), 'VERIFY_EXTERNAL_TARGET');
  assert.equal(dynamicScanPlan(`http://${'b'.repeat(63)}:9/`).allowedHost, 'b'.repeat(63));
});

test('a rede interna anexa só o contêiner alvo', async () => {
  const {attachInternalTarget} = await import('../src/verify-dynamic.ts');
  const calls: string[][] = [];
  await attachInternalTarget({
    network: 'verify-homologation-abc123ef',
    container: 'verify-alvo',
    run: async args => {
      calls.push([...args]);
      return {code: 0, stdout: args.includes('inspect') ? 'true' : ''};
    },
  });
  assert.deepEqual(calls, [
    [VERIFY_RUNTIME_BIN, 'network', 'create', '--internal', 'verify-homologation-abc123ef'],
    [VERIFY_RUNTIME_BIN, 'network', 'inspect', 'verify-homologation-abc123ef', '--format', '{{.Internal}}'],
    [VERIFY_RUNTIME_BIN, 'network', 'connect', 'verify-homologation-abc123ef', 'verify-alvo'],
  ]);
});

test('a rede interna leva os rótulos de dono antes do nome', async () => {
  const {attachInternalTarget} = await import('../src/verify-dynamic.ts');
  const calls: string[][] = [];
  const labels = ['--label', 'com.agent-control.installation=ispagent', '--label', 'com.agent-control.kind=verify-dynamic-network'];
  await attachInternalTarget({
    network: 'verify-homologation-abc123ef', container: 'verify-alvo', labels,
    run: async args => { calls.push([...args]); return {code: 0, stdout: args.includes('inspect') ? 'true' : ''}; },
  });
  assert.deepEqual(calls[0], [VERIFY_RUNTIME_BIN, 'network', 'create', '--internal', ...labels, 'verify-homologation-abc123ef']);
});

test('inspect falso recusa a rede e não liga o alvo', async () => {
  const {attachInternalTarget} = await import('../src/verify-dynamic.ts');
  const calls: string[][] = [];
  await assert.rejects(() => attachInternalTarget({
    network: 'verify-homologation-abc123ef',
    container: 'verify-alvo',
    run: async args => {
      calls.push([...args]);
      return {code: 0, stdout: args.includes('inspect') ? 'false' : ''};
    },
  }), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_NETWORK_FORBIDDEN');
  assert.equal(calls.some(args => args.includes('--internal')), true);
  assert.equal(calls.some(args => args.includes('connect')), false);
});

test('nome fora do rótulo único não chega ao runtime', async () => {
  const {attachInternalTarget} = await import('../src/verify-dynamic.ts');
  let called = false;
  const run = async () => {
    called = true;
    return {code: 0, stdout: 'true'};
  };
  await assert.rejects(() => attachInternalTarget({network: 'app.local', container: 'verify-alvo', run}), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_NETWORK_FORBIDDEN');
  await assert.rejects(() => attachInternalTarget({network: 'verify-homologation-abc123ef', container: 'app.local', run}), (error: unknown) => error instanceof Refusal && error.code === 'VERIFY_NETWORK_FORBIDDEN');
  assert.equal(called, false);
});

function catchRefusal(fn: () => void): unknown {
  try { fn(); }
  catch (error) { return error; }
  throw new Error('deveria recusar');
}
