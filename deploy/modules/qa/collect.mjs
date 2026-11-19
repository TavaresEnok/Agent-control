/**
 * Coletor real do Módulo 2 — QA pesado (deploy/modules/qa/collect.mjs).
 *
 * Regras de segurança:
 * - Executa testes do projeto somente em subprocessos no contêiner isolado.
 * - Copia apenas arquivos regulares necessários para um diretório isolado em /tmp.
 * - Redireciona logs de bibliotecas para stderr e emite na stdout um único JSON UTF-8:
 *   {
 *     coverage: [{ tool, version, status, detail }],
 *     findings: [{ tool, rule, file, line, severity, message, evidence }]
 *   }
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, extname, isAbsolute, join, posix, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  classifyMutant, comparePasses, executeNodeSuite, executionAllowed, mutationTool, planMutations, runtimeInstalled, selectNodeSuite, suiteTool, testIdentity,
} from './execute-tests.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_FILES = 400;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.state',
  '.next',
  '.cache',
]);
const ALLOWED_EXTS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.html',
  '.htm',
  '.md',
  '.sql',
]);
const FORBIDDEN_FILENAMES = new Set([
  '.env',
  '.credentials.json',
  'auth.json',
  'id_rsa',
  'id_ed25519',
]);

function cleanSingleLine(value, maxLen = 360) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function normalizeRelPath(rel) {
  const parts = rel.split(sep);
  if (isAbsolute(rel) || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('QA_INVALID_RELATIVE_PATH');
  }
  return parts.join(posix.sep);
}

const internal = 'interno';
const unmeasured = 'não aferida';

async function loadTool(specifier, entry) {
  const roots = [
    process.env.QA_TOOLS_NODE_MODULES,
    '/opt/qa-tools/node_modules',
    join(SCRIPT_DIR, 'node_modules'),
    join(SCRIPT_DIR, '..', '..', '..', 'node_modules'),
  ].filter(Boolean);

  for (const root of roots) {
    const packageDir = join(root, specifier);
    const candidate = join(packageDir, entry);
    if (!existsSync(candidate)) continue;
    const {version} = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
      throw new Error(`QA_TOOL_VERSION_UNAVAILABLE: ${specifier}`);
    }
    return {api: await import(pathToFileURL(candidate).href), version};
  }
  throw new Error(`QA_TOOL_UNAVAILABLE: ${specifier}`);
}

/** Copia apenas arquivos regulares permitidos e contabiliza os recortes sem expor seus nomes. */
function copyRepoToIsolatedTmp(repoDir) {
  const resolvedRepo = resolve(repoDir);
  if (!lstatSync(resolvedRepo, {throwIfNoEntry: false})?.isDirectory()) {
    throw new Error('QA_REPO_NOT_FOUND');
  }
  const workRoot = mkdtempSync(join(tmpdir(), 'qa-isolated-'));
  const workspace = join(workRoot, 'workspace');
  const copiedFiles = [];
  const exclusions = new Map();
  let incomplete = false;
  let copiedBytes = 0;

  function exclude(reason, cutsAnalysis = false, count = 1) {
    exclusions.set(reason, (exclusions.get(reason) ?? 0) + count);
    incomplete ||= cutsAnalysis;
  }

  function walk(currentDir, depth) {
    let entries;
    try {
      entries = readdirSync(currentDir, {withFileTypes: true});
    } catch {
      exclude('diretórios ilegíveis', true);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const [index, entry] of entries.entries()) {
      if (copiedFiles.length >= MAX_FILES) {
        exclude('entradas ou subárvores fora do limite de arquivos', true, entries.length - index);
        break;
      }
      if (FORBIDDEN_FILENAMES.has(entry.name)) {
        exclude('nomes reservados a credenciais');
        continue;
      }
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
        exclude('subárvores de metadados, dependências ou artefatos');
        continue;
      }
      if (entry.name.startsWith('.') && entry.name !== '.eslintrc.json') {
        exclude('entradas ou subárvores ocultas');
        continue;
      }

      const fullPath = join(currentDir, entry.name);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        exclude('entradas ilegíveis', true);
        continue;
      }
      if (stat.isDirectory()) {
        if (depth >= 10) exclude('subárvores fora do limite de profundidade', true);
        else walk(fullPath, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        exclude('links simbólicos ou arquivos especiais');
        continue;
      }
      if (!ALLOWED_EXTS.has(extname(entry.name).toLowerCase())) {
        exclude('arquivos de extensões fora da coleta');
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        exclude('arquivos fora do limite individual de bytes', true);
        continue;
      }
      if (copiedBytes + stat.size > MAX_SNAPSHOT_BYTES) {
        exclude('arquivos fora do limite total de bytes', true);
        continue;
      }
      const rel = normalizeRelPath(relative(resolvedRepo, fullPath));
      const destPath = join(workspace, rel);
      try {
        mkdirSync(dirname(destPath), {recursive: true, mode: 0o700});
        cpSync(fullPath, destPath, {dereference: false});
        chmodSync(destPath, 0o600);
      } catch {
        rmSync(destPath, {force: true});
        exclude('arquivos indisponíveis durante a cópia', true);
        continue;
      }
      copiedFiles.push(rel);
      copiedBytes += stat.size;
    }
  }

  try {
    chmodSync(workRoot, 0o700);
    mkdirSync(workspace, {mode: 0o700});
    walk(resolvedRepo, 0);
    return {workRoot, workspace, copiedFiles, incomplete, exclusions};
  } catch (error) {
    rmSync(workRoot, {recursive: true, force: true});
    throw error;
  }
}

