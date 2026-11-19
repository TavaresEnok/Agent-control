import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, posix} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {digest} from './contracts.ts';
import type {Ledger, VerificationModule} from './ledger.ts';
import {readModuleReviewVerdict} from './module-exam-proof.ts';
import {readRecheckBlob} from './module-recheck-git.ts';
import type {LocalRegression} from './module-recheck-local.ts';
import {readModuleMeasurements} from './module-recheck-measurement.ts';
import {redactUnknownSecrets} from './verify-redact.ts';
import type {ModuleToolCoverage} from './verification-modules.ts';

export const FUNCTION_COVERAGE_RULE = 'QA-COBERTURA-FUNCAO-SEM-TESTE';
const NODE_TEST_TOOL = 'node-test-v8';
const ORIGINAL_ZERO_COUNTS = 'contagem V8 da função nas passadas 1, 2 e 3: 0, 0, 0';
const MAX_SOURCE_BYTES = 8 * 1024;
const MAX_EXPRESSION_LENGTH = 1000;
const EXECUTION_TIMEOUT_MS = 5000;
const NUMBER = String.raw`(?:0|[1-9]\d{0,8})`;
const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;
const SCRIPT_PATH = /^[\p{L}\p{M}\p{N} _@.+/-]+\.(?:[m]?[jt]s)$/u;

export type RecheckScope = {id: string; file: string; line: number; tool: string; rule: string};
type Target = {name: string; line: number; endLine: number; code: string; signature: string};
type Blob = NonNullable<Awaited<ReturnType<typeof readRecheckBlob>>>;
type RecheckProof = {runId: string; tool: string; version: string; origin: 'collector'; collectorImage: string};

export function supportsFunctionalRecheck(module: string, item: RecheckScope) {
  return module === 'qa' && item.tool === NODE_TEST_TOOL && item.rule === FUNCTION_COVERAGE_RULE;
}

function lineAt(text: string, index: number) {
  return text.slice(0, index).split('\n').length;
}

// Admit whole modules consisting of pure numeric functions only. Both Git
// blobs are later run verbatim. No repository config, dependency, or hook is loaded.
function readFunctions(source: string): Target[] | undefined {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES || /\r(?!\n)|[\u2028\u2029]/.test(source)) return;
  const expression = String.raw`${NUMBER}(?:[ \t]+[+*-][ \t]+${NUMBER}){0,12}`;
  const declaration = new RegExp(String.raw`\s*(?<code>export[ \t]+function[ \t]+(?<name>${IDENTIFIER})[ \t]*\([ \t]*\)[ \t]*(?<type>:[ \t]*number[ \t]*)?\{\s*return[ \t]+${expression}\s*(?:;\s*)?\})[ \t]*;?`, 'y');
  const functions: Target[] = [];
  const names = new Set<string>();
  while (source.slice(declaration.lastIndex).trim()) {
    const match = declaration.exec(source);
    if (!match) return;
    const {name, code, type} = match.groups!;
    if (names.has(name!) || code!.length > MAX_EXPRESSION_LENGTH) return;
    names.add(name!);
    const start = match.index + match[0].indexOf(code!);
    functions.push({name: name!, code: code!, line: lineAt(source, start), endLine: lineAt(source, start + code!.length),
      signature: type ? '(): number' : '()'});
  }
  return functions;
}

