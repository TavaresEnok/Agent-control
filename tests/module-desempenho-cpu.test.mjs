import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {collectCpuMetrics} from '../deploy/modules/desempenho/cpu-metrics.mjs';

const snapshotRoot = resolve('tests/fixtures/module-desempenho-cpu');

test('profiler V8 mede defeito e controle sintéticos pela identidade de origem', async () => {
  const root = resolve('tests/fixtures/module-desempenho');
  const file = 'server.mjs';
  const defectRoot = join(root, 'defective'), controlRoot = join(root, 'clean');
  const defect = await collectCpuMetrics({snapshotRoot: defectRoot, file, functionName: 'computeHeavyReport'});
  const control = await collectCpuMetrics({snapshotRoot: controlRoot, file, functionName: 'computeCachedReport'});
  const defectSource = readFileSync(join(defectRoot, file), 'utf8').split('\n');
  const declaration = defectSource.findIndex(line => line.includes('function computeHeavyReport(')) + 1;
  const compute = defectSource.findIndex(line => line.includes('acc = (acc *')) + 1;
  assert.ok(declaration > 0 && compute > 0);
  assert.equal(defect.status, 'measured', defect.detail);
  assert.equal(defect.coverage, 'partial');
  assert.equal(defect.line, declaration);
  assert.ok(defect.sampleCount > 0);
  assert.ok(defect.selfSamples > 0, JSON.stringify({selfMs: defect.selfMs, frames: defect.profile.nodes.filter(n => n.callFrame.url === 'cpu-snapshot.js')}));
  assert.ok(defect.lineTicks.some(tick => tick.line === compute && tick.ticks > 0), JSON.stringify(defect.lineTicks));
  assert.ok(defect.selfMs >= 80, `defect selfMs=${defect.selfMs}`);
  assert.equal(defect.hotspot, true);
  assert.equal(control.status, 'measured', control.detail);
  assert.equal(control.hotspot, false);
  assert.ok(control.selfMs < 80, `control selfMs=${control.selfMs}`);
  console.log(`PROVAS CPU: defeito=${defect.selfMs.toFixed(1)}ms (${defect.selfSamples} amostras), controle=${control.selfMs.toFixed(1)}ms (${control.selfSamples} amostras)`);
});

test('não executa código externo e rejeita escapes, fontes ambíguas e loops sem limite', async () => {
  const dir = mkdtempSync(resolve('tests/fixtures/module-desempenho-cpu/tmp-'));
  try {
    const run = async source => {
      writeFileSync(join(dir, 'input.js'), source);
      return collectCpuMetrics({snapshotRoot: dir, file: 'input.js', functionName: 'target'});
    };
    for (const source of [
      'function target(){ return process.pid; }',
      'function target(){ process.send({profile:{}}); }',
      'function target(){ let x = 1; //# sourceURL=cpu-snapshot.js\n return x; }',
      'function target(){ return performance.now.constructor("return process")(); }',
      'function target(){ return import("node:fs"); }',
      'function target(){ return this; }',
      'function target(){ let x = {}; return x["constructor"]; }',
      'function target(){ return 1; } function target(){ return 2; }',
      'function target(){ while(true){} }',
    ]) {
      const result = await run(source);
      assert.equal(result.status, 'partial', source);
      assert.match(result.detail, /CPU não medida/);
    }
    const result = await run(`throw new Error('fora'); function target(){ return 1; }`);
    assert.equal(result.status, 'measured', result.detail);
    symlinkSync('/etc/passwd', join(dir, 'outside'));
    assert.equal((await collectCpuMetrics({snapshotRoot: dir, file: 'outside', functionName: 'target'})).status, 'partial');
    assert.equal((await collectCpuMetrics({snapshotRoot: dir, file: '../clean.js', functionName: 'target'})).status, 'partial');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
