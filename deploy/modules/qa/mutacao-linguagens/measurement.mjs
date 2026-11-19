import {createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

export const seed = 21398117;
export const limits = Object.freeze({
  candidates: 512, mutants: 8, tests: 200, outputBytes: 1024 * 1024,
  pythonMs: 10_000, goMs: 35_000, mutationMs: 50_000, propertiesMs: 12_000,
});

const arithmetic = new Set(['+', '-', '*', '/', '//', '%', '**']);
const caseStatuses = new Set(['passed', 'failed', 'skipped', 'error', 'pending']);
const positive = value => Number.isSafeInteger(value) && value > 0;
export const goDependencyMissing = /module lookup disabled by GOPROXY=off|import lookup disabled by -mod=vendor|inconsistent vendoring|no required module provides package|missing go\.sum entry|updates to go\.mod needed|requires go >= .*GOTOOLCHAIN=local/i;
const goCompilerDiagnostic = /^.+?\.go:\d+(?::\d+)?: (.*)$/;
const goSourceDependency = /^(?:(?:no required module provides package|missing go\.sum entry|cannot find module providing package) |module lookup disabled by GOPROXY=off\b|import lookup disabled by -mod=vendor\b)/;
const goNamedDependency = /^(?:no required module provides package|missing go\.sum entry for module providing package|cannot find module providing package) ([^:\s;]+)/;
const goSourceErrors = [
  /^(?:syntax error:|invalid operation:|undefined:|cannot assign to )/,
  /^(?:expected .+, found |illegal character |(?:string|rune) literal not terminated$)/,
  /^(?:cannot use .+ as |cannot convert .+ to |constant .+ overflows )/,
  /^(?:division by zero|missing return)$/,
  /^invalid argument: index .+ \(constant(?: -\d+)? of type .+\) must not be negative$/,
  /^(?:assignment mismatch:|(?:not enough|too many) arguments in call to |declared and not used:)/,
  /^(?:.+ redeclared in this block|".+" imported (?:as .+ and )?not used)$/,
];
const goBuildOperational = /fork\/exec|resource temporarily unavailable|cannot allocate memory|out of memory|permission denied|no space left on device|too many open files|read-only file system|input\/output error|signal: (?:killed|terminated)|internal compiler error|no such file or directory|unexpected EOF/i;
const goDiagnosticNote = /^(?:too many errors$|other declaration of )/;
export const goListFormat = String.raw`{{range .GoFiles}}{{printf "S\t%s/%s\n" $.Dir .}}{{end}}{{if or .TestGoFiles .XTestGoFiles}}{{printf "P\t%s\n" .ImportPath}}{{end}}`;

export function processJson({code, output}) {
  if (code !== 0) throw new Error('tool-process-failed');
  return JSON.parse(output);
}

export function stopGoAtTestLimit() {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let started = 0;
  return chunk => {
    const lines = (pending + decoder.write(chunk)).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // The complete report is validated by decodeGoSuite if the process finishes.
        continue;
      }
      if (event?.Action === 'run' && ++started > limits.tests) return 'QA_TEST_GO_CASE_LIMIT';
    }
  };
}

export function decodePlan(result, files, readSource) {
  const report = processJson(result);
  const sources = new Set(files);
  if (!Array.isArray(report?.edits) || report.edits.length > limits.candidates ||
      !Array.isArray(report.omitted) || report.omitted.some(file => !sources.has(file)) ||
      new Set(report.omitted).size !== report.omitted.length || typeof report.truncated !== 'boolean' ||
      (report.truncated && report.edits.length !== limits.candidates)) throw new Error('invalid-plan');
  const edits = new Map();
  let file;
  let lines;
  let columns;
  for (const edit of report.edits) {
    if (!sources.has(edit?.file) || !positive(edit.line) || !positive(edit.column) ||
        !arithmetic.has(edit.before) || !arithmetic.has(edit.after) || edit.before === edit.after) {
      throw new Error('invalid-edit');
    }
    if (file !== edit.file) {
      file = edit.file;
      lines = readSource(file).split('\n');
      columns = new Map();
    }
    if (!columns.has(edit.line)) columns.set(edit.line, Array.from(lines[edit.line - 1] ?? ''));
    const target = columns.get(edit.line).slice(edit.column - 1, edit.column - 1 + edit.before.length);
    if (target.join('') !== edit.before) throw new Error('edit-origin-mismatch');
    const {line, column, before, after} = edit;
    const location = {file, line, column, before, after};
    const key = JSON.stringify(location);
    edits.set(key, {...location, id: createHash('sha256').update(key).digest('hex')});
  }
  return {...report, edits: [...edits.values()]};
}