function readTest(source: string, testFile: string, sourceFile: string, name: string) {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES || /\r(?!\n)|[\u2028\u2029]/.test(source)) return;
  const quotedTitle = String.raw`(?:"(?:[^"\\\r\n\u2028\u2029]|\\["'\\]){1,200}"|'(?:[^'\\\r\n\u2028\u2029]|\\["'\\]){1,200}')`;
  const imports = String.raw`^\s*import[ \t]+test[ \t]+from[ \t]+(['"])node:test\1[ \t]*(?:;[ \t]*)?\r?\n\s*import[ \t]+assert[ \t]+from[ \t]+(['"])node:assert\/strict\2[ \t]*(?:;[ \t]*)?\r?\n\s*import[ \t]+\{[ \t]*(?<name>${IDENTIFIER})[ \t]*\}[ \t]+from[ \t]+(?<quote>['"])(?<path>[^"'\\\r\n]+)\k<quote>[ \t]*(?:;[ \t]*)?\r?\n\s*`;
  const assertion = String.raw`(?<assertion>assert\.(?:equal|strictEqual)\(\s*(?<function>${IDENTIFIER})\(\s*\)\s*,\s*(?<expected>${NUMBER})\s*\))`;
  const declaration = String.raw`(?<test>test\([ \t]*(?<title>${quotedTitle})\s*,\s*\(\s*\)\s*=>\s*(?<block>\{\s*)?${assertion}\s*(?<close>(?:;\s*)?\}\s*)?\))\s*(?:;\s*)?$`;
  const pattern = new RegExp(imports + declaration, 'd');
  const match = pattern.exec(source);
  if (!match) return;
  const groups = match.groups!;
  const relativeSource = posix.relative(posix.dirname(testFile), sourceFile);
  const specifier = relativeSource.startsWith('../') ? relativeSource : './' + relativeSource;
  if (Boolean(groups.block) !== Boolean(groups.close) || groups.name !== name || groups.function !== name
    || groups.path !== specifier || groups.assertion!.length > MAX_EXPRESSION_LENGTH) return;
  const title = groups.title!.slice(1, -1).replace(/\\(["'\\])/g, '$1');
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(title)) return;
  const start = match.indices!.groups!.test![0];
  return {title, line: lineAt(source, start), column: start - source.lastIndexOf('\n', start - 1),
    assertion: groups.assertion!, expected: Number(groups.expected)};
}

// The only executable input is validated by readFunctions/readTest. Permission
// mode grants read access to this pair of staged files and disables child processes.
// Record an assertion mismatch from the named test, never a loader/runner failure.
const NODE_TEST_DRIVER = `
const { run } = require('node:test');
const [file, title, line, column, expected] = process.argv.slice(1);
(async () => {
  const outcomes = [];
  let summary;
  for await (const { type, data } of run({ files: [file], isolation: 'none' })) {
    if (type === 'test:summary' && data.file === undefined) summary = data;
    if (type === 'test:pass' || type === 'test:fail') outcomes.push({type, data});
  }
  if (outcomes.length !== 1 || summary?.counts.tests !== 1 || summary.counts.skipped || summary.counts.todo) return;
  const { type, data } = outcomes[0];
  if (data.file !== file || data.name !== title || data.line !== Number(line) || data.column !== Number(column)) return;
  const failure = data.details?.error;
  const cause = failure?.cause;
  const value = Number(expected);
  if (type === 'test:pass' && summary.success && summary.counts.passed === 1) {
    process.stdout.write(JSON.stringify({status: 'passed', actual: expected, expected, node: process.versions.node}));
  } else if (type === 'test:fail' && !summary.success && summary.counts.failed === 1
    && failure.failureType === 'testCodeFailure' && cause?.code === 'ERR_ASSERTION'
    && cause.operator === 'strictEqual' && cause.expected === value && !Object.is(cause.actual, value)
    && Number.isSafeInteger(cause.actual)) {
    const actual = Object.is(cause.actual, -0) ? '-0' : String(cause.actual);
    process.stdout.write(JSON.stringify({status: 'assertion-failed', actual, expected, node: process.versions.node}));
  }
})().catch(() => { process.exitCode = 1; });`;

const TestExecution = z.object({
  status: z.enum(['passed', 'assertion-failed']), actual: z.string().regex(/^-?\d+$/), expected: z.string().regex(/^\d+$/),
  node: z.string().regex(/^\d+\.\d+\.\d+$/),
}).strict();
const exec = promisify(execFile);

async function runTest(source: Blob, sourceFile: string, test: Blob, testFile: string,
  identity: NonNullable<ReturnType<typeof readTest>>, signal?: AbortSignal) {
  let stage: string | undefined;
  try {
    stage = await mkdtemp(join(tmpdir(), 'ac-recheck-regression-'));
    const target = join(stage, sourceFile);
    const probe = join(stage, testFile);
    await mkdir(dirname(target), {recursive: true});
    await mkdir(dirname(probe), {recursive: true});
    await Promise.all([
      writeFile(join(stage, 'package.json'), '{"type":"module"}', {flag: 'wx', mode: 0o400}),
      writeFile(target, source.text, {flag: 'wx', mode: 0o400}),
      writeFile(probe, test.text, {flag: 'wx', mode: 0o400}),
    ]);
    const {stdout} = await exec(process.execPath, ['--permission', '--experimental-strip-types',
      `--allow-fs-read=${stage}`, '-e', NODE_TEST_DRIVER, '--',
      probe, identity.title, String(identity.line), String(identity.column), String(identity.expected)],
    {cwd: stage, env: {LANG: 'C.UTF-8'}, timeout: EXECUTION_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4096, signal});
    return TestExecution.parse(JSON.parse(stdout));
  } catch {
    signal?.throwIfAborted();
    return undefined;
  } finally {
    if (stage) await rm(stage, {recursive: true, force: true});
  }
}

async function readCorrectionProof(ledger: Ledger, scope: BoundScope, current: Target): Promise<RecheckProof | undefined> {
  const fileKey = scope.item.file.replace(/[%|~\s\u0000-\u001f\u007f]/g, char => char === '~' ? '%7E' : encodeURIComponent(char));
  const {item, measurement} = scope;
  if (!measurement?.collectorImage) return;
  const coverage = await readModuleMeasurements(ledger.pool, scope.runId, measurement.runId, item.file);
  if (coverage.findings.some(({tool, rule, line}) => tool === item.tool && rule === item.rule
    && (line === null || line >= current.line && line <= current.endLine))) return;
  const find = (rows: ModuleToolCoverage[], tool: string) => {
    const hits = rows.filter(row => row.tool === tool);
    return hits.length === 1 && hits[0]!.status === 'ok' ? hits[0] : undefined;
  };
  const base = find(coverage.original, item.tool);
  if (!base || find(coverage.corrected, item.tool)?.version !== base.version) return;
  const before = find(coverage.original, `qa-arquivo:${fileKey}`);
  const after = find(coverage.corrected, `qa-arquivo:${fileKey}`);
  if (!before || !after || [before, after].some(row => row.version !== base.version)
    || !completeV8Coverage(before.detail, true) || !completeV8Coverage(after.detail, false)) return;
  return {runId: measurement.runId, tool: item.tool, version: base.version, origin: 'collector', collectorImage: measurement.collectorImage};
}

function completeV8Coverage(detail: string, original: boolean): boolean {
  const header = 'V8 em três passadas: ramos';
  const prefix = detail.startsWith(header) ? header : redactUnknownSecrets(header);
  if (!detail.startsWith(prefix + ' ')) return false;
  const passes = detail.slice(prefix.length + 1).split('; ramos ');
  return passes.length === 3 && passes.every(pass => {
    const parsed = /^(\d+)\/(\d+), funções (\d+)\/(\d+)$/.exec(pass);
    if (!parsed) return false;
    const [branches, allBranches, covered, allFunctions] = parsed.slice(1).map(Number) as [number, number, number, number];
    return [branches, allBranches, covered, allFunctions].every(Number.isSafeInteger) && branches <= allBranches
      && (original ? covered < allFunctions : covered > 0 && covered <= allFunctions);
  });
}

export type BoundScope = {
  module: VerificationModule; repo: string; runId: string; originalCommit: string; head: string;
  measurement?: {runId: string; collectorImage: string};
  item: RecheckScope; evidence: string; originalMessage: string; testFile: string; signal?: AbortSignal;
};

export async function measureRecheckRegression(ledger: Ledger, scope: BoundScope) {
  const {repo, runId, originalCommit, head, item, evidence, testFile, signal} = scope;
  if (evidence !== ORIGINAL_ZERO_COUNTS) return {reason: 'MODULE_RECHECK_FUNCTIONAL_ORIGIN_UNPROVEN'} as const;
  if (!SCRIPT_PATH.test(item.file)) return {reason: 'MODULE_RECHECK_FUNCTION_IDENTITY_UNPROVEN'} as const;
  const [beforeBlob, afterBlob, testBlob] = await Promise.all([
    readRecheckBlob(repo, originalCommit, item.file, signal),
    readRecheckBlob(repo, head, item.file, signal),
    readRecheckBlob(repo, head, testFile, signal),
  ]);
  const original = beforeBlob && readFunctions(beforeBlob.text);
  const before = original?.find(fn => fn.line === item.line);
  const current = afterBlob && readFunctions(afterBlob.text);
  const after = before && current?.find(fn => fn.name === before.name && fn.signature === before.signature);
  if (!beforeBlob || !afterBlob || !original || !current || !before || !after
    || overlappingDeclaration(original, before) || overlappingDeclaration(current, after)) {
    return {reason: 'MODULE_RECHECK_FUNCTION_IDENTITY_UNPROVEN'} as const;
  }
  if (scope.originalMessage !== `Função exportada '${before.name}' sem execução medida pelo V8`) {
    return {reason: 'MODULE_RECHECK_FUNCTIONAL_ORIGIN_UNPROVEN'} as const;
  }
  const test = testBlob && readTest(testBlob.text, testFile, item.file, before.name);
  if (!test || !testBlob) return {reason: 'MODULE_RECHECK_FUNCTIONAL_TEST_UNAVAILABLE'} as const;
  const moduleProof = await readCorrectionProof(ledger, scope, after);
  if (!moduleProof) return {reason: 'MODULE_RECHECK_MODULE_PROOF_MISSING'} as const;

  const originalRun = await runTest(beforeBlob, item.file, testBlob, testFile, test, signal);
  const correctedRun = await runTest(afterBlob, item.file, testBlob, testFile, test, signal);
  if (!originalRun || !correctedRun || originalRun.node !== correctedRun.node) {
    return {reason: 'MODULE_RECHECK_FUNCTIONAL_EXECUTION_UNAVAILABLE'} as const;
  }
  if (originalRun.status === 'passed') return {reason: 'MODULE_RECHECK_ORIGINAL_TEST_PASSED'} as const;
  if (correctedRun.status !== 'passed') return {reason: 'MODULE_RECHECK_CORRECTED_TEST_FAILED'} as const;
  const observations = {
    original: {commit: originalCommit, status: originalRun.status, actual: originalRun.actual, expected: originalRun.expected},
    corrected: {commit: head, status: correctedRun.status, actual: correctedRun.actual, expected: correctedRun.expected},
  };
  const receipt = {
    moduleProofRunId: moduleProof.runId, scope: {...item, runId, evidenceDigest: digest(evidence)},
    original: {blob: beforeBlob.oid, line: before.line, endLine: before.endLine},
    corrected: {blob: afterBlob.oid, line: after.line, endLine: after.endLine},
    function: {name: before.name, signature: before.signature}, observations, executionVersion: originalRun.node,
    testFile, testBlob: testBlob.oid, testLine: test.line, testColumn: test.column, testTitle: test.title,
    assertionDigest: digest(test.assertion),
  };
  return {criterion: 'direct-call-meets-expected-value' as const,
    before, after, moduleProof, assertion: test.assertion, receipt: {...receipt, receiptDigest: digest(receipt)}};
}

function overlappingDeclaration(functions: Target[], target: Target) {
  return functions.some(fn => fn !== target && fn.line <= target.endLine && fn.endLine >= target.line);
}

type QaRegression = Exclude<Awaited<ReturnType<typeof measureRecheckRegression>>, {reason: string}>;
export type FunctionalRegression = QaRegression | LocalRegression;

const Observation = TestExecution.omit({node: true}).extend({commit: z.string().regex(/^[a-f0-9]{40}$/)});
const Correction = z.object({
  rule: z.literal(FUNCTION_COVERAGE_RULE), assertion: z.string().max(MAX_EXPRESSION_LENGTH),
  original: Observation, corrected: Observation, criterion: z.literal('direct-call-meets-expected-value'),
}).strict();
const LocalObservation = Observation.extend({actual: z.string().min(1).max(400), expected: z.string().min(1).max(400)});
const LocalCorrection = z.object({
  rule: z.string().min(1).max(200), criterion: z.string().min(1).max(120), object: z.string().min(1).max(400),
  original: LocalObservation, corrected: LocalObservation,
}).strict();

export function readFunctionalRecheckVerdict(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const {correction: _correction, ...verdict} = value as Record<string, unknown>;
  return readModuleReviewVerdict(verdict);
}

export function recheckCorrectionMatches(value: unknown, reason: string, proof: FunctionalRegression): boolean {
  if (typeof value !== 'object' || value === null || !('correction' in value)) return false;
  const {original, corrected} = proof.receipt.observations;
  const cites = (item: string) => reason.includes('`' + item + '`');
  if ('object' in proof.receipt) {
    const parsed = LocalCorrection.safeParse(value.correction);
    const expected = {rule: proof.receipt.scope.rule, criterion: proof.criterion, object: proof.receipt.object,
      ...proof.receipt.observations};
    return parsed.success && digest(parsed.data) === digest(expected)
      && [proof.receipt.object, original.actual, corrected.actual].every(cites);
  }
  const parsed = Correction.safeParse(value.correction);
  return parsed.success && digest(parsed.data) === digest({
    rule: proof.receipt.scope.rule, assertion: proof.assertion, criterion: 'direct-call-meets-expected-value',
    ...proof.receipt.observations,
  }) && [parsed.data.rule, parsed.data.assertion, original.actual, corrected.actual].every(cites);
}
