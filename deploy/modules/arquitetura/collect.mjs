/**
 * Coletor do módulo 3 — Arquitetura e dívida técnica.
 * Executa exclusivamente análise estática (knip, jscpd, dependency-cruiser, AST TypeScript)
 * sobre uma cópia isolada em /tmp, sem importar ou executar código/configurações do repositório.
 */
import {spawnSync} from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from 'node:fs';
import {dirname, extname, join, posix, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';

const require = createRequire(import.meta.url);

const MAX_COPY_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PER_FILE_COVERAGE = 500;
const TOOL_TIMEOUT_MS = 180_000;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

const JS_TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const DEFAULT_THRESHOLDS = Object.freeze({
  jscpdMinLines: 8,
  jscpdMinTokens: 40,
  fnCyclomaticMedia: 13,
  fnCyclomaticAlta: 20,
  fnNestingMedia: 5,
  fnNestingAlta: 6,
  fileLocMedia: 300,
  fileLocAlta: 600,
  fileCyclomaticMedia: 35,
  fileCyclomaticAlta: 60,
  jscpdComplexityMedia: 25,
  jscpdComplexityAlta: 50,
});

function toPosix(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

export function normalizeRepoPath(filePath, repoRoot) {
  let rel = String(filePath ?? '').trim();
  if (!rel) return '.';
  if (repoRoot) {
    const posixRoot = toPosix(resolve(repoRoot)).replace(/\/+$/, '');
    const posixVal = toPosix(rel);
    if (posixVal === posixRoot) return '.';
    if (posixVal.startsWith(posixRoot + '/')) {
      rel = posixVal.slice(posixRoot.length + 1);
    }
  }
  rel = toPosix(rel).replace(/^\.\/+/, '').replace(/^\/+/, '');
  const normalized = posix.normalize(rel);
  if (!normalized || normalized === '.' || normalized.startsWith('..')) {
    return '.';
  }
  return normalized;
}

export function clampLine(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 1) return 1;
  return Math.trunc(num);
}

function readPackageVersion(pkgName, toolsRoot) {
  const roots = [toolsRoot, '/opt/arquitetura-tools', dirname(import.meta.url.replace(/^file:\/\//, ''))];
  for (const base of roots) {
    if (!base) continue;
    const candidate = join(base, 'node_modules', pkgName, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      /* próximo */
    }
  }
  return 'desconhecida';
}

function resolveBin(name, toolsRoot) {
  const candidates = [
    toolsRoot ? join(toolsRoot, 'node_modules', '.bin', name) : '',
    `/opt/arquitetura-tools/node_modules/.bin/${name}`,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

// Abre o arquivo de origem sem seguir um link trocado após o lstat. A cópia é
// privada e gravável pelo coletor, independentemente do modo da origem.
function copyPrivateFile(srcPath, destPath, maxFileBytes) {
  const source = openSync(srcPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const st = fstatSync(source);
    if (!st.isFile() || st.size > maxFileBytes) {
      const err = new Error('arquivo alterado durante a cópia');
      err.code = 'EINVAL';
      throw err;
    }
    const dest = openSync(destPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      let bytes;
      while ((bytes = readSync(source, buffer, 0, buffer.length, null)) > 0) {
        total += bytes;
        if (total > maxFileBytes) {
          const err = new Error('arquivo cresceu durante a cópia');
          err.code = 'EFBIG';
          throw err;
        }
        let offset = 0;
        while (offset < bytes) offset += writeSync(dest, buffer, offset, bytes - offset);
      }
    } finally {
      closeSync(dest);
    }
  } finally {
    closeSync(source);
  }
}

/**
 * Copia apenas arquivos regulares e diretórios seguros de sourceRoot para destRoot,
 * ignorando symlinks, sockets, dispositivos, diretórios de build/vendor e arquivos > 2 MiB.
 */
export function copyRepoSafely(sourceRoot, destRoot, opts = {}) {
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error(`Diretório do repositório inválido: ${sourceRoot}`);
  }
  try {
    accessSync(sourceRoot, fsConstants.R_OK | fsConstants.X_OK);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'ERR';
    throw new Error(`ARQUITETURA_REPO_UNREADABLE: raiz do repositório presente porém ilegível (${code}): ${sourceRoot}`);
  }
  const maxFiles = opts.maxFiles ?? MAX_COPY_FILES;
  const maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const copiedFiles = [];
  const skipped = [];
  let stoppedAt;
  let failure;

  function walk(directoryPath, currentRel) {
    let directory;
    try {
      directory = openSync(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      if (currentRel === '') throw new Error(`ARQUITETURA_REPO_UNREADABLE: raiz não acessível (${err.code ?? 'ERR'})`);
      skipped.push({file: currentRel, reason: 'diretorio_ilegivel'});
      return;
    }
    try {
      walkOpened(`/proc/self/fd/${directory}`, currentRel);
    } finally {
      closeSync(directory);
    }
  }

  function walkOpened(currentSrc, currentRel) {
    let entries;
    try {
      entries = readdirSync(currentSrc, {withFileTypes: true});
    } catch (err) {
      if (currentRel === '') {
        throw new Error(`ARQUITETURA_REPO_UNREADABLE: falha ao ler raiz do repositório (${err.code ?? 'ERR'}): ${sourceRoot}`);
      }
      skipped.push({file: currentRel, reason: 'diretorio_ilegivel'});
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const srcPath = join(currentSrc, entry.name);
      const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      if (copiedFiles.length >= maxFiles) {
        stoppedAt = relPath;
        return;
      }
      let st;
      try {
        st = lstatSync(srcPath);
      } catch {
        skipped.push({file: relPath, reason: 'metadados_ilegiveis'});
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped.push({file: relPath, reason: 'diretorio_excluido'});
        } else {
          walk(srcPath, relPath);
          if (stoppedAt || failure) return;
        }
      } else if (!st.isFile()) {
        skipped.push({file: relPath, reason: st.isSymbolicLink() ? 'symlink' : 'arquivo_nao_regular'});
      } else if (st.size > maxFileBytes) {
        skipped.push({file: relPath, reason: 'limite_bytes'});
      } else {
        const destPath = join(destRoot, relPath);
        try {
          mkdirSync(dirname(destPath), {recursive: true});
          copyPrivateFile(srcPath, destPath, maxFileBytes);
        } catch (err) {
          failure = {file: relPath, code: err.code ?? 'ERR'};
          return;
        }
        copiedFiles.push(relPath);
      }
    }
  }

  try {
    mkdirSync(destRoot, {recursive: true});
  } catch (err) {
    return {copiedFiles, skipped, failure: {file: '.', code: err.code ?? 'ERR'}};
  }
  walk(sourceRoot, '');
  return {copiedFiles, skipped, stoppedAt, failure};
}

function collectPackageEntries(pkg) {
  const entries = new Set();
  if (!pkg || typeof pkg !== 'object') return entries;

  const addEntry = val => {
    if (typeof val !== 'string') return;
    const cleaned = val.trim().replace(/^\.\//, '');
    if (!cleaned || cleaned.includes('..') || cleaned.startsWith('/')) return;
    if (JS_TS_EXTS.has(extname(cleaned).toLowerCase())) entries.add(cleaned);
  };

  addEntry(pkg.main);
  addEntry(pkg.module);

  if (typeof pkg.bin === 'string') {
    addEntry(pkg.bin);
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const val of Object.values(pkg.bin)) addEntry(val);
  }

  function walkExports(node) {
    if (typeof node === 'string') addEntry(node);
    else if (Array.isArray(node)) node.forEach(walkExports);
    else if (node && typeof node === 'object') Object.values(node).forEach(walkExports);
  }
  walkExports(pkg.exports);

  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const scriptVal of Object.values(pkg.scripts)) {
      if (typeof scriptVal !== 'string') continue;
      const matches = scriptVal.match(/(?:\.\/)?[A-Za-z0-9_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)\b/g);
      if (matches) {
        for (const match of matches) addEntry(match);
      }
    }
  }
  return entries;
}

export function buildKnipConfig(workRepoDir, repoFiles) {
  const fileSet = new Set(repoFiles);
  const entrySet = new Set();

  if (fileSet.has('package.json')) {
    try {
      const pkgText = readFileSync(join(workRepoDir, 'package.json'), 'utf8').slice(0, 512 * 1024);
      const pkg = JSON.parse(pkgText);
      for (const candidate of collectPackageEntries(pkg)) {
        if (fileSet.has(candidate)) entrySet.add(candidate);
      }
    } catch {
      /* package.json inválido: usa heurística estática de entradas */
    }
  }

  const standardEntryRegex = /^(?:src\/)?(?:index|main|server|app|cli|worker)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  for (const rel of repoFiles) {
    if (standardEntryRegex.test(rel) || /^bin\/[^/]+\.(?:ts|mts|cts|js|mjs|cjs)$/.test(rel)) {
      entrySet.add(rel);
    }
  }

  // Fallback para projetos onde os arquivos ficam só em src/ sem nome padrão de entrada
  const jsTsFiles = repoFiles.filter(f => JS_TS_EXTS.has(extname(f).toLowerCase()));
  if (entrySet.size === 0 && jsTsFiles.length > 0) {
    const nonTest = jsTsFiles.filter(f => !/(^|\/)(tests?|__tests__|fixtures?)\//i.test(f) && !/\.(test|spec)\./i.test(f));
    if (nonTest.includes('src/index.ts')) entrySet.add('src/index.ts');
    else if (nonTest.includes('index.ts')) entrySet.add('index.ts');
  }

  const config = {
    entry: [...entrySet].sort(),
    project: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}'],
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/tests/**',
      '**/test/**',
      '**/__tests__/**',
      '**/fixtures/**',
      '**/fixture/**',
      '**/*.test.*',
      '**/*.spec.*',
      '**/*.d.{ts,mts,cts}',
      '*.config.{js,ts,mjs,cjs,mts,cts}',
      '.dependency-cruiser.{js,cjs,mjs}',
      'knip.{js,ts,mjs,cjs,mts,cts}',
    ],
  };

  return config;
}

function isIgnoredByKnipConfig(relFile) {
  return (
    /(^|\/)(node_modules|dist|build|coverage|\.next)\//i.test(relFile) ||
    /(^|\/)(tests?|__tests__|fixtures?)\//i.test(relFile) ||
    /\.(test|spec)\./i.test(relFile) ||
    /\.d\.(?:ts|mts|cts)$/i.test(relFile) ||
    /^[^/]+\.config\.(?:js|ts|mjs|cjs|mts|cts)$/i.test(relFile) ||
    /^\.dependency-cruiser\.(?:js|cjs|mjs)$/i.test(relFile) ||
    /^knip\.(?:js|ts|mjs|cjs|mts|cts)$/i.test(relFile)
  );
}

function sanitizeTsConfigInWork(workRepoDir, copiedFiles) {
  const snapshotFiles = new Set(copiedFiles.map(file => join(workRepoDir, file)));
  const configs = new Map();
  const ts = require('typescript');

  function sanitize(file) {
    if (configs.has(file)) return configs.get(file);

    const {config, error} = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
    const valid = !error && Boolean(config) && typeof config === 'object' && !Array.isArray(config);
    configs.set(file, valid);
    if (!valid) return false;

    function localExtends(specifier) {
      if (typeof specifier !== 'string') return undefined;
      const normalized = toPosix(specifier);
      if (!/^\.\.?\//.test(normalized)) return undefined;
      const path = resolve(dirname(file), normalized);
      const target = snapshotFiles.has(path) ? path
        : !path.endsWith('.json') && snapshotFiles.has(path + '.json') ? path + '.json'
        : undefined;
      return target !== undefined && sanitize(target) ? normalized : undefined;
    }

    if (Array.isArray(config.extends)) {
      config.extends = config.extends.map(localExtends).filter(value => value !== undefined);
      if (config.extends.length === 0) delete config.extends;
    } else if ('extends' in config) {
      const local = localExtends(config.extends);
      if (local === undefined) delete config.extends;
      else config.extends = local;
    }
    writeFileSync(file, JSON.stringify(config, null, 2));
    return true;
  }

  const tsConfigPath = join(workRepoDir, 'tsconfig.json');
  return snapshotFiles.has(tsConfigPath) && sanitize(tsConfigPath);
}

function createSourceFile(ts, file, content) {
  const ext = extname(file).toLowerCase();
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX
    : ext === '.jsx' ? ts.ScriptKind.JSX
    : ['.ts', '.mts', '.cts'].includes(ext) ? ts.ScriptKind.TS
    : ts.ScriptKind.JS;
  return ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
}

function getImportLines(fileText, file) {
  const lines = new Map();
  if (!fileText) return lines;
  const ts = require('typescript');
  const source = createSourceFile(ts, file, fileText);
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(callee) && callee.text === 'require') ||
          (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'require' && callee.name.text === 'resolve')) {
        specifier = node.arguments[0];
      }
    }
    if (specifier && ts.isStringLiteralLike(specifier) && !lines.has(specifier.text)) {
      lines.set(specifier.text, source.getLineAndCharacterOfPosition(specifier.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return lines;
}

export function findImportLine(fileText, moduleSpecifier) {
  return getImportLines(fileText, 'source.tsx').get(moduleSpecifier) ?? 1;
}

export function parseKnipReport(rawJson, repoRoot, candidateFiles) {
  const isCandidate = candidateFiles === undefined
    ? file => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file) && !isIgnoredByKnipConfig(file)
    : file => candidateFiles.has(file);
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  if (!data || typeof data !== 'object' || !Array.isArray(data.issues)) {
    throw new Error('Saída JSON do knip inválida: campo issues ausente');
  }

  const findings = [];
  const fileIssueCounts = new Map();
  const unusedFiles = new Set();
  const entrySet = new Set(data.entryFiles ?? []);
  let unusedExportsCount = 0;
  let unusedDepsCount = 0;

  const bumpFile = file => {
    fileIssueCounts.set(file, (fileIssueCounts.get(file) ?? 0) + 1);
  };

  for (const issue of data.issues) {
    if (!issue || typeof issue !== 'object') continue;
    const relFile = normalizeRepoPath(issue.file, repoRoot);

    if (Array.isArray(issue.files)) {
      for (const f of issue.files) {
        const target = normalizeRepoPath(f?.name ?? relFile, repoRoot);
        if (!isCandidate(target)) continue;
        unusedFiles.add(target);
        bumpFile(target);
        findings.push({
          tool: 'knip',
          rule: 'KNIP-UNUSED-FILE',
          file: target,
          line: 1,
          severity: 'media',
          message: `Arquivo não alcançável a partir das entradas do projeto: ${target}`,
          evidence: `knip files: ${target}`,
        });
      }
    }

    const exportBuckets = [
      ['exports', 'KNIP-UNUSED-EXPORT', 'Exportação não utilizada'],
      ['nsExports', 'KNIP-UNUSED-NS-EXPORT', 'Exportação de namespace não utilizada'],
      ['types', 'KNIP-UNUSED-TYPE', 'Tipo exportado não utilizado'],
      ['nsTypes', 'KNIP-UNUSED-NS-TYPE', 'Tipo de namespace não utilizado'],
      ['enumMembers', 'KNIP-UNUSED-ENUM-MEMBER', 'Membro de enum não utilizado'],
      ['namespaceMembers', 'KNIP-UNUSED-NS-MEMBER', 'Membro de namespace não utilizado'],
      ['duplicates', 'KNIP-DUPLICATE-EXPORT', 'Exportação duplicada'],
    ];

    for (const [key, rule, label] of exportBuckets) {
      if (!isCandidate(relFile)) continue;
      if (!Array.isArray(issue[key])) continue;
      for (const item of issue[key]) {
        const name = String(item?.name ?? 'desconhecido');
        const line = clampLine(item?.line);
        unusedExportsCount += 1;
        bumpFile(relFile);
        findings.push({
          tool: 'knip',
          rule,
          file: relFile,
          line,
          severity: 'baixa',
          message: `${label}: ${name} em ${relFile}`,
          evidence: `${relFile}:${line} símbolo=${name}`,
        });
      }
    }

    const depBuckets = [
      ['dependencies', 'KNIP-UNUSED-DEPENDENCY', 'Dependência declarada não utilizada', 'media'],
      ['devDependencies', 'KNIP-UNUSED-DEV-DEPENDENCY', 'Dependência de desenvolvimento não utilizada', 'baixa'],
      ['optionalPeerDependencies', 'KNIP-UNUSED-PEER-DEPENDENCY', 'Peer dependency opcional não utilizada', 'baixa'],
      ['unlisted', 'KNIP-UNLISTED-DEPENDENCY', 'Dependência importada não declarada no package.json', 'media'],
      ['unresolved', 'KNIP-UNRESOLVED-IMPORT', 'Importação local não resolvida', 'media'],
    ];

    for (const [key, rule, label, severity] of depBuckets) {
      // Problemas de dependências também podem pertencer a um manifesto.
      if (!isCandidate(relFile) && !/(^|\/)package\.json$/i.test(relFile)) continue;
      if (isIgnoredByKnipConfig(relFile)) continue;
      if (!Array.isArray(issue[key])) continue;
      for (const item of issue[key]) {
        const name = String(item?.name ?? 'desconhecido');
        const line = clampLine(item?.line);
        unusedDepsCount += 1;
        bumpFile(relFile);
        findings.push({
          tool: 'knip',
          rule,
          file: relFile,
          line,
          severity,
          message: `${label}: ${name}`,
          evidence: `${relFile}:${line} pacote=${name}`,
        });
      }
    }
  }

  const confirmedFiles = [...new Set([...(data.analyzedFiles ?? []), ...unusedFiles])]
    .filter(isCandidate)
    .sort();
  const perFileCoverage = confirmedFiles.slice(0, MAX_PER_FILE_COVERAGE).map(file => ({
    tool: 'knip:file',
    role: unusedFiles.has(file) ? 'nao_alcancado' : entrySet.has(file) ? 'entrada' : 'modulo',
    issues: fileIssueCounts.get(file) ?? 0,
    file,
  }));

  return {
    findings,
    perFileCoverage,
    stats: {
      totalFiles: confirmedFiles.length,
      entries: confirmedFiles.filter(file => entrySet.has(file)).length,
      unusedFiles: unusedFiles.size,
      unusedExports: unusedExportsCount,
      unusedDeps: unusedDepsCount,
    },
  };
}

export function parseJscpdReport(rawJson, repoRoot, scannedBaseDir) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  if (!data || typeof data !== 'object' || !Array.isArray(data.duplicates)) {
    throw new Error('Saída JSON do jscpd inválida: campo duplicates ausente');
  }

  const findings = [];
  const duplicatedFiles = new Set();

  for (const dup of data.duplicates) {
    if (!dup || typeof dup !== 'object') continue;
    const firstRaw = dup.firstFile?.name ?? '';
    const secondRaw = dup.secondFile?.name ?? '';
    const firstFile = normalizeRepoPath(
      scannedBaseDir ? join(scannedBaseDir, firstRaw) : firstRaw,
      repoRoot,
    );
    const secondFile = normalizeRepoPath(
      scannedBaseDir ? join(scannedBaseDir, secondRaw) : secondRaw,
      repoRoot,
    );
    const startA = clampLine(dup.firstFile?.startLoc?.line ?? dup.firstFile?.start);
    const endA = clampLine(dup.firstFile?.endLoc?.line ?? dup.firstFile?.end);
    const startB = clampLine(dup.secondFile?.startLoc?.line ?? dup.secondFile?.start);
    const endB = clampLine(dup.secondFile?.endLoc?.line ?? dup.secondFile?.end);
    const linesCount = Math.max(1, Number(dup.lines) || (endA - startA + 1));
    const tokensCount = Math.max(1, Number(dup.tokens) || 0);
    const kind = String(dup.kind ?? 'exact');

    duplicatedFiles.add(firstFile);
    duplicatedFiles.add(secondFile);

    const severity = linesCount >= 40 ? 'alta' : 'media';
    const preview = String(dup.fragment ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);

    findings.push({
      tool: 'jscpd',
      rule: 'JSCPD-DUPLICATION',
      file: firstFile,
      line: startA,
      severity,
      message: `Bloco duplicado (${kind}, ${linesCount} linhas, ${tokensCount} tokens) também presente em ${secondFile}:${startB}-${endB}`,
      evidence: `${firstFile}:${startA}-${endA} ~ ${secondFile}:${startB}-${endB}; trecho="${preview}"`,
    });
  }

  const total = data.statistics?.total ?? {};
  return {
    findings,
    duplicatedFiles,
    stats: {
      clones: Number(total.clones ?? findings.length) || 0,
      sources: Number(total.sources ?? 0) || 0,
      lines: Number(total.lines ?? 0) || 0,
      duplicatedLines: Number(total.duplicatedLines ?? 0) || 0,
      percentage: Number(total.percentage ?? 0) || 0,
    },
  };
}

export function parseJscpdComplexityReport(rawJson, repoRoot, scannedBaseDir, coveredAstFiles = new Set()) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  const files = data?.summary?.files;
  if (!Array.isArray(files)) {
    throw new Error('Saída JSON de complexidade do jscpd inválida: summary.files ausente');
  }

  const findings = [];
  const fileMetrics = [];

  for (const item of files) {
    if (!item || typeof item !== 'object') continue;
    const rel = normalizeRepoPath(
      scannedBaseDir ? join(scannedBaseDir, String(item.path ?? '')) : String(item.path ?? ''),
      repoRoot,
    );
    const complexity = Number(item.complexity) || 0;
    const lines = Number(item.lines) || 0;
    const tokens = Number(item.tokens) || 0;
    fileMetrics.push({file: rel, complexity, lines, tokens, format: String(item.format ?? '')});

    if (!coveredAstFiles.has(rel) && complexity >= DEFAULT_THRESHOLDS.jscpdComplexityMedia) {
      const severity = complexity >= DEFAULT_THRESHOLDS.jscpdComplexityAlta ? 'alta' : 'media';
      findings.push({
        tool: 'jscpd',
        rule: 'JSCPD-COMPLEXITY-HIGH',
        file: rel,
        line: 1,
        severity,
        message: `Arquivo com complexidade estrutural elevada (${complexity}) em ${rel}`,
        evidence: `arquivo=${rel}; complexidade=${complexity}; linhas=${lines}; tokens=${tokens}`,
      });
    }
  }

  return {
    findings,
    fileMetrics,
    totalFiles: Number(data?.summary?.totalFiles ?? files.length) || files.length,
  };
}