export function patchSource(source, edit) {
  const lines = source.split('\n');
  const line = Array.from(lines[edit.line - 1] ?? '');
  const index = edit.column - 1;
  if (line.slice(index, index + edit.before.length).join('') !== edit.before) {
    throw new Error('edit-origin-mismatch');
  }
  line.splice(index, edit.before.length, edit.after);
  lines[edit.line - 1] = line.join('');
  return lines.join('\n');
}

export function decodePythonSuite(result, files, propertiesOnly = false) {
  const report = processJson(result);
  const allowed = new Set(files);
  if (!Array.isArray(report?.tests) || report.tests.length > limits.tests ||
      typeof report.limited !== 'boolean' || typeof report.unavailable !== 'boolean' ||
      ![0, 1, 2, 3, 4, 5].includes(report.exitCode)) throw new Error('invalid-python-report');
  const tests = report.tests.map(test => {
    if (!allowed.has(test?.file) || !positive(test.line) || typeof test.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(test.id) || !caseStatuses.has(test.status) ||
        typeof test.property !== 'boolean' || (propertiesOnly && !test.property) ||
        !Number.isInteger(test.examples) || test.examples < 0 || test.examples > 256 ||
        (!test.property && test.examples !== 0)) throw new Error('invalid-python-test');
    const {id, file, line, status, property, examples} = test;
    return {id, file, line, status, property, examples};
  });
  if (new Set(tests.map(test => test.id)).size !== tests.length) throw new Error('duplicate-python-test');
  const failed = tests.some(test => test.status === 'failed' || test.status === 'error');
  const executionError = !(tests.length === 0 && report.exitCode === 5) &&
    (report.exitCode !== Number(failed) || tests.some(test => ['error', 'pending'].includes(test.status)));
  const reason = report.unavailable ? 'offline-dependency' : report.limited ? 'test-limit'
    : executionError ? 'python-test-execution' : undefined;
  // Preserve the validated observations even if pytest was interrupted. The property
  // summary counts only cases with examples and a passing or failing verdict.
  if (reason && propertiesOnly) return {reason, tests};
  return reason ? {reason} : {tests};
}

function readGoBuildDiagnostics(reports, output, importPath) {
  let pkg = importPath;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line || line === '#' || line.startsWith('# [')) continue;
    if (line.startsWith('# ')) {
      pkg = line.slice(2);
      continue;
    }
    const located = goCompilerDiagnostic.exec(line);
    const message = located?.[1] ?? line;
    if (goDiagnosticNote.test(message)) continue;
    // A toolchain failure without a source position can appear in stderr after any package header.
    if (importPath === undefined && !located && goBuildOperational.test(message)) return true;
    if (importPath !== undefined && pkg !== importPath) {
      // Go's loader can print the importing package in the header while
      // the structured event and the message name the missing dependency.
      if (goNamedDependency.exec(message)?.[1] === importPath && goDependencyMissing.test(message)) {
        reports.set(importPath, {...reports.get(importPath), unavailable: true});
      }
      continue;
    }
    const report = reports.get(pkg || undefined) ?? {};
    if (located && goSourceErrors.some(pattern => pattern.test(message))) {
      if (pkg) report.source = true;
    } else if ((located ? goSourceDependency.test(message) : true) && goDependencyMissing.test(message)) {
      report.unavailable = true;
    } else if (located || goBuildOperational.test(message) || (pkg && !/^\s/.test(raw))) {
      // A source position can also identify the import whose compiled
      // artifact the tool could not read. Unknown messages are inconclusive.
      report.operational = true;
    }
    reports.set(pkg || undefined, report);
  }
  return false;
}

