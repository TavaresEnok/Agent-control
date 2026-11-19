import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
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
import {readModuleMeasurements, RECHECK_PROOF_VERSION} from './module-recheck-measurement.ts';
import {redactUnknownSecrets} from './verify-redact.ts';
import type {ModuleToolCoverage} from './verification-modules.ts';

export const FUNCTION_COVERAGE_RULE = 'QA-COBERTURA-FUNCAO-SEM-TESTE';
const NODE_TEST_TOOL = 'node-test-v8';
const ORIGINAL_ZERO_COUNTS = 'contagem V8 da função nas passadas 1, 2 e 3: 0, 0, 0';
export const FUNCTION_COVERAGE_CRITERION = 'same-function-executed-in-three-v8-passes';
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

// Admit whole modules consisting of pure numeric functions only. This gives
// us the full inventory and allows the current blob to run in isolation.
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

type Measurements = Awaited<ReturnType<typeof readModuleMeasurements>>;

function coverageKey(file: string) {
  const key = 'qa-arquivo:' + file.replace(/[%|~\s\u0000-\u001f\u007f]/g, char => char === '~' ? '%7E' : encodeURIComponent(char));
  return key.length <= 120 ? key : key.slice(0, 95) + '~' + createHash('sha256').update(key).digest('hex').slice(0, 24);
}

function readPasses(detail: string) {
  const header = 'V8 em três passadas: ramos';
  const prefix = detail.startsWith(header) ? header : redactUnknownSecrets(header);
  if (!detail.startsWith(prefix + ' ')) return;
  const passes = detail.slice(prefix.length + 1).split('; ramos ');
  if (passes.length !== 3) return;
  const counts = [];
  for (const pass of passes) {
    const parsed = /^(\d+)\/(\d+), funções (\d+)\/(\d+)$/.exec(pass);
    if (!parsed) return;
    const [branches, allBranches, covered, allFunctions] = parsed.slice(1).map(Number) as [number, number, number, number];
    if (![branches, allBranches, covered, allFunctions].every(Number.isSafeInteger)
      || branches > allBranches || covered > allFunctions) return;
    counts.push({covered, total: allFunctions});
  }
  return counts;
}

function measuredTool(rows: ModuleToolCoverage[], tool: string) {
  const hits = rows.filter(row => row.tool === tool);
  return hits.length === 1 && hits[0]!.status === 'ok' ? hits[0] : undefined;
}

function measureCoverage(rows: ModuleToolCoverage[], findings: Measurements['findings'], item: RecheckScope, version: string,
  functions: Target[], target: Target) {
  const row = measuredTool(rows, coverageKey(item.file));
  const passes = row?.version === version ? readPasses(row.detail) : undefined;
  if (!passes || !passes.every(pass => pass.total === functions.length)) return;
  const uncovered = new Map<string, {id: string; name: string; line: number}>();
  for (const finding of findings) {
    if (finding.tool !== item.tool || finding.rule !== item.rule) continue;
    const name = new RegExp(`^Função exportada '(${IDENTIFIER})' sem execução medida pelo V8$`).exec(finding.message ?? '')?.[1];
    const fn = functions.find(fn => fn.name === name);
    // A matching name in a stale location still contradicts a correction.
    // An ambiguous or stale entry cannot account for any of the gaps.
    if (!fn || fn.line !== finding.line || uncovered.has(fn.name)
      || (finding.collectorEvidence !== null && finding.collectorEvidence !== ORIGINAL_ZERO_COUNTS)) return;
    uncovered.set(fn.name, {id: finding.id, name: fn.name, line: fn.line});
  }
  const missing = passes.map(pass => pass.total - pass.covered);
  if (missing.some(count => count < uncovered.size)) return;
  const targetFinding = uncovered.get(target.name)?.id ?? null;
  // With the whole function inventory and every gap accounted for, the
  // complement is measured as executed, even when other functions are not.
  if (!targetFinding && !missing.every(count => count === uncovered.size)) return;
  return {passes, uncovered: [...uncovered.values()], targetFinding};
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
  const {measurement} = scope;
  const missingProof = {reason: 'MODULE_RECHECK_MODULE_PROOF_MISSING'} as const;
  if (!measurement?.collectorImage) return missingProof;
  const coverage = await readModuleMeasurements(ledger.pool, runId, measurement.runId, item.file);
  const version = measuredTool(coverage.original, item.tool)?.version;
  if (!version || measuredTool(coverage.corrected, item.tool)?.version !== version) return missingProof;
  const originCoverage = measureCoverage(coverage.original, coverage.originalFindings, item, version, original, before);
  const currentCoverage = measureCoverage(coverage.corrected, coverage.findings, item, version, current, after);
  if (originCoverage?.targetFinding !== item.id || !currentCoverage) return missingProof;
  const verdict: 'reaberto' | 'fechado' = currentCoverage.targetFinding ? 'reaberto' : 'fechado';
  let probe = null;
  if (verdict === 'fechado') {
    const test = testBlob && readTest(testBlob.text, testFile, item.file, before.name);
    if (!test || !testBlob) return {reason: 'MODULE_RECHECK_FUNCTIONAL_TEST_UNAVAILABLE'} as const;
    const execution = await runTest(afterBlob, item.file, testBlob, testFile, test, signal);
    if (!execution) return {reason: 'MODULE_RECHECK_FUNCTIONAL_EXECUTION_UNAVAILABLE'} as const;
    if (execution.status !== 'passed') return {reason: 'MODULE_RECHECK_CORRECTED_TEST_FAILED'} as const;
    probe = {testFile, testBlob: testBlob.oid, testLine: test.line, testColumn: test.column, testTitle: test.title,
      assertion: test.assertion, execution};
  }
  const moduleProof: RecheckProof = {runId: measurement.runId, tool: item.tool, version,
    origin: 'collector', collectorImage: measurement.collectorImage};
  const observations = {
    original: {commit: originalCommit, ...originCoverage},
    corrected: {commit: head, ...currentCoverage},
  };
  const receipt = {
    proofVersion: RECHECK_PROOF_VERSION, criterion: FUNCTION_COVERAGE_CRITERION,
    moduleProofRunId: moduleProof.runId, scope: {...item, runId, evidenceDigest: digest(evidence)},
    original: {blob: beforeBlob.oid, line: before.line, endLine: before.endLine},
    corrected: {blob: afterBlob.oid, line: after.line, endLine: after.endLine},
    function: {name: before.name, signature: before.signature}, observations,
    ...(probe && {testFile: probe.testFile, testBlob: probe.testBlob, testLine: probe.testLine, testColumn: probe.testColumn,
      testTitle: probe.testTitle, assertionDigest: digest(probe.assertion), execution: probe.execution}),
  };
  return {criterion: FUNCTION_COVERAGE_CRITERION, verdict, before, after, moduleProof,
    assertion: probe?.assertion ?? null, receipt: {...receipt, receiptDigest: digest(receipt)}};
}

