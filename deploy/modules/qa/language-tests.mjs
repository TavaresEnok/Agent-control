import {spawn} from 'node:child_process';
import {constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, posix, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {comparePasses, executionAllowed} from './execute-tests.mjs';

const {languageRuntimes: pins} = JSON.parse(readFileSync(new URL('./qa-tools.lock.json', import.meta.url), 'utf8'));
const python = '/usr/local/bin/python3.12';
const go = '/usr/local/go/bin/go';
const pythonRunner = fileURLToPath(new URL('./python-test-runner.py', import.meta.url));
const maxTests = 200;
const maxFindings = 50;
const testTimeoutMs = 8_000;
const goTimeoutMs = 35_000;
const maxFiles = 400;
const maxFileBytes = 1024 * 1024;
const maxSnapshotBytes = 64 * 1024 * 1024;
const maxDepth = 10;
const maxProfileBytes = 2 * 1024 * 1024;
const passCount = 3;
const unmeasured = 'não aferida';
const partialSnapshot = 'escopo parcial por limites ou arquivos indisponíveis no snapshot';
const excludedDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.state', '.next', '.cache']);
const reservedNames = /^(?:\.env(?:\..*)?|\.credentials\.json|auth\.json|id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc)$/;

export const languageSuites = {
  python: {tool: 'python-unittest-coverage', version: `Python ${pins.python.version} / coverage.py ${pins.coverage.version}`},
  go: {tool: 'go-test-cover', version: `Go ${pins.go.version}`},
};

const pythonCandidate = /(?:^|\/)(?:test[^/]*|[^/]+_test)\.py$/;
const pythonImportable = /^(?:[\p{ID_Start}_][\p{ID_Continue}]*\/)*[\p{ID_Start}_][\p{ID_Continue}]*\.py$/u;
const goCandidate = /_test\.go$/;
const goExcluded = /(?:^|\/)(?:vendor|testdata|[._][^/]*)(?:\/|$)/;
const count = value => Number.isSafeInteger(value) && value >= 0;
const metric = value => Array.isArray(value) && value.length === 2 && value.every(count) && value[0] <= value[1];

export function selectLanguageSuite(language, copiedFiles, incomplete) {
  const candidates = language === 'python'
    ? copiedFiles.filter(file => pythonCandidate.test(file))
    : copiedFiles.filter(file => goCandidate.test(file) && !goExcluded.test(file));
  if (incomplete) return {reason: partialSnapshot};
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

/** Load bounded inputs from the read-only Git mount. The buffers stay in the supervisor. */
export function loadLanguageSnapshot(repoDir) {
  const files = new Map();
  let totalBytes = 0;

  function walk(directory, depth) {
    const entries = readdirSync(join(repoDir, directory), {withFileTypes: true});
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (reservedNames.test(entry.name)) continue;
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const file = posix.join(directory, entry.name);
      const source = join(repoDir, file);
      const stat = lstatSync(source);
      if (stat.isDirectory()) {
        if (depth >= maxDepth || !walk(file, depth + 1)) return false;
        continue;
      }
      if (!stat.isFile() || stat.size > maxFileBytes || totalBytes + stat.size > maxSnapshotBytes || files.size >= maxFiles) {
        return false;
      }
      const content = readFileSync(source, {flag: constants.O_RDONLY | constants.O_NOFOLLOW});
      if (content.length !== stat.size) return false;
      files.set(file, {content, mode: 0o600 | (stat.mode & 0o100)});
      totalBytes += content.length;
    }
    return true;
  }

  try {
    if (!lstatSync(repoDir).isDirectory() || !walk('', 0)) return {reason: partialSnapshot};
  } catch {
    return {reason: partialSnapshot};
  }
  return {
    files: [...files.keys()],
    copyTo(destination) {
      mkdirSync(destination, {mode: 0o700});
      for (const [file, {content, mode}] of files) {
        const path = join(destination, file);
        mkdirSync(dirname(path), {recursive: true, mode: 0o700});
        writeFileSync(path, content, {mode, flag: 'wx'});
      }
    },
  };
}

export function runLanguageProcess(binary, args, cwd, {
  timeoutMs = testTimeoutMs, maxBytes = 2 * 1024 * 1024, env = {}, spawnChild = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnChild(binary, args, {
      cwd, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: {PATH: '/usr/bin:/bin', HOME: cwd, TMPDIR: '/tmp', LANG: 'C.UTF-8', TZ: 'UTC', ...env},
    });
    const output = [];
    const diagnostics = [];
    let size = 0;
    let finished = false;
    let groupStopped = false;

    function stopGroup() {
      if (groupStopped || !child.pid) return;
      groupStopped = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') return 'QA_TEST_PROCESS_KILL';
      }
    }

    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        const killError = stopGroup();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(new Error(killError ?? error));
      } else {
        resolve(result);
      }
    }

    function capture(chunks) {
      return chunk => {
        if (finished) return;
        size += chunk.length;
        if (size > maxBytes) finish('QA_TEST_OUTPUT_LIMIT');
        else chunks.push(chunk);
      };
    }

    const timer = setTimeout(() => finish('QA_TEST_TIMEOUT'), timeoutMs);
    child.stdout.on('data', capture(output));
    child.stderr.on('data', capture(diagnostics));
    child.stdout.on('error', () => finish('QA_TEST_PROCESS_IO'));
    child.stderr.on('error', () => finish('QA_TEST_PROCESS_IO'));
    child.once('error', error => finish(`QA_TEST_SPAWN_${error.code ?? 'ERROR'}`));
    child.once('exit', () => {
      if (finished) return;
      const error = stopGroup();
      if (error) finish(error);
    });
    child.once('close', (code, signal) => {
      if (finished) return;
      if (signal || (code !== 0 && code !== 1)) {
        finish('QA_TEST_PROCESS_EXIT');
        return;
      }
      finish(null, {code, output: Buffer.concat(output).toString('utf8'), diagnostics: Buffer.concat(diagnostics).toString('utf8')});
    });
  });
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
  const {tests, unavailable, errors, coverage, fixtureSkips, unsupported = 0} = report ?? {};
  if (![unavailable, errors, fixtureSkips, unsupported].every(count) || !Array.isArray(tests) || tests.length > maxTests ||
      tests.some(test => !selection.files.includes(test?.file) || typeof test.name !== 'string' ||
        !['passed', 'failed', 'skipped', 'unavailable'].includes(test.status)) ||
      (coverage !== null && (!count(coverage?.files) || coverage.files > selection.sourceFiles.length ||
        !metric(coverage.statements) || !metric(coverage.branches)))) throw new Error(invalid);
  return {tests: tests.map(test => testCase(test.file, test.name, test.status)), unavailable, errors, coverage, fixtureSkips, unsupported};
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
const goTestName = /^(?:Test|Example)[\p{L}\p{Nd}_]*$/u;

