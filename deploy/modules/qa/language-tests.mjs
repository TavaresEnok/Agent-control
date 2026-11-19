import {constants, cpSync, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {comparePasses, executionAllowed, runBoundedProcess} from './execute-tests.mjs';

const {languageRuntimes: pins} = JSON.parse(readFileSync(new URL('./qa-tools.lock.json', import.meta.url), 'utf8'));
const python = '/usr/local/bin/python3.12';
const go = '/usr/local/go/bin/go';
const pythonRunner = fileURLToPath(new URL('./python-test-runner.py', import.meta.url));
const maxTests = 200;
const maxFindings = 50;
const goTimeoutMs = 35_000;
const maxProfileBytes = 2 * 1024 * 1024;
const passCount = 3;
const unmeasured = 'não aferida';

export const languageSuites = {
  python: {tool: 'python-unittest-coverage', version: `Python ${pins.python.version} / coverage.py ${pins.coverage.version}`},
  go: {tool: 'go-test-cover', version: `Go ${pins.go.version}`},
};

const pythonCandidate = /(?:^|\/)(?:test[^/]*|[^/]+_test)\.py$/;
const pythonImportable = /^(?:[\p{ID_Start}_][\p{ID_Continue}]*\/)*[\p{ID_Start}_][\p{ID_Continue}]*\.py$/u;
const goCandidate = /_test\.go$/;
const goExcluded = /(?:^|\/)(?:vendor|testdata|_[^/]*)(?:\/|$)/;
const count = value => Number.isSafeInteger(value) && value >= 0;
const metric = value => Array.isArray(value) && value.length === 2 && value.every(count) && value[0] <= value[1];

function isLanguageTest(file, language) {
  return language === 'python' ? pythonCandidate.test(file) : goCandidate.test(file) && !goExcluded.test(file);
}

export function hasLanguageTestCandidates(copiedFiles) {
  return copiedFiles.some(file => isLanguageTest(file, 'python') || isLanguageTest(file, 'go'));
}

export function selectLanguageSuite(language, copiedFiles, incomplete) {
  const candidates = copiedFiles.filter(file => isLanguageTest(file, language));
  if (incomplete) return {reason: 'escopo parcial por limites ou arquivos indisponíveis no snapshot'};
  if (!candidates.length) return {reason: 'nenhum arquivo candidato a teste unitário'};
  if (language === 'python') {
    const files = candidates.filter(file => pythonImportable.test(file));
    if (!files.length) return {reason: 'escopo parcial: arquivos de teste sem nome importável pelo unittest'};
    const sourceFiles = copiedFiles.filter(file => file.endsWith('.py') && !pythonCandidate.test(file) &&
      !/(?:^|\/)(?:test|tests)\//.test(file));
    return {files, sourceFiles, omitted: candidates.length - files.length};
  }
  const modules = copiedFiles.filter(file => posix.basename(file) === 'go.mod' && !goExcluded.test(file));
  if (!modules.length) return {reason: 'módulo Go indisponível: nenhum go.mod no snapshot'};
  const moduleFile = modules.includes('go.mod') ? 'go.mod' : modules.length === 1 ? modules[0] : null;
  if (!moduleFile) return {reason: 'escopo parcial: vários módulos Go sem go.mod na raiz'};
  const moduleDir = posix.dirname(moduleFile);
  const nested = modules.filter(file => file !== moduleFile).map(file => posix.dirname(file) + '/');
  const inModule = file => (moduleDir === '.' || file.startsWith(moduleDir + '/')) &&
    !nested.some(prefix => file.startsWith(prefix)) && !goExcluded.test(file);
  const files = candidates.filter(inModule);
  if (!files.length) return {reason: 'escopo parcial: nenhum candidato no módulo Go selecionado'};
  const sourceFiles = copiedFiles.filter(file => file.endsWith('.go') && !goCandidate.test(file) && inModule(file));
  return {files, sourceFiles, moduleFile, moduleDir, omitted: candidates.length - files.length};
}

function readJson(output, errorCode) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(errorCode);
  }
}

function testCase(file, name, status) {
  return {file, name, status, line: 1, column: 1};
}