function lineOfOffset(content, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function findLineNumber(content, pattern, fallback = 1) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if ( typeof pattern === 'string' ? lines[i].includes(pattern) : pattern.test(lines[i]) ) {
      return i + 1;
    }
  }
  return Math.max(1, fallback);
}

/**
 * Extrai informações estruturais de arquivos de código e de teste sem executar código.
 */
function analyzeSourceFile(relFile, content) {
  const functions = [];
  const routes = [];
  const lines = content.split(/\r?\n/);

  // Descobre funções exportadas e locais: `export function nome(params)` ou `function nome(params)`
  const fnRegex = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = fnRegex.exec(content)) !== null) {
    const name = match[1];
    const startLine = lineOfOffset(content, match.index);
    const isExported = /export\s+(?:async\s+)?function/.test(match[0]);

    functions.push({name, startLine, isExported});
  }

  // Descobre declarações de rotas HTTP: app.get('/api/...', ...), router.post('/api/...', ...)
  const routeRegex = /\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  let routeMatch;
  while ((routeMatch = routeRegex.exec(content)) !== null) {
    routes.push({
      method: routeMatch[1].toUpperCase(),
      path: routeMatch[2],
      file: relFile,
      line: lineOfOffset(content, routeMatch.index),
      snippet: lines[lineOfOffset(content, routeMatch.index) - 1]?.trim() ?? routeMatch[0],
    });
  }

  return {file: relFile, functions, routes};
}

const testNames = new Set(['test', 'it', 'describe', 'xit', 'xtest', 'xdescribe']);
const skipMethods = new Set(['skip', 'fixme', 'todo']);
const validatorPrefix = 'QA-VALIDADOR: ';

function visitAst(node, visitor) {
  if (!node?.type || visitor(node) === false) return;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visitAst(child, visitor);
    } else {
      visitAst(value, visitor);
    }
  }
}

function member(node, object, property) {
  return node?.type === 'MemberExpression' && !node.computed &&
    node.object.name === object && node.property.name === property;
}

function testCall(node, aliases) {
  if (node.type !== 'CallExpression') return;
  const {callee, arguments: args} = node;
  const localName = callee.type === 'Identifier' ? callee.name
    : callee.type === 'MemberExpression' && !callee.computed ? callee.object.name : undefined;
  const name = aliases.get(localName) ?? localName;
  const method = callee.type === 'MemberExpression' ? callee.property.name : undefined;
  if (!testNames.has(name) || (method && !skipMethods.has(method) && method !== 'only')) return;
  const title = args[0]?.type === 'StringLiteral' ? args[0].value
    : args[0]?.type === 'TemplateLiteral' && !args[0].expressions.length ? args[0].quasis[0].value.cooked : undefined;
  if (title === undefined) return;
  const callback = args.find(arg => ['ArrowFunctionExpression', 'FunctionExpression'].includes(arg.type));
  const options = args.find(arg => arg.type === 'ObjectExpression');
  const skipOption = options?.properties.some(prop => prop.type === 'ObjectProperty' && !prop.computed &&
    ['skip', 'todo'].includes(prop.key.name ?? prop.key.value) &&
    ((prop.value.type === 'BooleanLiteral' && prop.value.value) ||
      (prop.value.type === 'StringLiteral' && prop.value.value.length > 0)));
  const skipped = name.startsWith('x') || skipMethods.has(method) || skipOption;
  return {title, callback, skipped, suite: name === 'describe' || name === 'xdescribe', localName};
}

