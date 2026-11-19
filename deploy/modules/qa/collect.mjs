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
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  classifyMutant, comparePasses, executeNodeSuite, executionAllowed, mutationTool, planMutations, runtimeInstalled, selectNodeSuite, suiteTool, testIdentity,
} from './execute-tests.mjs';
import {collectLanguageSuite, hasLanguageTestCandidates, languageSuites} from './language-tests.mjs';
import {collectLanguageMutation, collectPythonProperties, languageMeasurementTools} from './mutacao-linguagens/index.mjs';
import {publishMutation, publishProperties} from './mutacao-linguagens/report.mjs';
import {collectJsProperties, propertyLimits, propertyTool} from './js-properties.mjs';
import {bancoLocalTool, collectQaBancoLocal} from './banco-local/index.mjs';
import {localLoadTool, runLocalLoadQa} from './carga-local/index.mjs';
import {functionalContractTools, maxContractDocuments, runFunctionalContract} from './contratos/index.mjs';

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
  '.css',
  '.png',
  '.md',
  '.sql',
  '.py',
  '.go',
]);
const ALLOWED_FILENAMES = new Set(['go.mod', 'go.sum']);
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

function displayPath(file) {
  return file.replace(/[%|~\s\u0000-\u001f\u007f]/g, char => char === '~' ? '%7E' : encodeURIComponent(char));
}

function abbreviateIdentity(value, maxLength) {
  if (value.length <= maxLength) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `${value.slice(0, maxLength - hash.length - 1)}~${hash}`;
}