function goImportPath(selection, moduleName, file) {
  const relative = posix.relative(selection.moduleDir, file);
  return relative ? `${moduleName}/${relative}` : moduleName;
}

function goCaseKey(pkg, name) {
  return `${pkg}\0${name}`;
}

export function decodeGoPass({code, output, diagnostics}, profile, selection, moduleName, locations = new Map()) {
  const errorCode = 'QA_GO_REPORT_INVALID';
  const filesByPackage = new Map();
  for (const file of selection.files) {
    const pkg = goImportPath(selection, moduleName, posix.dirname(file));
    if (!filesByPackage.has(pkg)) filesByPackage.set(pkg, []);
    filesByPackage.get(pkg).push(file);
  }
  const tests = [];
  const running = new Map();
  const failedTests = new Set();
  const failedPackages = new Map();
  const failedBuilds = new Set();
  const unavailableBuilds = new Set();
  let started = 0;
  let unattributed = 0;
  for (const line of output.split('\n').filter(Boolean)) {
    const event = readJson(line, errorCode);
    if (typeof event?.Action !== 'string') throw new Error(errorCode);
    if (event.Action === 'build-output' && goUnavailable.test(event.Output)) unavailableBuilds.add(event.ImportPath);
    if (event.Action === 'build-fail') failedBuilds.add(event.ImportPath);
    if (!event.Test && event.Action === 'fail') failedPackages.set(event.Package, event.FailedBuild);
    if (typeof event.Test !== 'string') continue;
    const root = event.Test.split('/', 1)[0];
    if (!goTestName.test(root)) continue;
    const candidates = filesByPackage.get(event.Package);
    if (!candidates?.length) continue;
    const key = goCaseKey(event.Package, event.Test);
    const inFlight = running.get(key) ?? 0;
    if (event.Action === 'run') {
      if (++started > maxTests) throw new Error('QA_LANGUAGE_TEST_LIMIT');
      running.set(key, inFlight + 1);
    }
    const status = Object.hasOwn(goStatuses, event.Action) ? goStatuses[event.Action] : null;
    if (!status) continue;
    if (inFlight > 1) running.set(key, inFlight - 1);
    else running.delete(key);
    if (status === 'failed') failedTests.add(event.Package);
    const parent = locations.get(goCaseKey(event.Package, root));
    const location = locations.get(key) ?? parent;
    const file = location?.file ?? (candidates.length === 1 ? candidates[0] : null);
    if (!file) unattributed++;
    tests.push({...testCase(file, `${event.Package}.${event.Test}`, status), line: location?.line ?? 1});
    if (tests.length > maxTests) throw new Error('QA_LANGUAGE_TEST_LIMIT');
  }
  const unavailableDiagnostic = goUnavailable.test(diagnostics);
  const unavailable = unavailableBuilds.size || Number(unavailableDiagnostic);
  let errors = [...running.values()].reduce((sum, active) => sum + active, 0);
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
  return {tests, unavailable, errors, coverage, fixtureSkips: 0, unattributed};
}

