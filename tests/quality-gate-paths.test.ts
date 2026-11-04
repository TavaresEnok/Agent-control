import assert from 'node:assert/strict';
import test from 'node:test';
import { digest } from '../src/contracts.ts';
import { QualityPolicy } from '../src/quality-policy.ts';
import { gatePathIntersects, isNormalizedProtectedGatePath, writePathsIntersectProtectedGate } from '../src/quality-gate-paths.ts';

const verifier = 'a'.repeat(64);
const historical = { schemaVersion: 1 as const, requiredReviews: 1, allowLowRiskQaWaiver: false, requireHumanIntegration: true, verifierDigest: verifier };

test('historical quality policy stays valid and keeps its digest without protectedGatePaths', () => {
  const parsed = QualityPolicy.parse(historical);
  assert.equal('protectedGatePaths' in parsed, false);
  assert.equal(digest(parsed), digest(historical));
  assert.equal(digest(QualityPolicy.parse(JSON.parse(JSON.stringify(historical)))), digest(historical));
});

test('protectedGatePaths is normalized, deduplicated and covered by the policy digest', () => {
  const published = QualityPolicy.parse({ ...historical, protectedGatePaths: ['package.json', 'src/', 'package.json', '.github/workflows/'] });
  assert.deepEqual(published.protectedGatePaths, ['package.json', 'src/', '.github/workflows/']);
  assert.notEqual(digest(published), digest(historical));
  assert.equal(digest(QualityPolicy.parse(JSON.parse(JSON.stringify(published)))), digest(published));
  const full = Array.from({ length: 64 }, (_, index) => `gate/file-${index}.txt`);
  assert.equal(QualityPolicy.parse({ ...historical, protectedGatePaths: full }).protectedGatePaths?.length, 64);
  assert.deepEqual(QualityPolicy.parse({ ...historical, protectedGatePaths: [] }).protectedGatePaths, []);
});

test('protectedGatePaths rejects absolute, parent and non-normalized paths and lists above 64', () => {
  assert.equal(isNormalizedProtectedGatePath('src/'), true);
  assert.equal(isNormalizedProtectedGatePath('.github/workflows/'), true);
  for (const path of ['/etc/passwd', '../package.json', 'src/../package.json', 'src//a.ts', './src/a.ts', 'src\\a.ts', 'a'.repeat(241), '', 'src/./a.ts', '/'])
    assert.equal(isNormalizedProtectedGatePath(path), false, path);
  for (const path of ['/etc/passwd', '../package.json', 'foo//bar', './package.json', 'a/../../b'])
    assert.throws(() => QualityPolicy.parse({ ...historical, protectedGatePaths: [path] }), path);
  assert.throws(() => QualityPolicy.parse({ ...historical, protectedGatePaths: Array.from({ length: 65 }, (_, index) => `gate/file-${index}.txt`) }));
  assert.throws(() => QualityPolicy.parse({ ...historical, protectedGatePaths: ['ok.ts', 1] }));
});

test('write paths intersect exact gate files and directory prefixes, including parent scopes', () => {
  const protectedPaths = ['package.json', '.github/workflows/', 'tests/quality-gate-paths.test.ts'];
  assert.equal(writePathsIntersectProtectedGate(['package.json'], protectedPaths), true);
  assert.equal(writePathsIntersectProtectedGate(['.github/workflows/ci.yml'], protectedPaths), true);
  assert.equal(writePathsIntersectProtectedGate(['.github/workflows'], protectedPaths), true);
  assert.equal(writePathsIntersectProtectedGate(['.github'], protectedPaths), true);
  assert.equal(writePathsIntersectProtectedGate(['tests'], protectedPaths), true);
  assert.equal(writePathsIntersectProtectedGate(['tests/quality-gate-paths.test.ts'], protectedPaths), true);
  assert.equal(gatePathIntersects('src/app.ts', 'src/'), true);
  assert.equal(gatePathIntersects('src', 'src/quality.ts'), true);
  assert.equal(writePathsIntersectProtectedGate(['src/app.ts'], protectedPaths), false);
  assert.equal(gatePathIntersects('src2/app.ts', 'src/'), false);
  assert.equal(gatePathIntersects('package.json.bak', 'package.json'), false);
  assert.equal(gatePathIntersects('package.json/extra', 'package.json'), false);
  assert.equal(gatePathIntersects('../package.json', 'src/app.ts'), true);
  assert.equal(gatePathIntersects('/etc/passwd', 'src/app.ts'), true);
  assert.equal(writePathsIntersectProtectedGate(['src/app.ts'], []), false);
});
