import {constants, accessSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {basename, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {executionAllowed, runBoundedProcess} from '../execute-tests.mjs';
import {selectLanguageSuite} from '../language-tests.mjs';
import {
  decodeGoSuite, decodePlan, decodePythonSuite, goDependencyMissing, goListFormat, limits, measurePlan,
  patchSource, processJson, seed, stopGoAtTestLimit, summarizeProperties,
} from './measurement.mjs';

const python = '/usr/local/bin/python3.12';
const go = '/usr/local/go/bin/go';
const goPlanner = fileURLToPath(new URL('./go-mutesting-plan', import.meta.url));
const pythonRunner = fileURLToPath(new URL('./python-runner.py', import.meta.url));
const {languageMeasurements: pins} = JSON.parse(readFileSync(new URL('../qa-tools.lock.json', import.meta.url), 'utf8'));
const pythonVersions = pins.python.versions;
export const languageMeasurementTools = {
  python: {tool: 'mutmut', version: pythonVersions.mutmut},
  go: {tool: 'go-mutesting', version: pins.go.version},
  properties: {tool: 'hypothesis', version: pythonVersions.hypothesis},
};

class MeasurementError extends Error {
  constructor(reason, status = 'not-run') {
    super(reason);
    this.status = status;
  }
}

function contained(parent, child) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

function checkContext({repoDir, workRoot, workspace}, files) {
  if (!executionAllowed(repoDir)) throw new MeasurementError('isolated-container-required');
  if (!contained('/tmp', workRoot) || !contained(workRoot, workspace) ||
      realpathSync(workRoot) !== workRoot || realpathSync(workspace) !== workspace ||
      files.some(file => !contained(workspace, resolve(workspace, file)) ||
        relative(workspace, resolve(workspace, file)) !== file || /[\p{Cc}\p{Cf}]/u.test(file))) {
    throw new MeasurementError('invalid-snapshot');
  }
}

async function copySession(context, task) {
  const scratch = mkdtempSync(join(context.workRoot, 'qa-language-'));
  try {
    const project = join(scratch, 'project');
    cpSync(context.workspace, project, {recursive: true, filter: source => {
      const stat = lstatSync(source);
      if (!stat.isDirectory() && !stat.isFile()) throw new MeasurementError('invalid-snapshot');
      return true;
    }});
    return await task(project, scratch);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

function bounded(deadline) {
  return (binary, args, cwd, env, maxMs, stopOnStdout) => {
    const timeoutMs = Math.min(maxMs, Math.floor(deadline - performance.now()));
    if (timeoutMs <= 0) throw new MeasurementError('time-budget');
    return runBoundedProcess(binary, args, cwd, {env, timeoutMs, maxBytes: limits.outputBytes, stopOnStdout});
  };
}

function requireTool(path, mode = constants.X_OK) {
  try {
    accessSync(path, mode);
  } catch {
    throw new MeasurementError('tool-unavailable', 'unavailable');
  }
}

export async function verifyPinnedTool(probe, matches) {
  let installed;
  try {
    installed = processJson(await probe());
  } catch (error) {
    if (errorReason(error) !== 'tool-execution') throw error;
    throw new MeasurementError('tool-unavailable', 'unavailable');
  }
  if (!matches(installed)) throw new MeasurementError('tool-unavailable', 'unavailable');
}

function pythonCommand(run, args, cwd, home) {
  return run(python, ['-P', '-s', '-S', '-B', pythonRunner, ...args], cwd,
    {HOME: home, TMPDIR: home, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTHONHASHSEED: String(seed)},
    limits.pythonMs);
}

async function checkPython(run, scratch, mode) {
  requireTool(python);
  requireTool(pythonRunner, constants.R_OK);
  const required = mode === 'plan' ? Object.keys(pythonVersions) : ['pytest', 'hypothesis'];
  await verifyPinnedTool(() => pythonCommand(run, ['probe', mode], scratch, scratch),
    installed => required.every(tool => installed?.[tool] === pythonVersions[tool]));
}

function goEnvironment(home, cache) {
  return {
    PATH: '/usr/local/go/bin:/usr/bin:/bin', HOME: home, TMPDIR: home,
    GOPATH: join(home, 'go'), GOCACHE: cache, GOENV: 'off', GOWORK: 'off',
    GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off', GOTELEMETRY: 'off',
    CGO_ENABLED: '0', GOMAXPROCS: '2',
  };
}

export async function goScope(run, project, home, cache, selection) {
  const cwd = join(project, selection.moduleDir);
  const env = goEnvironment(home, cache);
  const {Replace} = processJson(await run(go, ['mod', 'edit', '-json'], cwd, env, limits.goMs));
  if (Replace?.some(item => !item.New?.Version)) throw new MeasurementError('go-local-replace', 'unavailable');
  const mode = lstatSync(join(cwd, 'vendor', 'modules.txt'), {throwIfNoEntry: false})?.isFile() ? '-mod=vendor' : '-mod=readonly';
  const result = await run(go, ['list', mode, '-f', goListFormat, './...'], cwd, env, limits.goMs);
  if (result.code !== 0) {
    if (goDependencyMissing.test(result.diagnostics)) throw new MeasurementError('offline-dependency', 'unavailable');
    throw new MeasurementError('go-package-selection');
  }
  const sources = new Set();
  const packages = new Set();
  for (const line of result.output.split('\n').filter(Boolean)) {
    const [kind, value, extra] = line.split('\t');
    if (!value || extra !== undefined) throw new MeasurementError('go-package-selection');
    if (kind === 'S' && contained(project, value) && isAbsolute(value)) sources.add(relative(project, value));
    else if (kind === 'P') packages.add(value);
    else throw new MeasurementError('go-package-selection');
  }
  return {sources: selection.sourceFiles.filter(file => sources.has(file)), packages, mode};
}

export async function runGoSuite(run, project, home, cache, selection, {mode, packages}) {
  try {
    const result = await run(go, [
      'test', '-json', mode, '-count=1', '-p=2', '-parallel=1', '-vet=off',
      '-timeout=8s', '-run', '^(Test|Example)', '-shuffle=' + seed, './...',
    ], join(project, selection.moduleDir), goEnvironment(home, cache), limits.goMs, stopGoAtTestLimit());
    return decodeGoSuite(result, packages);
  } catch (error) {
    if (error.message === 'QA_TEST_GO_CASE_LIMIT') return {reason: 'test-limit'};
    throw error;
  }
}

function errorReason(error) {
  if (error instanceof MeasurementError) return error.message;
  if (error.message === 'QA_TEST_TIMEOUT') return 'process-timeout';
  if (error.message === 'QA_TEST_OUTPUT_LIMIT') return 'process-output-limit';
  return 'tool-execution';
}

async function measure(language, context, selection) {
  const deadline = performance.now() + limits.mutationMs;
  const run = bounded(deadline);
  const root = mkdtempSync(join(context.workRoot, 'qa-mutation-'));
  try {
    const cache = join(root, 'cache');
    if (language === 'python') await checkPython(run, root, 'plan');
    else {
      requireTool(go);
      requireTool(goPlanner);
      mkdirSync(cache);
      await verifyPinnedTool(() => run(goPlanner, ['--version'], root, {}, limits.goMs),
        version => version === pins.go.version);
    }

    const {plan, scope} = await copySession(context, async (project, scratch) => {
      const scope = language === 'go' ? await goScope(run, project, scratch, cache, selection) : undefined;
      const sources = (scope?.sources ?? selection.sourceFiles.filter(file => basename(file) !== 'conftest.py')).toSorted();
      const result = language === 'python'
        ? await pythonCommand(run, ['plan', ...sources], project, scratch)
        : await run(goPlanner, sources, project, goEnvironment(scratch, cache), limits.goMs);
      return {plan: decodePlan(result, sources, file => readFileSync(join(project, file), 'utf8')), scope};
    });

    return await measurePlan(plan, async edit => {
      if (performance.now() >= deadline) return {reason: 'time-budget'};
      try {
        return await copySession(context, async (project, scratch) => {
          if (edit) {
            const path = join(project, edit.file);
            const source = readFileSync(path, 'utf8');
            writeFileSync(path, patchSource(source, edit));
          }
          if (language === 'python') {
            const result = await pythonCommand(run, ['suite', String(seed), ...selection.files], project, scratch);
            return decodePythonSuite(result, selection.files);
          }
          return await runGoSuite(run, project, scratch, cache, selection, scope);
        });
      } catch (error) {
        return {reason: errorReason(error)};
      }
    });
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

async function collect(kind, context, copiedFiles, incomplete, runner) {
  const report = {...languageMeasurementTools[kind], seed};
  const language = kind === 'properties' ? 'python' : kind;
  const selection = selectLanguageSuite(language, copiedFiles, incomplete);
  if (selection.reason) return {...report, status: 'not-run', reason: selection.reason, selection: true};
  try {
    checkContext(context, copiedFiles);
    const result = await runner(selection);
    const omittedTests = selection.omitted;
    const status = omittedTests && result.status === 'measured' ? 'partial' : result.status;
    return {...report, ...result, status, omittedTests};
  } catch (error) {
    const status = error instanceof MeasurementError ? error.status : 'not-run';
    return {...report, status, reason: errorReason(error)};
  }
}

/** Run only in the existing offline QA container on the collector's copied snapshot. */
export function collectLanguageMutation(language, context, copiedFiles, incomplete) {
  if (language !== 'python' && language !== 'go') throw new TypeError('unsupported mutation language');
  return collect(language, context, copiedFiles, incomplete, selection => measure(language, context, selection));
}

/** Measure only collected, genuine Hypothesis properties already in the selected test files. */
export function collectPythonProperties(context, copiedFiles, incomplete) {
  return collect('properties', context, copiedFiles, incomplete, async selection => {
    const run = bounded(performance.now() + limits.propertiesMs);
    return copySession(context, async (project, scratch) => {
      await checkPython(run, scratch, 'properties');
      const result = await pythonCommand(run, ['properties', String(seed), ...selection.files], project, scratch);
      return summarizeProperties(decodePythonSuite(result, selection.files, true));
    });
  });
}