function readRegularFile(file, limit, errorCode) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error(errorCode);
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset > stat.size) throw new Error(errorCode);
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Go discovers subtests during execution. Reserve a slot in the pinned testing runner
// immediately before calling each test, subtest or example. O_EXCL shares the budget
// across package processes as well as goroutines. The image's stdlib stays intact.
export function prepareGoTestBudget(scratch, goroot) {
  const cases = join(scratch, 'cases');
  mkdirSync(cases);
  const replacements = {};
  const testing = join(goroot, 'src', 'testing');
  function overlay(file, anchor, replacement, extra = '') {
    const original = join(testing, file);
    const source = readFileSync(original, 'utf8');
    const parts = source.split(anchor);
    if (parts.length !== 2) throw new Error('QA_GO_TEST_BUDGET_UNAVAILABLE');
    const patched = join(scratch, file);
    writeFileSync(patched, parts.join(replacement) + extra);
    replacements[original] = patched;
  }
  overlay('testing.go', '\n\tfn(t)\n', '\n\tif t.level > 0 { qaAdmitCase(t.Name(), fn) }\n\tfn(t)\n', `
var qaNextCase atomic.Int32

func qaAdmitCase(name string, callback any) {
    dir := os.Getenv("QA_GO_CASE_DIR")
    if dir == "" {
        os.Exit(1)
    }
    for {
        slot := qaNextCase.Add(1)
        if slot > ${maxTests} {
            _ = os.WriteFile(filepath.Join(dir, "limit"), nil, 0600)
            os.Exit(1)
        }
        path := filepath.Join(dir, strconv.Itoa(int(slot)))
        receipt, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
        if os.IsExist(err) {
            continue
        }
        if err != nil {
            os.Exit(1)
        }
        source, line := "", 0
        pc := reflect.ValueOf(callback).Pointer()
        if function := runtime.FuncForPC(pc); function != nil {
            source, line = function.FileLine(pc)
        }
        _, err = fmt.Fprintf(receipt, "%x %x %d\\n", name, source, line)
        closeErr := receipt.Close()
        if err != nil || closeErr != nil {
            os.Exit(1)
        }
        return
    }
}
`);
  overlay('run_example.go', '\n\teg.F()\n', '\n\tqaAdmitCase(eg.Name, eg.F)\n\teg.F()\n');
  const overlayFile = join(scratch, 'go-overlay.json');
  writeFileSync(overlayFile, JSON.stringify({Replace: replacements}));
  return {overlayFile, cases};
}

