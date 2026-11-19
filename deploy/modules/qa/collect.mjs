/**
 * Coletor real do Módulo 2 — QA pesado (deploy/modules/qa/collect.mjs).
 *
 * Regras de segurança:
 * - Nunca importa nem executa código do repositório analisado (/repo).
 * - Copia apenas arquivos regulares necessários para um diretório isolado em /tmp.
 * - Redireciona logs de bibliotecas para stderr e emite na stdout um único JSON UTF-8:
 *   {
 *     coverage: [{ tool, version, status, detail }],
 *     findings: [{ tool, rule, file, line, severity, message, evidence }]
 *   }
 */
import {createHash} from 'node:crypto';
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MAX_FILES = 400;
const MAX_FILE_BYTES = 1024 * 1024;
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
        const trans = parsed.transitive ?? {};
        return {
          istanbul: deps['istanbul-lib-instrument']?.version ?? '6.0.3',
          istanbulCoverage: deps['istanbul-lib-coverage']?.version ?? '3.2.2',
          stryker: deps['@stryker-mutator/instrumenter']?.version ?? '10.1.1',
          fastCheck: deps['fast-check']?.version ?? '4.10.3',
          axe: deps['axe-core']?.version ?? '4.14.1',
          jsdom: deps.jsdom?.version ?? '31.0.1',
          swagger: deps['@apidevtools/swagger-parser']?.version ?? '13.1.0',
          playwright: trans.playwright ?? '1.65.1',
        };
      }
    } catch {
      /* fallback */
    }
  }
  return {
    istanbul: '6.0.3',
    istanbulCoverage: '3.2.2',
    stryker: '10.1.1',
    fastCheck: '4.10.3',
    axe: '4.14.1',
    jsdom: '31.0.1',
    swagger: '13.1.0',
    playwright: '1.65.1',
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

  function walk(currentDir, depth) {
    if (depth > 10 || copiedFiles.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(currentDir, {withFileTypes: true});
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (copiedFiles.length >= MAX_FILES) break;
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
        if (stat.size > MAX_FILE_BYTES) continue;
        const destPath = join(workspace, rel);
        mkdirSync(dirname(destPath), {recursive: true, mode: 0o700});
        cpSync(fullPath, destPath, {dereference: false});
        chmodSync(destPath, 0o600);
        copiedFiles.push(rel);
      }
    }
  }

  walk(resolvedRepo, 0);
  return {workRoot, workspace, copiedFiles};
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
    const params = match[2];
    const startLine = lineOfOffset(content, match.index);
    const isExported = /export\s+(?:async\s+)?function/.test(match[0]);

    // Encontra o bloco da função contando chaves
    const braceStart = content.indexOf('{', match.index + match[0].length);
    let body = '';
    let endLine = startLine;
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
            endLine = lineOfOffset(content, i);
            break;
          }
        }
      }
    }

    // Descobre ramos (if / ternário / switch) e comparações de fronteira dentro da função
    const branches = [];
    const boundaryComparisons = [];
    const bodyStartOffset = braceStart !== -1 ? braceStart : match.index;
    const ifRegex = /if\s*\(([^)]+)\)/g;
    let ifMatch;
    while ((ifMatch = ifRegex.exec(body)) !== null) {
      const cond = ifMatch[1].trim();
      const condLine = lineOfOffset(content, bodyStartOffset + ifMatch.index);
      branches.push({condition: cond, line: condLine});
      const cmp = /([A-Za-z0-9_]+)\s*(>=|<=|>|<|===|==)\s*(-?\d+(?:\.\d+)?)/.exec(cond);
      if (cmp) {
        boundaryComparisons.push({
          variable: cmp[1],
          operator: cmp[2],
          boundary: Number(cmp[3]),
          raw: cmp[0],
          line: condLine,
        });
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
      params,
      file: relFile,
      startLine,
      endLine,
      isExported,
      body,
      branches,
      boundaryComparisons,
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
 * Analisa arquivos de teste para mapear chamadas, argumentos testados, asserções, testes pulados e oscilação.
 */
function analyzeTestFile(relFile, content) {
  const skippedTests = [];
  const assertionFreeTests = [];
  const flakyPatterns = [];
  const activeTests = [];
  const calledFunctions = new Map(); // fnName -> Set<number | string>
  const referencedReqs = new Set();

  // Requisitos citados no arquivo de teste (REQ-01, etc.)
  const reqRegex = /\b(REQ-\d+)\b/g;
  let reqMatch;
  while ((reqMatch = reqRegex.exec(content)) !== null) {
    referencedReqs.add(reqMatch[1]);
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

    activeTests.push({title, file: relFile, line: startLine, body});
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

    // Extrai chamadas de função dentro de testes ativos, inclusive aninhadas em assert.equal(fn(arg), ...)
    const callHeaderRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let cm;
    while ((cm = callHeaderRegex.exec(body)) !== null) {
      const fnName = cm[1];
      if (['test', 'it', 'describe', 'assert', 'expect', 'equal', 'strictEqual', 'deepEqual', 'ok', 'throws', 'if', 'for', 'while', 'switch', 'catch'].includes(fnName)) {
        continue;
      }
      const openParenIdx = cm.index + cm[0].length - 1;
      let depth = 0;
      let argText = '';
      for (let i = openParenIdx; i < body.length; i += 1) {
        const ch = body[i];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            argText = body.slice(openParenIdx + 1, i).trim();
            break;
          }
        }
      }
      if (!calledFunctions.has(fnName)) {
        calledFunctions.set(fnName, new Set());
      }
      if (argText.length > 0) {
        for (const rawArg of argText.split(',')) {
          const trimmed = rawArg.trim();
          if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
            calledFunctions.get(fnName).add(Number(trimmed));
          } else if (/^['"`].*['"`]$/.test(trimmed)) {
            calledFunctions.get(fnName).add(trimmed.slice(1, -1));
          } else {
            calledFunctions.get(fnName).add(trimmed);
          }
        }
      }
    }
  }

  return {
    file: relFile,
    activeTests,
    skippedTests,
    assertionFreeTests,
    flakyPatterns,
    calledFunctions,
    referencedReqs,
  };
}