function overlappingDeclaration(functions: Target[], target: Target) {
  return functions.some(fn => fn !== target && fn.line <= target.endLine && fn.endLine >= target.line);
}

type QaRegression = Exclude<Awaited<ReturnType<typeof measureRecheckRegression>>, {reason: string}>;
export type FunctionalRegression = QaRegression | LocalRegression;

const Observation = TestExecution.omit({node: true}).extend({commit: z.string().regex(/^[a-f0-9]{40}$/)});
const CoverageCorrection = z.object({
  rule: z.literal(FUNCTION_COVERAGE_RULE), criterion: z.literal(FUNCTION_COVERAGE_CRITERION),
  function: z.string(), conclusion: z.enum(['coverage-added', 'coverage-regressed']),
  originalGaps: z.array(z.number().int().nonnegative()).length(3),
  currentGaps: z.array(z.number().int().nonnegative()).length(3),
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
  if (!('verdict' in proof)) {
    const {original, corrected} = proof.receipt.observations;
    const parsed = LocalCorrection.safeParse(value.correction);
    const expected = {rule: proof.receipt.scope.rule, criterion: proof.criterion, object: proof.receipt.object,
      ...proof.receipt.observations};
    return parsed.success && digest(parsed.data) === digest(expected)
      && [proof.receipt.object, original.actual, corrected.actual].every(item => reason.includes('`' + item + '`'));
  }
  const parsed = CoverageCorrection.safeParse(value.correction);
  const {original, corrected} = proof.receipt.observations;
  const gaps = (side: typeof original) => side.passes.map(pass => pass.total - pass.covered);
  const closes = proof.verdict === 'fechado';
  const name = proof.receipt.function.name;
  return parsed.success && digest(parsed.data) === digest({
    rule: proof.receipt.scope.rule, criterion: proof.criterion, function: name,
    conclusion: closes ? 'coverage-added' : 'coverage-regressed', originalGaps: gaps(original), currentGaps: gaps(corrected),
  }) && reason === coverageReason(name, closes);
}

const COVERAGE_REASON_START = 'A função `<nome>` teve zero execuções nas três passadas da origem.';
const COVERAGE_CLOSE_REASON = 'Na medição atual, os outros achados explicam todas as lacunas, portanto a função foi executada nas três passadas.';
const COVERAGE_REOPEN_REASON = 'Na medição atual, a mesma função voltou a registrar zero execuções nas três passadas.';

function coverageReason(name: string, closes: boolean) {
  return COVERAGE_REASON_START.replace('<nome>', () => name) + ' ' + (closes ? COVERAGE_CLOSE_REASON : COVERAGE_REOPEN_REASON);
}

export const COVERAGE_REVIEW_INSTRUCTION = 'Compare a identidade da função no mesmo arquivo e as passadas V8 de regressionProof. '
  + 'Sem ferramentas, rede ou escrita. Responda JSON com kind confirmacao, binding, status, proof e reason. '
  + 'Use provavel quando não puder decidir. Ao decidir, copie code em proof e inclua correction '
  + 'com rule, criterion e function (somente o nome), e calcule originalGaps e currentGaps (total menos covered, por passada). '
  + 'Use descartado e conclusion coverage-added se os outros achados explicarem todas as lacunas atuais. '
  + 'Use confirmado e conclusion coverage-regressed se o achado atual registrar três zeros para a mesma função. '
  + 'Em reason, preencha o nome no início e escolha a frase final conforme o resultado. Início: ' + COVERAGE_REASON_START
  + ' Finais: ' + COVERAGE_CLOSE_REASON + ' ' + COVERAGE_REOPEN_REASON;