export function decodePythonPass({code, output}, selection) {
  if (code !== 0) throw new Error('QA_PYTHON_EXECUTION_FAILED');
  const invalid = 'QA_PYTHON_REPORT_INVALID';
  const report = readJson(output, invalid);
  if (report?.limited === true) throw new Error('QA_LANGUAGE_TEST_LIMIT');
  const {tests, unavailable, errors, coverage, fixtureSkips} = report ?? {};
  if (![unavailable, errors, fixtureSkips].every(count) || !Array.isArray(tests) || tests.length > maxTests ||
      tests.some(test => !selection.files.includes(test?.file) || typeof test.name !== 'string' ||
        !['passed', 'failed', 'skipped', 'unavailable'].includes(test.status)) ||
      (coverage !== null && (!count(coverage?.files) || coverage.files > selection.sourceFiles.length ||
        !metric(coverage.statements) || !metric(coverage.branches)))) throw new Error(invalid);
  return {tests: tests.map(test => testCase(test.file, test.name, test.status)), unavailable, errors, coverage, fixtureSkips};
}

export function decodeGoProfile(profile, sources) {
  if (profile === null) return null;
  const [header, ...lines] = profile.trimEnd().split('\n');
  if (header !== 'mode: set') throw new Error('QA_GO_PROFILE_INVALID');
  const files = new Set();
  const blocks = new Map();
  let covered = 0;
  let total = 0;
  for (const line of lines) {
    const match = /^(.+):(\d+\.\d+,\d+\.\d+) (\d+) ([01])$/.exec(line);
    if (!match || !count(Number(match[3]))) throw new Error('QA_GO_PROFILE_INVALID');
    const [, file, range, numStmt, executed] = match;
    if (!sources.has(file)) continue;
    files.add(file);
    const key = `${file}:${range}`;
    const previous = blocks.get(key);
    if (previous && previous.numStmt !== numStmt) throw new Error('QA_GO_PROFILE_INVALID');
    if (!previous) total += Number(numStmt);
    if (executed === '1' && previous?.executed !== '1') covered += Number(numStmt);
    blocks.set(key, {numStmt, executed: previous?.executed === '1' ? '1' : executed});
  }
  if (!metric([covered, total])) throw new Error('QA_GO_PROFILE_INVALID');
  return files.size ? {files: files.size, statements: [covered, total]} : null;
}

const goUnavailable = /module lookup disabled by GOPROXY=off|no required module provides package|missing go\.sum entry for module providing package|updates to go\.mod needed|requires go >= .*GOTOOLCHAIN=local/i;
const goStatuses = {pass: 'passed', fail: 'failed', skip: 'skipped'};

function goImportPath(selection, moduleName, file) {
  const relative = posix.relative(selection.moduleDir, file);
  return relative ? `${moduleName}/${relative}` : moduleName;
}

export function decodeGoPass({code, output, diagnostics}, profile, selection, moduleName) {
  const errorCode = 'QA_GO_REPORT_INVALID';
  const filesByPackage = new Map();
  for (const file of selection.files) {
    const pkg = goImportPath(selection, moduleName, posix.dirname(file));
    if (!filesByPackage.has(pkg)) filesByPackage.set(pkg, []);
    filesByPackage.get(pkg).push(file);
  }
  const tests = [];
  const running = new Set();
  const failedTests = new Set();
  const failedPackages = new Map();
  const failedBuilds = new Set();
  const unavailableBuilds = new Set();
  for (const line of output.split('\n').filter(Boolean)) {
    const event = readJson(line, errorCode);
    if (typeof event?.Action !== 'string') throw new Error(errorCode);
    if (event.Action === 'build-output' && goUnavailable.test(event.Output)) unavailableBuilds.add(event.ImportPath);
    if (event.Action === 'build-fail') failedBuilds.add(event.ImportPath);
    if (!event.Test && event.Action === 'fail') failedPackages.set(event.Package, event.FailedBuild);
    if (typeof event.Test !== 'string' || !/^(?:Test|Example)[\p{L}\p{N}_]*$/u.test(event.Test)) continue;
    const candidates = filesByPackage.get(event.Package);
    if (!candidates?.length) continue;
    const name = `${event.Package}.${event.Test}`;
    if (event.Action === 'run') running.add(name);
    const status = Object.hasOwn(goStatuses, event.Action) ? goStatuses[event.Action] : null;
    if (!status) continue;
    running.delete(name);
    if (status === 'failed') failedTests.add(event.Package);
    const file = candidates.length === 1 ? candidates[0] : selection.moduleFile;
    tests.push(testCase(file, name, status));
    if (tests.length > maxTests) throw new Error('QA_LANGUAGE_TEST_LIMIT');
  }
  const unavailableDiagnostic = goUnavailable.test(diagnostics);
  const unavailable = unavailableBuilds.size || Number(unavailableDiagnostic);
  let errors = running.size;
  for (const pkg of failedBuilds) {
    if (!unavailableBuilds.has(pkg)) errors++;
  }
  for (const [pkg, build] of failedPackages) {
    if (!build && failedTests.has(pkg)) continue;
    if (!failedBuilds.has(build ?? pkg) && !unavailableBuilds.has(build ?? pkg)) errors++;
  }
  if (code !== 0 && !failedTests.size && !unavailable && !errors) errors++;
  if (code === 0 && (failedTests.size || failedBuilds.size || failedPackages.size || running.size)) {
    throw new Error(errorCode);
  }
  const sources = new Set(selection.sourceFiles.map(file => goImportPath(selection, moduleName, file)));
  let coverage = null;
  if (tests.some(test => test.status === 'passed' || test.status === 'failed')) {
    try {
      coverage = decodeGoProfile(profile, sources);
    } catch {
      // A missing or invalid profile does not erase test events.
    }
  }
  return {tests, unavailable, errors, coverage, fixtureSkips: 0};
}