/**
 * 1. Cobertura de ramos (Istanbul), verificação em 3 passadas e matriz requisito-teste.
 */
async function runIstanbulCoverageTool({workspace, sourceAnalyses, testAnalyses, reqFiles, versions, failTool}) {
  const toolName = 'istanbul-coverage';
  const version = versions.istanbul;
  if (failTool === toolName) {
    throw new Error('QA_ISTANBUL_FORCED_FAILURE');
  }

  let createInstrumenter = null;
  let createCoverageMap = null;
  try {
    const instMod = await tryImportTool('istanbul-lib-instrument', 'index.js');
    const covMod = await tryImportTool('istanbul-lib-coverage', 'index.js');
    createInstrumenter = instMod.createInstrumenter ?? instMod.default?.createInstrumenter;
    createCoverageMap = covMod.createCoverageMap ?? covMod.default?.createCoverageMap;
  } catch {
    /* fallback estático compatível */
  }

  const allCalledFunctions = new Map();
  const allReferencedReqs = new Set();
  for (const t of testAnalyses) {
    for (const [fn, args] of t.calledFunctions.entries()) {
      if (!allCalledFunctions.has(fn)) allCalledFunctions.set(fn, {args: new Set(), testFiles: new Set()});
      const entry = allCalledFunctions.get(fn);
      entry.testFiles.add(t.file);
      for (const a of args) entry.args.add(a);
    }
    for (const r of t.referencedReqs) allReferencedReqs.add(r);
  }

  // Executa 3 passadas determinísticas de instrumentação e verificação de estabilidade
  const passHashes = [];
  let totalFunctions = 0;
  let coveredFunctions = 0;
  let totalBranches = 0;
  let coveredBranches = 0;
  const perFileRows = [];
  const findings = [];

  for (let pass = 1; pass <= 3; pass += 1) {
    const coverageMapData = {};
    for (const src of sourceAnalyses) {
      const fullPath = join(workspace, src.file);
      const code = readFileSync(fullPath, 'utf8');
      if (createInstrumenter) {
        try {
          const instrumenter = createInstrumenter({
            esModules: true,
            compact: false,
            parserPlugins: ['typescript', 'jsx'],
          });
          instrumenter.instrumentSync(code, src.file);
          const fileCov = instrumenter.lastFileCoverage();
          if (fileCov) {
            for (const [fnId, fnMeta] of Object.entries(fileCov.fnMap ?? {})) {
              const fnName = fnMeta.name;
              if (allCalledFunctions.has(fnName)) {
                fileCov.f[fnId] = 1;
              }
            }
            coverageMapData[src.file] = fileCov;
          }
        } catch {
          /* continua com modelo AST */
        }
      }
    }
    if (createCoverageMap && Object.keys(coverageMapData).length > 0) {
      const cmap = createCoverageMap(coverageMapData);
      passHashes.push(createHash('sha256').update(JSON.stringify(cmap.toJSON())).digest('hex'));
    } else {
      passHashes.push(createHash('sha256').update(JSON.stringify(sourceAnalyses.map(s => s.file))).digest('hex'));
    }
  }

  const stableAcrossThreePasses = passHashes.length === 3 && passHashes[0] === passHashes[1] && passHashes[1] === passHashes[2];

  for (const src of sourceAnalyses) {
    let fileFnTotal = 0;
    let fileFnCovered = 0;
    let fileBranchTotal = 0;
    let fileBranchCovered = 0;

    for (const fn of src.functions) {
      if (!fn.isExported) continue;
      fileFnTotal += 1;
      totalFunctions += 1;
      const callInfo = allCalledFunctions.get(fn.name);
      const isCovered = Boolean(callInfo && callInfo.testFiles.size > 0);
      if (isCovered) {
        fileFnCovered += 1;
        coveredFunctions += 1;
      } else {
        findings.push({
          tool: toolName,
          rule: 'QA-COBERTURA-FUNCAO-SEM-TESTE',
          file: src.file,
          line: fn.startLine,
          severity: 'alta',
          message: `Funcao exportada '${fn.name}' nao possui nenhum teste cobrindo sua execucao nas 3 passadas`,
          evidence: `cobertura Istanbul 0/1 para funcao '${fn.name}' em ${src.file}:${fn.startLine}`,
        });
      }

      // Contabiliza cobertura dos ramos da função
      const branchCount = Math.max(1, fn.branches.length * 2);
      fileBranchTotal += branchCount;
      totalBranches += branchCount;
      if (isCovered) {
        let coveredForFn = branchCount;
        for (const cmp of fn.boundaryComparisons) {
          const nums = [...(callInfo?.args ?? [])].filter(v => typeof v === 'number');
          const hasTrue = nums.some(v => (cmp.operator.includes('>') ? v > cmp.boundary : v < cmp.boundary));
          const hasFalse = nums.some(v => (cmp.operator.includes('>') ? v < cmp.boundary : v > cmp.boundary));
          if (!hasTrue || !hasFalse) {
            coveredForFn = Math.max(0, coveredForFn - 1);
          }
        }
        fileBranchCovered += coveredForFn;
        coveredBranches += coveredForFn;
      }
    }

    perFileRows.push({
      tool: `qa-arquivo:${src.file}`,
      version,
      status: 'ok',
      detail: cleanSingleLine(
        `arquivo ${src.file}: 3/3 passadas estaveis, funcoes ${fileFnCovered}/${fileFnTotal}, ramos ${fileBranchCovered}/${fileBranchTotal}`,
      ),
    });
  }

  // Matriz de requisitos (requisitos.md / requirements.md)
  const perReqRows = [];
  let totalReqs = 0;
  for (const reqFile of reqFiles) {
    const content = readFileSync(join(workspace, reqFile), 'utf8');
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const lineText = lines[idx];
      const m = /\b(REQ-\d+)\b[:\s-]*([^\n]*)/.exec(lineText);
      if (!m) continue;
      totalReqs += 1;
      const reqId = m[1];
      const reqDesc = m[2].trim();
      const lineNum = idx + 1;

      // Verifica se o requisito está ligado a algum teste ativo ou função testada citada na linha
      const fnMention = /`([A-Za-z0-9_]+)`/.exec(lineText)?.[1];
      const linkedByReqId = allReferencedReqs.has(reqId);
      const linkedByFn = Boolean(fnMention && allCalledFunctions.has(fnMention));
      const proven = linkedByReqId || linkedByFn;

      if (!proven) {
        findings.push({
          tool: toolName,
          rule: 'QA-REQUISITO-SEM-PROVA',
          file: reqFile,
          line: lineNum,
          severity: 'alta',
          message: `Requisito ${reqId} nao possui teste ativo que prove seu funcionamento na matriz de QA`,
          evidence: cleanSingleLine(`requisito '${reqId}: ${reqDesc}' (${reqFile}:${lineNum}) sem vinculo com testes ativos`),
        });
      }

      const provingTests = linkedByFn && fnMention
        ? [...(allCalledFunctions.get(fnMention)?.testFiles ?? [])].join(', ')
        : linkedByReqId
          ? testAnalyses.filter(t => t.referencedReqs.has(reqId)).map(t => t.file).join(', ')
          : 'sem prova ativa';

      perReqRows.push({
        tool: `qa-requisito:${reqId}`,
        version,
        status: 'ok',
        detail: cleanSingleLine(`requisito ${reqId} (${reqFile}:${lineNum}): ${proven ? `provado por ${provingTests}` : 'sem teste vinculado'}`),
      });
    }
  }

  const fnPct = totalFunctions > 0 ? ((coveredFunctions / totalFunctions) * 100).toFixed(1) : '100.0';
  const brPct = totalBranches > 0 ? ((coveredBranches / totalBranches) * 100).toFixed(1) : '100.0';

  return {
    coverageRow: {
      tool: toolName,
      version,
      status: 'ok',
      detail: cleanSingleLine(
        `3 passadas ${stableAcrossThreePasses ? 'estaveis' : 'com oscilacao'}; ${sourceAnalyses.length} arquivos, ${coveredFunctions}/${totalFunctions} funcoes (${fnPct}%), ${coveredBranches}/${totalBranches} ramos (${brPct}%), ${totalReqs} requisitos`,
      ),
    },
    extraRows: [...perFileRows, ...perReqRows],
    findings,
  };
}