function onlyExpression(callback) {
  if (!['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type) ||
      callback.async || callback.generator || callback.params.length) return;
  const {body} = callback;
  if (body.type !== 'BlockStatement') return body;
  if (body.body.length === 1 && body.body[0].type === 'ExpressionStatement') return body.body[0].expression;
}

function literal(node) {
  return ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(node?.type) ||
    (node?.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral');
}

// Declaração de caso de borda como uma asserção direta de node:test sobre uma importação local.
function declaredValidator(test, runnerBindings, assertBindings, importedFunctions) {
  if (!test.title.startsWith(validatorPrefix) || !runnerBindings.has(test.localName)) return;
  const assertion = onlyExpression(test.callback);
  if (assertion?.type !== 'CallExpression') return;
  const {callee, arguments: args} = assertion;
  if (callee.type !== 'MemberExpression' || callee.computed || !assertBindings.has(callee.object.name)) return;
  const method = callee.property.name;
  const call = method === 'throws' && args.length === 1 ? onlyExpression(args[0])
    : ['equal', 'strictEqual'].includes(method) && args.length === 2 && literal(args[1]) ? args[0] : undefined;
  if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier' || !call.arguments.every(literal)) return;
  return importedFunctions.get(call.callee.name);
}

/** Levanta candidatos estáticos sem confundir opções do teste com seu callback. */
export function analyzeTestFile(relFile, content, parse) {
  const ast = parse(content, {
    sourceType: 'unambiguous',
    plugins: [/\.(?:ts|mts|cts|tsx)$/.test(relFile) ? 'typescript' : null, /\.(?:js|jsx|tsx)$/.test(relFile) ? 'jsx' : null].filter(Boolean),
  });
  const skippedTests = [];
  const assertionFreeTests = [];
  const flakyPatterns = [];
  const activeTests = [];
  const validators = [];
  let validatorDeclarations = 0;
  const importedFunctions = new Map();
  const aliases = new Map();
  const runnerBindings = new Set();
  const assertBindings = new Set();
  const topLevelCalls = new Set(ast.program.body.map(node => node.expression));

  for (const declaration of ast.program.body) {
    if (declaration.type !== 'ImportDeclaration' || declaration.importKind === 'type') continue;
    const path = declaration.source.value;
    for (const spec of declaration.specifiers) {
      if (spec.importKind === 'type') continue;
      const local = spec.local.name;
      const name = spec.imported?.name ?? spec.imported?.value;
      if (path === 'node:test' && (name ? ['test', 'it', 'describe'].includes(name) : spec.type === 'ImportDefaultSpecifier')) {
        runnerBindings.add(local);
        aliases.set(local, name ?? 'test');
      }
      if (['node:assert/strict', 'node:assert', 'assert/strict', 'assert'].includes(path) && !name) {
        assertBindings.add(local);
      }
      if (path.startsWith('.') && name) {
        const source = posix.normalize(posix.join(posix.dirname(relFile), path));
        importedFunctions.set(local, {source, name});
      }
    }
  }

  function record(test, node, kind) {
    const line = node.loc.start.line;
    const snippet = content.slice(node.start, node.start + 140).split('\n')[0];
    skippedTests.push({title: test.title, kind, file: relFile, line, snippet});
  }

  function analyze(node, suppressed) {
    const test = testCall(node, aliases);
    if (!test) return;
    const {title, callback, skipped, suite} = test;
    if (!suite && title.startsWith(validatorPrefix)) validatorDeclarations++;
    if (skipped) record(test, node, 'skip/todo explícito');
    if (suite || skipped || suppressed) {
      if (callback) visitAst(callback.body, child => analyze(child, skipped || suppressed));
      return false;
    }

    const {line, column} = node.loc.start;
    const item = {title, file: relFile, line, column: column + 1};
    const calls = [];
    let hasAssertion = false;
    let conditionalSkip = false;
    if (callback) visitAst(callback.body, child => {
      if (testCall(child, aliases)) return analyze(child, false);
      if (child.type !== 'CallExpression') return;
      const call = child.callee;
      const context = callback.params[0]?.name;
      if (context && (member(call, context, 'skip') || member(call, context, 'todo'))) {
        conditionalSkip = true;
        record(test, child, 'skip/todo no callback');
      }
      if (call.name === 'assert' || call.name === 'expect' ||
          (call.type === 'MemberExpression' && (assertBindings.has(call.object.name) || call.object.name === 'assert' ||
            member(call, 'fc', 'assert')))) hasAssertion = true;
      const imported = importedFunctions.get(call.name);
      if (imported) calls.push(imported);
      if (member(call, 'Math', 'random') || call.name === 'waitForTimeout' || call.property?.name === 'waitForTimeout') {
        flakyPatterns.push({...item, line: child.loc.start.line, snippet: content.slice(child.start, child.end)});
      }
    });

    if (!hasAssertion) assertionFreeTests.push({...item, snippet: title});
    const requirements = [...title.matchAll(/\bREQ-\d+\b/g)].map(match => match[0]);
    activeTests.push({...item, hasAssertion, conditionalSkip, calls, requirements});
    const validator = topLevelCalls.has(node) && declaredValidator(test, runnerBindings, assertBindings, importedFunctions);
    if (validator) validators.push({...item, validator});
    return false;
  }

  visitAst(ast.program, node => analyze(node, false));
  return {activeTests, skippedTests, assertionFreeTests, flakyPatterns, validators, validatorDeclarations};
}

function coverageRow(tool, version, status, detail) {
  return {tool: cleanSingleLine(tool, 120), version, status, detail: cleanSingleLine(detail)};
}

function indexRuntimeStatuses(tests = []) {
  const statuses = new Map();
  for (const test of tests) {
    const identity = testIdentity(test);
    statuses.set(identity, statuses.has(identity) ? undefined : test.statuses);
  }
  return candidate => statuses.get(testIdentity({...candidate, name: candidate.title.slice(0, 200)}));
}

function referencesFunction(calls, file, fn) {
  return calls.some(call => call.name === fn.name &&
    (call.source === file || call.source === file.slice(0, -extname(file).length)));
}

export function buildTraceability({workspace, sourceAnalyses, testAnalyses, reqFiles, runtimeTests, incomplete}) {
  const tool = 'qa-matriz-estatica';
  const version = internal;
  const rows = [];
  const findings = [];
  const tests = testAnalyses.flatMap(t => t.activeTests).filter(t => t.hasAssertion);
  const linked = (file, fn) => tests.filter(t => referencesFunction(t.calls, file, fn));
  const statusesOf = indexRuntimeStatuses(runtimeTests);
  const providesEvidence = t => runtimeTests
    ? statusesOf(t)?.every(status => status === 'passed')
    : !t.conditionalSkip;
  const describe = matches => matches.map(t => {
    const statuses = statusesOf(t);
    const detail = statuses?.join(',') ?? (t.conditionalSkip ? 'skip/todo possível' : 'execução sem vínculo confirmado');
    return `${t.file}:${t.line} ${t.title} (${detail})`;
  }).join('; ') || 'sem teste vinculado';
  const functions = sourceAnalyses.flatMap(src => src.functions.filter(fn => fn.isExported).map(fn => ({
    file: src.file, name: fn.name, line: fn.startLine, matches: linked(src.file, fn),
  })));
  for (const fn of functions) {
    rows.push(coverageRow(`qa-funcionalidade:${fn.file}:${fn.name}`, version, 'ok',
      `vínculo estático ${fn.file}:${fn.line} ${fn.name} → ${describe(fn.matches)}`));
  }
  let requirements = 0;
  for (const reqFile of reqFiles) {
    for (const [idx, text] of readFileSync(join(workspace, reqFile), 'utf8').split(/\r?\n/).entries()) {
      const id = /\bREQ-\d+\b/.exec(text)?.[0];
      if (!id) continue;
      requirements++;
      const mentioned = [...text.matchAll(/`([A-Za-z_]\w*)`/g)].map(match => match[1]);
      const features = functions.filter(fn => mentioned.includes(fn.name));
      const identifiers = features.map(fn => `${fn.name} (${fn.file}:${fn.line})`).join(', ');
      const matches = [...new Set([...tests.filter(t => t.requirements.includes(id)), ...features.flatMap(fn => fn.matches)])];
      const line = idx + 1;
      rows.push(coverageRow(`qa-requisito:${id}`, version, 'ok',
        `vínculo estático ${reqFile}:${line} → ${identifiers || 'sem funcionalidade identificada'} → ${describe(matches)}`));
      if (!matches.some(providesEvidence) && !incomplete) {
        findings.push({tool, rule: 'QA-REQUISITO-SEM-PROVA', file: reqFile, line, severity: 'alta',
          message: `Requisito ${id} sem ${runtimeTests ? 'teste vinculado aprovado nas três passadas' : 'vínculo estático com teste ativo que contenha asserção'}`,
          evidence: `${reqFile}:${line} → ${identifiers || 'sem funcionalidade identificada'} → ${describe(matches)}`});
      }
    }
  }
  return {
    coverageRow: coverageRow(tool, version, 'ok', `análise estática de ${requirements} requisitos e ${functions.length} funções exportadas`),
    extraRows: rows,
    findings,
  };
}

export function summarizeNodePasses(passes, sourceAnalyses, version) {
  const tests = comparePasses(passes);
  const extraRows = [];
  const findings = [];
  const measured = passes.map(pass => new Map(pass.coverage.map(c => [c.file, c])));
  for (const [index, pass] of passes.entries()) {
    const counts = status => pass.tests.filter(t => t.status === status).length;
    extraRows.push(coverageRow('node-test-v8-execucao', version, 'ok',
      `execução ${index + 1}: node:test resultado ${pass.summary ? 'aprovado' : 'reprovado'}; ${counts('passed')} aprovados, ${counts('failed')} reprovados, ${counts('skipped')} pulados, ${counts('todo')} todo`));
  }
  for (const test of tests) {
    const oscillates = new Set(test.statuses).size > 1;
    if (!oscillates && test.statuses.every(status => status === 'skipped' || status === 'todo')) {
      findings.push({tool: suiteTool, rule: 'QA-TESTE-PULADO-EXECUCAO', file: test.file, line: test.line,
        severity: 'alta', message: `Teste '${test.name}' marcado como pulado ou pendente pelo node:test`,
        evidence: `node:test nas passadas 1, 2 e 3: ${test.statuses.join(', ')}`});
    }
    if (!oscillates && !test.statuses.includes('failed')) continue;
    findings.push({
      tool: suiteTool, rule: oscillates ? 'QA-TESTE-OSCILANTE' : 'QA-TESTE-FALHOU', file: test.file,
      line: test.line, severity: 'alta', message: `Teste '${test.name}' ${oscillates ? 'mudou de resultado' : 'falhou'} em três execuções`,
      evidence: `node:test nas passadas 1, 2 e 3: ${test.statuses.join(', ')}; ${test.error ?? 'eventos do runner'}`,
    });
  }
  for (const src of sourceAnalyses) {
    const coverage = measured.map(files => files.get(src.file));
    const describe = c => c ? `ramos ${c.coveredBranchCount}/${c.totalBranchCount}, funções ${c.coveredFunctionCount}/${c.totalFunctionCount}` : 'arquivo sem medição';
    extraRows.push(coverageRow(`qa-arquivo:${src.file}`, version, coverage.some(Boolean) ? 'ok' : 'skipped',
      `V8 em três passadas: ${coverage.map(describe).join('; ')}`));
    for (const fn of src.functions.filter(fn => fn.isExported)) {
      const measurements = coverage.map(c => c?.functions.find(f => f.name === fn.name && f.line === fn.startLine));
      if (!measurements.every(f => f?.count === 0)) continue;
      findings.push({tool: suiteTool, rule: 'QA-COBERTURA-FUNCAO-SEM-TESTE', file: src.file, line: fn.startLine,
        severity: 'alta', message: `Função exportada '${fn.name}' sem execução medida pelo V8`,
        evidence: 'contagem V8 da função nas passadas 1, 2 e 3: 0, 0, 0'});
    }
  }
  const stable = tests.every(t => new Set(t.statuses).size === 1);
  return {tests, stable, findings, extraRows};
}

async function runNodeCoverage({context, sourceAnalyses, version, failTool, runtime}) {
  if (failTool === suiteTool) throw new Error('QA_NODE_TEST_FORCED_FAILURE');
  if (context.reason) return {coverageRow: coverageRow(suiteTool, unmeasured, 'skipped', context.reason)};
  const passes = [];
  for (let index = 0; index < 3; index++) {
    passes.push(await executeNodeSuite(context));
  }
  const result = summarizeNodePasses(passes, sourceAnalyses, version);
  runtime.tests = result.tests;
  if (result.stable && passes.every(p => p.summary && p.tests.some(t => t.status === 'passed'))) runtime.baseline = passes[0];
  return {
    coverageRow: coverageRow(suiteTool, version, 'ok',
      `três execuções de node:test, resultados ${result.stable ? 'iguais' : 'diferentes'}, ${result.tests.length} testes observados, cobertura de ramos V8 por arquivo`),
    ...result,
  };
}

async function runStrykerMutationTool({context, sourceFiles, failTool, runtime}) {
  if (failTool === mutationTool) throw new Error('QA_STRYKER_FORCED_FAILURE');
  if (context.reason) return {coverageRow: coverageRow(mutationTool, unmeasured, 'skipped', context.reason)};
  if (!runtime.baseline) return {coverageRow: coverageRow(mutationTool, unmeasured, 'skipped',
    'mutação requer três passadas estáveis com testes aprovados e sem falhas')};

  const {api: {Instrumenter}, version} = await loadTool('@stryker-mutator/instrumenter', 'dist/src/index.js');
  if (typeof Instrumenter !== 'function') throw new Error('QA_STRYKER_INSTRUMENTER_MISSING');
  const measuredFiles = new Set(runtime.baseline.coverage.map(item => item.file));
  const measuredSources = sourceFiles.filter(file => measuredFiles.has(file));
  const unmeasuredSources = sourceFiles.length - measuredSources.length;
  const {selected, total} = await planMutations(Instrumenter, measuredSources, file =>
    readFileSync(join(context.workspace, file), 'utf8'));

  if (total === 0) return {coverageRow: coverageRow(mutationTool, version, 'skipped', `StrykerJS não retornou mutantes EqualityOperator; ${unmeasuredSources} fontes fora por falta de medição V8`)};
  const extraRows = [];
  const findings = [];
  let killed = 0;
  let survived = 0;
  let errors = 0;
  for (const [index, mutation] of selected.entries()) {
    const tool = `qa-mutante:${index + 1}`;
    const patch = `${mutation.file}:${mutation.line} EqualityOperator → ${cleanSingleLine(mutation.replacement, 90)}`;
    try {
      const mutated = await executeNodeSuite({...context, mutation});
      const {status, killedBy} = classifyMutant(runtime.baseline, mutated);
      const evidence = killedBy
        ? `node:test reprovou ${killedBy.file}:${killedBy.line} '${killedBy.name}' (${killedBy.error ?? 'falha do teste'}) após o patch`
        : `node:test aprovou após o patch com os mesmos resultados da referência (${mutated.tests.filter(t => t.status === 'passed').length} testes aprovados)`;
      extraRows.push(coverageRow(tool, version, 'ok', `${status} | ${patch} | ${evidence}`));
      if (killedBy) {
        killed++;
      } else {
        survived++;
        findings.push({tool: mutationTool, rule: 'QA-STRYKER-MUTANTE-SOBREVIVENTE', file: mutation.file,
          line: mutation.line, severity: 'alta', message: 'Mutante de igualdade do StrykerJS sobreviveu à suíte executada',
          evidence: `${patch}: ${evidence}`});
      }
    } catch (error) {
      errors++;
      extraRows.push(coverageRow(tool, version, 'failed', `${patch}: ${error.message}`));
    }
  }
  return {
    coverageRow: coverageRow(mutationTool, version, errors ? 'failed' : 'ok',
      `${selected.length}/${total} mutantes EqualityOperator tentados sob a mesma configuração V8 da referência sem patch: ${killed} mortos, ${survived} sobreviventes, ${errors} sem classificação por erro; ${total - selected.length} fora do limite e ${unmeasuredSources} fontes sem medição V8`),
    extraRows,
    findings,
  };
}

export function measureValidatorCases({sourceAnalyses, testAnalyses, runtimeTests}) {
  const tool = 'qa-propriedades-funcionais';
  const declaredCount = testAnalyses.reduce((sum, test) => sum + test.validatorDeclarations, 0);
  const statusesOf = indexRuntimeStatuses(runtimeTests);
  const findings = [];
  let measured = 0;
  for (const candidate of testAnalyses.flatMap(t => t.validators)) {
    const {validator, file, line, title} = candidate;
    if (!sourceAnalyses.some(src => src.functions.some(fn => fn.isExported &&
      referencesFunction([validator], src.file, fn)))) continue;
    const statuses = statusesOf(candidate);
    if (statuses?.length !== 3 || !statuses.every(status => status === 'passed' || status === 'failed')) continue;
    measured++;
    if (statuses.includes('failed')) {
      findings.push({tool, rule: 'QA-VALIDADOR-CASO-REPROVADO', file, line, severity: 'alta',
        message: `Caso funcional declarado para '${validator.name}' reprovado pelo node:test`,
        evidence: `${title} nas três passadas: ${statuses.join(', ')}`});
    }
  }
  return {
    coverageRow: coverageRow(tool, internal, measured ? 'ok' : 'skipped',
      `${measured} de ${declaredCount} casos de borda sintéticos declarados medidos nas três passadas; ${findings.length} com reprovação`),
    findings,
  };
}

function runStaticTestAudit({testAnalyses, version}) {
  const toolName = 'qa-auditoria-estatica-testes';
  const findings = [];
  let totalActive = 0;
  let totalSkipped = 0;
  let totalNoAssert = 0;

  for (const t of testAnalyses) {
    totalActive += t.activeTests.length;
    totalSkipped += t.skippedTests.length;
    totalNoAssert += t.assertionFreeTests.length;

    for (const sk of t.skippedTests) {
      findings.push({
        tool: toolName,
        rule: 'QA-TESTE-PULADO',
        file: sk.file,
        line: sk.line,
        severity: 'alta',
        message: `Marcação estática de skip/todo em '${sk.title}'`,
        evidence: cleanSingleLine(`${sk.kind} em ${sk.file}:${sk.line} -> ${sk.snippet}`),
      });
    }

    for (const na of t.assertionFreeTests) {
      findings.push({
        tool: toolName,
        rule: 'QA-TESTE-SEM-ASSERCAO',
        file: na.file,
        line: na.line,
        severity: 'media',
        message: `Análise estática não identificou asserção em '${na.title}'`,
        evidence: cleanSingleLine(`bloco de teste sem assert/expect em ${na.file}:${na.line}`),
      });
    }

    for (const fl of t.flakyPatterns) {
      findings.push({
        tool: toolName,
        rule: 'QA-PADRAO-NAO-DETERMINISTICO',
        file: fl.file,
        line: fl.line,
        severity: 'media',
        message: `Teste '${fl.title}' contém padrão estático associado a não determinismo`,
        evidence: cleanSingleLine(`uso de Math.random/waitForTimeout em ${fl.file}:${fl.line} -> ${fl.snippet}`),
      });
    }
  }

  return {
    coverageRow: {
      tool: toolName,
      version,
      status: 'ok',
      detail: cleanSingleLine(
        `${testAnalyses.length} arquivos de teste analisados com @babel/parser (${totalActive} blocos, ${totalSkipped} marcações de skip, ${totalNoAssert} sem asserção identificada)`,
      ),
    },
    findings,
  };
}

/**
 * Acessibilidade básica de HTML estático, sem executar scripts da página.
 */
async function runAxeCoreTool({workspace, htmlFiles, failTool}) {
  const toolName = 'axe-core';
  if (failTool === toolName) {
    throw new Error('QA_AXE_FORCED_FAILURE');
  }

  if (htmlFiles.length === 0) {
    return {
      coverageRow: {
        tool: toolName,
        version: unmeasured,
        status: 'skipped',
        detail: 'nenhum arquivo HTML encontrado no repositorio',
      },
      findings: [],
    };
  }

  const {api: axeMod, version} = await loadTool('axe-core', 'axe.js');
  const {api: {JSDOM}, version: domVersion} = await loadTool('jsdom', 'lib/api.js');
  const axeSource = (axeMod.default ?? axeMod).source;
  if (!axeSource || !JSDOM) throw new Error('QA_AXE_TOOL_INCOMPLETE');

  const findings = [];
  let incompleteChecks = 0;
  for (const relHtml of htmlFiles) {
    const rawHtml = readFileSync(join(workspace, relHtml), 'utf8');
    // Remove qualquer tag <script> antes de criar o DOM para garantir que nenhum script não confiável exista
    const sanitizedHtml = rawHtml.replace(/<script\b[\s\S]*?<\/script>/gi, '');

    const dom = new JSDOM(sanitizedHtml, {runScripts: 'outside-only'});
    try {
      dom.window.eval(axeSource);
      const results = await dom.window.axe.run(dom.window.document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
        },
        rules: {
          'color-contrast': {enabled: false},
        },
      });
      incompleteChecks += results.incomplete.length;
      for (const violation of results.violations ?? []) {
        const ruleId = String(violation.id ?? 'wcag').toUpperCase();
        const severity =
          violation.impact === 'critical' || violation.impact === 'serious'
            ? 'alta'
            : violation.impact === 'moderate'
              ? 'media'
              : 'baixa';
        for (const node of violation.nodes ?? []) {
          const snippet = String(node.html ?? violation.id);
          const tagProbe = snippet.split(/\s+/)[0]?.replace(/[<>]/g, '') || snippet;
          const line = findLineNumber(rawHtml, snippet.slice(0, 32), findLineNumber(rawHtml, `<${tagProbe}`, 1));
          findings.push({
            tool: toolName,
            rule: `QA-AXE-${ruleId}`,
            file: relHtml,
            line,
            severity,
            message: cleanSingleLine(`Violacao de acessibilidade axe-core (${violation.id}): ${violation.help}`),
            evidence: cleanSingleLine(`elemento ${snippet} em ${relHtml}:${line}`),
          });
        }
      }
    } finally {
      dom.window.close();
    }
  }

  return {
    coverageRow: {
      tool: toolName,
      version,
      status: 'ok',
      detail: cleanSingleLine(
        `HTML estático em jsdom ${domVersion}, sem scripts nem layout; regra color-contrast desativada. ${htmlFiles.length} arquivos em regras selecionadas WCAG A/AA e boas práticas; ${findings.length} violações e ${incompleteChecks} resultados de regra inconclusivos`,
      ),
    },
    findings,
  };
}

