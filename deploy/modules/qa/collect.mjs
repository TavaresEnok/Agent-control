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
import {dirname, extname, join, posix, relative, resolve, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {
  classifyMutant, comparePasses, executeNodeSuite, executionAllowed, mutationTool, planMutations, runtimeInstalled, selectNodeSuite, suiteTool,
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
  const normalized = rel.split(sep).join(posix.sep).replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) {
    throw new Error(`QA_INVALID_RELATIVE_PATH: ${rel}`);
  }
  return normalized;
}

function loadLockedVersions() {
  const candidates = [
    join(SCRIPT_DIR, 'qa-tools.lock.json'),
    '/opt/qa-tools/qa-tools.lock.json',
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
        const deps = parsed.dependencies ?? {};
        return {
          stryker: deps['@stryker-mutator/instrumenter']?.version ?? '10.1.1',
          fastCheck: deps['fast-check']?.version ?? '4.10.3',
          axe: deps['axe-core']?.version ?? '4.14.1',
          jsdom: deps.jsdom?.version ?? '31.0.1',
          swagger: deps['@apidevtools/swagger-parser']?.version ?? '13.1.0',
          playwrightAudit: '1',
        };
      }
    } catch {
      /* fallback */
    }
  }
  return {
    stryker: '10.1.1',
    fastCheck: '4.10.3',
    axe: '4.14.1',
    jsdom: '31.0.1',
    swagger: '13.1.0',
    playwrightAudit: '1',
  };
}

async function tryImportTool(specifier, EntryRelPath) {
  const roots = [
    process.env.QA_TOOLS_NODE_MODULES,
    '/opt/qa-tools/node_modules',
    join(SCRIPT_DIR, 'node_modules'),
    join(SCRIPT_DIR, '..', '..', '..', 'node_modules'),
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = join(root, specifier, EntryRelPath);
    if (existsSync(candidate)) {
      return import(pathToFileURL(candidate).href);
    }
  }
  return import(specifier);
}

/**
 * Copia apenas arquivos regulares permitidos de repoDir para /tmp/qa-isolated-XXXX/workspace.
 * Ignora subpasta `clean` apenas quando repoDir é a raiz da fixture que também contém `src/`
 * para que a pasta de controle limpo `tests/fixtures/module-qa/clean` possa coexistir sem duplicação.
 */