export function readGoCaseLocations(cases, cwd, selection, moduleName) {
  const invalid = 'QA_GO_CASE_REPORT_INVALID';
  if (readRegularFile(join(cases, 'limit'), 0, invalid) !== null) throw new Error('QA_LANGUAGE_TEST_LIMIT');
  const locations = new Map();
  const testFiles = new Set(selection.files);
  for (let slot = 1; slot <= maxTests; slot++) {
    const receipt = readRegularFile(join(cases, String(slot)), maxFileBytes, invalid);
    if (receipt === null) break;
    const match = /^([a-f0-9]+) ([a-f0-9]*) (\d+)\n$/.exec(receipt);
    if (!match || match[1].length % 2 || match[2].length % 2 || !count(Number(match[3]))) throw new Error(invalid);
    const [, nameHex, sourceHex, lineNumber] = match;
    const name = Buffer.from(nameHex, 'hex').toString('utf8');
    const source = Buffer.from(sourceHex, 'hex').toString('utf8');
    const file = relative(cwd, source);
    const line = Number(lineNumber);
    if (!testFiles.has(file) || line < 1) continue;
    const pkg = goImportPath(selection, moduleName, posix.dirname(file));
    const key = goCaseKey(pkg, name);
    const old = locations.get(key);
    if (old === undefined) locations.set(key, {file, line});
    else if (old && (old.file !== file || old.line !== line)) locations.set(key, null);
  }
  return locations;
}

function goEnvironment(home) {
  return {
    PATH: '/usr/local/go/bin:/usr/bin:/bin',
    HOME: home, TMPDIR: home, GOPATH: join(home, 'go'), GOCACHE: join(home, 'go-cache'), GOENV: 'off',
    GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off', GOVCS: '*:off',
    CGO_ENABLED: '0', GOMAXPROCS: '2',
  };
}