export function parseDepcruiseReport(rawJson, repoRoot, readSourceFile) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  if (!data || typeof data !== 'object' || !Array.isArray(data.modules)) {
    throw new Error('Saída JSON do dependency-cruiser inválida: campo modules ausente');
  }

  const findings = [];
  const seenKeys = new Set();
  const perFileCoverage = [];
  let cyclesCount = 0;
  let layerViolationsCount = 0;
  let orphansCount = 0;
  let totalDependencies = 0;
  let measuredModules = 0;

  const importCache = new Map();
  const getLines = relFile => {
    if (importCache.has(relFile)) return importCache.get(relFile);
    let text = '';
    if (typeof readSourceFile === 'function') {
      try {
        text = readSourceFile(relFile) ?? '';
      } catch {
        text = '';
      }
    }
    const lines = getImportLines(text, relFile);
    importCache.set(relFile, lines);
    return lines;
  };

  for (const mod of data.modules) {
    if (!mod || typeof mod !== 'object') continue;
    const sourceFile = normalizeRepoPath(mod.source, repoRoot);
    const deps = Array.isArray(mod.dependencies) ? mod.dependencies : [];
    const dependents = Array.isArray(mod.dependents) ? mod.dependents : [];
    totalDependencies += deps.length;

    let fileHasCycle = false;
    let fileHasLayer = false;

    if (Array.isArray(mod.rules)) {
      for (const ruleObj of mod.rules) {
        const ruleName = String(ruleObj?.name ?? '');
        if (ruleName === 'no-orphans') {
          const key = `orphan:${sourceFile}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            orphansCount += 1;
            findings.push({
              tool: 'dependency-cruiser',
              rule: 'DEPCRUISE-NO-ORPHANS',
              file: sourceFile,
              line: 1,
              severity: 'informativa',
              message: `Módulo órfão sem dependentes nem dependências: ${sourceFile}`,
              evidence: `modulo=${sourceFile}; orphan=true`,
            });
          }
        }
      }
    }

    for (const dep of deps) {
      if (!dep || typeof dep !== 'object') continue;
      const rules = Array.isArray(dep.rules) ? dep.rules : [];
      const isCircular = dep.circular || rules.some(rule => rule?.name === 'no-circular');
      const layerRules = rules.filter(rule => typeof rule?.name === 'string' && rule.name.startsWith('layer-'));
      if (!isCircular && layerRules.length === 0) continue;

      const spec = String(dep.module ?? '');
      const resolved = normalizeRepoPath(dep.resolved || spec, repoRoot);
      const line = getLines(sourceFile).get(spec) ?? 1;
      if (isCircular) {
        fileHasCycle = true;
        const key = JSON.stringify(['cycle', sourceFile, resolved === '.' ? spec : resolved]);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cyclesCount += 1;
          const chain = Array.isArray(dep.cycle)
            ? [sourceFile, ...dep.cycle.map(c => normalizeRepoPath(c?.name ?? '', repoRoot))].join(' -> ')
            : `${sourceFile} -> ${resolved}`;
          findings.push({
            tool: 'dependency-cruiser',
            rule: 'DEPCRUISE-NO-CIRCULAR',
            file: sourceFile,
            line,
            severity: 'alta',
            message: `Dependência circular detectada a partir de ${sourceFile} para ${resolved}`,
            evidence: `ciclo: ${chain}`,
          });
        }
      }

      for (const {name: ruleName} of layerRules) {
        fileHasLayer = true;
        const ruleId = `DEPCRUISE-${ruleName.toUpperCase()}`;
        const key = JSON.stringify(['layer', sourceFile, resolved, ruleId]);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          layerViolationsCount += 1;
          findings.push({
            tool: 'dependency-cruiser',
            rule: ruleId,
            file: sourceFile,
            line,
            severity: 'alta',
            message: `Violação de camada (${ruleName}): ${sourceFile} importa ${resolved}`,
            evidence: `${sourceFile}:${line} -> ${resolved} (especificador="${spec}", regra=${ruleName})`,
          });
        }
      }
    }

    const isRepoModule = !mod.coreModule && !mod.couldNotResolve && !mod.matchesDoNotFollow;
    if (isRepoModule) {
      measuredModules += 1;
      if (perFileCoverage.length < MAX_PER_FILE_COVERAGE) {
        const instability = typeof mod.instability === 'number' ? mod.instability.toFixed(2) : 'n/a';
        perFileCoverage.push({
          file: sourceFile,
          deps: deps.length,
          dependents: dependents.length,
          instability,
          cycle: fileHasCycle,
          layerViolation: fileHasLayer,
        });
      }
    }
  }

  return {
    findings,
    perFileCoverage,
    stats: {
      totalModules: measuredModules,
      totalDependencies,
      cycles: cyclesCount,
      layerViolations: layerViolationsCount,
      orphans: orphansCount,
    },
  };
}

function analyzeLexicalComplexity(content) {
  const cleaned = content
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g, '""');
  const lines = cleaned.split(/\r?\n/);
  let decisions = 0;
  let maxDepth = 0;
  let braceDepth = 0;
  let fnLine = 1;
  let fnName = 'modulo';
  let foundFn = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fnMatch = /(?:function\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/.exec(line);
    if (!foundFn && fnMatch) {
      foundFn = true;
      fnLine = i + 1;
      fnName = fnMatch[1] || fnMatch[2] || 'funcao';
    }
    const branchMatches = line.match(/\b(?:if|for|while|case|catch)\b|\?\s*[^:]|\&\&|\|\||\?\?/g);
    if (branchMatches) decisions += branchMatches.length;
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    braceDepth = Math.max(0, braceDepth + opens - closes);
    if (braceDepth > maxDepth) maxDepth = braceDepth;
  }
  const controlDepth = Math.max(0, maxDepth - 1);
  return {
    functionsCount: foundFn ? 1 : 0,
    fileCyclomatic: 1 + decisions,
    maxFnCyclomatic: 1 + decisions,
    maxNesting: controlDepth,
    fnLine,
    fnName,
  };
}

/**
 * Analisador estático de complexidade por AST TypeScript (somente parse sintático, sem execução).
 */
export function analyzeAstComplexity(workRepoDir, jsTsFiles, thresholds = DEFAULT_THRESHOLDS, options = {}) {
  const ts = options.ts ?? require('typescript');
  const hasAstApi = Boolean(ts && typeof ts.createSourceFile === 'function');
  if (!hasAstApi && options.requireAstApi) {
    throw new Error('API sintática ts.createSourceFile indisponível');
  }
  const findings = [];
  const perFile = [];
  let maxFileCyclomatic = 0;
  let maxFunctionCyclomatic = 0;
  let maxNesting = 0;
  let complexFunctionsCount = 0;
  let largeFilesCount = 0;

  if (!hasAstApi) {
    for (const relFile of jsTsFiles) {
      if (/(^|\/)(tests?|__tests__|fixtures?)\//i.test(relFile) || /\.(test|spec|d)\./i.test(relFile)) {
        continue;
      }
      let content = '';
      try {
        content = readFileSync(join(workRepoDir, relFile), 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      const loc = lines.filter(l => l.trim().length > 0).length;
      const lex = analyzeLexicalComplexity(content);
      if (lex.fileCyclomatic > maxFileCyclomatic) maxFileCyclomatic = lex.fileCyclomatic;
      if (lex.maxFnCyclomatic > maxFunctionCyclomatic) maxFunctionCyclomatic = lex.maxFnCyclomatic;
      if (lex.maxNesting > maxNesting) maxNesting = lex.maxNesting;
      if (lex.maxFnCyclomatic >= thresholds.fnCyclomaticMedia) {
        complexFunctionsCount += 1;
        findings.push({
          tool: 'ast-complexity',
          rule: 'COMPLEXITY-CYCLOMATIC-HIGH',
          file: relFile,
          line: clampLine(lex.fnLine),
          severity: lex.maxFnCyclomatic >= thresholds.fnCyclomaticAlta ? 'alta' : 'media',
          message: `Função '${lex.fnName}' com complexidade ciclomática alta (${lex.maxFnCyclomatic}, limite ${thresholds.fnCyclomaticMedia})`,
          evidence: `${relFile}:${lex.fnLine} funcao=${lex.fnName}; complexidade_ciclomatica=${lex.maxFnCyclomatic}; profundidade_max=${lex.maxNesting}`,
        });
      }
      if (lex.maxNesting >= thresholds.fnNestingMedia) {
        findings.push({
          tool: 'ast-complexity',
          rule: 'COMPLEXITY-NESTING-DEEP',
          file: relFile,
          line: clampLine(lex.fnLine),
          severity: lex.maxNesting >= thresholds.fnNestingAlta ? 'alta' : 'media',
          message: `Função '${lex.fnName}' com aninhamento excessivo (${lex.maxNesting} níveis, limite ${thresholds.fnNestingMedia})`,
          evidence: `${relFile}:${lex.fnLine} funcao=${lex.fnName}; profundidade_max=${lex.maxNesting}`,
        });
      }
      if (loc >= thresholds.fileLocMedia) {
        largeFilesCount += 1;
        findings.push({
          tool: 'ast-complexity',
          rule: 'COMPLEXITY-FILE-LARGE',
          file: relFile,
          line: 1,
          severity: loc >= thresholds.fileLocAlta ? 'alta' : 'media',
          message: `Arquivo extenso demais (${loc} linhas úteis, limite ${thresholds.fileLocMedia})`,
          evidence: `${relFile}:1 linhas_uteis=${loc}; linhas_totais=${lines.length}; funcoes=${lex.functionsCount}`,
        });
      }
      perFile.push({
        file: relFile,
        loc,
        functions: lex.functionsCount,
        fileCyclomatic: lex.fileCyclomatic,
        maxFnCyclomatic: lex.maxFnCyclomatic,
        maxNesting: lex.maxNesting,
      });
    }
    return {
      findings,
      perFile,
      stats: {
        analyzedFiles: perFile.length,
        maxFileCyclomatic,
        maxFunctionCyclomatic,
        maxNesting,
        complexFunctions: complexFunctionsCount,
        largeFiles: largeFilesCount,
      },
    };
  }

  const isDecisionNode = node => {
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        return true;
      case ts.SyntaxKind.BinaryExpression:
        return (
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        );
      default:
        return false;
    }
  };

  const isNestingNode = node =>
    node.kind === ts.SyntaxKind.IfStatement ||
    node.kind === ts.SyntaxKind.ForStatement ||
    node.kind === ts.SyntaxKind.ForInStatement ||
    node.kind === ts.SyntaxKind.ForOfStatement ||
    node.kind === ts.SyntaxKind.WhileStatement ||
    node.kind === ts.SyntaxKind.DoStatement ||
    node.kind === ts.SyntaxKind.SwitchStatement ||
    node.kind === ts.SyntaxKind.TryStatement;

  const isFunctionLike = node =>
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node);

  const functionNameOf = (node, sourceFile) => {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
    if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    if (ts.isPropertyAssignment(node.parent) && ts.isIdentifier(node.parent.name)) {
      return node.parent.name.text;
    }
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `anonimo@${pos.line + 1}`;
  };

  for (const relFile of jsTsFiles) {
    if (/(^|\/)(tests?|__tests__|fixtures?)\//i.test(relFile) || /\.(test|spec|d)\./i.test(relFile)) {
      continue;
    }
    const fullPath = join(workRepoDir, relFile);
    let content = '';
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const loc = lines.filter(l => l.trim().length > 0).length;
    const sourceFile = createSourceFile(ts, relFile, content);

    let fileTotalDecisions = 0;
    let fileMaxNesting = 0;
    let fileMaxFnCyclomatic = 1;
    let functionsCount = 0;

    function measureFunction(fnNode) {
      functionsCount += 1;
      let complexity = 1;
      let deepest = 0;

      function visitBody(node, depth) {
        if (node !== fnNode && isFunctionLike(node)) {
          // Funções aninhadas são medidas separadamente para não inflar duplamente
          measureFunction(node);
          return;
        }
        let nextDepth = depth;
        if (isDecisionNode(node)) {
          complexity += 1;
          fileTotalDecisions += 1;
        }
        if (isNestingNode(node)) {
          const isElseIf =
            node.kind === ts.SyntaxKind.IfStatement &&
            node.parent &&
            node.parent.kind === ts.SyntaxKind.IfStatement &&
            node.parent.elseStatement === node;
          if (!isElseIf) {
            nextDepth = depth + 1;
            if (nextDepth > deepest) deepest = nextDepth;
          }
        }
        ts.forEachChild(node, child => visitBody(child, nextDepth));
      }

      for (const parameter of fnNode.parameters) {
        visitBody(parameter, 0);
      }
      if (fnNode.body) {
        visitBody(fnNode.body, 0);
      }

      if (deepest > fileMaxNesting) fileMaxNesting = deepest;
      if (complexity > fileMaxFnCyclomatic) fileMaxFnCyclomatic = complexity;
      if (complexity > maxFunctionCyclomatic) maxFunctionCyclomatic = complexity;
      if (deepest > maxNesting) maxNesting = deepest;

      const startLine = sourceFile.getLineAndCharacterOfPosition(fnNode.getStart(sourceFile)).line + 1;
      const fnName = functionNameOf(fnNode, sourceFile);

      if (complexity >= thresholds.fnCyclomaticMedia) {
        complexFunctionsCount += 1;
        const severity = complexity >= thresholds.fnCyclomaticAlta ? 'alta' : 'media';
        findings.push({
          tool: 'ast-complexity',
          rule: 'COMPLEXITY-CYCLOMATIC-HIGH',
          file: relFile,
          line: clampLine(startLine),
          severity,
          message: `Função '${fnName}' com complexidade ciclomática alta (${complexity}, limite ${thresholds.fnCyclomaticMedia})`,
          evidence: `${relFile}:${startLine} funcao=${fnName}; complexidade_ciclomatica=${complexity}; profundidade_max=${deepest}`,
        });
      }

      if (deepest >= thresholds.fnNestingMedia) {
        const severity = deepest >= thresholds.fnNestingAlta ? 'alta' : 'media';
        findings.push({
          tool: 'ast-complexity',
          rule: 'COMPLEXITY-NESTING-DEEP',
          file: relFile,
          line: clampLine(startLine),
          severity,
          message: `Função '${fnName}' com aninhamento excessivo (${deepest} níveis, limite ${thresholds.fnNestingMedia})`,
          evidence: `${relFile}:${startLine} funcao=${fnName}; profundidade_max=${deepest}`,
        });
      }
    }

    function walkTop(node) {
      if (isFunctionLike(node)) {
        measureFunction(node);
        return;
      }
      if (isDecisionNode(node)) {
        fileTotalDecisions += 1;
      }
      ts.forEachChild(node, walkTop);
    }

    walkTop(sourceFile);

    const fileCyclomatic = 1 + fileTotalDecisions;
    if (fileCyclomatic > maxFileCyclomatic) maxFileCyclomatic = fileCyclomatic;

    if (loc >= thresholds.fileLocMedia) {
      largeFilesCount += 1;
      const severity = loc >= thresholds.fileLocAlta ? 'alta' : 'media';
      findings.push({
        tool: 'ast-complexity',
        rule: 'COMPLEXITY-FILE-LARGE',
        file: relFile,
        line: 1,
        severity,
        message: `Arquivo extenso demais (${loc} linhas úteis, limite ${thresholds.fileLocMedia})`,
        evidence: `${relFile}:1 linhas_uteis=${loc}; linhas_totais=${lines.length}; funcoes=${functionsCount}`,
      });
    }

    if (fileCyclomatic >= thresholds.fileCyclomaticMedia) {
      const severity = fileCyclomatic >= thresholds.fileCyclomaticAlta ? 'alta' : 'media';
      findings.push({
        tool: 'ast-complexity',
        rule: 'COMPLEXITY-FILE-CYCLOMATIC',
        file: relFile,
        line: 1,
        severity,
        message: `Complexidade ciclomática acumulada alta no arquivo (${fileCyclomatic}, limite ${thresholds.fileCyclomaticMedia})`,
        evidence: `${relFile}:1 complexidade_arquivo=${fileCyclomatic}; max_funcao=${fileMaxFnCyclomatic}; funcoes=${functionsCount}`,
      });
    }

    perFile.push({
      file: relFile,
      loc,
      functions: functionsCount,
      fileCyclomatic,
      maxFnCyclomatic: fileMaxFnCyclomatic,
      maxNesting: fileMaxNesting,
    });
  }

  return {
    findings,
    perFile,
    stats: {
      analyzedFiles: perFile.length,
      maxFileCyclomatic,
      maxFunctionCyclomatic,
      maxNesting,
      complexFunctions: complexFunctionsCount,
      largeFiles: largeFilesCount,
    },
  };
}

function coverageLimit(total, listed) {
  return `linhas_por_arquivo=${listed}/${total}; limite_linhas=${MAX_PER_FILE_COVERAGE}; cobertura_truncada=${total > listed ? 'sim' : 'nao'}`;
}

function snapshotCoverage({copiedFiles, skipped, stoppedAt, failure}) {
  const listed = skipped.slice(0, MAX_PER_FILE_COVERAGE);
  const incomplete = Boolean(failure || stoppedAt || skipped.length);
  return [
    {
      tool: 'snapshot',
      version: '1',
      status: failure ? 'failed' : incomplete ? 'skipped' : 'ok',
      detail: `copiados=${copiedFiles.length}; entradas_omitidas_conhecidas=${skipped.length}; ` +
        `limite_arquivos=${MAX_COPY_FILES}; limite_bytes_por_arquivo=${MAX_FILE_BYTES}; ` +
        `cobertura_parcial=${incomplete ? 'sim' : 'nao'}; ${coverageLimit(skipped.length, listed.length)}` +
        (stoppedAt ? `; limite_arquivos_atingido_em=${JSON.stringify(stoppedAt)}; restante_nao_inventariado=sim` : '') +
        (failure ? `; falha_copia=${failure.code}; arquivo=${JSON.stringify(failure.file)}; analise_interrompida=sim; restante_nao_inventariado=sim` : ''),
    },
    ...listed.map(({file, reason}) => ({
      tool: 'snapshot:omitted',
      version: '1',
      status: 'skipped',
      detail: `arquivo=${JSON.stringify(file)}; motivo=${reason}`,
    })),
  ];
}

function snapshotSetupFailure(err) {
  const coverage = snapshotCoverage({
    copiedFiles: [], skipped: [], failure: {file: '.', code: err.code ?? 'ERR'},
  });
  return {coverage, findings: []};
}

export function runCollector(options = {}) {
  const repoDir = options.repoDir ?? process.env.AC_REPO_DIR ?? '/repo';
  const toolsRoot = options.toolsRoot ?? '/opt/arquitetura-tools';
  const execFn = options.spawnSync ?? spawnSync;

  const versions = {
    knip: readPackageVersion('knip', toolsRoot),
    jscpd: readPackageVersion('jscpd', toolsRoot),
    depcruise: readPackageVersion('dependency-cruiser', toolsRoot),
    ast: readPackageVersion('typescript', toolsRoot),
  };

  let workRoot;
  try {
    workRoot = mkdtempSync(join(tmpdir(), 'arch-work-'));
  } catch (err) {
    return snapshotSetupFailure(err);
  }
  const workRepoDir = join(workRoot, 'repo');
  const workOutDir = join(workRoot, 'out');
  const workCfgDir = join(workRoot, 'cfg');
  try {
    try {
      mkdirSync(workOutDir, {recursive: true});
      mkdirSync(workCfgDir, {recursive: true});
    } catch (err) {
      return snapshotSetupFailure(err);
    }
    const snapshot = copyRepoSafely(repoDir, workRepoDir);
    const coverage = snapshotCoverage(snapshot);
    const findings = [];
    if (snapshot.failure) return {coverage, findings};

    const {copiedFiles} = snapshot;
    const jsTsFiles = copiedFiles.filter(f => JS_TS_EXTS.has(extname(f).toLowerCase()));
    const nonTestJsTsFiles = jsTsFiles.filter(
      f => !/(^|\/)(tests?|__tests__|fixtures?)\//i.test(f) && !/\.(test|spec|d)\./i.test(f),
    );

    // 1. AST Complexity (arquivos e funções complexas demais em JS/TS)
    let astAnalyzedSet = new Set();
    if (nonTestJsTsFiles.length === 0) {
      coverage.push({
        tool: 'ast-complexity',
        version: versions.ast,
        status: 'skipped',
        detail: 'nenhum arquivo JS/TS de produção para análise AST',
      });
    } else {
      try {
        const requireAstApi = existsSync(join(toolsRoot, 'node_modules', 'typescript'));
        const astResult = analyzeAstComplexity(workRepoDir, nonTestJsTsFiles, DEFAULT_THRESHOLDS, {requireAstApi});
        astAnalyzedSet = new Set(astResult.perFile.map(item => item.file));
        findings.push(...astResult.findings);
        const rows = astResult.perFile.slice(0, MAX_PER_FILE_COVERAGE);
        coverage.push({
          tool: 'ast-complexity',
          version: versions.ast,
          status: 'ok',
          detail: `arquivos=${astResult.stats.analyzedFiles}, max_ciclomatica_arquivo=${astResult.stats.maxFileCyclomatic}, max_ciclomatica_funcao=${astResult.stats.maxFunctionCyclomatic}, max_aninhamento=${astResult.stats.maxNesting}, funcoes_complexas=${astResult.stats.complexFunctions}, arquivos_grandes=${astResult.stats.largeFiles}; ${coverageLimit(astResult.perFile.length, rows.length)}`,
        });
        for (const row of rows) {
          coverage.push({
            tool: 'ast-complexity:file',
            version: versions.ast,
            status: 'ok',
            detail: `arquivo=${row.file}; loc=${row.loc}; funcoes=${row.functions}; ciclom_arquivo=${row.fileCyclomatic}; max_ciclom_fn=${row.maxFnCyclomatic}; max_aninh=${row.maxNesting}`,
          });
        }
      } catch (err) {
        coverage.push({
          tool: 'ast-complexity',
          version: versions.ast,
          status: 'failed',
          detail: `falha na análise AST: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        });
      }
    }

    // 2. JSCPD (duplicação e complexidade multi-linguagem)
    if (copiedFiles.length === 0) {
      coverage.push({
        tool: 'jscpd',
        version: versions.jscpd,
        status: 'skipped',
        detail: 'nenhum arquivo no snapshot',
      });
    } else {
      try {
        const jscpdCfgPath = join(workCfgDir, 'jscpd.json');
        writeFileSync(
          jscpdCfgPath,
          JSON.stringify({
            threshold: 100,
            minLines: DEFAULT_THRESHOLDS.jscpdMinLines,
            minTokens: DEFAULT_THRESHOLDS.jscpdMinTokens,
            ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.next/**', '**/tests/**', '**/test/**', '**/__tests__/**', '**/fixtures/**', '**/fixture/**', '**/*.test.*', '**/*.spec.*', '**/*.d.{ts,mts,cts}'],
          }),
        );
        const jscpdBin = resolveBin('jscpd', toolsRoot);
        const dupRes = execFn(
          jscpdBin,
          [
            '--config',
            jscpdCfgPath,
            '--reporters',
            'json',
            '--output',
            workOutDir,
            '--silent',
            '--no-tips',
            '--no-gitignore',
            '--max-size',
            String(MAX_FILE_BYTES),
            workRepoDir,
          ],
          {cwd: workRepoDir, encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024},
        );
        if (dupRes.error) throw dupRes.error;
        if (dupRes.status !== 0) {
          throw new Error(`jscpd retornou status ${dupRes.status}: ${(dupRes.stderr || dupRes.stdout || '').slice(0, 300)}`);
        }
        const dupReportPath = join(workOutDir, 'jscpd-report.json');
        const parsedDup = parseJscpdReport(readFileSync(dupReportPath, 'utf8'), workRepoDir, null);
        findings.push(...parsedDup.findings);

        // Complexidade via jscpd --complexity
        const compRes = execFn(
          jscpdBin,
          [
            '--config',
            jscpdCfgPath,
            '--complexity',
            '--reporters',
            'json',
            '--output',
            workOutDir,
            '--silent',
            '--no-tips',
            '--no-gitignore',
            '--max-size',
            String(MAX_FILE_BYTES),
            workRepoDir,
          ],
          {cwd: workRepoDir, encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024},
        );
        if (compRes.error) throw compRes.error;
        if (compRes.status !== 0) {
          throw new Error(`jscpd --complexity retornou status ${compRes.status}: ${(compRes.stderr || compRes.stdout || '').slice(0, 300)}`);
        }
        const compReportPath = join(workOutDir, 'jscpd-complexity.json');
        const parsedComp = parseJscpdComplexityReport(
          readFileSync(compReportPath, 'utf8'),
          workRepoDir,
          null,
          astAnalyzedSet,
        );
        findings.push(...parsedComp.findings);

        const rows = parsedComp.fileMetrics.slice(0, MAX_PER_FILE_COVERAGE);
        const measured = parsedComp.totalFiles > 0 || parsedDup.stats.sources > 0;
        coverage.push({
          tool: 'jscpd',
          version: versions.jscpd,
          status: measured ? 'ok' : 'skipped',
          detail: `arquivos_medidos=${parsedComp.totalFiles}, clones=${parsedDup.stats.clones}, linhas_duplicadas=${parsedDup.stats.duplicatedLines}, percentual=${parsedDup.stats.percentage.toFixed(2)}%; ` +
            `fontes_duplicacao=${parsedDup.stats.sources}; min_linhas=${DEFAULT_THRESHOLDS.jscpdMinLines}; min_tokens=${DEFAULT_THRESHOLDS.jscpdMinTokens}; ` +
            coverageLimit(parsedComp.totalFiles, rows.length),
        });

        for (const row of rows) {
          coverage.push({
            tool: 'jscpd:file',
            version: versions.jscpd,
            status: 'ok',
            detail: `arquivo=${row.file}; linhas=${row.lines}; tokens=${row.tokens}; complexidade_jscpd=${row.complexity}; duplicado=${parsedDup.duplicatedFiles.has(row.file) ? 'sim' : 'nao'}`,
          });
        }
      } catch (err) {
        coverage.push({
          tool: 'jscpd',
          version: versions.jscpd,
          status: 'failed',
          detail: `falha ao executar jscpd: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        });
      }
    }

    // 3. dependency-cruiser (ciclos e violações de camada)
    if (nonTestJsTsFiles.length === 0) {
      coverage.push({
        tool: 'dependency-cruiser',
        version: versions.depcruise,
        status: 'skipped',
        detail: 'nenhum arquivo JS/TS de produção para análise de dependências',
      });
    } else {
      try {
        const hasTsConfig = sanitizeTsConfigInWork(workRepoDir, copiedFiles);
        const baseCfgPath = existsSync(join(toolsRoot, 'depcruise.config.json'))
          ? join(toolsRoot, 'depcruise.config.json')
          : '/opt/arquitetura-tools/depcruise.config.json';
        const depCfg = JSON.parse(readFileSync(baseCfgPath, 'utf8'));
        if (hasTsConfig) {
          depCfg.options = {...depCfg.options, tsConfig: {fileName: 'tsconfig.json'}};
        }
        const effectiveDepCfgPath = join(workCfgDir, 'depcruise.config.json');
        writeFileSync(effectiveDepCfgPath, JSON.stringify(depCfg, null, 2));

        const depOutPath = join(workOutDir, 'depcruise.json');
        const depBin = resolveBin('depcruise', toolsRoot);
        const depRes = execFn(
          depBin,
          [
            '--config',
            effectiveDepCfgPath,
            '--metrics',
            '--output-type',
            'json',
            '--output-to',
            depOutPath,
            '.',
          ],
          {cwd: workRepoDir, encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024},
        );
        if (depRes.error) throw depRes.error;
        if (depRes.status !== 0) {
          throw new Error(`depcruise retornou status ${depRes.status}: ${(depRes.stderr || depRes.stdout || '').slice(0, 300)}`);
        }
        const parsedDep = parseDepcruiseReport(
          readFileSync(depOutPath, 'utf8'),
          workRepoDir,
          rel => readFileSync(join(workRepoDir, rel), 'utf8'),
        );
        findings.push(...parsedDep.findings);
        coverage.push({
          tool: 'dependency-cruiser',
          version: versions.depcruise,
          status: 'ok',
          detail: `modulos=${parsedDep.stats.totalModules}, dependencias=${parsedDep.stats.totalDependencies}, ciclos=${parsedDep.stats.cycles}, violacoes_camada=${parsedDep.stats.layerViolations}, orfaos=${parsedDep.stats.orphans}; ${coverageLimit(parsedDep.stats.totalModules, parsedDep.perFileCoverage.length)}`,
        });
        for (const row of parsedDep.perFileCoverage) {
          coverage.push({
            tool: 'dependency-cruiser:file',
            version: versions.depcruise,
            status: 'ok',
            detail: `arquivo=${row.file}; deps=${row.deps}; dependentes=${row.dependents}; instabilidade=${row.instability}; ciclo=${row.cycle ? 'sim' : 'nao'}; violacao_camada=${row.layerViolation ? 'sim' : 'nao'}`,
          });
        }
      } catch (err) {
        coverage.push({
          tool: 'dependency-cruiser',
          version: versions.depcruise,
          status: 'failed',
          detail: `falha ao executar dependency-cruiser: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        });
      }
    }

    // 4. KNIP (código morto). Por último, pois prepara os manifestos do snapshot.
    const knipCandidates = new Set(nonTestJsTsFiles.filter(f => !isIgnoredByKnipConfig(f)));
    if (knipCandidates.size === 0) {
      coverage.push({
        tool: 'knip',
        version: versions.knip,
        status: 'skipped',
        detail:
          jsTsFiles.length === 0
            ? `nenhum arquivo JS/TS encontrado (arquivos copiados=${copiedFiles.length})`
            : `nenhum arquivo JS/TS de produção elegível para knip (arquivos copiados=${copiedFiles.length})`,
      });
    } else {
      try {
        if (!existsSync(join(workRepoDir, 'package.json'))) {
          writeFileSync(join(workRepoDir, 'package.json'), JSON.stringify({name: 'repo-scan', private: true}, null, 2));
        }
        const knipConfig = buildKnipConfig(workRepoDir, copiedFiles);
        const knipConfigPath = join(workCfgDir, 'knip.json');
        writeFileSync(knipConfigPath, JSON.stringify(knipConfig, null, 2));

        const worker = fileURLToPath(new URL('./knip-worker.mjs', import.meta.url));
        const knipRes = execFn(process.execPath, [worker, toolsRoot, knipConfigPath], {
          cwd: workRepoDir, encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
        });
        if (knipRes.error) throw knipRes.error;
        if (knipRes.status !== 0) {
          throw new Error(`knip retornou status ${knipRes.status}: ${(knipRes.stderr || knipRes.stdout || '').slice(0, 300)}`);
        }
        const parsedKnip = parseKnipReport(knipRes.stdout, workRepoDir, knipCandidates);
        findings.push(...parsedKnip.findings);
        const {stats} = parsedKnip;
        coverage.push({
          tool: 'knip',
          version: versions.knip,
          status: stats.totalFiles > 0 ? 'ok' : 'skipped',
          detail: `arquivos=${stats.totalFiles}, entradas=${stats.entries}, arquivos_nao_usados=${stats.unusedFiles}, exportacoes_nao_usadas=${stats.unusedExports}, deps_nao_usadas=${stats.unusedDeps}; ` +
            `elegiveis_sem_medicao_comprovada=${knipCandidates.size - stats.totalFiles}; ${coverageLimit(stats.totalFiles, parsedKnip.perFileCoverage.length)}`,
        });
        for (const row of parsedKnip.perFileCoverage) {
          coverage.push({
            tool: 'knip:file',
            version: versions.knip,
            status: 'ok',
            detail: `arquivo=${row.file}; papel=${row.role}; problemas=${row.issues}`,
          });
        }
      } catch (err) {
        coverage.push({
          tool: 'knip',
          version: versions.knip,
          status: 'failed',
          detail: `falha ao executar knip: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        });
      }
    }

    return {coverage, findings};
  } finally {
    rmSync(workRoot, {recursive: true, force: true});
  }
}

function launchedAsEntry() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return import.meta.url === pathToFileURL(argvPath).href;
  } catch {
    return false;
  }
}

if (launchedAsEntry()) {
  try {
    const result = runCollector();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