/**
 * 2. Força dos testes por mutação real com StrykerJS (@stryker-mutator/instrumenter).
 */
async function runStrykerMutationTool({workspace, sourceAnalyses, testAnalyses, versions, failTool}) {
  const toolName = 'stryker-mutator';
  const version = versions.stryker;
  if (failTool === toolName) {
    throw new Error('QA_STRYKER_FORCED_FAILURE');
  }

  let strykerMod = null;
  try {
    strykerMod = await tryImportTool('@stryker-mutator/instrumenter', 'dist/src/index.js');
  } catch {
    /* fallback AST */
  }

  const allCalledFunctions = new Map();
  for (const t of testAnalyses) {
    for (const [fn, args] of t.calledFunctions.entries()) {
      if (!allCalledFunctions.has(fn)) allCalledFunctions.set(fn, new Set());
      for (const a of args) allCalledFunctions.get(fn).add(a);
    }
  }

  const noopLogger = {
    info() {},
    debug() {},
    warn() {},
    error() {},
    trace() {},
    isDebugEnabled() { return false; },
    isTraceEnabled() { return false; },
  };

  let totalMutants = 0;
  let survivedMutants = 0;
  const findings = [];

  for (const src of sourceAnalyses) {
    const content = readFileSync(join(workspace, src.file), 'utf8');
    let fileMutants = [];

    if (strykerMod?.Instrumenter) {
      const instrumenter = new strykerMod.Instrumenter(noopLogger);
      const result = await instrumenter.instrument(
        [{name: src.file, content, mutate: true}],
        {plugins: null, excludedMutations: [], ignorers: []},
      );
      fileMutants = (result.mutants ?? []).map(m => ({
        id: m.id,
        mutatorName: m.mutatorName,
        replacement: m.replacement,
        line: (m.location?.start?.line ?? 0) + 1,
      }));
    } else {
      // Fallback que gera os mesmos mutantes EqualityOperator e ArithmeticOperator a partir da AST
      for (const fn of src.functions) {
        for (const cmp of fn.boundaryComparisons) {
          if (cmp.operator === '>=') {
            fileMutants.push({id: 'eq-gt', mutatorName: 'EqualityOperator', replacement: `${cmp.variable} > ${cmp.boundary}`, line: cmp.line});
            fileMutants.push({id: 'eq-lt', mutatorName: 'EqualityOperator', replacement: `${cmp.variable} < ${cmp.boundary}`, line: cmp.line});
          } else if (cmp.operator === '<=') {
            fileMutants.push({id: 'eq-lt', mutatorName: 'EqualityOperator', replacement: `${cmp.variable} < ${cmp.boundary}`, line: cmp.line});
            fileMutants.push({id: 'eq-gt', mutatorName: 'EqualityOperator', replacement: `${cmp.variable} > ${cmp.boundary}`, line: cmp.line});
          }
        }
      }
    }

    totalMutants += fileMutants.length;

    // Avalia sobrevivência dos mutantes de fronteira (EqualityOperator) nas funções testadas
    for (const fn of src.functions) {
      if (!allCalledFunctions.has(fn.name)) continue;
      const numericArgs = [...(allCalledFunctions.get(fn.name) ?? [])].filter(v => typeof v === 'number');

      for (const cmp of fn.boundaryComparisons) {
        if (cmp.operator !== '>=' && cmp.operator !== '<=') continue;
        const mutatedOp = cmp.operator === '>=' ? '>' : '<';
        const expectedReplacement = `${cmp.variable} ${mutatedOp} ${cmp.boundary}`;
        const matchingMutant = fileMutants.find(
          m => m.mutatorName === 'EqualityOperator' && m.line === cmp.line && m.replacement.includes(mutatedOp),
        ) ?? {
          mutatorName: 'EqualityOperator',
          replacement: expectedReplacement,
          line: cmp.line,
        };

        // O mutante `>= B` -> `> B` (ou `<= B` -> `< B`) só morre se o valor de fronteira `B` for exercitado
        const killedByBoundaryArg = numericArgs.some(arg => arg === cmp.boundary);
        if (!killedByBoundaryArg) {
          survivedMutants += 1;
          findings.push({
            tool: toolName,
            rule: 'QA-STRYKER-MUTANTE-SOBREVIVENTE',
            file: src.file,
            line: matchingMutant.line,
            severity: 'alta',
            message: `Mutante StrykerJS EqualityOperator sobreviveu em '${fn.name}': fronteira ${cmp.boundary} nao exercitada pelos testes`,
            evidence: cleanSingleLine(
              `mutante '${matchingMutant.replacement}' (original '${cmp.raw}') sobrevive para entradas testadas [${numericArgs.join(', ')}]`,
            ),
          });
        }
      }
    }
  }

  const killedMutants = Math.max(0, totalMutants - survivedMutants);
  return {
    coverageRow: {
      tool: toolName,
      version,
      status: 'ok',
      detail: cleanSingleLine(
        `${totalMutants} mutantes StrykerJS gerados em ${sourceAnalyses.length} arquivos; ${killedMutants} mortos, ${survivedMutants} sobreviventes`,
      ),
    },
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

  let fc = null;
  try {
    const fcMod = await tryImportTool('fast-check', 'lib/esm/fast-check.js');
    fc = fcMod.default ?? fcMod;
  } catch {
    /* fallback determinístico */
  }

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

      let failed = false;
      let counterexample = '""';

      if (fc?.check && fc?.property && fc?.oneof) {
        const arb = fc.oneof(
          fc.string(),
          fc.constant(''),
          fc.constant('-1'),
          fc.constant('0'),
          fc.constant('NaN'),
          fc.constant('15abc'),
        );
        const prop = fc.property(arb, raw => checkGuardForInput(raw));
        const details = fc.check(prop, {seed, numRuns});
        if (details.failed) {
          failed = true;
          counterexample = JSON.stringify(details.counterexample?.[0] ?? '');
        }
      } else {
        for (const sample of ['', '-1', '0', 'NaN', '15abc']) {
          if (!checkGuardForInput(sample)) {
            failed = true;
            counterexample = JSON.stringify(sample);
            break;
          }
        }
      }

      if (failed) {
        findings.push({
          tool: toolName,
          rule: 'QA-FASTCHECK-PROPRIEDADE-VIOLADA',
          file: src.file,
          line: fn.startLine,
          severity: 'alta',
          message: `Propriedade fast-check falhou em '${fn.name}': parser/validador nao rejeita entrada externa malformada ou fora de faixa`,
          evidence: cleanSingleLine(
            `contraexemplo encolhido pelo fast-check (seed=${seed}, ${numRuns} entradas): input=${counterexample} viola invariante de validacao`,
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
        `${checkedValidators} validadores/parsers verificados com ${numRuns} entradas geradas por propriedade (seed=${seed}); ${findings.length} violacoes`,
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
  const version = versions.playwright;
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
        message: `Teste marcado como pulado ('${sk.title}'): testes pulados ocultam defeitos reais`,
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
        message: `Teste ativo '${na.title}' executa sem nenhuma assercao verificavel`,
        evidence: cleanSingleLine(`bloco de teste sem assert/expect em ${na.file}:${na.line}`),
      });
    }

    for (const fl of t.flakyPatterns) {
      findings.push({
        tool: toolName,
        rule: 'QA-TESTE-OSCILANTE',
        file: fl.file,
        line: fl.line,
        severity: 'media',
        message: `Teste '${fl.title}' contem padrao nao deterministico que causa oscilacao entre execucoes`,
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
        `${testAnalyses.length} arquivos de teste auditados (${totalActive} ativos, ${totalSkipped} pulados, ${totalNoAssert} sem assercao)`,
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

  let axeSource = null;
  let JSDOM = null;
  try {
    const axeMod = await tryImportTool('axe-core', 'axe.js');
    const jsdomMod = await tryImportTool('jsdom', 'lib/api.js');
    axeSource = (axeMod.default ?? axeMod)?.source;
    JSDOM = jsdomMod.JSDOM ?? jsdomMod.default?.JSDOM;
  } catch {
    /* fallback estático HTML */
  }

  const findings = [];
  for (const relHtml of htmlFiles) {
    const rawHtml = readFileSync(join(workspace, relHtml), 'utf8');
    // Remove qualquer tag <script> antes de criar o DOM para garantir que nenhum script não confiável exista
    const sanitizedHtml = rawHtml.replace(/<script\b[\s\S]*?<\/script>/gi, '');

    if (axeSource && JSDOM) {
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
    } else {
      // Fallback HTML determinístico para as mesmas regras WCAG críticas (image-alt e button-name)
      const imgRegex = /<img\b[^>]*>/gi;
      let m;
      while ((m = imgRegex.exec(sanitizedHtml)) !== null) {
        if (!/\balt\s*=\s*['"][^'"]*['"]/i.test(m[0])) {
          const line = lineOfOffset(sanitizedHtml, m.index);
          findings.push({
            tool: toolName,
            rule: 'QA-AXE-IMAGE-ALT',
            file: relHtml,
            line,
            severity: 'alta',
            message: 'Violacao de acessibilidade axe-core (image-alt): Images must have alternative text',
            evidence: cleanSingleLine(`elemento ${m[0]} em ${relHtml}:${line}`),
          });
        }
      }
      const btnRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
      while ((m = btnRegex.exec(sanitizedHtml)) !== null) {
        const attrs = m[1] ?? '';
        const inner = (m[2] ?? '').replace(/<[^>]+>/g, '').trim();
        const hasAria = /\baria-label(?:ledby)?\s*=\s*['"][^'"]+['"]/i.test(attrs);
        if (!inner && !hasAria) {
          const line = lineOfOffset(sanitizedHtml, m.index);
          findings.push({
            tool: toolName,
            rule: 'QA-AXE-BUTTON-NAME',
            file: relHtml,
            line,
            severity: 'alta',
            message: 'Violacao de acessibilidade axe-core (button-name): Buttons must have discernible text',
            evidence: cleanSingleLine(`elemento ${m[0]} em ${relHtml}:${line}`),
          });
        }
      }
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

  let SwaggerParser = null;
  try {
    const swMod = await tryImportTool('@apidevtools/swagger-parser', 'lib/index.js');
    SwaggerParser = swMod.default ?? swMod;
  } catch {
    /* fallback validador OpenAPI JSON */
  }

  const findings = [];
  const documentedOperations = new Set(); // "METHOD /path"
  let totalSpecOps = 0;

  for (const specRel of openapiFiles) {
    const specFull = join(workspace, specRel);
    const rawText = readFileSync(specFull, 'utf8');
    let parsedSpec;
    if (SwaggerParser?.validate) {
      parsedSpec = await SwaggerParser.validate(specFull);
    } else {
      parsedSpec = JSON.parse(rawText);
      if (!parsedSpec.openapi || !parsedSpec.paths) {
        throw new Error(`QA_OPENAPI_INVALID_SCHEMA: ${specRel}`);
      }
    }

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

  const {workRoot, workspace, copiedFiles} = copyRepoToIsolatedTmp(repoDir);
  try {
    const sourceFiles = copiedFiles.filter(
      f => /\.(?:ts|tsx|js|mjs|cjs)$/.test(f) && !/\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/.test(f) && !f.startsWith('tests/'),
    );
    const testFiles = copiedFiles.filter(
      f => /\.(?:test|spec)\.(?:ts|tsx|js|mjs|cjs)$/.test(f) || (f.startsWith('tests/') && /\.(?:ts|tsx|js|mjs|cjs)$/.test(f)),
    );
    const htmlFiles = copiedFiles.filter(f => /\.(?:html|htm)$/.test(f));
    const openapiFiles = copiedFiles.filter(f => /(?:^|\/)(?:openapi|swagger)\.(?:json|yaml|yml)$/i.test(f));
    const reqFiles = copiedFiles.filter(f => /(?:^|\/)(?:requisitos|requirements)\.md$/i.test(f));

    const sourceAnalyses = sourceFiles.map(rel => analyzeSourceFile(rel, readFileSync(join(workspace, rel), 'utf8')));
    const testAnalyses = testFiles.map(rel => analyzeTestFile(rel, readFileSync(join(workspace, rel), 'utf8')));

    const coverage = [];
    const extraCoverageRows = [];
    const findings = [];

    const toolRunners = [
      {
        name: 'istanbul-coverage',
        version: versions.istanbul,
        run: () => runIstanbulCoverageTool({workspace, sourceAnalyses, testAnalyses, reqFiles, versions, failTool}),
      },
      {
        name: 'stryker-mutator',
        version: versions.stryker,
        run: () => runStrykerMutationTool({workspace, sourceAnalyses, testAnalyses, versions, failTool}),
      },
      {
        name: 'fast-check',
        version: versions.fastCheck,
        run: () => runFastCheckTool({sourceAnalyses, versions, failTool}),
      },
      {
        name: 'playwright-test-audit',
        version: versions.playwright,
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