/**
 * 6. Contrato de API (OpenAPI 3 via @apidevtools/swagger-parser cruzado com rotas do código).
 */
function routeShape(path, openapi = false) {
  if (!path.startsWith('/') || /[?*()+]|\$\{/.test(path)) return;
  const normalized = openapi
    ? path.replace(/\{[^/{}]+\}/g, '\u0000')
    : path.replace(/:[A-Za-z_]\w*(?=\/|[.-]|$)/g, '\u0000');
  if (/[{}:]/.test(normalized)) return;
  return normalized;
}

async function runSwaggerContractTool({workspace, openapiFiles, sourceAnalyses, incomplete, failTool}) {
  const toolName = 'swagger-parser';
  if (failTool === toolName) {
    throw new Error('QA_SWAGGER_FORCED_FAILURE');
  }

  const allRoutes = sourceAnalyses.flatMap(s => s.routes);
  if (openapiFiles.length === 0 && allRoutes.length === 0) {
    return {
      coverageRow: {
        tool: 'qa-contrato-openapi',
        version: unmeasured,
        status: 'skipped',
        detail: 'nenhuma especificação OpenAPI nem rota HTTP reconhecida na cópia',
      },
      extraRows: [],
      findings: [],
    };
  }

  let version = unmeasured;
  let SwaggerParser;
  if (openapiFiles.length) {
    const {api, version: installedVersion} = await loadTool('@apidevtools/swagger-parser', 'lib/index.js');
    SwaggerParser = api.default ?? api;
    version = installedVersion;
  }

  const findings = [];
  const documentedOperations = new Set(); // "METHOD /path"
  let totalSpecOps = 0;

  for (const specRel of openapiFiles) {
    const specFull = join(workspace, specRel);
    const parsedSpec = await SwaggerParser.validate(specFull, {
      resolve: {
        http: false,
        file: {canRead: file => file.url === specFull, read: () => readFileSync(specFull)},
      },
    });

    for (const [routePath, pathItem] of Object.entries(parsedSpec.paths ?? {})) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const op = pathItem[method];
        if (!op) continue;
        totalSpecOps += 1;
        documentedOperations.add(`${method.toUpperCase()} ${routePath}`);
        const shape = routeShape(routePath, true);
        if (shape !== undefined) documentedOperations.add(`${method.toUpperCase()} ${shape}`);
      }
    }
  }

  const extraRows = [];
  let unchecked = 0;
  for (const route of allRoutes) {
    const key = `${route.method} ${route.path}`;
    const shape = routeShape(route.path);
    const inContract = documentedOperations.has(key) ||
      (shape !== undefined && documentedOperations.has(`${route.method} ${shape}`));
    const excluded = inContract ? undefined : shape === undefined ? 'sintaxe de rota fora do cruzamento'
      : incomplete ? 'contrato não confirmado na cópia parcial' : undefined;
    if (excluded) unchecked++;
    if (!inContract && !excluded) {
      findings.push({
        tool: openapiFiles.length ? toolName : 'qa-contrato-openapi',
        rule: 'QA-CONTRATO-ROTA-SEM-OPENAPI',
        file: route.file,
        line: route.line,
        severity: 'media',
        message: `Rota '${key}' declarada no codigo nao consta no contrato OpenAPI do projeto`,
        evidence: cleanSingleLine(`rota ${key} em ${route.file}:${route.line} (${route.snippet}) ausente de ${openapiFiles.join(', ') || 'openapi.json'}`),
      });
    }
    extraRows.push(coverageRow(`qa-rota:${key}`, version, excluded ? 'skipped' : 'ok',
      `rota ${key} (${route.file}:${route.line}): ${excluded ??
        (inContract ? 'documentada e validada no contrato OpenAPI' : 'ausente no contrato OpenAPI')}`));
  }

  return {
    coverageRow: coverageRow(openapiFiles.length ? toolName : 'qa-contrato-openapi', version,
      openapiFiles.length || unchecked < allRoutes.length ? 'ok' : 'skipped',
      `${openapiFiles.length} especificações validadas, ${totalSpecOps} operações do contrato, ${allRoutes.length - unchecked} rotas conferidas e ${unchecked} sem conferência; métodos GET, POST, PUT, PATCH e DELETE`),
    extraRows,
    findings,
  };
}