function copyRepoToIsolatedTmp(repoDir) {
  const resolvedRepo = resolve(repoDir);
  if (!existsSync(resolvedRepo)) {
    throw new Error(`QA_REPO_NOT_FOUND: ${resolvedRepo}`);
  }
  const hasRootSrc = existsSync(join(resolvedRepo, 'src'));
  const hasCleanSubrepo =
    hasRootSrc &&
    existsSync(join(resolvedRepo, 'clean', 'src')) &&
    existsSync(join(resolvedRepo, 'clean', 'tests'));

  const workRoot = mkdtempSync(join(tmpdir(), 'qa-isolated-'));
  chmodSync(workRoot, 0o700);
  const workspace = join(workRoot, 'workspace');
  mkdirSync(workspace, {recursive: true, mode: 0o700});

  const copiedFiles = [];
  let incomplete = false;
  let copiedBytes = 0;

  function walk(currentDir, depth) {
    if (depth > 10 || copiedFiles.length >= MAX_FILES) {
      incomplete = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(currentDir, {withFileTypes: true});
    } catch {
      incomplete = true;
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (copiedFiles.length >= MAX_FILES) {
        incomplete = true;
        break;
      }
      if (entry.name.startsWith('.') && entry.name !== '.eslintrc.json') continue;
      if (FORBIDDEN_FILENAMES.has(entry.name)) continue;

      const fullPath = join(currentDir, entry.name);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || stat.isSocket() || stat.isFIFO() || stat.isBlockDevice() || stat.isCharacterDevice()) {
        continue;
      }
      const rel = normalizeRelPath(relative(resolvedRepo, fullPath));
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (depth === 0 && entry.name === 'clean' && hasCleanSubrepo) continue;
        walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTS.has(ext)) continue;
        if (stat.size > MAX_FILE_BYTES || copiedBytes + stat.size > MAX_SNAPSHOT_BYTES) {
          incomplete = true;
          continue;
        }
        const destPath = join(workspace, rel);
        mkdirSync(dirname(destPath), {recursive: true, mode: 0o700});
        cpSync(fullPath, destPath, {dereference: false});
        chmodSync(destPath, 0o600);
        copiedFiles.push(rel);
        copiedBytes += stat.size;
      }
    }
  }

  try {
    walk(resolvedRepo, 0);
    return {workRoot, workspace, copiedFiles, incomplete};
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

    // Encontra o bloco da função contando chaves
    const braceStart = content.indexOf('{', match.index + match[0].length);
    let body = '';
    if (braceStart !== -1) {
      let depth = 0;
      let i = braceStart;
      for (; i < content.length; i += 1) {
        const ch = content[i];
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            body = content.slice(braceStart, i + 1);
            break;
          }
        }
      }
    }

    // Verifica se a função faz parsing de entrada externa (parseInt/parseFloat/Number/JSON.parse)
    const usesParseInt = /\b(?:parseInt|parseFloat|Number)\s*\(/.test(body);
    const usesJsonParse = /\bJSON\.parse\s*\(/.test(body);
    const hasRegexGuard = /\/[^\n/]+\/\.test\s*\(/.test(body);
    const hasFiniteOrIntegerGuard = /\bNumber\.is(?:Finite|Integer|NaN)\b|\bisNaN\s*\(/.test(body);
    const hasPositiveBoundGuard = /(?:<\s*1|<=\s*0|>=\s*1|>\s*0)/.test(body);
    const hasTryCatch = /\btry\s*\{/.test(body);

    functions.push({
      name,
      startLine,
      isExported,
      parserModel: (usesParseInt || usesJsonParse)
        ? {
            usesParseInt,
            usesJsonParse,
            hasRegexGuard,
            hasFiniteOrIntegerGuard,
            hasPositiveBoundGuard,
            hasTryCatch,
          }
        : null,
    });
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

/**
 * Levanta candidatos estáticos para a matriz e a auditoria de testes.
 */
function analyzeTestFile(relFile, content) {
  const skippedTests = [];
  const assertionFreeTests = [];
  const flakyPatterns = [];
  const activeTests = [];
  const importedFunctions = new Map();
  for (const [, names, path] of content.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const source = posix.normalize(posix.join(posix.dirname(relFile), path));
    for (const item of names.split(',')) {
      const match = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(item.trim());
      if (match) importedFunctions.set(match[2] ?? match[1], {source, name: match[1]});
    }
  }

  // Detecta test.skip / it.skip / describe.skip / test.fixme / xit / xtest / { skip: true } / t.skip
  const skipPatterns = [
    {re: /\b(?:test|it|describe)\s*\.\s*(?:skip|fixme)\s*\(\s*['"`]([^'"`]+)['"`]/g, kind: 'test.skip/fixme'},
    {re: /\b(?:xit|xtest|xdescribe)\s*\(\s*['"`]([^'"`]+)['"`]/g, kind: 'xit/xtest'},
    {re: /\b(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{\s*skip\s*:\s*true\b/g, kind: 'option skip:true'},
    {re: /\bt\.skip\s*\(\s*['"`]?([^'"`)\n]*)/g, kind: 't.skip'},
  ];

  const lines = content.split(/\r?\n/);
  for (const {re, kind} of skipPatterns) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const line = lineOfOffset(content, m.index);
      skippedTests.push({
        title: m[1] || kind,
        kind,
        file: relFile,
        line,
        snippet: lines[line - 1]?.trim() ?? m[0],
      });
    }
  }

  // Detecta blocos de teste ativos: test('titulo', (...) => { ... }) ou it('titulo', ...)
  const testBlockRegex = /\b(?:test|it)\s*(\.\s*(?:skip|fixme))?\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let tm;
  while ((tm = testBlockRegex.exec(content)) !== null) {
    const isSkipped = Boolean(tm[1]);
    const title = tm[2];
    const startLine = lineOfOffset(content, tm.index);
    const afterHeader = content.slice(tm.index + tm[0].length, tm.index + tm[0].length + 80);
    if (/^\s*,\s*\{\s*skip\s*:\s*true\b/.test(afterHeader)) {
      continue;
    }
    const braceIdx = content.indexOf('{', tm.index + tm[0].length);
    let body = '';
    if (braceIdx !== -1) {
      let depth = 0;
      for (let i = braceIdx; i < content.length; i += 1) {
        if (content[i] === '{') depth += 1;
        else if (content[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            body = content.slice(braceIdx, i + 1);
            break;
          }
        }
      }
    }
    if (isSkipped) continue;

    const hasAssertion = /\b(?:assert\b|expect\s*\(|fc\.assert\s*\()/.test(body);
    if (!hasAssertion) {
      assertionFreeTests.push({
        title,
        file: relFile,
        line: startLine,
        snippet: lines[startLine - 1]?.trim() ?? title,
      });
    }

    if (/\bMath\.random\s*\(|\bwaitForTimeout\s*\(/.test(body)) {
      const flakyLine = findLineNumber(content, /Math\.random|waitForTimeout/, startLine);
      flakyPatterns.push({
        title,
        file: relFile,
        line: flakyLine,
        snippet: lines[flakyLine - 1]?.trim() ?? 'Math.random/waitForTimeout',
      });
    }

    const calls = [...body.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)]
      .map(match => importedFunctions.get(match[1])).filter(Boolean);
    const requirements = [...title.matchAll(/\bREQ-\d+\b/g)].map(match => match[0]);
    activeTests.push({title, file: relFile, line: startLine, hasAssertion, calls, requirements});
  }

  return {file: relFile, activeTests, skippedTests, assertionFreeTests, flakyPatterns};
}

function coverageRow(tool, version, status, detail) {
  return {tool, version, status, detail: cleanSingleLine(detail)};
}

function buildTraceability({workspace, sourceAnalyses, testAnalyses, reqFiles, runtimeTests}) {
  const tool = 'qa-matriz-estatica';
  const version = '1';
  const rows = [];
  const findings = [];
  const observed = new Map(runtimeTests.map(t => [JSON.stringify([t.file, t.line, t.name]), t.statuses.join(',')]));
  const tests = testAnalyses.flatMap(t => t.activeTests).filter(t => t.hasAssertion);
  const linked = (file, fn) => tests.filter(t => t.calls.some(call =>
    call.name === fn.name && (call.source === file || call.source === file.slice(0, -extname(file).length))));
  const describe = matches => matches.map(t => {
    const statuses = observed.get(JSON.stringify([t.file, t.line, t.title]));
    return `${t.file}:${t.line} ${t.title} (${statuses ?? 'execução sem vínculo confirmado'})`;
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
      if (matches.length === 0) {
        findings.push({tool, rule: 'QA-REQUISITO-SEM-PROVA', file: reqFile, line, severity: 'alta',
          message: `Requisito ${id} sem vínculo estático com teste que contenha asserção`,
          evidence: `${reqFile}:${line} → ${identifiers || 'sem funcionalidade identificada'} → sem teste vinculado`});
      }
    }
  }
  return {
    coverageRow: coverageRow(tool, version, 'ok', `análise estática de ${requirements} requisitos e ${functions.length} funções exportadas`),
    extraRows: rows,
    findings,
  };
}

function summarizeNodePasses(passes, sourceAnalyses, version) {
  const tests = comparePasses(passes);
  const extraRows = [];
  const findings = [];
  const measured = passes.map(pass => new Map(pass.coverage.map(c => [c.file, c])));
  for (const [index, pass] of passes.entries()) {
    const counts = status => pass.tests.filter(t => t.status === status).length;
    extraRows.push(coverageRow(`qa-passada:${index + 1}`, version, 'ok',
      `node:test ${pass.summary ? 'passou' : 'falhou'}: ${counts('passed')} aprovados, ${counts('failed')} reprovados, ${counts('skipped')} pulados, ${counts('todo')} todo`));
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
  if (context.reason) return {coverageRow: coverageRow(suiteTool, version, 'skipped', context.reason)};
  const passes = [];
  for (let index = 0; index < 3; index++) {
    passes.push(await executeNodeSuite({...context, measure: true}));
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

async function runStrykerMutationTool({context, sourceFiles, version, failTool, runtime}) {
  if (failTool === mutationTool) throw new Error('QA_STRYKER_FORCED_FAILURE');
  if (context.reason) return {coverageRow: coverageRow(mutationTool, version, 'skipped', context.reason)};
  const {Instrumenter} = await tryImportTool('@stryker-mutator/instrumenter', 'dist/src/index.js');
  if (typeof Instrumenter !== 'function') throw new Error('QA_STRYKER_INSTRUMENTER_MISSING');
  if (!runtime.baseline) return {coverageRow: coverageRow(mutationTool, version, 'skipped',
    'mutação requer três passadas estáveis com testes aprovados e sem falhas')};

  const measuredFiles = new Set(runtime.baseline.coverage.map(item => item.file));
  const measuredSources = sourceFiles.filter(file => measuredFiles.has(file));
  const {selected, total} = await planMutations(Instrumenter, measuredSources, file =>
    readFileSync(join(context.workspace, file), 'utf8'));

  if (total === 0) return {coverageRow: coverageRow(mutationTool, version, 'skipped', 'StrykerJS não retornou mutantes EqualityOperator')};
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
      `${selected.length}/${total} mutantes EqualityOperator executados: ${killed} mortos, ${survived} sobreviventes, ${errors} sem classificação por erro`),
    extraRows,
    findings,
  };
}

/**
 * 3. Propriedades e Fuzz de entradas externas com fast-check (seed fixa 20261119).
 */
async function runFastCheckTool({sourceAnalyses, versions, failTool}) {
  const toolName = 'fast-check';
  const version = versions.fastCheck;
  if (failTool === toolName) {
    throw new Error('QA_FASTCHECK_FORCED_FAILURE');
  }

  const fcMod = await tryImportTool('fast-check', 'lib/fast-check.js');
  const fc = fcMod.default ?? fcMod;

  const findings = [];
  let checkedValidators = 0;
  const numRuns = 200;
  const seed = 20261119;

  for (const src of sourceAnalyses) {
    for (const fn of src.functions) {
      if (!fn.parserModel) continue;
      checkedValidators += 1;
      const model = fn.parserModel;

      // Simulador seguro do modelo de guarda AST da função para entradas arbitrárias geradas pelo fast-check
      const checkGuardForInput = rawInput => {
        const str = String(rawInput ?? '');
        if (model.usesParseInt) {
          const isStrictPositiveDigits = /^[1-9]\d{0,3}$/.test(str);
          if (model.hasRegexGuard && model.hasFiniteOrIntegerGuard && model.hasPositiveBoundGuard) {
            return true;
          }
          // Sem guarda completa, entradas vazias, negativas ou não numéricas produzem NaN ou <= 0
          if (!isStrictPositiveDigits) {
            const parsed = Number.parseInt(str, 10);
            if (Number.isNaN(parsed) || parsed <= 0 || String(parsed) !== str.trim()) {
              return false;
            }
          }
        }
        if (model.usesJsonParse && !model.hasTryCatch) {
          try {
            JSON.parse(str);
          } catch {
            return false;
          }
        }
        return true;
      };

      const arb = fc.oneof(fc.string(), fc.constantFrom('', '-1', '0', 'NaN', '15abc'));
      const details = fc.check(fc.property(arb, raw => checkGuardForInput(raw)), {seed, numRuns});
      if (details.failed) {
        const counterexample = JSON.stringify(details.counterexample?.[0] ?? '');
        findings.push({
          tool: toolName,
          rule: 'QA-FASTCHECK-PROPRIEDADE-VIOLADA',
          file: src.file,
          line: fn.startLine,
          severity: 'alta',
          message: `Modelo estático da guarda de '${fn.name}' viola propriedade fast-check`,
          evidence: cleanSingleLine(
            `contraexemplo para o modelo estático encolhido pelo fast-check (seed=${seed}, ${numRuns} entradas): input=${counterexample} viola invariante de validacao`,
          ),
        });
      }
    }
  }

  return {
    coverageRow: {
      tool: toolName,
      version,
      status: 'ok',
      detail: cleanSingleLine(
        `${checkedValidators} modelos estáticos de validadores/parsers verificados com ${numRuns} entradas geradas por propriedade (seed=${seed}); ${findings.length} violacoes`,
      ),
    },
    findings,
  };
}

/**
 * 4. Auditoria de testes Playwright / E2E / unitários (testes pulados pelo healer/autor, sem asserção ou oscilantes).
 */
async function runPlaywrightTestAuditTool({testAnalyses, versions, failTool}) {
  const toolName = 'playwright-test-audit';
  const version = versions.playwrightAudit;
  if (failTool === toolName) {
    throw new Error('QA_PLAYWRIGHT_AUDIT_FORCED_FAILURE');
  }

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
        message: `Marcação estática de teste pulado ('${sk.title}')`,
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
        `${testAnalyses.length} arquivos de teste auditados por análise estática (${totalActive} blocos, ${totalSkipped} marcações de skip, ${totalNoAssert} sem asserção identificada)`,
      ),
    },
    findings,
  };
}

/**
 * 5. Acessibilidade básica de telas com axe-core 4.14.1 (sem executar scripts da página).
 */
async function runAxeCoreTool({workspace, htmlFiles, versions, failTool}) {
  const toolName = 'axe-core';
  const version = versions.axe;
  if (failTool === toolName) {
    throw new Error('QA_AXE_FORCED_FAILURE');
  }

  if (htmlFiles.length === 0) {
    return {
      coverageRow: {
        tool: toolName,
        version,
        status: 'skipped',
        detail: 'nenhum arquivo HTML encontrado no repositorio',
      },
      findings: [],
    };
  }

  const axeMod = await tryImportTool('axe-core', 'axe.js');
  const {JSDOM} = await tryImportTool('jsdom', 'lib/api.js');
  const axeSource = (axeMod.default ?? axeMod).source;
  if (!axeSource || !JSDOM) throw new Error('QA_AXE_TOOL_INCOMPLETE');

  const findings = [];
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
          values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'],
        },
        rules: {
          'color-contrast': {enabled: false},
        },
      });
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
        `${htmlFiles.length} arquivos HTML auditados com regras WCAG 2.2 AA (axe-core); ${findings.length} violacoes encontradas`,
      ),
    },
    findings,
  };
}

/**
 * 6. Contrato de API (OpenAPI 3 via @apidevtools/swagger-parser cruzado com rotas do código).
 */
async function runSwaggerContractTool({workspace, openapiFiles, sourceAnalyses, versions, failTool}) {
  const toolName = 'swagger-parser';
  const version = versions.swagger;
  if (failTool === toolName) {
    throw new Error('QA_SWAGGER_FORCED_FAILURE');
  }

  const allRoutes = sourceAnalyses.flatMap(s => s.routes);
  if (openapiFiles.length === 0 && allRoutes.length === 0) {
    return {
      coverageRow: {
        tool: toolName,
        version,
        status: 'skipped',
        detail: 'nenhuma especificacao OpenAPI nem rota HTTP encontrada no repositorio',
      },
      extraRows: [],
      findings: [],
    };
  }

  const swMod = await tryImportTool('@apidevtools/swagger-parser', 'lib/index.js');
  const SwaggerParser = swMod.default ?? swMod;

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
      }
    }
  }

  const extraRows = [];
  for (const route of allRoutes) {
    const key = `${route.method} ${route.path}`;
    const inContract = documentedOperations.has(key);
    if (!inContract) {
      findings.push({
        tool: toolName,
        rule: 'QA-CONTRATO-ROTA-SEM-OPENAPI',
        file: route.file,
        line: route.line,
        severity: 'media',
        message: `Rota '${key}' declarada no codigo nao consta no contrato OpenAPI do projeto`,
        evidence: cleanSingleLine(`rota ${key} em ${route.file}:${route.line} (${route.snippet}) ausente de ${openapiFiles.join(', ') || 'openapi.json'}`),
      });
    }
    extraRows.push({
      tool: `qa-rota:${key}`,
      version,
      status: 'ok',
      detail: cleanSingleLine(
        `rota ${key} (${route.file}:${route.line}): ${inContract ? 'documentada e validada no contrato OpenAPI' : 'ausente no contrato OpenAPI'}`,
      ),
    });
  }

  return {
    coverageRow: {
      tool: toolName,
      version,
      status: 'ok',
      detail: cleanSingleLine(
        `${openapiFiles.length} especificacao OpenAPI validada (${totalSpecOps} operacoes no contrato, ${allRoutes.length} rotas conferidas no codigo)`,
      ),
    },
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
  const versions = loadLockedVersions();

  const {workRoot, workspace, copiedFiles, incomplete} = copyRepoToIsolatedTmp(repoDir);
  try {
    const codeFiles = copiedFiles.filter(f => /\.(?:[cm]?[jt]s|tsx)$/.test(f) && !/\.d\.[cm]?ts$/.test(f));
    const testFiles = codeFiles.filter(f => /(?:^|\/)(?:test|tests)\//.test(f) ||
      /(?:^|\/|[.-])(?:test|spec)\.(?:[cm]?[jt]s|tsx)$/.test(f));
    const sourceFiles = codeFiles.filter(f => !testFiles.includes(f));
    const htmlFiles = copiedFiles.filter(f => /\.(?:html|htm)$/.test(f));
    const openapiFiles = copiedFiles.filter(f => /(?:^|\/)(?:openapi|swagger)\.(?:json|yaml|yml)$/i.test(f));
    const reqFiles = copiedFiles.filter(f => /(?:^|\/)(?:requisitos|requirements)\.md$/i.test(f));

    const sourceAnalyses = sourceFiles.map(rel => analyzeSourceFile(rel, readFileSync(join(workspace, rel), 'utf8')));
    const testAnalyses = testFiles.map(rel => analyzeTestFile(rel, readFileSync(join(workspace, rel), 'utf8')));

    const coverage = [];
    const extraCoverageRows = [];
    const findings = [];

    const runtime = {tests: [], baseline: null};
    const context = {repoDir, workspace, workRoot};
    let selectionError;
    try {
      const manifest = copiedFiles.includes('package.json') ? JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')) : null;
      const selection = selectNodeSuite({
        manifest, testFiles,
        readTest: file => readFileSync(join(workspace, file), 'utf8'),
        incomplete: incomplete || copiedFiles.some(f => f.endsWith('/package.json')),
      });
      Object.assign(context, selection);
      if (!context.reason && !executionAllowed(repoDir)) {
        if (runtimeInstalled && process.env.QA_HOST_TEST_MODE !== '1') throw new Error('QA_CONTAINER_REQUIRED');
        context.reason = 'execução dinâmica reservada ao contêiner isolado';
      }
    } catch (error) {
      selectionError = error;
    }

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
        version: versions.stryker,
        run: () => {
          if (selectionError) throw selectionError;
          return runStrykerMutationTool({context, sourceFiles, version: versions.stryker, failTool, runtime});
        },
      },
      {
        name: 'qa-matriz-estatica',
        version: '1',
        run: () => buildTraceability({workspace, sourceAnalyses, testAnalyses, reqFiles, runtimeTests: runtime.tests}),
      },
      {
        name: 'fast-check',
        version: versions.fastCheck,
        run: () => runFastCheckTool({sourceAnalyses, versions, failTool}),
      },
      {
        name: 'playwright-test-audit',
        version: versions.playwrightAudit,
        run: () => runPlaywrightTestAuditTool({testAnalyses, versions, failTool}),
      },
      {
        name: 'axe-core',
        version: versions.axe,
        run: () => runAxeCoreTool({workspace, htmlFiles, versions, failTool}),
      },
      {
        name: 'swagger-parser',
        version: versions.swagger,
        run: () => runSwaggerContractTool({workspace, openapiFiles, sourceAnalyses, versions, failTool}),
      },
    ];

    for (const runner of toolRunners) {
      try {
        const res = await runner.run();
        coverage.push(res.coverageRow);
        if (Array.isArray(res.extraRows)) {
          extraCoverageRows.push(...res.extraRows);
        }
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
        coverage.push({
          tool: runner.name,
          version: runner.version,
          status: 'failed',
          detail: cleanSingleLine(`falha na ferramenta ${runner.name}: ${message}`),
        });
      }
    }

    // Carga e falhas ativas (k6) só rodam em homologação com rede dedicada; no coletor offline ficam skipped
    coverage.push({
      tool: 'k6-homologacao',
      version: '0.54.0',
      status: 'skipped',
      detail: 'rede desligada por padrao e sem URL de homologacao declarada; carga ativa nao executada no coletor offline',
    });

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`QA_COLLECTOR_FATAL: ${message}\n`);
    process.exit(1);
  });
}