export function decodeGoSuite({code, output, diagnostics}, testPackages) {
  const tests = new Map();
  const packages = new Map();
  const completedFailures = new Set();
  const failedBuilds = new Set();
  const buildOutput = new Map();
  let executionFailure = false;
  for (const line of output.split('\n').filter(Boolean)) {
    const event = JSON.parse(line);
    const {Action: action, Package: pkg, ImportPath: importPath, FailedBuild: failedBuild,
      Test: name, Output: message, OutputType: outputType} = event ?? {};
    if (typeof action !== 'string') throw new Error('invalid-go-event');
    const buildPackage = typeof importPath === 'string' ? importPath : '';
    if (action === 'build-output') {
      if (typeof message !== 'string') throw new Error('invalid-go-event');
      if (!buildOutput.has(buildPackage)) buildOutput.set(buildPackage, []);
      buildOutput.get(buildPackage).push(message);
    }
    if (action === 'build-fail') failedBuilds.add(buildPackage);
    if (action === 'fail' && typeof failedBuild === 'string' && failedBuild) failedBuilds.add(failedBuild);
    // The testing binary emits this frame when it finishes a failing suite. The go command
    // can also report a failed case and package after an abort, with only its FAIL\t... frame.
    if (action === 'output' && !name && outputType === 'frame' && message === 'FAIL\n' && packages.get(pkg) === 'pending') {
      completedFailures.add(pkg);
    }
    if (!['start', 'run', 'pass', 'fail', 'skip'].includes(action)) continue;
    if (typeof pkg !== 'string' || (name !== undefined && typeof name !== 'string')) {
      throw new Error('invalid-go-event');
    }
    if (!name) {
      if (action === 'start') {
        if (packages.has(pkg)) throw new Error('duplicate-go-package');
        packages.set(pkg, 'pending');
      } else {
        // Build failures can report a package without starting a test binary.
        if (packages.get(pkg) !== 'pending') executionFailure = true;
        packages.set(pkg, action);
      }
      continue;
    }
    if (!testPackages.has(pkg) || packages.get(pkg) !== 'pending' || name.length > 256) {
      throw new Error('invalid-go-test');
    }
    const id = JSON.stringify([pkg, name]);
    if (action === 'run') {
      if (tests.has(id)) throw new Error('duplicate-go-test');
      tests.set(id, {id, package: pkg, name, status: 'pending'});
      if (tests.size > limits.tests) return {reason: 'test-limit'};
    } else {
      const status = {pass: 'passed', fail: 'failed', skip: 'skipped'}[action];
      if (!status || tests.get(id)?.status !== 'pending') throw new Error('incomplete-go-test');
      tests.get(id).status = status;
    }
  }
  const buildDiagnostics = new Map();
  if (readGoBuildDiagnostics(buildDiagnostics, diagnostics)) {
    return {reason: failedBuilds.size ? 'go-build-execution' : 'go-test-execution'};
  }
  for (const [pkg, chunks] of buildOutput) readGoBuildDiagnostics(buildDiagnostics, chunks.join(''), pkg);
  const unscoped = buildDiagnostics.get(undefined);
  if (unscoped?.unavailable || [...failedBuilds].some(pkg => buildDiagnostics.get(pkg)?.unavailable)) {
    return {reason: 'offline-dependency'};
  }
  const observed = [...tests.values()];
  const failedPackages = new Set(observed.filter(test => test.status === 'failed').map(test => test.package));
  if (failedBuilds.size) {
    const sourceFailures = code === 1 && !unscoped?.operational && [...failedBuilds].every(pkg => {
      const diagnostic = buildDiagnostics.get(pkg);
      return diagnostic?.source && !diagnostic.operational;
    });
    return {reason: sourceFailures ? 'go-build-failed' : 'go-build-execution'};
  }
  if (executionFailure || !packages.size || observed.some(test => test.status === 'pending') ||
      [...testPackages].some(pkg => !packages.has(pkg)) ||
      [...packages].some(([pkg, status]) => status === 'pending' ||
        (status === 'fail') !== failedPackages.has(pkg) || (status === 'fail' && !completedFailures.has(pkg))) ||
      code !== Number(failedPackages.size > 0)) return {reason: 'go-test-execution'};
  return {tests: observed};
}