/**
 * Executa a coleta completa do Módulo 2 (QA pesado) sobre repoDir.
 */
export async function collectQaModule(options = {}) {
  const repoDir = options.repoDir ?? process.env.QA_REPO_DIR ?? '/repo';
  const failTool = options.failTool ?? process.env.QA_FAIL_TOOL ?? '';

  const {workRoot, workspace, copiedFiles, incomplete, exclusions} = copyRepoToIsolatedTmp(repoDir);
  try {
    const codeFiles = copiedFiles.filter(f => /\.(?:[cm]?[jt]s|tsx)$/.test(f) && !/\.d\.[cm]?ts$/.test(f));
    const testFiles = codeFiles.filter(f => /(?:^|\/)(?:test|tests)\//.test(f) ||
      /(?:^|\/|[.-])(?:test|spec)\.(?:[cm]?[jt]s|tsx)$/.test(f));
    const sourceFiles = codeFiles.filter(f => !testFiles.includes(f));
    const htmlFiles = copiedFiles.filter(f => /\.(?:html|htm)$/.test(f));
    const openapiFiles = copiedFiles.filter(f => /(?:^|\/)(?:openapi|swagger)\.(?:json|yaml|yml)$/i.test(f));
    const reqFiles = copiedFiles.filter(f => /(?:^|\/)(?:requisitos|requirements)\.md$/i.test(f));

    const sourceAnalyses = sourceFiles.map(rel => analyzeSourceFile(rel, readFileSync(join(workspace, rel), 'utf8')));
    const testAnalyses = [];
    let parserVersion = unmeasured;
    let parserError;
    let omittedTestFiles = 0;
    if (testFiles.length) {
      try {
        const {api: {parse}, version} = await loadTool('@babel/parser', 'lib/index.js');
        parserVersion = version;
        for (const file of testFiles) {
          try {
            testAnalyses.push(analyzeTestFile(file, readFileSync(join(workspace, file), 'utf8'), parse));
          } catch {
            omittedTestFiles++;
          }
        }
      } catch (error) {
        parserError = error;
      }
    }

    const coverage = [coverageRow('qa-snapshot', internal, 'ok',
      `${copiedFiles.length} arquivos copiados (${incomplete ? 'cópia parcial' : 'dentro do escopo'}); limites de 400 arquivos, 1 MiB por arquivo, 64 MiB no total e 10 níveis`)];
    for (const [reason, count] of exclusions) {
      coverage.push(coverageRow('qa-snapshot-exclusao', internal, 'skipped', `${count} ${reason}`));
    }
    const extraCoverageRows = [];
    const findings = [];

    const runtime = {tests: undefined, baseline: null};
    const context = {repoDir, workspace, workRoot};
    let selectionError;
    try {
      const manifest = copiedFiles.includes('package.json') ? JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) : null;
      const selection = selectNodeSuite({
        manifest, testFiles,
        readTest: file => readFileSync(join(workspace, file), 'utf8'),
        incomplete,
        nestedManifest: copiedFiles.some(f => f.endsWith('/package.json')),
      });
      Object.assign(context, selection);
      if (!context.reason && !executionAllowed(repoDir)) {
        if (runtimeInstalled && process.env.QA_HOST_TEST_MODE !== '1') throw new Error('QA_CONTAINER_REQUIRED');
        context.reason = 'execução dinâmica reservada ao contêiner isolado';
      }
    } catch (error) {
      selectionError = error;
    }

    if (context.files && context.files.length < testFiles.length) {
      coverage.push(coverageRow('qa-selecao-execucao', internal, 'skipped',
        `${testFiles.length - context.files.length} arquivos de teste fora dos padrões de descoberta do node:test`));
    }
    if (omittedTestFiles) {
      coverage.push(coverageRow('qa-sintaxe-testes', parserVersion, 'skipped',
        `${omittedTestFiles} arquivos de teste ilegíveis ou com sintaxe não analisada`));
    }
    const matrixPartial = incomplete || !!parserError || omittedTestFiles > 0;
    const toolRunners = [
      {
        name: suiteTool,
        version: process.versions.v8,
        run: () => {
          if (selectionError) throw selectionError;
          return runNodeCoverage({context, sourceAnalyses, version: process.versions.v8, failTool, runtime});
        },
      },
      {
        name: mutationTool,
        run: () => {
          if (selectionError) throw selectionError;
          return runStrykerMutationTool({context, sourceFiles, failTool, runtime});
        },
      },
      {
        name: 'qa-matriz-estatica',
        partial: matrixPartial,
        run: () => buildTraceability({workspace, sourceAnalyses, testAnalyses, reqFiles,
          runtimeTests: runtime.tests, incomplete: matrixPartial}),
      },
      {
        name: 'qa-propriedades-funcionais',
        partial: matrixPartial,
        run: () => measureValidatorCases({sourceAnalyses, testAnalyses, runtimeTests: runtime.tests}),
      },
      {
        name: 'qa-auditoria-estatica-testes',
        partial: matrixPartial,
        run: () => {
          if (parserError) throw parserError;
          if (!testAnalyses.length) return {coverageRow: coverageRow('qa-auditoria-estatica-testes', unmeasured,
            'skipped', 'nenhum arquivo de teste com sintaxe analisada')};
          return runStaticTestAudit({testAnalyses, version: parserVersion});
        },
      },
      {
        name: 'axe-core',
        partial: incomplete,
        run: () => runAxeCoreTool({workspace, htmlFiles, failTool}),
      },
      {
        name: 'qa-contrato-openapi',
        partial: incomplete,
        run: () => runSwaggerContractTool({workspace, openapiFiles, sourceAnalyses, incomplete, failTool}),
      },
    ];

    for (const runner of toolRunners) {
      try {
        const res = await runner.run();
        const scoped = row => runner.partial
          ? coverageRow(row.tool, row.version, row.status, `escopo parcial; ${row.detail}`)
          : row;
        coverage.push(scoped(res.coverageRow));
        if (res.extraRows) extraCoverageRows.push(...res.extraRows.map(scoped));
        if (Array.isArray(res.findings)) {
          for (const item of res.findings) {
            findings.push({
              tool: cleanSingleLine(item.tool, 80),
              rule: cleanSingleLine(item.rule, 120),
              file: normalizeRelPath(item.file),
              line: Number.isInteger(item.line) && item.line >= 1 ? item.line : 1,
              severity: ['alta', 'media', 'baixa', 'informativa'].includes(item.severity) ? item.severity : 'media',
              message: cleanSingleLine(item.message, 320),
              evidence: cleanSingleLine(item.evidence, 360),
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        coverage.push(coverageRow(runner.name, runner.version ?? unmeasured, 'failed',
          `${runner.partial ? 'escopo parcial; ' : ''}falha em ${runner.name}: ${message}`));
      }
    }

    coverage.push(
      coverageRow('qa-fuzz', unmeasured, 'skipped', 'geração aleatória de entradas não executada'),
      coverageRow('qa-carga', unmeasured, 'skipped', 'carga ativa não executada no coletor offline'),
    );

    coverage.push(...extraCoverageRows);

    return {coverage, findings};
  } finally {
    rmSync(workRoot, {recursive: true, force: true});
  }
}

async function main() {
  const writeStdout = process.stdout.write.bind(process.stdout);
  const redirectToStderr = (...args) => {
    process.stderr.write(`${args.map(a => String(a)).join(' ')}\n`);
  };
  console.log = redirectToStderr;
  console.info = redirectToStderr;
  console.debug = () => {};
  console.warn = redirectToStderr;

  const result = await collectQaModule();
  const payload = `${JSON.stringify(result)}\n`;
  if (existsSync('/output')) {
    try {
      writeFileSync('/output/achados-brutos.json', payload, 'utf8');
    } catch {
      /* /output opcional */
    }
  }
  writeStdout(payload);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`QA_COLLECTOR_FATAL: ${message}\n`);
    process.stdout.write(`${JSON.stringify({
      coverage: [coverageRow('qa-coletor', internal, 'failed', `falha antes de concluir a coleta: ${message}`)],
      findings: [],
    })}\n`);
    process.exitCode = 1;
  });
}