function readProfile(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxProfileBytes) throw new Error('QA_GO_PROFILE_LIMIT');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset > stat.size) throw new Error('QA_GO_PROFILE_LIMIT');
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function goEnvironment(home, cache) {
  return {
    PATH: '/usr/local/go/bin:/usr/bin:/bin',
    HOME: home, TMPDIR: home, GOPATH: join(home, 'go'), GOCACHE: cache, GOENV: 'off',
    GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off',
    CGO_ENABLED: '0', GOMAXPROCS: '2',
  };
}

async function executeLanguagePass(language, context, selection, cache) {
  if (!executionAllowed(context.repoDir)) throw new Error('QA_CONTAINER_REQUIRED');
  const scratch = mkdtempSync(join(context.workRoot, `${language}-`));
  try {
    const cwd = join(scratch, 'project');
    cpSync(context.workspace, cwd, {recursive: true});
    if (language === 'python') {
      const plan = join(scratch, 'plan.json');
      writeFileSync(plan, JSON.stringify({...selection, maxTests, maxProfileBytes}));
      const result = await runBoundedProcess(python, ['-I', '-S', '-B', pythonRunner, plan, join(scratch, 'coverage.json')],
        cwd, {env: {HOME: scratch, TMPDIR: scratch}});
      return decodePythonPass(result, selection);
    }
    const moduleDir = join(cwd, selection.moduleDir);
    const env = goEnvironment(scratch, cache);
    const manifest = await runBoundedProcess(go, ['mod', 'edit', '-json'], moduleDir, {env});
    if (manifest.code !== 0) throw new Error('QA_GO_MODULE_INVALID');
    const {Module, Replace} = readJson(manifest.output, 'QA_GO_MODULE_INVALID');
    if (typeof Module?.Path !== 'string' || !Module.Path) throw new Error('QA_GO_MODULE_INVALID');
    if (Replace?.some(item => !item.New?.Version)) {
      return {tests: [], unavailable: 1, errors: 0, coverage: null, reason: 'replace local no go.mod fora do escopo offline', fixtureSkips: 0};
    }
    const profile = join(scratch, 'coverage.out');
    const result = await runBoundedProcess(go, [
      'test', '-json', '-mod=readonly', '-count=1', '-p=2', '-parallel=1', '-vet=off', '-timeout=8s',
      '-run', '^(Test|Example)', '-covermode=set', `-coverprofile=${profile}`, './...',
    ], moduleDir, {env, timeoutMs: goTimeoutMs});
    let measuredProfile = null;
    try {
      measuredProfile = readProfile(profile);
    } catch {
      // Files outside the profile size or type limits are not evidence of coverage.
    }
    return decodeGoPass(result, measuredProfile, selection, Module.Path);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

function passOutcome({tests, unavailable, errors, fixtureSkips}) {
  const counts = status => tests.filter(test => test.status === status).length;
  const passed = counts('passed');
  const failed = counts('failed');
  const skipped = counts('skipped');
  const outcome = errors ? 'erro na execução' : unavailable ? 'dependência indisponível' :
    failed ? 'reprovado' : passed ? 'aprovado' : skipped || fixtureSkips ? 'todos os casos pulados' : 'nenhum teste executável';
  const fixtures = fixtureSkips ? `, ${fixtureSkips} fixtures puladas` : '';
  return `${outcome}; ${passed} aprovados, ${failed} reprovados, ${skipped} pulados${fixtures}`;
}

export async function measureLanguageSuite(language, selection, executePass) {
  const {tool, version} = languageSuites[language];
  const extraRows = [];
  const findings = [];
  const passes = [];
  const row = (name, status, detail) => ({tool: name, version, status, detail});
  for (let i = 0; i < passCount; i++) {
    let pass;
    try {
      pass = await executePass();
    } catch (error) {
      // Retain the other attempts without publishing raw test output or diagnostics.
      const reason = /^QA_[A-Z0-9_]+$/.test(error.message) ? error.message : 'executor indisponível ou interrompido';
      pass = {tests: [], errors: 1, unavailable: 0, coverage: null, fixtureSkips: 0, reason};
    }
    passes.push(pass);
    const status = pass.errors ? 'failed' : pass.tests.some(test => ['passed', 'failed'].includes(test.status)) && !pass.unavailable ? 'ok' : 'skipped';
    extraRows.push(row(`${tool}-execucao`, status, `execução ${i + 1}: ${passOutcome(pass)}${pass.reason ? `; ${pass.reason}` : ''}`));
  }
  const completedPasses = passes.filter(pass => !pass.errors && !pass.unavailable);
  const tests = comparePasses(completedPasses);
  for (const test of tests) {
    const fluctuates = new Set(test.statuses).size > 1;
    if (!fluctuates && !test.statuses.includes('failed')) continue;
    findings.push({tool, rule: fluctuates ? 'QA-TESTE-OSCILANTE' : 'QA-TESTE-FALHOU',
      file: test.file, line: test.line, severity: 'alta',
      message: `Teste '${test.name}' ${fluctuates ? 'mudou de resultado' : 'falhou'}`,
      evidence: `passadas completas (${completedPasses.length}/3): ${test.statuses.join(', ')}`});
  }
  for (const pass of passes.filter(item => item.errors || item.unavailable)) {
    const index = passes.indexOf(pass) + 1;
    for (const test of pass.tests.filter(item => item.status === 'failed')) {
      if (findings.some(item => item.file === test.file && item.message === `Teste '${test.name}' falhou`)) continue;
      findings.push({tool, rule: 'QA-TESTE-FALHOU', file: test.file, line: test.line, severity: 'alta',
        message: `Teste '${test.name}' falhou`, evidence: `caso reprovado na execução ${index}, com escopo parcial`});
    }
  }
  const executed = passes.some(pass => pass.tests.some(test => ['passed', 'failed'].includes(test.status)));
  const status = passes.some(pass => pass.errors) ? 'failed' :
    passes.some(pass => pass.unavailable) || !executed ? 'skipped' : 'ok';
  const reason = status === 'failed' ? 'erro na execução' :
    passes.some(pass => pass.unavailable) ? 'dependência indisponível no ambiente offline' :
      executed ? `${findings.length} casos com falha ou oscilação` : 'nenhum teste executado com resultado';
  const describe = coverage => {
    if (!coverage) return 'sem medição';
    const statements = `statements ${coverage.statements.join('/')}`;
    return coverage.branches ? `${statements}, ramos ${coverage.branches.join('/')}` : statements;
  };
  const partial = selection.omitted > 0 || passes.some(pass => pass.errors || pass.unavailable ||
    pass.coverage?.files !== selection.sourceFiles.length);
  const anyCoverage = passes.some(pass => pass.coverage);
  const scope = !anyCoverage ? 'sem medição' : partial ? 'escopo parcial' : 'escopo medido';
  const belowFull = passes.some(pass => [pass.coverage?.statements, pass.coverage?.branches]
    .some(value => value && value[0] < value[1]));
  extraRows.push(row(`${tool}-cobertura`, anyCoverage && !partial ? 'ok' : 'skipped',
    `${scope}${belowFull ? ', abaixo de 100% no escopo medido' : ''}; ${passes.map((pass, index) => `${index + 1}: ${describe(pass.coverage)}`).join('; ')}`));
  if (findings.length > maxFindings) {
    extraRows.push(row(`${tool}-limite`, 'skipped', `${findings.length - maxFindings} achados fora do limite de publicação`));
  }
  return {coverageRow: row(tool, status, `três passadas; ${reason}`), extraRows, findings: findings.slice(0, maxFindings)};
}

export async function collectLanguageSuite(language, context, copiedFiles, incomplete) {
  const {tool} = languageSuites[language];
  const skip = detail => ({coverageRow: {tool, version: unmeasured, status: 'skipped', detail}});
  const selection = selectLanguageSuite(language, copiedFiles, incomplete);
  if (selection.reason) return skip(selection.reason);
  if (!executionAllowed(context.repoDir)) return skip('execução dinâmica reservada ao contêiner isolado');
  const cache = join(context.workRoot, 'go-cache');
  if (language === 'go') mkdirSync(cache);
  return measureLanguageSuite(language, selection, () => executeLanguagePass(language, context, selection, cache));
}