export function baselineStatus(suite) {
  if (suite.reason) return {status: 'not-run', reason: suite.reason};
  const passed = suite.tests.filter(test => test.status === 'passed').length;
  const failed = suite.tests.filter(test => test.status === 'failed').length;
  const skipped = suite.tests.length - passed - failed;
  if (failed) return {status: 'failed', reason: 'baseline-failed', passed, failed, skipped};
  if (!passed) return {status: 'not-run', reason: 'no-passing-tests'};
  return {status: 'passed', passed, skipped};
}

export function classifyTrial(baseline, trial) {
  if (trial.reason) return {status: 'not-run', reason: trial.reason};
  const cases = new Map(trial.tests.map(test => [test.id, test]));
  if (cases.size !== baseline.tests.length || baseline.tests.some(test => {
    const observed = cases.get(test.id);
    return !observed || observed.property !== test.property || observed.file !== test.file ||
      observed.line !== test.line || (test.examples > 0 && !observed.examples) || (test.status === 'passed'
      ? !['passed', 'failed'].includes(observed.status) : observed.status !== test.status);
  })) return {status: 'not-run', reason: 'test-set-changed'};
  const failed = trial.tests.find(test => test.status === 'failed');
  if (!failed) return {status: 'survived'};
  const killedBy = failed.file
    ? {id: failed.id, file: failed.file, line: failed.line}
    : {package: failed.package, name: failed.name};
  return {status: 'killed', killedBy};
}

export async function measurePlan(plan, runSuite) {
  const ranked = plan.edits.map(edit => ({
    edit, rank: createHash('sha256').update(`${seed}:${edit.id}`).digest('hex'),
  })).sort((a, b) => a.rank < b.rank ? -1 : Number(a.rank > b.rank));
  const selected = ranked.slice(0, limits.mutants);
  const initial = ranked.length ? await runSuite() : {reason: 'no-candidates'};
  const baseline = baselineStatus(initial);
  const mutants = [];
  for (const {edit} of selected) {
    const result = baseline.status === 'passed'
      ? classifyTrial(initial, await runSuite(edit))
      : {status: 'not-run', reason: baseline.reason};
    mutants.push({...edit, ...result});
  }
  const killed = mutants.filter(mutant => mutant.status === 'killed').length;
  const survived = mutants.filter(mutant => mutant.status === 'survived').length;
  const notRun = ranked.length - killed - survived;
  const measured = killed + survived;
  const status = initial.reason === 'offline-dependency' ? 'unavailable'
    : measured ? (notRun || plan.truncated || plan.omitted.length ? 'partial' : 'measured') : 'not-run';
  return {status, baseline, candidates: ranked.length, killed, survived, notRun, mutants,
    unselected: ranked.length - selected.length, truncated: plan.truncated, omittedSources: plan.omitted.length,
    score: measured ? killed / measured : null};
}

export function summarizeProperties(suite) {
  const properties = suite.tests ?? [];
  const measured = properties.filter(test => test.examples > 0 && ['passed', 'failed'].includes(test.status));
  if (!measured.length) {
    const reason = suite.reason ?? (properties.length ? 'no-property-examples' : 'no-properties');
    return {status: reason === 'offline-dependency' ? 'unavailable' : 'not-run', reason, properties};
  }
  const status = !suite.reason && measured.length === properties.length ? 'measured' : 'partial';
  const outcome = measured.some(test => test.status === 'failed') ? 'failed' : 'passed';
  return {status, outcome, properties, ...(suite.reason && {reason: suite.reason})};
}