function fileCoverageKey(prefix, file, suffix = '') {
  return abbreviateIdentity(`${prefix}:${displayPath(file)}${suffix}`, 120);
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

  function exclude(reason, cutsAnalysis = false) {
    exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);
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
    for (const entry of entries) {
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
      const goVendorManifest = entry.name === 'modules.txt' && basename(currentDir) === 'vendor';
      if (!ALLOWED_EXTS.has(extname(entry.name).toLowerCase()) && !ALLOWED_FILENAMES.has(entry.name) && !goVendorManifest) {
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
      if (copiedFiles.length >= MAX_FILES) {
        exclude('arquivos elegíveis fora do limite de arquivos', true);
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

function findLineNumber(content, pattern, fallback = 1) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if ( typeof pattern === 'string' ? lines[i].includes(pattern) : pattern.test(lines[i]) ) {
      return i + 1;
    }
  }
  return Math.max(1, fallback);
}

export async function loadQaSyntax() {
  const [{api: {parse}, version}, {api: traversal}] = await Promise.all([
    loadTool('@babel/parser', 'lib/index.js'),
    loadTool('@babel/traverse', 'lib/index.js'),
  ]);
  return {version, parse, traverse: traversal.default};
}

function parseFile(file, content, parse, options) {
  return parse(content, {
    sourceType: 'unambiguous',
    plugins: [/\.(?:ts|mts|cts|tsx)$/.test(file) ? 'typescript' : null,
      /\.(?:js|jsx|tsx)$/.test(file) ? 'jsx' : null].filter(Boolean),
    ...options,
  });
}

function staticString(node) {
  while (['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(node?.type)) {
    node = node.expression;
  }
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
}

const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const routeReceivers = new Set(['app', 'router', 'server']);
const primitiveBinary = new Set(['+', '-', '*', '/', '%', '**', '<<', '>>', '>>>', '|', '&', '^',
  '==', '!=', '===', '!==', '<', '<=', '>', '>=']);
const primitiveUnary = new Set(['+', '-', '!', '~', 'typeof', 'void']);

function purePrimitiveFunction(fn) {
  if (fn.node.async || fn.node.generator || !fn.node.params.every(param => param.type === 'Identifier')) return false;

  function expression(path) {
    const {node} = path;
    if (literal(node)) return true;
    if (path.isIdentifier()) {
      const binding = path.scope.getBinding(node.name);
      return ['param', 'const'].includes(binding?.kind) && binding.scope.getFunctionParent()?.path === fn;
    }
    if (path.isUnaryExpression()) return primitiveUnary.has(node.operator) && expression(path.get('argument'));
    if (path.isLogicalExpression() || (path.isBinaryExpression() && primitiveBinary.has(node.operator))) {
      return expression(path.get('left')) && expression(path.get('right'));
    }
    if (path.isConditionalExpression()) return ['test', 'consequent', 'alternate'].every(key => expression(path.get(key)));
    return path.isTemplateLiteral() && path.get('expressions').every(expression);
  }

  function statement(path) {
    if (path.isBlockStatement()) return path.get('body').every(statement);
    if (path.isEmptyStatement()) return true;
    if (path.isReturnStatement()) return !path.node.argument || expression(path.get('argument'));
    if (path.isThrowStatement()) return expression(path.get('argument'));
    if (path.isIfStatement()) return expression(path.get('test')) && statement(path.get('consequent')) &&
      (!path.node.alternate || statement(path.get('alternate')));
    if (path.isSwitchStatement()) {
      return expression(path.get('discriminant')) && path.get('cases').every(branch =>
        (!branch.node.test || expression(branch.get('test'))) && branch.get('consequent').every(statement));
    }
    return path.isVariableDeclaration({kind: 'const'}) && path.get('declarations').every(declarator =>
      declarator.get('id').isIdentifier() && declarator.node.init && expression(declarator.get('init')));
  }

  const body = fn.get('body');
  return body.isBlockStatement() ? statement(body) : expression(body);
}

/** Lê a estrutura das fontes sem carregar seus módulos. */
export function analyzeSourceFile(relFile, content, {parse, traverse}) {
  const declarations = new Map();
  const exportNames = new Map();
  const routes = [];
  let directEval = false;
  function addExport(path, name) {
    const declaration = path.isVariableDeclarator() ? path.get('init') : path;
    if (!declaration?.isFunctionDeclaration() && !declaration?.isFunctionExpression() &&
        !declaration?.isArrowFunctionExpression()) return;
    if (!exportNames.has(declaration.node)) exportNames.set(declaration.node, new Set());
    exportNames.get(declaration.node).add(name);
  }
  traverse(parseFile(relFile, content, parse), {
    FunctionDeclaration(path) {
      const {node} = path;
      if (!node.id) return;
      declarations.set(node, {path, binding: path.parentPath.scope.getBinding(node.id.name), name: node.id.name});
      if (path.parentPath.isExportNamedDeclaration()) addExport(path, node.id.name);
      if (path.parentPath.isExportDefaultDeclaration()) addExport(path, 'default');
    },
    VariableDeclarator(path) {
      const id = path.get('id');
      const init = path.get('init');
      if (!path.parentPath.isVariableDeclaration({kind: 'const'}) || !id.isIdentifier() ||
          (!init.isArrowFunctionExpression() && !init.isFunctionExpression())) return;
      const {name} = id.node;
      declarations.set(init.node, {path: init, binding: path.scope.getBinding(name), name: init.node.id?.name ?? name});
      if (path.parentPath.parentPath.isExportNamedDeclaration()) addExport(path, name);
    },
    ExportSpecifier(path) {
      const {local, exported, exportKind} = path.node;
      const parent = path.parentPath.node;
      if (parent.source || parent.exportKind === 'type' || exportKind === 'type') return;
      const binding = path.scope.getBinding(local.name);
      if (binding?.path.isFunctionDeclaration() || binding?.kind === 'const') addExport(binding.path, exported.name ?? exported.value);
    },
    'CallExpression|OptionalCallExpression'(path) {
      const callee = path.node.callee;
      if (callee.type === 'Identifier' && callee.name === 'eval') directEval = true;
      if (!['MemberExpression', 'OptionalMemberExpression'].includes(callee.type) || !routeReceivers.has(callee.object.name?.toLowerCase())) return;
      const method = (callee.computed ? staticString(callee.property) : callee.property.name)?.toLowerCase();
      if (!httpMethods.has(method)) return;
      const arg = path.node.arguments[0];
      if (!arg) return;
      const binding = arg.type === 'Identifier' ? path.scope.getBinding(arg.name) : undefined;
      const init = binding?.kind === 'const' && binding.constant && binding.path.isVariableDeclarator() &&
        binding.path.get('id').isIdentifier({name: arg.name}) && binding.path.node.end < arg.start
        ? binding.path.node.init : undefined;
      routes.push({method: method.toUpperCase(), path: staticString(arg) ?? staticString(init),
        expression: content.slice(arg.start, arg.end), file: relFile, line: path.node.loc.start.line,
        snippet: content.slice(path.node.start, arg.end)});
    },
  });

  const functions = [...declarations].map(([node, {path, binding, name}]) => {
    const names = [...(exportNames.get(node) ?? [])];
    const stable = !directEval && binding?.constant === true;
    const primitive = names.length > 0 && stable && purePrimitiveFunction(path);
    const propertyTarget = primitive && binding.scope.path.isProgram() && node.end - node.start <= propertyLimits.maxPlanBytes
      ? {code: content.slice(node.start, node.end), arity: node.params.length} : undefined;
    return {name, startLine: node.loc.start.line, isExported: names.length > 0, exportNames: names, stable,
      pure: path.isFunctionDeclaration() && primitive, propertyTarget};
  });
  return {file: relFile, functions, routes};
}

const testNames = new Set(['test', 'it', 'describe', 'xit', 'xtest', 'xdescribe']);
const skipMethods = new Set(['skip', 'fixme', 'todo']);
const validatorPrefix = 'QA-VALIDADOR: ';
const assertionModules = new Set(['node:assert', 'assert', 'node:assert/strict', 'assert/strict']);
export const qaAssertionMethods = ['ok', 'equal', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepEqual',
  'notDeepEqual', 'deepStrictEqual', 'notDeepStrictEqual', 'partialDeepStrictEqual', 'throws',
  'doesNotThrow', 'match', 'doesNotMatch', 'ifError', 'fail'];
const assertionMethods = new Set(qaAssertionMethods);
const binaryAssertions = new Set(qaAssertionMethods.filter(method => /equal$/i.test(method) ||
  method === 'match' || method === 'doesNotMatch'));
const callbackAssertions = new Set(['throws', 'doesNotThrow']);

// Node resolves ESM specifiers as URLs, including percent-encoding and dot segments.
function localImportSource(file, specifier) {
  if (!specifier?.startsWith('./') && !specifier?.startsWith('../')) return;
  const root = '/qa-snapshot/';
  try {
    const path = fileURLToPath(new URL(specifier, pathToFileURL(root + file)));
    if (path.startsWith(root)) return path.slice(root.length);
  } catch {}
}

function importedBinding(path, name) {
  const binding = path.scope.getBinding(name);
  if (binding?.kind !== 'module' || !binding.path.parentPath.isImportDeclaration()) return;
  const specifier = binding.path.node;
  const declaration = binding.path.parentPath.node;
  if (declaration.importKind === 'type' || specifier.importKind === 'type') return;
  return {module: declaration.source.value, name: binding.path.isImportDefaultSpecifier() ? 'default'
    : specifier.imported?.name ?? specifier.imported?.value,
    namespace: binding.path.isImportNamespaceSpecifier()};
}

function callTarget(path) {
  const {callee} = path.node;
  const member = ['MemberExpression', 'OptionalMemberExpression'].includes(callee.type);
  const receiver = member && callee.object.type === 'Identifier' ? callee.object.name : undefined;
  const local = callee.type === 'Identifier' ? callee.name : receiver;
  return {local, receiver, property: receiver && (callee.computed ? staticString(callee.property) : callee.property.name),
    binding: local && importedBinding(path, local), optional: path.isOptionalCallExpression() || callee.type === 'OptionalMemberExpression'};
}

function proofAssertion({receiver, property, binding, optional}) {
  if (!binding || !assertionModules.has(binding.module)) return;
  const root = binding.name === 'strict' || binding.name === 'default';
  if (receiver && (root || binding.namespace) && assertionMethods.has(property)) return {receiver, method: property, optional};
  if (!receiver && (root || assertionMethods.has(binding.name))) return {receiver: 'void 0', method: root ? 'ok' : binding.name, optional};
}

function importedCall(path, file) {
  if (!path?.isCallExpression() && !path?.isOptionalCallExpression()) return;
  const {receiver, property, binding, optional} = callTarget(path);
  const name = receiver ? binding?.namespace && property : binding?.name;
  const source = localImportSource(file, binding?.module);
  if (source && name) return {source, name, receiver, optional};
}

function featureIdentity({source, name}) {
  return JSON.stringify([source, name]);
}

function spreadElements(path) {
  const operand = path.get('argument');
  if (operand.isArrayExpression()) return operand.get('elements');
  if (!operand.isIdentifier()) return;
  const binding = operand.scope.getBinding(operand.node.name);
  if (binding?.kind !== 'const' || !binding.constant || !binding.path.isVariableDeclarator() ||
      binding.path.node.end > operand.node.start || binding.referencePaths.some(ref => ref.node !== operand.node) ||
      !binding.path.get('id').isIdentifier() || !binding.path.get('init').isArrayExpression()) return;
  return binding.path.get('init').get('elements');
}

function assertionFeatures(path, file, {method, optional}) {
  const features = [];
  const limited = [];
  let callback;
  let unknownSpread = false;
  const args = path.get('arguments');
  const takesCallback = callbackAssertions.has(method);
  const arity = binaryAssertions.has(method) ? 2 : takesCallback || ['ok', 'ifError'].includes(method) ? 1 : 0;
  const spread = args.findIndex(arg => arg.isSpreadElement());
  const variableArity = spread >= 0 && spread < arity;
  function inspect(arg, uncertain) {
    if (arg.isSpreadElement()) {
      const elements = spreadElements(arg);
      if (elements) elements.forEach(element => inspect(element, true));
      else unknownSpread = true;
      return;
    }
    const callPath = takesCallback ? onlyExpression(arg) : arg.isAwaitExpression() ? arg.get('argument') : arg;
    const call = importedCall(callPath, file);
    if (!call) return;
    const identity = featureIdentity(call);
    if (uncertain || optional || call.optional) limited.push(identity);
    else if (takesCallback) callback = {arg, callPath, identity};
    else features.push(identity);
  }
  for (const [index, arg] of args.entries()) {
    const uncertain = variableArity && index >= spread;
    if (index >= arity && !uncertain) break;
    inspect(arg, uncertain);
  }
  return {features, callback, limited, unknownSpread};
}

/** Instrumenta chamadas diretas no callback registrado com node:test, preservando as linhas. */
export function instrumentTestAssertions(file, content, {parse, traverse}) {
  const ast = parseFile(file, content, parse, {tokens: true});
  const trailingCommas = new Set();
  let previous;
  for (const token of ast.tokens) {
    const label = token.type.label;
    if (!label) continue; // Comentários não alteram a pontuação dos argumentos.
    if (label === ')' && previous === ',') trailingCommas.add(token.start);
    previous = label;
  }
  const sites = new Map();
  const edits = [];
  let prefix = '__qaAssertion';
  while (content.includes(prefix)) prefix += '_';
  const wrapCallback = `${prefix}Callback`;
  const markTarget = `${prefix}Invoked`;
  let index = 0;
  function wrap(node, before, after) {
    edits.push({offset: node.start, loc: node.loc.start, text: before},
      {offset: node.end, loc: node.loc.end, text: after});
  }
  traverse(ast, {
    CallExpression(path) {
      const owner = path.getFunctionParent();
      const registration = owner?.parentPath;
      if (!registration?.isCallExpression()) return;
      const test = testCall(registration);
      if (!test?.nodeRunner || test.optional || test.suite || test.skipped || test.callback !== owner.node) return;
      const accepted = proofAssertion(callTarget(path));
      if (!accepted || accepted.optional) return;
      const probe = `${prefix}${index++}`;
      const site = sites.get(registration.node) ?? {title: test.title, probes: []};
      const {features, callback} = assertionFeatures(path, file, accepted);
      const completed = `${probe}Completed`;
      const failed = `${probe}Failed`;
      const callbackCompleted = callback ? `${probe}TargetCompleted` : undefined;
      const callbackFailed = callback ? `${probe}TargetFailed` : undefined;
      site.probes.push({completed, failed, features, callback: callback?.identity, callbackCompleted, callbackFailed});
      sites.set(registration.node, site);
      const markers = [completed, failed, callbackCompleted, callbackFailed].filter(Boolean).map(name => `function ${name}() {}`);
      wrap(path.node.callee, `${prefix}(`, `, ${accepted.receiver}, ${JSON.stringify(accepted.method)}, ${markers.join(', ')})`);
      if (callback) {
        wrap(callback.arg.node, `${wrapCallback}(${markTarget} => (`, '))');
        const target = callback.callPath.node;
        const offset = target.end - 1;
        const loc = {line: target.loc.end.line, column: target.loc.end.column - 1};
        const separator = target.arguments.length && !trailingCommas.has(offset) ? ', ' : '';
        // A expansão vazia marca o despacho após os argumentos e mantém a chamada no callback.
        edits.push({offset, loc, text: `${separator}...${markTarget}()`});
      }
    },
  });
  const proofs = [...sites].map(([node, site]) => {
    const {line, column} = node.loc.start;
    return {...site, file, line, column: column + 1};
  });
  if (!edits.length) return {content, proofs};
  let cursor = 0;
  const chunks = [];
  const editLines = new Map();
  for (const edit of edits.sort((a, b) => a.offset - b.offset)) {
    chunks.push(content.slice(cursor, edit.offset), edit.text);
    cursor = edit.offset;
    const line = editLines.get(edit.loc.line) ?? [];
    line.push(edit);
    editLines.set(edit.loc.line, line);
  }
  const preload = posix.relative(posix.dirname(file), '.qa-v8-probe.mjs');
  const specifier = preload.startsWith('../') ? preload : `./${preload}`;
  chunks.push(content.slice(cursor), `\nimport {captureAssertion as ${prefix}, captureAssertionCallback as ${wrapCallback}} from ${JSON.stringify(specifier)};\n`);
  return {content: chunks.join(''), proofs, originalColumn(line, column) {
    let shift = 0;
    for (const edit of editLines.get(line) ?? []) {
      if (edit.loc.column + shift >= column) break;
      shift += edit.text.length;
    }
    return column - shift;
  }};
}

function testCall(path, {local, receiver, property, binding, optional} = callTarget(path)) {
  const {arguments: args} = path.node;
  const nodeRunner = binding?.module === 'node:test' && ['test', 'it', 'describe', 'default'].includes(binding.name);
  const playwright = binding?.module === '@playwright/test' && binding.name === 'test';
  if (!nodeRunner && !playwright && local && path.scope.getBinding(local) && !binding) return;
  const name = nodeRunner ? (binding.name === 'default' ? 'test' : binding.name) : playwright ? 'test' : local;
  if (!testNames.has(name) || (receiver && !skipMethods.has(property) && property !== 'only')) return;
  const title = args[0]?.type === 'StringLiteral' ? args[0].value
    : args[0]?.type === 'TemplateLiteral' && !args[0].expressions.length ? args[0].quasis[0].value.cooked : undefined;
  if (title === undefined) return;
  const callback = args.find(arg => ['ArrowFunctionExpression', 'FunctionExpression'].includes(arg.type));
  const options = args.find(arg => arg.type === 'ObjectExpression');
  const skipOption = options?.properties.some(prop => prop.type === 'ObjectProperty' && !prop.computed &&
    ['skip', 'todo'].includes(prop.key.name ?? prop.key.value) &&
    ((prop.value.type === 'BooleanLiteral' && prop.value.value) ||
      (prop.value.type === 'StringLiteral' && prop.value.value.length > 0)));
  const skipped = name.startsWith('x') || skipMethods.has(property) || skipOption;
  return {title, callback, skipped, suite: name === 'describe' || name === 'xdescribe', nodeRunner, optional};
}

function onlyExpression(callback) {
  if (!callback?.isFunctionExpression() && !callback?.isArrowFunctionExpression()) return;
  if (callback.node.async || callback.node.generator || callback.node.params.length) return;
  const body = callback.get('body');
  if (!body.isBlockStatement()) return body;
  const statements = body.get('body');
  if (statements.length === 1 && statements[0].isExpressionStatement()) return statements[0].get('expression');
  if (statements.length === 1 && statements[0].isReturnStatement()) return statements[0].get('argument');
}

function literal(node) {
  return ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral'].includes(node?.type) ||
    (node?.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral');
}

// Declaração de caso de borda como uma asserção direta de node:test sobre uma importação local.
function declaredValidator(registration, test, file) {
  if (!test.title.startsWith(validatorPrefix) || !test.nodeRunner || test.optional ||
      !registration.parentPath.isExpressionStatement() || !registration.parentPath.parentPath.isProgram()) return;
  const assertion = onlyExpression(registration.get('arguments').find(arg => arg.node === test.callback));
  if (!assertion?.isCallExpression()) return;
  const accepted = proofAssertion(callTarget(assertion));
  if (!accepted || accepted.optional) return;
  const args = assertion.get('arguments');
  const {method} = accepted;
  const call = method === 'throws' && args.length === 1 ? onlyExpression(args[0])
    : ['equal', 'strictEqual'].includes(method) && args.length === 2 && literal(args[1].node) ? args[0] : undefined;
  const imported = importedCall(call, file);
  if (imported && !imported.optional && call.node.arguments.every(literal)) return imported;
}

function fastCheckMethod({receiver, property, binding, optional}) {
  if (optional || binding?.module !== 'fast-check') return;
  if (!receiver) return binding.name;
  if (binding.namespace || binding.name === 'default') return property;
}

function integerOptions(path, defaults, bounds) {
  if (!path) return defaults;
  if (!path.isObjectExpression()) return;
  const values = {...defaults};
  const keys = new Set();
  for (const entry of path.node.properties) {
    if (entry.type !== 'ObjectProperty' || entry.computed) return;
    const key = entry.key.name ?? staticString(entry.key);
    if (!Object.hasOwn(bounds, key) || keys.has(key)) return;
    const node = entry.value;
    const value = node.type === 'NumericLiteral' ? node.value
      : node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral'
        ? -node.argument.value : undefined;
    const [min, max] = bounds[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) return;
    values[key] = value;
    keys.add(key);
  }
  return values;
}

// A comparação deve avaliar diretamente a função local com ao menos um argumento gerado.
function propertyComparison(predicate, file, content) {
  if ((!predicate?.isArrowFunctionExpression() && !predicate?.isFunctionExpression()) ||
      predicate.node.async || predicate.node.generator || !predicate.node.params.every(param =>
        param.type === 'Identifier' && !param.optional)) return;
  const body = predicate.get('body');
  let expr = body;
  let returnsValue = true;
  if (body.isBlockStatement()) {
    if (body.node.body.length !== 1) return;
    const [statement] = body.get('body');
    if (statement.isReturnStatement()) expr = statement.get('argument');
    else if (statement.isExpressionStatement()) {
      expr = statement.get('expression');
      returnsValue = false;
    } else return;
  }
  let operator;
  let operands;
  if (returnsValue && expr.isBinaryExpression() &&
      ['===', '!==', '<', '<=', '>', '>='].includes(expr.node.operator)) {
    operator = expr.node.operator;
    operands = [expr.get('left'), expr.get('right')];
  } else if (expr.isCallExpression()) {
    const assertionTarget = callTarget(expr);
    const assertion = proofAssertion(assertionTarget);
    const strictEqual = assertion?.method === 'strictEqual' || (assertion?.method === 'equal' &&
      (assertionTarget.binding.module.endsWith('/strict') || assertionTarget.binding.name === 'strict'));
    if (assertion?.optional || !strictEqual || expr.node.arguments.length !== 2) return;
    operator = 'strictEqual';
    operands = expr.get('arguments');
  } else return;

  const params = predicate.node.params.map(param => param.name);
  let target;
  let generatedReferences = 0;
  function verify(path, allowTarget = false) {
    if (literal(path.node)) return true;
    if (path.isIdentifier() && predicate.node.params.includes(path.scope.getBinding(path.node.name)?.path.node)) {
      generatedReferences++;
      return true;
    }
    if (path.isUnaryExpression()) return primitiveUnary.has(path.node.operator) && verify(path.get('argument'));
    if (path.isBinaryExpression()) return primitiveBinary.has(path.node.operator) &&
      verify(path.get('left')) && verify(path.get('right'));
    if (!allowTarget) return false;
    const imported = importedCall(path, file);
    if (!imported || imported.receiver || imported.optional) return false;
    const local = path.node.callee.name;
    const args = path.get('arguments');
    const before = generatedReferences;
    if (!args.every(arg => verify(arg)) || generatedReferences === before) return false;
    if (target && (target.source !== imported.source || target.name !== imported.name ||
      target.local !== local || target.arity !== args.length)) return false;
    target = {...imported, local, arity: args.length};
    return true;
  }

  if (!operands.every(operand => verify(operand, true)) || !target) return;
  return {operator, params, target, operands: operands.map(({node}) => content.slice(node.start, node.end))};
}

function declaredJsProperty(path, file, content) {
  const callback = path.getFunctionParent();
  const registration = callback?.parentPath;
  if (!registration?.isCallExpression() || !registration.parentPath.isExpressionStatement() ||
      !registration.parentPath.parentPath.isProgram()) return;
  const registrationTarget = callTarget(registration);
  const test = testCall(registration, registrationTarget);
  if (!test?.nodeRunner || registrationTarget.receiver || test.optional || test.suite || test.skipped || registration.node.arguments.length !== 2 ||
      registration.node.arguments[1] !== callback.node || onlyExpression(callback)?.node !== path.node) return;
  const [property, options] = path.get('arguments');
  if (!property?.isCallExpression() || fastCheckMethod(callTarget(property)) !== 'property' || path.node.arguments.length > 2) return;
  const args = property.get('arguments');
  const predicate = args.pop();
  if (!args.length || args.length > propertyLimits.maxParameters) return;
  const integers = [];
  const {int32, defaultSeed, defaultRuns, maxRuns} = propertyLimits;
  for (const arbitrary of args) {
    if (!arbitrary.isCallExpression() || fastCheckMethod(callTarget(arbitrary)) !== 'integer' ||
        arbitrary.node.arguments.length > 1) return;
    const range = integerOptions(arbitrary.get('arguments')[0], {min: int32[0], max: int32[1]}, {min: int32, max: int32});
    if (!range || range.min >= range.max) return;
    integers.push(range);
  }
  const settings = integerOptions(options, {seed: defaultSeed, numRuns: defaultRuns}, {seed: int32, numRuns: [1, maxRuns]});
  const comparison = propertyComparison(predicate, file, content);
  if (!settings || comparison?.params.length !== integers.length) return;
  const {line, column} = path.node.loc.start;
  return {...comparison, ...settings, integers, file, line, column: column + 1, testLine: registration.node.loc.start.line};
}

function isThrowingGuard(path) {
  const condition = path.find(parent => parent.key === 'test' && parent.parentPath?.isIfStatement());
  if (!condition || condition.getFunctionParent() !== path.getFunctionParent()) return false;
  const {consequent, alternate} = condition.parentPath.node;
  return [consequent, alternate].some(branch => branch?.type === 'ThrowStatement' ||
    (branch?.type === 'BlockStatement' && branch.body.some(statement => statement.type === 'ThrowStatement')));
}

function hasManualCheck(path) {
  if (isThrowingGuard(path)) return true;
  const initializer = path.parentPath.isAwaitExpression() ? path.parentPath : path;
  const declaration = initializer.parentPath;
  if (initializer.key !== 'init' || !declaration.isVariableDeclarator() || !declaration.get('id').isIdentifier()) return false;
  const binding = declaration.scope.getBinding(declaration.node.id.name);
  if (binding?.path !== declaration || !binding.constant) return false;
  const owner = path.getFunctionParent();
  return binding.referencePaths.some(ref => ref.getFunctionParent() === owner && isThrowingGuard(ref));
}

/** Levanta candidatos estáticos sem confundir opções do teste com seu callback. */
export function analyzeTestFile(relFile, content, {parse, traverse}) {
  const ast = parseFile(relFile, content, parse);
  const skippedTests = [];
  const assertionFreeTests = [];
  const flakyPatterns = [];
  const activeTests = [];
  const validators = [];
  const jsProperties = [];
  let validatorDeclarations = 0;
  let jsPropertyDeclarations = 0;
  const byCallback = new Map();

  function record(test, node, kind) {
    const line = node.loc.start.line;
    const snippet = content.slice(node.start, node.start + 140).split('\n')[0];
    skippedTests.push({title: test.title, kind, file: relFile, line, snippet});
  }

  traverse(ast, {
    'CallExpression|OptionalCallExpression'(path) {
      const {node} = path;
      const owner = path.findParent(parent => byCallback.has(parent.node));
      const enclosing = byCallback.get(owner?.node);
      const target = callTarget(path);
      const fastCheck = fastCheckMethod(target);
      if (fastCheck === 'assert' || fastCheck === 'check') {
        jsPropertyDeclarations++;
        const property = fastCheck === 'assert' && declaredJsProperty(path, relFile, content);
        if (property) jsProperties.push(property);
      }
      const test = testCall(path, target);
      if (test) {
        const {title, callback, skipped, suite} = test;
        if (!suite && title.startsWith(validatorPrefix)) validatorDeclarations++;
        if (skipped) record(test, node, 'skip/todo explícito');
        const suppressed = skipped || enclosing?.suppressed;
        const {line, column} = node.loc.start;
        const item = {title, file: relFile, line, column: column + 1};
        const requirements = [...title.matchAll(/\bREQ-\d+\b/g)].map(match => match[0]);
        const candidate = {...item, hasAssertion: false, conditionalSkip: false, features: [], limitedFeatures: [],
          unknownSpread: false, requirements};
        if (callback) byCallback.set(callback, {test, candidate, suppressed});
        if (suite || suppressed) return;
        activeTests.push(candidate);
        const validator = declaredValidator(path, test, relFile);
        if (validator) validators.push({...item, validator});
        return;
      }
      if (!enclosing || enclosing.suppressed || enclosing.test.suite) return;

      const {candidate} = enclosing;
      const imported = importedCall(path, relFile);
      if (imported && hasManualCheck(path)) candidate.limitedFeatures.push(featureIdentity(imported));
      const {local, receiver, property, binding} = target;
      const context = owner.node.params[0]?.name;
      const isTestContext = enclosing.test.nodeRunner && context && receiver === context &&
        path.scope.getBinding(receiver)?.path.node === owner.node.params[0];
      const firstArg = node.arguments[0];
      const playwrightSkip = (binding?.module === '@playwright/test' || (receiver === 'test' && !path.scope.getBinding(receiver))) &&
        ['skip', 'fixme'].includes(property) && !(firstArg?.type === 'BooleanLiteral' && !firstArg.value);
      if (playwrightSkip || (isTestContext && ['skip', 'todo'].includes(property))) {
        candidate.conditionalSkip = true;
        record(candidate, node, 'skip/todo no callback');
      }
      const accepted = proofAssertion(target);
      const otherAssertion = (local === 'assert' || (!receiver && local === 'expect') || (receiver === 'fc' && property === 'assert')) &&
        (!path.scope.getBinding(local) || (binding && !assertionModules.has(binding.module)));
      if (accepted || otherAssertion || fastCheck === 'assert') candidate.hasAssertion = true;
      if (accepted) {
        const {features, callback, limited, unknownSpread} = assertionFeatures(path, relFile, accepted);
        if (callback) features.push(callback.identity);
        const direct = enclosing.test.nodeRunner && !enclosing.test.optional && path.getFunctionParent() === owner;
        candidate.unknownSpread ||= unknownSpread;
        candidate.limitedFeatures.push(...limited, ...(direct ? [] : features));
        if (direct) candidate.features.push(...features);
      }
      if ((receiver === 'Math' && property === 'random') || local === 'waitForTimeout' || property === 'waitForTimeout') {
        flakyPatterns.push({title: candidate.title, file: relFile, line: node.loc.start.line, snippet: content.slice(node.start, node.end)});
      }
    },
  });
  for (const {title, file, line, column, hasAssertion} of activeTests) {
    if (!hasAssertion) assertionFreeTests.push({title, file, line, column, snippet: title});
  }
  return {activeTests, skippedTests, assertionFreeTests, flakyPatterns, validators, validatorDeclarations, jsProperties, jsPropertyDeclarations};
}

function coverageRow(tool, version, status, detail) {
  return {tool: cleanSingleLine(tool, 120), version, status, detail: cleanSingleLine(detail)};
}

function indexRuntimeTests(tests = []) {
  const statuses = new Map();
  for (const test of tests) {
    const identity = testIdentity(test);
    statuses.set(identity, statuses.has(identity) ? undefined : test);
  }
  return candidate => statuses.get(testIdentity({...candidate, name: candidate.title.slice(0, 200)}));
}

const everyPass = (values, accepts) => values?.length === 3 && values.every(accepts);
const completedAssertions = test => everyPass(test?.assertionStatuses, status => status === 'completed');

const identifier = /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;
const codeSpan = /^`([^`]+)`(?!`)/;
const fileQualifier = /^\s+(?:de|from)\s+(?=`)/i;
const referenceSeparator = /^(?:\s*,\s*(?:(?:e|and|além de|bem como|as well as)\s+)?|\s+(?:e|and|além de|bem como|as well as)\s+)(?=`)/i;
const expectedResult = /\b(?:saída|resultado|valor|texto)\s+esperad[oa]\b[^.!?;]*$|\b(?:retornar?|devolver?)(?:\s+(?:o\s+(?:texto|valor|resultado)|a\s+saída))?\s*$/i;

function readTargetList(text) {
  const targets = [];
  let rest = text;
  for (;;) {
    const symbol = codeSpan.exec(rest);
    const target = {name: symbol?.[1] ?? rest, source: undefined, invalid: !symbol || !identifier.test(symbol[1])};
    rest = symbol ? rest.slice(symbol[0].length) : '';
    const qualifier = fileQualifier.exec(rest);
    if (qualifier) {
      rest = rest.slice(qualifier[0].length);
      const file = codeSpan.exec(rest);
      target.source = (file?.[1] ?? rest).replace(/^\.\//, '');
      target.invalid ||= !file || target.source.includes('\\') ||
        target.source.split('/').some(part => !part || part === '.' || part === '..');
      rest = file ? rest.slice(file[0].length) : '';
    }
    targets.push(target);
    const separator = referenceSeparator.exec(rest);
    if (!separator) return {targets, rest};
    rest = rest.slice(separator[0].length);
  }
}

function requirementTargets(body) {
  const spans = /`[^`]+`(?!`)/g;
  const references = [];
  let ambiguousQualified = false;
  let calculationEnd;
  for (let span; (span = spans.exec(body));) {
    const {targets, rest} = readTargetList(body.slice(span.index));
    spans.lastIndex = body.length - rest.length;
    const leading = span.index === 0;
    if (leading && /^[.!?]?$/.test(rest.trim())) return {kind: 'symbols', targets};
    if (!targets.some(target => target.source !== undefined)) continue;
    const prefix = body.slice(0, span.index);
    const startsCalculation = /^calcular\s+com\s+$/i.test(prefix);
    const continuesCalculation = calculationEnd !== undefined &&
      /^\s+e\s+conferir\s+com\s+$/i.test(body.slice(calculationEnd, span.index));
    if (startsCalculation) calculationEnd = spans.lastIndex;
    const parenthesized = prefix.trimEnd().endsWith('(') && rest.trimStart().startsWith(')');
    const expected = parenthesized && expectedResult.test(prefix.trimEnd().slice(0, -1));
    if (!leading && !startsCalculation && !continuesCalculation && (!parenthesized || expected)) {
      ambiguousQualified = true;
      continue;
    }
    references.push(...targets.map(target => target.source === undefined ? {ambiguous: true} : target));
  }
  if (references.length) {
    if (ambiguousQualified) references.push({ambiguous: true});
    return {kind: 'symbols', targets: references};
  }
  const ambiguous = ambiguousQualified || body.startsWith('`') || /\(\s*`/.test(body);
  return {kind: ambiguous ? 'ambiguous' : 'title'};
}

function displayTarget({name, source}) {
  return source === undefined ? name : `${name} (${displayPath(source)})`;
}

export function buildTraceability({workspace, sourceAnalyses, testAnalyses, reqFiles, runtimeTests, incomplete, executionPartial}) {
  const tool = 'qa-matriz-estatica';
  const version = internal;
  const rows = [];
  const findings = [];
  const tests = testAnalyses.flatMap(t => t.activeTests);
  const runtimeOf = indexRuntimeTests(runtimeTests);
  const hasRuntime = Array.isArray(runtimeTests);
  const complete = !incomplete && !executionPartial;
  const unknownSpreads = tests.filter(t => t.unknownSpread);
  const providesEvidence = (t, feature) => {
    const result = runtimeOf(t);
    return everyPass(result?.statuses, status => status === 'passed') && completedAssertions(result) &&
      (!feature || everyPass(result.featurePasses, pass => pass.includes(feature.identity)));
  };
  const mightPass = test => !runtimeOf(test)?.statuses.some(status => status === 'failed' || status === 'skipped' || status === 'todo');
  const runtimeLimited = test => {
    const result = runtimeOf(test);
    return mightPass(test) && (!everyPass(result?.statuses, status => status !== 'absent') ||
      !everyPass(result.assertionStatuses, status => status !== 'unsupported'));
  };
  const describe = (matches, features = []) => [...new Set(matches)].map(t => {
    const result = runtimeOf(t);
    let detail = t.conditionalSkip ? 'skip/todo possível'
      : t.hasAssertion ? 'asserção candidata; execução não medida'
        : t.limitedFeatures.length ? 'verificação candidata fora da instrumentação' : 'asserção estática não identificada';
    if (result) {
      const linked = features.filter(({identity}) => t.features.includes(identity) || t.limitedFeatures.includes(identity));
      const completed = linked.length ? linked.every(({identity, stable}) =>
        stable && everyPass(result.featurePasses, pass => pass.includes(identity))) : completedAssertions(result);
      const failed = linked.length ? linked.some(({identity, stable}) =>
        stable && result.failedFeaturePasses?.some(pass => pass.includes(identity)))
        : result.assertionStatuses?.includes('failed') || result.failedFeaturePasses?.some(pass => pass.length);
      const limited = result.assertionStatuses?.includes('unsupported') ||
        linked.some(({identity, stable}) => !stable || t.limitedFeatures.includes(identity));
      const assertion = linked.length ? 'asserção do alvo' : 'asserção';
      const outcomes = [];
      if (failed) outcomes.push(`${assertion} reprovada em pelo menos uma passada`);
      if (completed) outcomes.push(`${assertion} concluída nas três passadas`);
      if (limited) outcomes.push(`cobertura limitada de ${assertion}`);
      if (!outcomes.length) outcomes.push(`conclusão da ${assertion} não observada em todas as passadas`);
      detail = `${result.statuses.join(',')}, ${outcomes.join(', ')}`;
    }
    return `${displayPath(t.file)}:${t.line} ${t.title} (${detail})`;
  }).join('; ') || 'sem teste vinculado';
  const functions = sourceAnalyses.flatMap(src => src.functions.flatMap(fn => fn.exportNames.map(name => {
    const identity = featureIdentity({source: src.file, name});
    return {file: src.file, name, line: fn.startLine, stable: fn.stable, identity,
      matches: tests.filter(t => t.features.includes(identity)), limited: tests.filter(t => t.limitedFeatures.includes(identity))};
  })));
  for (const fn of functions) {
    rows.push(coverageRow(fileCoverageKey('qa-funcionalidade', fn.file, `:${fn.name}`), version, 'ok',
      `vínculo estático ${abbreviateIdentity(displayPath(fn.file), 240)}:${fn.line} ${fn.name} → ${describe([...fn.matches, ...fn.limited], [fn])}`));
  }

  function evaluateTarget(candidates, feature, qualified) {
    const limited = feature ? [...feature.limited, ...unknownSpreads] : [];
    const supported = !feature || (feature.stable && (qualified || !incomplete));
    if (supported && candidates.some(test => providesEvidence(test, feature))) return 'proved';
    if (complete && hasRuntime && !runtimeTests.length && !tests.length) return 'missing';
    if (!complete || !supported || limited.some(mightPass)) return 'limited';
    if (!hasRuntime) {
      return candidates.some(test => test.hasAssertion && !test.conditionalSkip) ? 'unavailable' : 'no-candidate';
    }
    if ((!runtimeTests.length && tests.length) || candidates.some(runtimeLimited)) return 'limited';
    return 'missing';
  }

  let requirements = 0;
  for (const reqFile of reqFiles) {
    for (const [idx, text] of readFileSync(join(workspace, reqFile), 'utf8').split(/\r?\n/).entries()) {
      const marker = /\bREQ-\d+\b/.exec(text);
      if (!marker) continue;
      requirements++;
      const [id] = marker;
      const body = text.slice(marker.index + id.length).replace(/^\s*:\s*/, '').trim();
      const requirement = requirementTargets(body);
      const resolved = (requirement.targets ?? []).map(ref => ({
        ref, functions: ref.invalid || ref.ambiguous ? [] : functions.filter(fn =>
          fn.name === ref.name && (ref.source === undefined || fn.file === ref.source)),
      }));
      const titled = tests.filter(t => t.requirements.includes(id));
      const byTitle = requirement.kind === 'title';
      const outcomes = byTitle ? [{status: evaluateTarget(titled)}] : resolved.map(({ref, functions}) => {
        const [feature] = functions;
        if (ref.ambiguous) return {status: 'ambiguous'};
        if (functions.length > 1) return {status: 'ambiguous', label: displayTarget(ref)};
        if (!feature) return {status: 'unresolved', label: displayTarget(ref)};
        return {status: evaluateTarget(feature.matches, feature, ref.source !== undefined),
          label: `${feature.name} (${displayPath(feature.file)}:${feature.line})`};
      });
      if (requirement.kind === 'ambiguous') outcomes.push({status: 'ambiguous'});
      const linked = resolved.flatMap(target => target.functions);
      const matches = byTitle ? titled : linked.flatMap(fn => [...fn.matches, ...fn.limited]);
      const missing = outcomes.filter(outcome => outcome.status === 'missing');
      const noCandidate = outcomes.filter(outcome => outcome.status === 'no-candidate');
      const unresolved = outcomes.filter(outcome => outcome.status === 'unresolved');
      const proved = outcomes.every(outcome => outcome.status === 'proved');
      const measured = outcomes.every(outcome => ['proved', 'missing'].includes(outcome.status));
      const status = measured ? 'ok' : 'skipped';
      let verification = 'prova não medida: cobertura limitada';
      if (proved) verification = 'vínculo comprovado nas três passadas';
      else if (measured) verification = runtimeTests.length ? 'vínculo sem prova nas três passadas' : 'inventário completo: nenhum teste encontrado';
      else if (outcomes.some(outcome => outcome.status === 'ambiguous')) verification = 'prova não medida: cobertura limitada por referência ambígua; informe `símbolo` de `arquivo`';
      else if (unresolved.length) verification = 'prova não medida: referência não resolvida';
      else if (noCandidate.length || outcomes.some(outcome => outcome.status === 'unavailable')) verification = 'prova não medida: somente análise estática';
      if (!measured && missing.length) verification += ', com lacuna medida';
      const identifiers = outcomes.map(({label, status}) => status === 'unresolved' ? `${label} sem resolução` : label).filter(Boolean).join(', ');
      const line = idx + 1;
      const context = body ? ` → contexto: ${body}` : '';
      const detail = `vínculo estático ${displayPath(reqFile)}:${line} → ${identifiers || 'sem funcionalidade identificada'} → ${verification} → ${describe(matches, linked)}${context}`;
      rows.push(coverageRow(`qa-requisito:${id}`, version, status, detail));
      if (missing.length) {
        const labels = missing.map(outcome => outcome.label).filter(Boolean);
        const targetDetail = labels.length ? ` para ${labels.join(', ')}` : '';
        const cause = runtimeTests.length ? 'sem teste vinculado aprovado com asserção concluída nas três passadas'
          : 'sem testes no inventário completo';
        findings.push({tool, rule: 'QA-REQUISITO-SEM-PROVA', file: reqFile, line, severity: 'alta',
          message: `Requisito ${id} ${cause}${targetDetail}`, evidence: detail});
      }
      if (noCandidate.length) {
        const labels = noCandidate.map(outcome => outcome.label).filter(Boolean);
        const targetDetail = labels.length ? ` para ${labels.join(', ')}` : '';
        findings.push({tool, rule: 'QA-REQUISITO-SEM-CANDIDATO', file: reqFile, line, severity: 'alta',
          message: `Requisito ${id} sem candidato estático ativo${targetDetail}; execução não medida`, evidence: detail});
      }
    }
  }
  return {
    coverageRow: coverageRow(tool, version, 'ok', `análise estática de ${requirements} requisitos e ${functions.length} identidades de funções exportadas`),
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
    extraRows.push(coverageRow(fileCoverageKey('qa-arquivo', src.file), version, coverage.some(Boolean) ? 'ok' : 'skipped',
      `V8 em três passadas: ${coverage.map(describe).join('; ')}`));
    for (const fn of src.functions.filter(fn => fn.isExported)) {
      const measurements = coverage.map(c => c?.functions.find(f => f.name === fn.name && f.line === fn.startLine));
      if (!measurements.every(f => f?.count === 0)) continue;
      findings.push({tool: suiteTool, rule: 'QA-COBERTURA-FUNCAO-SEM-TESTE', file: src.file, line: fn.startLine,
        severity: 'alta', message: `Função exportada '${fn.exportNames.join(', ')}' sem execução medida pelo V8`,
        evidence: 'contagem V8 da função nas passadas 1, 2 e 3: 0, 0, 0'});
    }
  }
  const stable = tests.every(t => new Set(t.statuses).size === 1);
  return {tests, stable, findings, extraRows};
}

async function runNodeCoverage({context, sourceAnalyses, version, failTool, runtime}) {
  if (failTool === suiteTool) throw new Error('QA_NODE_TEST_FORCED_FAILURE');
  if (context.emptyInventory) runtime.tests = [];
  if (context.reason) return {coverageRow: coverageRow(suiteTool, unmeasured, 'skipped', context.reason)};
  const passes = [];
  for (let index = 0; index < 3; index++) {
    passes.push(await executeNodeSuite(context));
  }
  const result = summarizeNodePasses(passes, sourceAnalyses, version);
  runtime.tests = result.tests;
  const proved = result.tests.filter(completedAssertions).length;
  const unsupported = result.tests.filter(test => test.assertionStatuses.includes('unsupported')).length;
  result.extraRows.push(coverageRow('qa-assercoes-node-test', version, unsupported === result.tests.length ? 'skipped' : 'ok',
    `${proved} testes com node:assert concluído nas três passadas, ${result.tests.length - proved - unsupported} sem conclusão em todas, ${unsupported} com cobertura limitada; somente chamadas síncronas diretas no callback reconhecido`));
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
  const runtimeOf = indexRuntimeTests(runtimeTests);
  const findings = [];
  let pureCases = 0;
  let measured = 0;
  for (const candidate of testAnalyses.flatMap(t => t.validators)) {
    const {validator, file, line, title} = candidate;
    if (!sourceAnalyses.some(src => src.file === validator.source &&
      src.functions.some(fn => fn.pure && fn.exportNames.includes(validator.name)))) continue;
    pureCases++;
    const result = runtimeOf(candidate);
    const statuses = result?.statuses;
    const identity = featureIdentity(validator);
    if (!everyPass(statuses, (status, index) => {
      const passes = status === 'passed' ? result.featurePasses : status === 'failed' ? result.failedFeaturePasses : undefined;
      return passes?.[index]?.includes(identity);
    })) continue;
    measured++;
    if (statuses.includes('failed')) {
      findings.push({tool, rule: 'QA-VALIDADOR-CASO-REPROVADO', file, line, severity: 'alta',
        message: `Caso funcional declarado para '${validator.name}' reprovado pelo node:test`,
        evidence: `${title} nas três passadas: ${statuses.join(', ')}`});
    }
  }
  return {
    coverageRow: coverageRow(tool, internal, measured ? 'ok' : 'skipped',
      `${measured} de ${declaredCount} casos de borda sintéticos declarados medidos nas três passadas; ${findings.length} com reprovação; ${declaredCount - pureCases} sem forma elegível ou pureza demonstrável; ${pureCases - measured} elegíveis sem execução comprovada; somente operações primitivas e vínculos locais`),
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

async function runSwaggerContractTool({workspace, openapiFiles, sourceAnalyses, incomplete, failTool, validatedOpenApi}) {
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
  const extraRows = [];
  const documentedOperations = new Set(); // "METHOD /path"
  let totalSpecOps = 0;
  let invalidSpecs = 0;

  for (const specRel of openapiFiles) {
    const specFull = join(workspace, specRel);
    let parsedSpec;
    try {
      parsedSpec = await SwaggerParser.validate(specFull, {
        resolve: {
          http: false,
          file: {canRead: file => file.url === specFull, read: () => readFileSync(specFull)},
        },
      });
    } catch {
      invalidSpecs++;
      extraRows.push(coverageRow(fileCoverageKey('qa-openapi', specRel), version, 'failed',
        `${displayPath(specRel)}: especificação ilegível, inválida ou com referência fora do escopo`));
      continue;
    }
    extraRows.push(coverageRow(fileCoverageKey('qa-openapi', specRel), version, 'ok',
      `${displayPath(specRel)}: especificação validada`));
    if (validatedOpenApi.size < maxContractDocuments) validatedOpenApi.set(specRel, parsedSpec);

    for (const [routePath, pathItem] of Object.entries(parsedSpec.paths ?? {})) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of httpMethods) {
        const op = pathItem[method];
        if (!op) continue;
        totalSpecOps += 1;
        documentedOperations.add(`${method.toUpperCase()} ${routePath}`);
        const shape = routeShape(routePath, true);
        if (shape !== undefined) documentedOperations.add(`${method.toUpperCase()} ${shape}`);
      }
    }
  }

  let unchecked = 0;
  for (const route of allRoutes) {
    const label = `${route.method} ${route.path ?? route.expression}`;
    const shape = route.path === undefined ? undefined : routeShape(route.path);
    const inContract = shape !== undefined && (documentedOperations.has(label) ||
      documentedOperations.has(`${route.method} ${shape}`));
    const excluded = inContract ? undefined : shape === undefined ? 'sintaxe de rota fora do cruzamento'
      : incomplete ? 'contrato não confirmado no escopo parcial'
        : invalidSpecs ? 'contrato não confirmado com especificação inválida' : undefined;
    if (excluded) unchecked++;
    if (!inContract && !excluded) {
      findings.push({
        tool: openapiFiles.length ? toolName : 'qa-contrato-openapi',
        rule: 'QA-CONTRATO-ROTA-SEM-OPENAPI',
        file: route.file,
        line: route.line,
        severity: 'media',
        message: `Rota '${label}' declarada no codigo nao consta no contrato OpenAPI do projeto`,
        evidence: `rota ${label} em ${displayPath(route.file)}:${route.line} (${route.snippet}) ausente de ${openapiFiles.map(displayPath).join(', ') || 'openapi.json'}`,
      });
    }
    const key = route.path === undefined ? `qa-rota:${label} (${displayPath(route.file)}:${route.line})` : `qa-rota:${label}`;
    extraRows.push(coverageRow(abbreviateIdentity(key, 120), version, excluded ? 'skipped' : 'ok',
      `rota ${label} (${displayPath(route.file)}:${route.line}): ${excluded ??
        (inContract ? 'documentada e validada no contrato OpenAPI' : 'ausente no contrato OpenAPI')}`));
  }

  return {
    coverageRow: coverageRow(openapiFiles.length ? toolName : 'qa-contrato-openapi', version,
      invalidSpecs ? 'failed' : openapiFiles.length || unchecked < allRoutes.length ? 'ok' : 'skipped',
      `${openapiFiles.length - invalidSpecs} especificações validadas, ${invalidSpecs} inválidas ou indisponíveis, ${totalSpecOps} operações do contrato, ${allRoutes.length - unchecked} rotas conferidas e ${unchecked} sem conferência; métodos GET, POST, PUT, PATCH e DELETE`),
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
    const htmlFiles = copiedFiles.filter(f => /\.(?:html|htm)$/i.test(f));
    const openapiFiles = copiedFiles.filter(f => /(?:^|\/)(?:openapi|swagger)\.(?:json|yaml|yml)$/i.test(f));
    const reqFiles = copiedFiles.filter(f => /(?:^|\/)(?:requisitos|requirements)\.md$/i.test(f));

    const sourceAnalyses = [];
    const testAnalyses = [];
    let parserVersion = unmeasured;
    let parserError;
    let omittedTestFiles = 0;
    let omittedSourceFiles = 0;
    if (codeFiles.length) {
      try {
        const syntax = await loadQaSyntax();
        parserVersion = syntax.version;
        for (const file of sourceFiles) {
          try {
            sourceAnalyses.push(analyzeSourceFile(file, readFileSync(join(workspace, file), 'utf8'), syntax));
          } catch {
            omittedSourceFiles++;
          }
        }
        for (const file of testFiles) {
          try {
            testAnalyses.push(analyzeTestFile(file, readFileSync(join(workspace, file), 'utf8'), syntax));
          } catch {
            omittedTestFiles++;
          }
        }
      } catch (error) {
        parserError = error;
        omittedSourceFiles = sourceFiles.length;
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
    const validatedOpenApi = new Map();
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
    if (omittedSourceFiles) {
      coverage.push(coverageRow('qa-sintaxe-fontes', parserVersion, 'skipped',
        `${omittedSourceFiles} arquivos de fonte ilegíveis ou com sintaxe não analisada`));
    }
    const sourcePartial = incomplete || omittedSourceFiles > 0;
    const matrixPartial = sourcePartial || !!parserError || omittedTestFiles > 0;
    const languageCandidates = hasLanguageTestCandidates(copiedFiles);
    context.emptyInventory &&= !matrixPartial && !languageCandidates;
    const executionPartial = context.files?.length < testFiles.length || languageCandidates;
    const measurementPath = file => abbreviateIdentity(displayPath(file), 100);
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
        partial: matrixPartial || executionPartial,
        run: () => buildTraceability({workspace, sourceAnalyses, testAnalyses, reqFiles,
          runtimeTests: runtime.tests, incomplete: matrixPartial, executionPartial}),
      },
      {
        name: 'qa-propriedades-funcionais',
        partial: matrixPartial,
        run: () => measureValidatorCases({sourceAnalyses, testAnalyses, runtimeTests: runtime.tests}),
      },
      {
        name: propertyTool,
        partial: matrixPartial,
        run: () => collectJsProperties({context, sourceAnalyses, testAnalyses, incomplete, parserError, failTool,
          row: coverageRow, key: fileCoverageKey, path: measurementPath, unmeasured}),
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
        name: 'qa-navegador',
        partial: incomplete,
        run: async () => {
          if (!htmlFiles.length) return {coverageRow: coverageRow('qa-navegador', unmeasured, 'skipped', 'nenhum arquivo HTML no snapshot')};
          const {runBrowserQa} = await import('./browser-qa.mjs');
          const {api, version} = await loadTool('axe-core', 'axe.js');
          return runBrowserQa({workspace, copiedFiles, htmlFiles, incomplete,
            inImage: runtimeInstalled,
            allowed: runtimeInstalled ? executionAllowed(repoDir) : process.env.QA_HOST_TEST_MODE === '1',
            axe: {source: (api.default ?? api).source, version}, row: coverageRow, key: fileCoverageKey, unmeasured});
        },
      },
      {
        name: 'qa-contrato-openapi',
        partial: sourcePartial,
        run: () => runSwaggerContractTool({workspace, openapiFiles, sourceAnalyses, incomplete: sourcePartial, failTool, validatedOpenApi}),
      },
      {
        name: bancoLocalTool,
        partial: incomplete,
        run: () => collectQaBancoLocal({repoDir, workspace, copiedFiles, incomplete, row: coverageRow}),
      },
      {
        name: localLoadTool,
        partial: incomplete,
        run: () => runLocalLoadQa({workspace, workRoot, copiedFiles, enabled: executionAllowed(repoDir),
          row: coverageRow, key: fileCoverageKey}),
      },
      ...Object.entries(functionalContractTools).map(([kind, name]) => ({
        name,
        partial: incomplete,
        run: async () => {
          if (failTool === name) throw new Error('QA_FUNCTIONAL_CONTRACT_FORCED_FAILURE');
          try {
            return await runFunctionalContract(kind, {workspace, workRoot, copiedFiles, openapiFiles, validatedOpenApi,
              enabled: executionAllowed(repoDir), row: coverageRow, key: fileCoverageKey, pathLabel: measurementPath});
          } catch {
            throw new Error('QA_FUNCTIONAL_CONTRACT_UNAVAILABLE');
          }
        },
      })),
      ...Object.entries(languageSuites).map(([language, {tool, version}]) => ({
        name: tool,
        version,
        run: () => {
          if (failTool === tool) throw new Error('QA_LANGUAGE_TEST_FORCED_FAILURE');
          return collectLanguageSuite(language, context, copiedFiles, incomplete);
        },
      })),
      ...Object.entries(languageMeasurementTools).map(([kind, {tool, version}]) => ({
        name: tool,
        version,
        run: async () => {
          if (failTool === tool) throw new Error('QA_LANGUAGE_MEASUREMENT_FORCED_FAILURE');
          if (kind === 'properties') {
            const report = await collectPythonProperties(context, copiedFiles, incomplete);
            return publishProperties(report, coverageRow, measurementPath);
          }
          const report = await collectLanguageMutation(kind, context, copiedFiles, incomplete);
          return publishMutation(report, coverageRow, measurementPath);
        },
      })),
    ];

    for (const runner of toolRunners) {
      try {
        const res = await runner.run();
        const scoped = row => runner.partial
          ? {...row, detail: cleanSingleLine(`escopo parcial; ${row.detail}`)}
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