async function executeLanguagePass(language, snapshot, selection) {
  const deadline = performance.now() + (language === 'go' ? goTimeoutMs : testTimeoutMs);
  function run(binary, args, cwd, env, limit) {
    const timeoutMs = Math.min(limit, Math.floor(deadline - performance.now()));
    if (timeoutMs <= 0) throw new Error('QA_TEST_TIMEOUT');
    return runLanguageProcess(binary, args, cwd, {env, timeoutMs});
  }

  const scratch = mkdtempSync(join(tmpdir(), `qa-${language}-`));
  try {
    const cwd = join(scratch, 'project');
    snapshot.copyTo(cwd);
    if (language === 'python') {
      const plan = join(scratch, 'plan.json');
      writeFileSync(plan, JSON.stringify({...selection, maxTests, maxProfileBytes}));
      const result = await run(python, ['-I', '-S', '-B', pythonRunner, plan, join(scratch, 'coverage.json')],
        cwd, {HOME: scratch, TMPDIR: scratch}, testTimeoutMs);
      return decodePythonPass(result, selection);
    }
    const moduleDir = join(cwd, selection.moduleDir);
    const env = goEnvironment(scratch);
    const manifest = await run(go, ['mod', 'edit', '-json'], moduleDir, env, testTimeoutMs);
    if (manifest.code !== 0) throw new Error('QA_GO_MODULE_INVALID');
    const {Module, Replace} = readJson(manifest.output, 'QA_GO_MODULE_INVALID');
    if (typeof Module?.Path !== 'string' || !Module.Path) throw new Error('QA_GO_MODULE_INVALID');
    if (Replace?.some(item => !item.New?.Version)) {
      return {tests: [], unavailable: 1, errors: 0, coverage: null, reason: 'replace local no go.mod fora do escopo offline', fixtureSkips: 0};
    }
    const profile = join(scratch, 'coverage.out');
    const {overlayFile, cases} = prepareGoTestBudget(scratch, dirname(dirname(go)));
    const result = await run(go, [
      'test', '-json', '-mod=readonly', '-count=1', '-p=2', '-parallel=1', '-vet=off', '-timeout=8s',
      '-run', '^(Test|Example)', `-overlay=${overlayFile}`, '-covermode=set', `-coverprofile=${profile}`, './...',
    ], moduleDir, {...env, QA_GO_CASE_DIR: cases}, goTimeoutMs);
    const locations = readGoCaseLocations(cases, cwd, selection, Module.Path);
    let measuredProfile = null;
    try {
      measuredProfile = readRegularFile(profile, maxProfileBytes, 'QA_GO_PROFILE_LIMIT');
    } catch {
      // Files outside the profile size or type limits are not evidence of coverage.
    }
    return decodeGoPass(result, measuredProfile, selection, Module.Path, locations);
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

function passOutcome({tests, unavailable, errors, fixtureSkips, unsupported, unattributed}) {
  const counts = status => tests.filter(test => test.status === status).length;
  const passed = counts('passed');
  const failed = counts('failed');
  const skipped = counts('skipped');
  const outcome = errors ? 'erro na execução' : unavailable ? 'dependência indisponível' :
    failed ? 'reprovado' : passed ? 'aprovado' : unsupported ? 'formato pytest não suportado' :
      skipped || fixtureSkips ? 'todos os casos pulados' : 'nenhum teste executável';
  const fixtures = fixtureSkips ? `, ${fixtureSkips} fixtures puladas` : '';
  const unsupportedDetail = unsupported ? `, ${unsupported} arquivos com formato pytest não suportado` : '';
  const locations = unattributed ? `, ${unattributed} casos Go sem arquivo identificado` : '';
  return `${outcome}; ${passed} aprovados, ${failed} reprovados, ${skipped} pulados${fixtures}${unsupportedDetail}${locations}`;
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
    if (!test.file || (!fluctuates && !test.statuses.includes('failed'))) continue;
    findings.push({tool, rule: fluctuates ? 'QA-TESTE-OSCILANTE' : 'QA-TESTE-FALHOU',
      file: test.file, line: test.line, severity: 'alta',
      message: `Teste '${test.name}' ${fluctuates ? 'mudou de resultado' : 'falhou'}`,
      evidence: `passadas completas (${completedPasses.length}/3): ${test.statuses.join(', ')}`});
  }
  for (const pass of passes.filter(item => item.errors || item.unavailable)) {
    const index = passes.indexOf(pass) + 1;
    for (const test of pass.tests.filter(item => item.file && item.status === 'failed')) {
      if (findings.some(item => item.file === test.file && item.message === `Teste '${test.name}' falhou`)) continue;
      findings.push({tool, rule: 'QA-TESTE-FALHOU', file: test.file, line: test.line, severity: 'alta',
        message: `Teste '${test.name}' falhou`, evidence: `caso reprovado na execução ${index}, com escopo parcial`});
    }
  }
  const executed = passes.some(pass => pass.tests.some(test => ['passed', 'failed'].includes(test.status)));
  const status = passes.some(pass => pass.errors) ? 'failed' :
    passes.some(pass => pass.unavailable) || !executed ? 'skipped' : 'ok';
  const unsupported = passes.some(pass => pass.unsupported);
  const unattributed = passes.some(pass => pass.unattributed);
  let reason = status === 'failed' ? 'erro na execução' :
    passes.some(pass => pass.unavailable) ? 'dependência indisponível no ambiente offline' :
      executed ? `${findings.length} casos com falha ou oscilação` : 'nenhum teste executado com resultado';
  if (unsupported) reason += '; formato pytest não suportado';
  if (unattributed) reason += '; atribuição parcial dos casos Go';
  const describe = coverage => {
    if (!coverage) return 'sem medição';
    const statements = `statements ${coverage.statements.join('/')}`;
    return coverage.branches ? `${statements}, ramos ${coverage.branches.join('/')}` : statements;
  };
  const partial = selection.omitted > 0 || unsupported || passes.some(pass => pass.errors || pass.unavailable ||
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
  const preliminary = selectLanguageSuite(language, copiedFiles, incomplete);
  if (preliminary.reason) return skip(preliminary.reason);
  if (!executionAllowed(context.repoDir)) return skip('execução dinâmica reservada ao contêiner isolado');
  const snapshot = loadLanguageSnapshot(context.repoDir);
  if (snapshot.reason) return skip(snapshot.reason);
  const selection = selectLanguageSuite(language, snapshot.files, false);
  if (selection.reason) return skip(selection.reason);
  return measureLanguageSuite(language, selection, () => executeLanguagePass(language, snapshot, selection));
}
