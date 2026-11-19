import {deepStrictEqual} from 'node:assert/strict';
import {digest} from './contracts.ts';
import type {Ledger} from './ledger.ts';
import {readRecheckBlob} from './module-recheck-git.ts';
import {moduleMeasurementCriterion} from './module-recheck-criteria.ts';
import {readModuleMeasurements} from './module-recheck-measurement.ts';
import type {BoundScope} from './module-recheck-regression.ts';
import type {ModuleRawFinding, ModuleToolCoverage} from './verification-modules.ts';

const MAX_BLOB_BYTES = 16_000;
const PROBE = /^import test from 'node:test';\r?\nimport assert from 'node:assert\/strict';\r?\nimport \{ readFileSync \} from 'node:fs';\r?\ntest\(("(?:[^"\\\r\n]|\\["\\])+"), \(\) => (assert\.deepStrictEqual\(JSON\.parse\(readFileSync\(0, 'utf8'\)\), (\[[^\r\n]+\])\))\);\s*$/;

function readMeasurementTest(text: string) {
  if (Buffer.byteLength(text) > 4096) return;
  const match = PROBE.exec(text);
  if (!match) return;
  try {
    const title: unknown = JSON.parse(match[1]!);
    const expected: unknown = JSON.parse(match[3]!);
    if (typeof title !== 'string' || !title.trim() || title.length > 160 || /[\u0000-\u001f\u007f-\u009f]/u.test(title)
      || !Array.isArray(expected) || expected.length !== 3 || !expected.every(part => typeof part === 'string')) return;
    return {title, assertion: match[2]!, expected: expected as [string, string, string]};
  } catch {
    return;
  }
}

// The committed test supplies only the expected tuple. Evaluate the admitted
// assertion against both measurements without loading repository code.
function assertMeasurement(actual: string[], expected: string[]) {
  try {
    deepStrictEqual(actual, expected);
    return 'passed' as const;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_ASSERTION') return 'assertion-failed' as const;
    throw error;
  }
}

function mainToolEnabled(rows: ModuleToolCoverage[], tool: string, version: string) {
  // Squawk emits records per migration; the selected row is itself the
  // measurement. Ast-grep reports both aggregate and per-file rows.
  if (tool === 'squawk') return !rows.some(row => row.tool === tool && row.status === 'failed');
  const candidates = rows.filter(row => row.tool === tool && (tool !== 'ast-grep' || !row.detail.startsWith('arquivo=')));
  return candidates.length === 1 && candidates[0]!.status === 'ok' && candidates[0]!.version === version;
}

export async function measureLocalRegression(ledger: Ledger, scope: BoundScope, finding: ModuleRawFinding,
  safe: (text: string) => boolean) {
  const {repo, originalCommit, head, item, module, runId, testFile, signal, measurement} = scope;
  const criterion = moduleMeasurementCriterion(module, item);
  if (!criterion || !measurement?.collectorImage) return {reason: 'MODULE_RECHECK_MODULE_PROOF_MISSING'} as const;
  const [beforeBlob, afterBlob, testBlob, coverage] = await Promise.all([
    readRecheckBlob(repo, originalCommit, item.file, signal),
    readRecheckBlob(repo, head, item.file, signal),
    readRecheckBlob(repo, head, testFile, signal),
    readModuleMeasurements(ledger.pool, runId, measurement.runId, item.file),
  ]);
  signal?.throwIfAborted();
  if (!beforeBlob || !afterBlob || [beforeBlob, afterBlob].some(blob => Buffer.byteLength(blob.text) > MAX_BLOB_BYTES)) {
    return {reason: 'MODULE_RECHECK_CHANGE_UNPROVEN'} as const;
  }
  if (coverage.findings.some(row => row.tool === item.tool && row.rule !== null && criterion.rules.includes(row.rule))) {
    return {reason: 'MODULE_RECHECK_MODULE_PROOF_MISSING'} as const;
  }
  const comparison = criterion.compare({finding, before: beforeBlob.text, after: afterBlob.text,
    original: coverage.original, corrected: coverage.corrected, correctedFindings: coverage.findings});
  if (!comparison) return {reason: 'MODULE_RECHECK_MEASUREMENT_UNPROVEN'} as const;
  const {before, after, object, desired} = comparison;
  const version = before.record.version;
  if (after.record.version !== version
    || ![coverage.original, coverage.corrected].every(rows => mainToolEnabled(rows, item.tool, version))) {
    return {reason: 'MODULE_RECHECK_MODULE_PROOF_MISSING'} as const;
  }
  const test = testBlob && readMeasurementTest(testBlob.text);
  if (!test || !testBlob || test.expected[0] !== item.file || test.expected[1] !== object || test.expected[2] !== desired) {
    return {reason: 'MODULE_RECHECK_FUNCTIONAL_TEST_UNAVAILABLE'} as const;
  }
  const regression = (commit: string, side: typeof before) => ({
    commit, status: assertMeasurement([item.file, object, side.value], test.expected), actual: side.value, expected: desired,
  });
  const observations = {original: regression(originalCommit, before), corrected: regression(head, after)};
  if (observations.original.status !== 'assertion-failed') return {reason: 'MODULE_RECHECK_ORIGINAL_TEST_PASSED'} as const;
  if (observations.corrected.status !== 'passed') return {reason: 'MODULE_RECHECK_CORRECTED_TEST_FAILED'} as const;
  const describe = (blob: string, side: typeof before) => ({
    blob, line: side.target.line,
    record: {tool: side.record.tool, version: side.record.version, detail: side.record.detail},
  });
  const receipt = {
    moduleProofRunId: measurement.runId, scope: {...item, rule: criterion.rules[0]!, runId, evidenceDigest: digest(scope.evidence)},
    ...(item.rule !== criterion.rules[0] && {recordedRule: item.rule}),
    criterion: criterion.id, object, observations,
    original: describe(beforeBlob.oid, before), corrected: describe(afterBlob.oid, after),
    testFile, testBlob: testBlob.oid, testTitle: test.title, assertionDigest: digest(test.assertion),
  };
  if (object.length > 400
    || ![object, test.title, before.target.code, after.target.code, version, before.record.detail, after.record.detail].every(safe)
    || [before.target.code, after.target.code].some(code => !code || code.length > 2000)) {
    return {reason: 'MODULE_RECHECK_EVIDENCE_UNAVAILABLE'} as const;
  }
  return {criterion: criterion.id, before: before.target, after: after.target,
    moduleProof: {runId: measurement.runId, tool: item.tool, version, origin: 'collector' as const, collectorImage: measurement.collectorImage},
    assertion: 'assert.deepStrictEqual(actual, expected)', receipt: {...receipt, receiptDigest: digest(receipt)}};
}

export type LocalRegression = Exclude<Awaited<ReturnType<typeof measureLocalRegression>>, {reason: string}>;
