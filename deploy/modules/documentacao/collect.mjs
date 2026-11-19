/**
 * Coletor do módulo 8 — Documentação viva.
 * Executa exclusivamente análise estática e validação documental (TypeDoc, dependency-cruiser e Mermaid)
 * sobre uma cópia isolada em /tmp, sem importar ou executar código ou configurações do repositório.
 */
import {spawnSync} from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, extname, join, posix, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const MAX_COPY_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COPY_BYTES = 192 * 1024 * 1024;
// Contratos de src/verification-modules.ts e module-documentation-artifacts.ts.
const MAX_DETAIL_CHARS = 2000;
const MAX_COVERAGE_ROWS = 5000;
const MAX_FINDINGS = 999;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024;
const ARTIFACT_PART_BYTES = 880;
const ARTIFACT_ENCODING = 'hex-utf8-v1';
const FORBIDDEN_REPORT_SEGMENTS = new Set(['.mcp.json', '.claude', '.husky', '.codex', '.grok']);
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

const UNTRUSTED_CONFIG_FILES = new Set([
  'typedoc.json',
  '.typedoc.json',
  'typedoc.js',
  'typedoc.cjs',
  'typedoc.mjs',
  'typedoc.config.js',
  'typedoc.config.cjs',
  'typedoc.config.mjs',
  'typedoc.config.ts',
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'webpack.config.js',
  'webpack.config.cjs',
  'webpack.config.mjs',
  '.dependency-cruiser.js',
  '.dependency-cruiser.cjs',
  '.dependency-cruiser.mjs',
  '.dependency-cruiser.json',
]);

const JS_TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const DOC_EXTS = new Set(['.md', '.markdown', '.mmd', '.mermaid']);
const SNAPSHOT_COMPILER_OPTIONS = {
  target: 'ES2022',
  module: 'ESNext',
  moduleResolution: 'bundler',
  allowJs: true,
  checkJs: false,
  strict: false,
  skipLibCheck: true,
  noEmit: true,
  types: [],
  plugins: [],
};
const TYPE_CHECK_ONLY_OPTIONS = new Set(['checkJs', 'strict', 'skipLibCheck', 'noEmit']);

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
  rel = toPosix(rel);
  if (posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return '.';
  const normalized = posix.normalize(rel);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
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
  for (const [file, getVersion] of [
    [join(toolsRoot, 'node_modules', pkgName, 'package.json'), pkg => pkg.version],
    [join(MODULE_DIR, 'tools.lock.json'), lock => lock.dependencies?.[pkgName]?.version],
  ]) {
    try {
      const version = getVersion(JSON.parse(readFileSync(file, 'utf8')));
      if (typeof version === 'string' && version) return version;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return 'desconhecida';
}

const mermaidParsers = new Map();

function createDefaultMermaidParser(toolsRoot) {
  if (!mermaidParsers.has(toolsRoot)) {
    mermaidParsers.set(toolsRoot, loadMermaidParser(toolsRoot));
  }
  return mermaidParsers.get(toolsRoot);
}

async function loadMermaidParser(toolsRoot) {
  const load = createRequire(join(toolsRoot, 'package.json'));
  const {JSDOM, VirtualConsole} = load('jsdom');
  const {window} = new JSDOM('', {virtualConsole: new VirtualConsole()});
  // DOMPurify needs a real document at import time. jsdom leaves scripts and resource loading disabled.
  const previousWindow = globalThis.window;
  globalThis.window = window;
  try {
    const {default: mermaid} = await import(pathToFileURL(load.resolve('mermaid')).href);
    mermaid.initialize({startOnLoad: false, securityLevel: 'strict', logLevel: 'fatal'});
    await mermaid.parse('flowchart LR\n  A["módulo"] --> B');
    return code => mermaid.parse(code);
  } catch (err) {
    window.close();
    throw err;
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

/**
 * Copia apenas arquivos regulares e diretórios seguros de sourceRoot para destRoot,
 * ignorando symlinks, sockets, dispositivos, diretórios de build/vendor, configurações
 * executáveis não confiáveis e arquivos > 2 MiB.
 */
export function copyRepoSafely(sourceRoot, destRoot, opts = {}) {
  if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
    throw new Error(`Diretório do repositório inválido: ${sourceRoot}`);
  }
  try {
    accessSync(sourceRoot, fsConstants.R_OK | fsConstants.X_OK);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'ERR';
    throw new Error(`DOCUMENTACAO_REPO_UNREADABLE: raiz do repositório presente porém ilegível (${code}): ${sourceRoot}`);
  }

  const maxFiles = opts.maxFiles ?? MAX_COPY_FILES;
  const maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const maxCopyBytes = opts.maxCopyBytes ?? MAX_COPY_BYTES;
  let copiedBytes = 0;
  const copiedFiles = [];
  const skipped = [];

  mkdirSync(destRoot, {recursive: true});

  function walk(currentSrc, currentRel) {
    if (copiedFiles.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(currentSrc, {withFileTypes: true});
    } catch (err) {
      if (currentRel === '') {
        const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'ERR';
        throw new Error(`DOCUMENTACAO_REPO_UNREADABLE: falha ao ler raiz do repositório (${code}): ${sourceRoot}`);
      }
      skipped.push(`${currentRel}/[ilegivel]`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (copiedFiles.length >= maxFiles) {
        skipped.push('LIMITE_ARQUIVOS');
        return;
      }
      if (entry.name === '.' || entry.name === '..') continue;
      if (entry.isSymbolicLink()) {
        skipped.push(currentRel ? `${currentRel}/${entry.name}` : entry.name);
        continue;
      }
      const srcPath = join(currentSrc, entry.name);
      const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      let st;
      try {
        st = lstatSync(srcPath);
      } catch {
        skipped.push(relPath);
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped.push(relPath);
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          skipped.push(relPath);
          continue;
        }
        mkdirSync(join(destRoot, relPath), {recursive: true});
        walk(srcPath, relPath);
      } else if (st.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (
          UNTRUSTED_CONFIG_FILES.has(entry.name) ||
          entry.name.startsWith('.') ||
          entry.name === 'auth.json' ||
          (!JS_TS_EXTS.has(ext) && !DOC_EXTS.has(ext) && ext !== '.json')
        ) {
          skipped.push(relPath);
          continue;
        }
        if (st.size > maxFileBytes || copiedBytes + st.size > maxCopyBytes) {
          skipped.push(relPath);
          continue;
        }
        const destPath = join(destRoot, relPath);
        mkdirSync(dirname(destPath), {recursive: true});
        if (entry.name === 'package.json') {
          // TypeDoc reads typedocOptions from package.json even with --options.
          // Preserve the dependency metadata but never pass options or npm scripts to a tool.
          let manifest;
          try {
            manifest = JSON.parse(readFileSync(srcPath, 'utf8'));
          } catch (err) {
            if (!(err instanceof SyntaxError)) throw err;
          }
          if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            skipped.push(relPath);
            continue;
          }
          delete manifest.typedocOptions;
          delete manifest.typedoc;
          delete manifest.scripts;
          writeFileSync(destPath, JSON.stringify(manifest));
        } else {
          copyFileSync(srcPath, destPath);
        }
        copiedFiles.push(relPath);
        copiedBytes += st.size;
      } else {
        skipped.push(relPath);
      }
    }
  }

  walk(sourceRoot, '');
  return {copiedFiles, skipped};
}

/**
 * Gera um tsconfig seguro e isolado sem plugins, sem extends externos e sem execução de código.
 */
export function sanitizeTsConfigInWork(workRepoDir, codeFiles = []) {
  const safeConfig = {
    compilerOptions: SNAPSHOT_COMPILER_OPTIONS,
    files: codeFiles.map(file => `./${file}`),
  };

  const tsConfigPath = join(workRepoDir, 'tsconfig.json');
  writeFileSync(tsConfigPath, JSON.stringify(safeConfig, null, 2));
  return tsConfigPath;
}

function measureResolutionCoverage(copiedFiles, skipped, readFile) {
  const isConfigFile = file => /(^|\/)(?:ts|js)config[^/]*\.json$/i.test(file);
  if (skipped.some(file => isConfigFile(file) || file === 'LIMITE_ARQUIVOS' || file.endsWith('/[ilegivel]')
    || JS_TS_EXTS.has(extname(file).toLowerCase()) || posix.basename(file) === 'package.json')) {
    return 'arquivo de código, manifesto ou configuração omitido do snapshot';
  }
  for (const file of copiedFiles.filter(isConfigFile)) {
    try {
      const config = JSON.parse(readFile(file));
      if (!config || typeof config !== 'object' || Array.isArray(config)) return `configuração não analisada em ${file}`;
      if (Object.hasOwn(config, 'extends') || Object.hasOwn(config, 'references')) return `extends ou references em ${file}`;

      const options = config.compilerOptions;
      if (!options || typeof options !== 'object' || Array.isArray(options)) return `compilerOptions não analisado em ${file}`;
      // Only settings known to match the snapshot or unrelated to resolution are measured.
      // In particular, omitted resolution modes use TypeScript defaults, not the snapshot defaults.
      const changed = Object.entries(options).find(([key, value]) => {
        if (TYPE_CHECK_ONLY_OPTIONS.has(key)) return typeof value !== 'boolean';
        const expected = SNAPSHOT_COMPILER_OPTIONS[key];
        return typeof expected === 'string'
          ? typeof value !== 'string' || value.toLowerCase() !== expected.toLowerCase()
          : !Object.hasOwn(SNAPSHOT_COMPILER_OPTIONS, key) || !isDeepStrictEqual(value, expected);
      });
      if (changed) return `opção ${JSON.stringify(changed[0])} em ${file}`;
      if (!Object.hasOwn(options, 'module') || !Object.hasOwn(options, 'moduleResolution')) {
        return `modo de resolução implícito em ${file}`;
      }
    } catch {
      return `configuração não analisada em ${file}`;
    }
  }
  return '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findLineInText(text, matcher) {
  if (!text) return 1;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (typeof matcher === 'string') {
      if (lines[i].includes(matcher)) return i + 1;
    } else if (matcher instanceof RegExp) {
      if (matcher.test(lines[i])) return i + 1;
    }
  }
  return 1;
}

function summarizeComment(commentObj) {
  if (!commentObj || typeof commentObj !== 'object') return '';
  const parts = [];
  if (Array.isArray(commentObj.summary)) {
    for (const seg of commentObj.summary) {
      if (seg && typeof seg.text === 'string') parts.push(seg.text);
    }
  }
  return parts.join('').trim();
}

function extractCommentBlockTags(commentObj) {
  if (!commentObj || typeof commentObj !== 'object' || !Array.isArray(commentObj.blockTags)) {
    return [];
  }
  return commentObj.blockTags.map(tag => ({
    tag: String(tag?.tag ?? ''),
    name: typeof tag?.name === 'string' ? tag.name : '',
    text: Array.isArray(tag?.content)
      ? tag.content.map(c => String(c?.text ?? '')).join('').trim()
      : '',
  }));
}

/**
 * Percorre o JSON de reflexão gerado pelo TypeDoc e extrai todos os símbolos exportados,
 * parâmetros, comentários JSDoc/TSDoc e localização exata (arquivo e linha).
 */
export function extractTypedocSymbols(typedocData, repoRoot) {
  const symbols = [];
  if (!typedocData || typeof typedocData !== 'object') return symbols;

  function visit(node, modulePrefix = '') {
    if (!node || typeof node !== 'object') return;
    const kind = Number(node.kind ?? 0);
    const name = String(node.name ?? '');
    if (node.flags?.isPrivate || node.flags?.isProtected) return;

    // Project (1) ou Module (2)
    if (kind === 1 || kind === 2) {
      const nextPrefix = kind === 2 && name ? (modulePrefix ? `${modulePrefix}.${name}` : name) : modulePrefix;
      if (Array.isArray(node.children)) {
        for (const child of node.children) visit(child, nextPrefix);
      }
      return;
    }

    const sourceEntry =
      (Array.isArray(node.sources) && node.sources[0]) ||
      (Array.isArray(node.signatures) &&
        node.signatures[0] &&
        Array.isArray(node.signatures[0].sources) &&
        node.signatures[0].sources[0]) ||
      null;

    const file = sourceEntry?.fileName ? normalizeRepoPath(sourceEntry.fileName, repoRoot) : '.';
    const line = clampLine(sourceEntry?.line ?? 1);

    const primarySig = Array.isArray(node.signatures) && node.signatures.length > 0 ? node.signatures[0] : null;
    const effectiveComment = primarySig?.comment ?? node.comment ?? null;
    const summaryText = summarizeComment(effectiveComment);
    const blockTags = extractCommentBlockTags(effectiveComment);
    const hasDoc = Boolean(summaryText.length > 0 || blockTags.length > 0);

    const parameterLists = (node.signatures ?? []).map(signature =>
      (signature.parameters ?? []).map(param => ({
        name: String(param.name ?? ''),
        optional: Boolean(param.flags?.isOptional || param.defaultValue !== undefined),
        rest: Boolean(param.flags?.isRest),
        hasDoc: Boolean(summarizeComment(param.comment)),
      })),
    );

    const qualifiedName = modulePrefix ? `${modulePrefix}.${name}` : name;

    if (name && file !== '.') {
      symbols.push({
        name,
        qualifiedName,
        kind,
        file,
        line,
        hasDoc,
        summaryText,
        blockTags,
        parameters: parameterLists[0] ?? [],
        parameterLists,
      });
    }
    // Only class/interface members are API members; do not descend into signatures or parameters.
    if ((kind === 128 || kind === 256) && Array.isArray(node.children)) {
      for (const child of node.children) visit(child, qualifiedName);
    }
  }

  visit(typedocData, '');
  return symbols;
}

/**
 * Analisa a saída JSON e os avisos diagnósticos do TypeDoc.
 */
export function parseTypedocReport(rawJson, rawCliOutput, repoRoot, readFileFn = () => '') {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  if (data?.kind !== 1 || typeof data.name !== 'string') {
    throw new Error('Saída JSON do TypeDoc inválida: reflexão do projeto ausente');
  }

  const symbols = extractTypedocSymbols(data, repoRoot);
  const resolveSymbol = rawSymName => {
    const cleaned = String(rawSymName ?? '').trim().replace(/#/g, '.');
    const exact = symbols.filter(sym => sym.qualifiedName === cleaned);
    if (exact.length === 1) return exact[0];
    const suffix = symbols.filter(sym => sym.qualifiedName.endsWith(`.${cleaned}`));
    if (suffix.length === 1) return suffix[0];
    const named = symbols.filter(sym => sym.name === cleaned);
    return named.length === 1 ? named[0] : null;
  };

  const findings = [];
  const seenKeys = new Set();
  const fileCache = new Map();

  const getFileText = relFile => {
    if (!relFile || relFile === '.') return '';
    if (fileCache.has(relFile)) return fileCache.get(relFile);
    let content = '';
    try {
      content = String(readFileFn(relFile) ?? '');
    } catch {
      content = '';
    }
    fileCache.set(relFile, content);
    return content;
  };

  const findInSymbolComment = (sym, matcher) => {
    const lines = getFileText(sym.file).split(/\r?\n/);
    // TypeDoc's source line is the declaration. Only its immediately preceding JSDoc
    // (possibly followed by decorators) can establish a diagnostic location.
    const prefix = lines.slice(0, clampLine(sym.line)).join('\n');
    const offset = prefix.lastIndexOf('/**');
    if (offset < 0) return clampLine(sym.line);
    const close = prefix.indexOf('*/', offset);
    if (close < 0) return clampLine(sym.line);
    const between = prefix.slice(close + 2);
    if (!/^\s*(?:@[^\n]*\n\s*)*(?:(?:export|declare|public|static|async|abstract|readonly|default)\s+)*[^\n]*$/.test(between)) return clampLine(sym.line);
    const comment = prefix.slice(offset, close + 2);
    const commentLines = comment.split('\n');
    let fence = null;
    const index = commentLines.findIndex(text => {
      const content = text.replace(/^\s*(?:\/\*\*|\*)[ \t]?/, '');
      if (fence) {
        if (closesFence(content, fence)) fence = null;
        return false;
      }
      fence = openingFence(content);
      return !fence && matcher.test(text);
    });
    return index < 0 ? clampLine(sym.line) : prefix.slice(0, offset).split('\n').length + index;
  };

  const cliLines = String(rawCliOutput ?? '')
    .split(/\r?\n/)
    .map(l => l.replace(/\x1B\[[0-9;]*m/g, '').trim())
    .filter(Boolean);

  for (const lineText of cliLines) {
    // 1. Parâmetro JSDoc @param desatualizado / inexistente na assinatura real
    const unusedParamMatch = lineText.match(
      /The signature ([^\s]+) has an @param with name "([^"]+)", which was not used/i,
    );
    if (unusedParamMatch) {
      const sigName = unusedParamMatch[1];
      const paramName = unusedParamMatch[2];
      const sym = resolveSymbol(sigName);
      if (!sym) continue;
      const file = sym.file;
      const paramTag = new RegExp(String.raw`^\s*(?:/\*\*\s*|\*\s*)?@param\s+(?:\{[^}]+\}\s+)?\[?${escapeRegExp(paramName)}(?=\s|[\]=]|\*/|$)`);
      const line = findInSymbolComment(sym, paramTag);
      const dedupKey = `PARAM:${file}:${sigName}:${paramName}`;
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey);
        findings.push({
          tool: 'typedoc',
          rule: 'DOC-TYPEDOC-PARAM-DESATUALIZADO',
          file,
          line,
          severity: 'alta',
          message: `JSDoc de "${sym?.name ?? sigName}" documenta o parâmetro "@param ${paramName}", que não existe na assinatura real da função.`,
          evidence: lineText,
        });
      }
      continue;
    }

    // 2. Link JSDoc {@link ...} apontando para símbolo inexistente
    const brokenLinkMatch = lineText.match(
      /Failed to resolve link to "([^"]+)" in comment for ([^\s]+)/i,
    );
    if (brokenLinkMatch) {
      const targetLink = brokenLinkMatch[1];
      const symRef = brokenLinkMatch[2];
      const sym = resolveSymbol(symRef);
      if (!sym) continue;
      const file = sym.file;
      const line = findInSymbolComment(sym, new RegExp(`@link\\s+${escapeRegExp(targetLink)}\\b`));
      const dedupKey = `LINK:${file}:${symRef}:${targetLink}`;
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey);
        findings.push({
          tool: 'typedoc',
          rule: 'DOC-TYPEDOC-LINK-QUEBRADO',
          file,
          line,
          severity: 'media',
          message: `Comentário JSDoc de "${sym?.name ?? symRef}" contém referência {@link ${targetLink}} para símbolo inexistente.`,
          evidence: lineText,
        });
      }
      continue;
    }

    // 3. Símbolo exportado sem documentação reportado pela validação do TypeDoc
    const notDocMatch = lineText.match(
      /^\[warning\]\s+([^\s]+)\s+\([^)]+\),\s+defined in\s+(.+),\s+does not have any documentation/i,
    );
    if (notDocMatch) {
      const symRef = notDocMatch[1];
      if (symRef.includes('.__type.')) continue;
      const sym = resolveSymbol(symRef);
      let file = sym?.file ?? normalizeRepoPath(notDocMatch[2], repoRoot);
      if (!sym && file.includes('/')) {
        const firstSlash = file.indexOf('/');
        const withoutPkgPrefix = file.slice(firstSlash + 1);
        if (withoutPkgPrefix && getFileText(withoutPkgPrefix)) {
          file = withoutPkgPrefix;
        }
      }
      if (file === '.' || !getFileText(file)) continue;
      const line = clampLine(sym?.line ?? 1);
      const shortName = sym?.name ?? (symRef.includes('.') ? symRef.split('.').pop() : symRef);
      const dedupKey = `NODOC:${file}:${sym?.qualifiedName ?? symRef}`;
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey);
        findings.push({
          tool: 'typedoc',
          rule: 'DOC-TYPEDOC-SIMBOLO-SEM-DOC',
          file,
          line,
          severity: 'media',
          message: `Símbolo público exportado "${shortName}" em ${file} não possui documentação JSDoc/TSDoc.`,
          evidence: lineText,
        });
      }
    }
  }

  // Fallback a partir do modelo de reflexão JSON para símbolos exportados sem comentário
  for (const sym of symbols) {
    if (!sym.hasDoc) {
      const dedupKey = `NODOC:${sym.file}:${sym.qualifiedName}`;
      if (!seenKeys.has(dedupKey)) {
        seenKeys.add(dedupKey);
        findings.push({
          tool: 'typedoc',
          rule: 'DOC-TYPEDOC-SIMBOLO-SEM-DOC',
          file: sym.file,
          line: sym.line,
          severity: 'media',
          message: `Símbolo público exportado "${sym.name}" em ${sym.file} não possui documentação JSDoc/TSDoc.`,
          evidence: `TypeDoc reflection kind=${sym.kind} name=${sym.name} (${sym.file}:${sym.line}) sem summary/blockTags`,
        });
      }
    }
  }

  return {symbols, findings};
}

/**
 * Cruza afirmações e assinaturas documentadas em arquivos Markdown com o catálogo
 * de símbolos reais extraído pelo TypeDoc.
 */
export function crossCheckMarkdownAgainstTypedoc(mdFiles, symbols, readFileFn = () => '', coverageByFile = new Map()) {
  const findings = [];
  const functions = new Map();
  for (const symbol of symbols) {
    if (symbol.kind !== 64) continue;
    if (!functions.has(symbol.name)) functions.set(symbol.name, []);
    functions.get(symbol.name).push(symbol);
  }

  for (const file of mdFiles) {
    let checked = 0;
    let fence = null;
    const lines = String(readFileFn(file) ?? '').split(/\r?\n/);
    for (const [index, lineText] of lines.entries()) {
      if (fence) {
        if (closesFence(lineText, fence)) fence = null;
        continue;
      }
      fence = openingFence(lineText);
      if (fence) continue;

      for (const match of lineText.matchAll(/(?<!`)`([A-Za-z_$][\w$]*)\(([^()`]*)\)`(?!`)/g)) {
        const [, name, args] = match;
        const matches = functions.get(name);
        if (matches?.length !== 1) continue;
        const [symbol] = matches;
        const documented = args.trim() ? args.split(',').map(arg => arg.trim()) : [];
        if (!documented.every(arg => /^[A-Za-z_$][\w$]*$/.test(arg))) continue;
        checked += 1;
        const actual = symbol.parameters.map(param => param.name);
        const signatures = symbol.parameterLists ?? [symbol.parameters];
        if (signatures.some(parameters =>
          documented.length >= parameters.filter(param => !param.optional && !param.rest).length &&
          (documented.length <= parameters.length || parameters.at(-1)?.rest) &&
          documented.every((arg, position) => arg === parameters[position]?.name)
        )) continue;
        findings.push({
          tool: 'typedoc',
          rule: 'DOC-TYPEDOC-MARKDOWN-ASSINATURA-DESATUALIZADA',
          file,
          line: index + 1,
          severity: 'media',
          message: `A assinatura documentada de "${name}" diverge da API exportada em ${symbol.file}:${symbol.line}.`,
          evidence: `documentado: ${name}(${args}) | código: ${name}(${actual.join(', ')})`,
        });
      }
    }
    coverageByFile.set(file, checked);
  }
  return findings;
}

function openingFence(line) {
  return line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^ \t]*)/);
}

function closesFence(line, opening) {
  const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return closing?.[1][0] === opening[1][0] && closing[1].length >= opening[1].length;
}

/**
 * Extrai diagramas em cercas Markdown e arquivos Mermaid independentes.
 */
export function extractMermaidBlocks(docFiles, readFileFn = () => '') {
  const blocks = [];
  for (const file of docFiles) {
    const text = String(readFileFn(file) ?? '');
    const ext = extname(file).toLowerCase();
    if (ext === '.mmd' || ext === '.mermaid') {
      if (text.trim()) blocks.push({file, startLine: 1, code: text});
      continue;
    }
    const lines = text.split(/\r?\n/);
    let fence = null;
    let start = 0;
    for (const [index, line] of lines.entries()) {
      if (!fence) {
        fence = openingFence(line);
        start = index + 1;
      } else if (closesFence(line, fence)) {
        if (fence[2].toLowerCase() === 'mermaid') {
          blocks.push({file, startLine: start + 1, code: lines.slice(start, index).join('\n')});
        }
        fence = null;
      }
    }
    if (fence?.[2].toLowerCase() === 'mermaid') {
      blocks.push({file, startLine: start + 1, code: lines.slice(start).join('\n')});
    }
  }
  return blocks;
}

/**
 * Extrai o subconjunto de flowcharts que pode ser comparado com um grafo de imports.
 * A leitura de uma cadeia só é aceita quando toda a instrução foi reconhecida.
 */
export function extractMermaidModuleReferences(block) {
  const moduleNodes = [];
  const chains = [];
  let unmeasured = 0;
  let hasHeader = false;

  const quoted = String.raw`"(?:\\.|[^"\\])*"`;
  const id = String.raw`(?:[\w/]|-(?![-.])|\.(?!-))+`; // Leave the first character of an arrow for the link lexer.
  const label = String.raw`(?:${quoted}|[^"\[\](){}\r\n])*`;
  const shape = String.raw`(?:\[\[(${label})\]\]|\[\((${label})\)\]|\(\((${label})\)\)|\[(${label})\]|\((${label})\)|\{\{(${label})\}\}|\{(${label})\})`;
  const node = new RegExp(String.raw`\s*(${id})(?:\s*${shape})?(?::::[\w-]+)?\s*`, 'y');
  const linkLabel = String.raw`(?:${quoted}|[^"\[\]{}<>=|;.-]|[-.=](?![-.=>]))+?`;
  const direct = String.raw`(<?)(?:--+>|==+>|-\.+-+>)`;
  const inline = String.raw`(<?)(?:--(?![-ox])${linkLabel}--+>|==(?!=)${linkLabel}\s==+>|-\.${linkLabel}\.+-+>)`;
  const link = new RegExp(String.raw`(?:${direct}(?:\s*\|(?:${quoted}|[^"|])*\|)?|${inline})`, 'y');
  const modulePath = /(?:^|[^\p{L}\p{N}\p{M}_./-])([\p{L}\p{N}\p{M}_./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))(?![\p{L}\p{N}\p{M}_./-])/u;
  const moduleFor = text => {
    const match = text.match(modulePath);
    return match ? normalizeRepoPath(match[1]) : null;
  };

  for (const [index, rawLine] of String(block.code ?? '').split(/\r?\n/).entries()) {
    const text = rawLine.trim();
    if (!text || text.startsWith('%%')) continue;
    let cursor = 0;
    if (!hasHeader) {
      const header = /^(?:flowchart|graph)(?:\s+(?:TB|TD|BT|RL|LR))?(?:\s*;\s*|\s*$)/.exec(text);
      if (!header) return {moduleNodes: [], moduleEdges: [], unmeasured: 1};
      hasHeader = true;
      cursor = header[0].length;
    }
    const line = block.startLine + index;
    while (cursor < text.length) {
      node.lastIndex = cursor;
      const first = node.exec(text);
      if (!first) {
        unmeasured += 1;
        break;
      }
      const nodes = [first];
      const links = [];
      cursor = node.lastIndex;
      while (cursor < text.length && text[cursor] !== ';') {
        link.lastIndex = cursor;
        const arrow = link.exec(text);
        if (!arrow) break;
        node.lastIndex = link.lastIndex;
        const next = node.exec(text);
        if (!next) break;
        nodes.push(next);
        links.push(arrow);
        cursor = node.lastIndex;
      }
      if (cursor < text.length && text[cursor] !== ';') {
        unmeasured += 1;
        break;
      }
      for (const [, nodeId, ...labels] of nodes) {
        const path = moduleFor(labels.find(value => value !== undefined) ?? '');
        if (path) moduleNodes.push({nodeId, modulePath: path, line, rawLine: text});
      }
      chains.push({ids: nodes.map(match => match[1]), links, line, rawLine: text});
      cursor += 1;
    }
  }

  const modulesById = new Map();
  for (const {nodeId, modulePath: path} of moduleNodes) {
    if (!modulesById.has(nodeId)) modulesById.set(nodeId, path);
    else if (modulesById.get(nodeId) !== path) modulesById.set(nodeId, null);
  }
  const resolveId = value => modulesById.has(value) ? modulesById.get(value) : moduleFor(value);
  const moduleEdges = [];
  for (const {ids, links, line, rawLine} of chains) {
    for (const [index, arrow] of links.entries()) {
      const from = resolveId(ids[index]);
      const to = resolveId(ids[index + 1]);
      if (!from || !to) {
        if (from || to || modulesById.has(ids[index]) || modulesById.has(ids[index + 1])) unmeasured += 1;
        continue;
      }
      moduleEdges.push({from, to, line, rawLine});
      if ((arrow[1] || arrow[2]) && from !== to) moduleEdges.push({from: to, to: from, line, rawLine});
    }
  }
  return {moduleNodes, moduleEdges, unmeasured};
}

/**
 * Analisa o relatório JSON e o diagrama Mermaid gerados pelo dependency-cruiser e
 * confere o grafo real contra os diagramas de arquitetura documentados no repositório.
 */
export function parseDepcruiseReport(rawJson, generatedMermaid, repoRoot, mermaidBlocks = [], readFileFn = () => '', resolutionPartial = false, validDocumentBlocks) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  if (!data || typeof data !== 'object' || !Array.isArray(data.modules)) {
    throw new Error('Saída JSON do dependency-cruiser inválida: campo modules ausente');
  }

  const findings = [];
  const perFileCoverage = [];
  const realModules = new Set();
  const realEdges = new Map(); // from -> Set(to)
  const incompleteSources = new Set();
  const environmentIssues = data.summary?.environment?.issues?.length > 0;
  const canCompare = !resolutionPartial && !environmentIssues;
  let totalDependencies = 0;
  let unresolvedCount = 0;
  let circularCount = 0;

  const resolveModuleAlias = modCandidate => {
    const norm = normalizeRepoPath(modCandidate, repoRoot);
    if (realModules.has(norm)) return norm;
    if (norm.includes('/') || norm === '.') return null;
    const candidates = [...realModules].filter(file => posix.basename(file) === norm);
    return candidates.length === 1 ? candidates[0] : null;
  };

  for (const mod of data.modules) {
    if (!mod || typeof mod !== 'object' || typeof mod.source !== 'string') continue;
    if (mod.coreModule || mod.couldNotResolve) continue;
    const srcRel = normalizeRepoPath(mod.source, repoRoot);
    if (srcRel === '.' || srcRel.startsWith('node_modules/')) continue;

    realModules.add(srcRel);
    if (!realEdges.has(srcRel)) realEdges.set(srcRel, new Set());

    const deps = Array.isArray(mod.dependencies) ? mod.dependencies : [];
    if (!Array.isArray(mod.dependencies) || mod.matchesDoNotFollow || mod.followable === false) incompleteSources.add(srcRel);
    const dependents = Array.isArray(mod.dependents) ? mod.dependents : [];
    let localDepsCount = 0;

    let fileText = '';
    const getFileText = () => {
      if (!fileText) {
        try {
          fileText = String(readFileFn(srcRel) ?? '');
        } catch {
          fileText = '';
        }
      }
      return fileText;
    };

    for (const dep of deps) {
      const resolved = typeof dep?.resolved === 'string' && dep.resolved.length > 0;
      if (!dep || typeof dep !== 'object' || (!dep.coreModule && !dep.couldNotResolve && !resolved)) {
        incompleteSources.add(srcRel);
        continue;
      }
      totalDependencies += 1;

      if (dep.resolved && !dep.coreModule && !dep.couldNotResolve) {
        const targetRel = normalizeRepoPath(dep.resolved, repoRoot);
        if (targetRel !== '.' && !targetRel.startsWith('node_modules/')) {
          realEdges.get(srcRel).add(targetRel);
          localDepsCount += 1;
        }
      }

      if (dep.couldNotResolve) incompleteSources.add(srcRel);
      const depSpec = String(dep.module ?? '');
      if (canCompare && dep.couldNotResolve && depSpec.startsWith('.')) {
        unresolvedCount += 1;
        const line = findLineInText(getFileText(), depSpec);
        findings.push({
          tool: 'dependency-cruiser',
          rule: 'DOC-DEPCRUISE-IMPORT-NAO-RESOLVIDO',
          file: srcRel,
          line,
          severity: 'alta',
          message: `Importação local "${depSpec}" em ${srcRel} ficou sem resolução no grafo estático.`,
          evidence: `dependency-cruiser couldNotResolve=true: ${srcRel} -> ${depSpec}`,
        });
      }

      if (dep.circular) {
        circularCount += 1;
        const cyclePath = Array.isArray(dep.cycle)
          ? dep.cycle.map(c => normalizeRepoPath(c?.name ?? c, repoRoot)).join(' -> ')
          : `${srcRel} <-> ${normalizeRepoPath(dep.resolved ?? depSpec, repoRoot)}`;
        const line = findLineInText(getFileText(), depSpec);
        findings.push({
          tool: 'dependency-cruiser',
          rule: 'DOC-DEPCRUISE-CICLO-DEPENDENCIA',
          file: srcRel,
          line,
          severity: 'media',
          message: `Ciclo de dependência detectado pelo dependency-cruiser a partir de ${srcRel}: ${cyclePath}.`,
          evidence: `dependency-cruiser circular=true: ${cyclePath}`,
        });
      }
    }

    perFileCoverage.push({
      file: srcRel,
      deps: localDepsCount,
      dependents: dependents.length,
      orphan: Boolean(mod.orphan),
    });
  }

  // Confere arestas documentadas nos diagramas Mermaid contra o grafo real do dependency-cruiser
  let checkedEdges = 0;
  const checkedEdgesByFile = new Map();
  let edgeMismatches = 0;
  let skippedEdges = 0;
  const skippedEdgesByFile = new Map();
  const unmeasuredByFile = new Map();
  for (const block of mermaidBlocks) {
    if (!checkedEdgesByFile.has(block.file)) checkedEdgesByFile.set(block.file, 0);
    const {moduleEdges, unmeasured} = extractMermaidModuleReferences(block);
    const valid = !validDocumentBlocks || validDocumentBlocks.has(block);
    const unknown = valid ? unmeasured : Math.max(1, unmeasured);
    unmeasuredByFile.set(block.file, (unmeasuredByFile.get(block.file) ?? 0) + unknown);
    for (const edge of moduleEdges) {
      const resolvedFrom = resolveModuleAlias(edge.from);
      const resolvedTo = resolveModuleAlias(edge.to);
      if (!valid || !canCompare || !resolvedFrom || !resolvedTo || incompleteSources.has(resolvedFrom)) {
        skippedEdges += 1;
        skippedEdgesByFile.set(block.file, (skippedEdgesByFile.get(block.file) ?? 0) + 1);
        continue;
      }
      checkedEdges += 1;
      checkedEdgesByFile.set(block.file, checkedEdgesByFile.get(block.file) + 1);
      if (!realEdges.get(resolvedFrom)?.has(resolvedTo)) {
        edgeMismatches += 1;
        findings.push({
          tool: 'dependency-cruiser',
          rule: 'DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE',
          file: block.file,
          line: edge.line,
          severity: 'alta',
          message: `Diagrama em ${block.file} documenta a dependência "${edge.from} -> ${edge.to}", que não existe no grafo real extraído pelo dependency-cruiser.`,
          evidence: `aresta documentada: ${edge.rawLine} | módulos reais de ${edge.from}: [${[...(realEdges.get(resolvedFrom) ?? [])].join(', ')}]`,
        });
      }
    }
  }

  const hasMermaidDiagram = typeof generatedMermaid === 'string' && generatedMermaid.trim().startsWith('flowchart');

  return {
    findings,
    perFileCoverage,
    checkedEdgesByFile,
    skippedEdgesByFile,
    unmeasuredByFile,
    stats: {
      totalModules: realModules.size,
      totalDependencies,
      unresolvedCount,
      circularCount,
      checkedEdges,
      skippedEdges,
      unmeasured: [...unmeasuredByFile.values()].reduce((total, count) => total + count, 0),
      edgeMismatches,
      hasMermaidDiagram,
    },
  };
}

/**
 * Valida a sintaxe de todos os blocos Mermaid da documentação e do diagrama gerado do código,
 * além de verificar se nós de módulos citados nos diagramas existem no repositório.
 */
export async function validateMermaidDocuments(docFiles, mermaidBlocks, repoFilesSet, mermaidParseFn, generatedMermaid = '') {
  const findings = [];
  const perFileStats = new Map();
  const validDocumentBlocks = new Set();
  for (const docFile of docFiles) {
    perFileStats.set(docFile, {blocks: 0, valid: 0, invalid: 0, moduleRefsChecked: 0});
  }

  let validBlocks = 0;
  let invalidBlocks = 0;
  let generatedDiagramValid = null;
  let generatedDiagramError = '';

  if (typeof generatedMermaid === 'string' && generatedMermaid.trim()) {
    try {
      await mermaidParseFn(generatedMermaid);
      generatedDiagramValid = true;
    } catch (err) {
      generatedDiagramValid = false;
      generatedDiagramError = err instanceof Error ? err.message : String(err);
    }
  }

  const hasRepoFile = modPath => {
    const norm = normalizeRepoPath(modPath);
    if (repoFilesSet.has(norm)) return true;
    if (norm.includes('/') || norm === '.') return false;
    for (const candidate of repoFilesSet) {
      if (posix.basename(candidate) === norm) {
        return true;
      }
    }
    return false;
  };

  for (const block of mermaidBlocks) {
    const fileStat = perFileStats.get(block.file) ?? {blocks: 0, valid: 0, invalid: 0, moduleRefsChecked: 0};
    fileStat.blocks += 1;
    perFileStats.set(block.file, fileStat);

    try {
      await mermaidParseFn(block.code);
    } catch (err) {
      if (err instanceof ReferenceError || err instanceof TypeError || err instanceof RangeError) throw err;
      invalidBlocks += 1;
      fileStat.invalid += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      const lineMatch = errMsg.match(/Parse error on line (\d+)/i);
      const relLine = lineMatch ? Math.max(1, Number(lineMatch[1])) : 1;
      const exactLine = block.startLine + Math.min(relLine, block.code.split(/\r?\n/).length) - 1;
      findings.push({
        tool: 'mermaid',
        rule: 'DOC-MERMAID-SINTAXE-INVALIDA',
        file: block.file,
        line: exactLine,
        severity: 'media',
        message: `Bloco Mermaid em ${block.file}:${exactLine} foi rejeitado pelo parser.`,
        evidence: errMsg.replace(/\s+/g, ' ').trim().slice(0, 240),
      });
      continue;
    }
    validBlocks += 1;
    fileStat.valid += 1;
    validDocumentBlocks.add(block);

    const {moduleNodes} = extractMermaidModuleReferences(block);
    const seenMissing = new Set();
    for (const nodeRef of moduleNodes) {
      fileStat.moduleRefsChecked += 1;
      if (!hasRepoFile(nodeRef.modulePath) && !seenMissing.has(`${nodeRef.line}:${nodeRef.modulePath}`)) {
        seenMissing.add(`${nodeRef.line}:${nodeRef.modulePath}`);
        findings.push({
          tool: 'mermaid',
          rule: 'DOC-MERMAID-MODULO-INEXISTENTE',
          file: block.file,
          line: nodeRef.line,
          severity: 'media',
          message: `Diagrama Mermaid em ${block.file} referencia o arquivo/módulo "${nodeRef.modulePath}", que não existe no repositório.`,
          evidence: nodeRef.rawLine,
        });
      }
    }
  }

  return {
    findings,
    perFileStats,
    validDocumentBlocks,
    stats: {
      totalDocFiles: docFiles.length,
      totalBlocks: mermaidBlocks.length,
      validBlocks,
      invalidBlocks,
      generatedDiagramValid,
      generatedDiagramError,
    },
  };
}

function appendArtifact(coverage, tool, version, file, text) {
  // Keep envelope tokens short as well as payload tokens: the runtime sanitizes
  // coverage details before the report can assemble them.
  const envelope = fields => JSON.stringify(fields, null, 1).replaceAll('\n', '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    coverage.push({
      tool, version, status: 'skipped',
      detail: envelope({artifact: file, encoding: ARTIFACT_ENCODING, reason: 'size-limit'}),
    });
    return;
  }
  const parts = Math.ceil(bytes.length / ARTIFACT_PART_BYTES);
  for (let part = 0; part < parts; part += 1) {
    const hex = bytes.subarray(part * ARTIFACT_PART_BYTES, (part + 1) * ARTIFACT_PART_BYTES).toString('hex');
    const data = hex.match(/.{1,16}/g).join(' ');
    coverage.push({
      tool,
      version,
      status: 'ok',
      detail: envelope({artifact: file, encoding: ARTIFACT_ENCODING, part: part + 1, parts, data}),
    });
  }
}

function isReportablePath(file) {
  return file.length <= 400 && !/[^A-Za-z0-9._@+\/-]/.test(file) && file.split('/').every(part =>
    part !== '' && part !== '.' && part !== '..' && part !== '.git' && part !== '.github'
    && part !== '.ai' && part !== 'node_modules' && !part.startsWith('.env')
    && !FORBIDDEN_REPORT_SEGMENTS.has(part.toLowerCase()),
  );
}

function boundedText(value, limit = MAX_DETAIL_CHARS) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .trim().slice(0, limit).toWellFormed() || 'sem detalhe';
}

function boundCollectorOutput(coverage, findings) {
  // Reserve espaço para pontuação do JSON e para uma linha que sinalize os cortes.
  let bytesRemaining = MAX_STDOUT_BYTES - 512;
  const rowBytes = row => Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
  const isSummary = row => row.tool.endsWith(':artefato')
    || !row.tool.includes(':')
    || (row.tool === 'documentacao:input' && row.status !== 'skipped');
  const retainedCoverage = coverage.map(row =>
    row.tool.endsWith(':artefato') ? row : {...row, detail: boundedText(row.detail)},
  );
  const summaries = retainedCoverage.filter(isSummary);
  for (const row of summaries) bytesRemaining -= rowBytes(row);
  let coverageSlots = MAX_COVERAGE_ROWS - summaries.length - 1;

  const retainedFindings = [];
  for (const finding of findings) {
    if (retainedFindings.length === MAX_FINDINGS) break;
    if (!isReportablePath(finding.file)) continue;
    const row = {
      ...finding,
      line: Math.min(finding.line, 10_000_000),
      message: boundedText(finding.message),
      evidence: boundedText(finding.evidence),
    };
    const bytes = rowBytes(row);
    if (bytes > bytesRemaining) break;
    bytesRemaining -= bytes;
    retainedFindings.push(row);
  }

  const selectedCoverage = retainedCoverage.filter(row => {
    if (isSummary(row)) return true;
    const bytes = rowBytes(row);
    if (coverageSlots === 0 || bytes > bytesRemaining) return false;
    coverageSlots -= 1;
    bytesRemaining -= bytes;
    return true;
  });
  const omittedCoverage = coverage.length - selectedCoverage.length;
  const omittedFindings = findings.length - retainedFindings.length;
  if (omittedCoverage || omittedFindings) {
    selectedCoverage.push({
      tool: 'documentacao:limites', version: '1', status: omittedFindings ? 'failed' : 'skipped',
      detail: `linhas_cobertura_omitidas=${omittedCoverage}; achados_omitidos=${omittedFindings}`,
    });
  }
  return {coverage: selectedCoverage, findings: retainedFindings};
}

function readToolOutput(label, result, outputFile) {
  if (result.error) throw result.error;
  if (result.status !== 0 || !existsSync(outputFile)) {
    const diagnostic = String(result.stderr || result.stdout || '').trim().slice(0, 200);
    throw new Error(`${label}: status=${result.status ?? result.signal ?? 'desconhecido'}; arquivo_gerado=${existsSync(outputFile)}; ${diagnostic}`);
  }
  const output = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(readFileSync(outputFile));
  if (!output.trim()) throw new Error(`${label}: arquivo gerado vazio`);
  return output;
}

/**
 * Executa o coletor completo do módulo 8 (documentação viva).
 */
export async function runCollector(opts = {}) {
  const repoDir = resolve(opts.repoDir ?? '/repo');
  const tmpBase = resolve(opts.tmpBase ?? process.env.TMPDIR ?? '/tmp');
  const toolsRoot = resolve(opts.toolsRoot ?? MODULE_DIR);
  const execFn = opts.execFn ?? spawnSync;
  const bin = name => join(toolsRoot, 'node_modules', '.bin', name);

  const versions = {
    typedoc: readPackageVersion('typedoc', toolsRoot),
    depcruise: readPackageVersion('dependency-cruiser', toolsRoot),
    mermaid: readPackageVersion('mermaid', toolsRoot),
  };

  const workRoot = mkdtempSync(join(tmpBase, 'ac-doc-work-'));
  const workRepoDir = join(workRoot, 'repo');
  const workCfgDir = join(workRoot, 'cfg');
  const workOutDir = join(workRoot, 'out');
  mkdirSync(workRepoDir, {recursive: true});
  mkdirSync(workCfgDir, {recursive: true});
  mkdirSync(workOutDir, {recursive: true});

  const coverage = [];
  const findings = [];

  try {
    const {copiedFiles, skipped} = copyRepoSafely(repoDir, workRepoDir, opts);
    coverage.push({
      tool: 'documentacao:input',
      version: '1',
      status: 'ok',
      detail: `arquivos_copiados=${copiedFiles.length}; entradas_omitidas=${skipped.length}`,
    });
    for (const file of skipped) {
      coverage.push({tool: 'documentacao:input', version: '1', status: 'skipped', detail: `entrada=${JSON.stringify(file)}`});
    }
    const toolOptions = {
      cwd: workRepoDir,
      env: {PATH: dirname(process.execPath) + ':/usr/local/bin:/usr/bin:/bin', HOME: workRoot, TMPDIR: workRoot, NO_COLOR: '1'},
      encoding: 'utf8',
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    };
    const repoFilesSet = new Set(copiedFiles);
    const readWorkFile = rel => readFileSync(join(workRepoDir, rel), 'utf8');

    const resolutionGap = measureResolutionCoverage(copiedFiles, skipped, readWorkFile);
    if (resolutionGap) coverage.push({
      tool: 'dependency-cruiser:resolucao', version: versions.depcruise, status: 'skipped',
      detail: `cobertura parcial: ${resolutionGap}; arestas documentadas não são comparadas`,
    });

    const codeFiles = copiedFiles.filter(
      f =>
        JS_TS_EXTS.has(extname(f).toLowerCase()) &&
        !/\.d\.[cm]?ts$/i.test(f) &&
        !/(^|\/)(tests?|__tests__|fixtures?)\//i.test(f) &&
        !/\.(test|spec)\.[^.]+$/i.test(f),
    );
    const docFiles = copiedFiles.filter(f => DOC_EXTS.has(extname(f).toLowerCase()));
    const mdFiles = docFiles.filter(f => {
      const ext = extname(f).toLowerCase();
      return ext === '.md' || ext === '.markdown';
    });

    const mermaidBlocks = extractMermaidBlocks(docFiles, readWorkFile);

    // 1. TypeDoc
    if (codeFiles.length === 0) {
      coverage.push({
        tool: 'typedoc',
        version: versions.typedoc,
        status: 'skipped',
        detail: 'nenhum arquivo TypeScript/JavaScript de código para geração e validação TypeDoc',
      });
    } else {
      try {
        const safeTsConfigPath = sanitizeTsConfigInWork(workRepoDir, codeFiles);
        const typedocOutPath = join(workOutDir, 'typedoc.json');
        const typedocCfgPath = join(workCfgDir, 'typedoc.options.json');
        const typedocOptions = {
          plugin: [],
          readme: 'none',
          excludePrivate: true,
          basePath: workRepoDir,
          tsconfig: safeTsConfigPath,
          entryPointStrategy: 'resolve',
          entryPoints: codeFiles.map(rel => join(workRepoDir, rel)),
          json: typedocOutPath,
          validation: {
            notExported: true,
            invalidLink: true,
            rewrittenLink: true,
            notDocumented: true,
            unusedMergeModuleWith: true,
          },
          requiredToBeDocumented: [
            'Enum',
            'EnumMember',
            'Variable',
            'Function',
            'Class',
            'Interface',
            'Method',
            'Accessor',
            'TypeAlias',
          ],
          skipErrorChecking: true,
        };
        writeFileSync(typedocCfgPath, JSON.stringify(typedocOptions, null, 2));

        const tdRes = execFn(bin('typedoc'), ['--options', typedocCfgPath], toolOptions);
        const reflection = readToolOutput('TypeDoc JSON', tdRes, typedocOutPath);
        const parsedTd = parseTypedocReport(
          reflection,
          `${tdRes.stdout ?? ''}\n${tdRes.stderr ?? ''}`,
          workRepoDir,
          readWorkFile,
        );
        const symbols = parsedTd.symbols.filter(symbol => repoFilesSet.has(symbol.file));
        const tdFindings = parsedTd.findings.filter(finding => repoFilesSet.has(finding.file));
        const checkedByFile = new Map();
        const mdFindings = crossCheckMarkdownAgainstTypedoc(mdFiles, symbols, readWorkFile, checkedByFile);
        for (const [file, checked] of checkedByFile) {
          coverage.push({
            tool: 'typedoc:markdown',
            version: versions.typedoc,
            status: checked ? 'ok' : 'skipped',
            detail: `arquivo=${file}; assinaturas_conferidas=${checked}`,
          });
        }
        findings.push(...tdFindings, ...mdFindings);
        appendArtifact(coverage, 'typedoc:artefato', versions.typedoc, 'api.json', JSON.stringify(symbols, null, 2));

        const documentedCount = symbols.filter(s => s.hasDoc).length;
        const undocumentedCount = symbols.length - documentedCount;

        coverage.push({
          tool: 'typedoc',
          version: versions.typedoc,
          status: 'ok',
          detail: `arquivos_codigo=${codeFiles.length}, simbolos_exportados=${symbols.length}, documentados=${documentedCount}, sem_doc=${undocumentedCount}, achados_typedoc=${tdFindings.length + mdFindings.length}`,
        });

        const symbolsByFile = new Map();
        for (const symbol of symbols) {
          if (!symbolsByFile.has(symbol.file)) symbolsByFile.set(symbol.file, []);
          symbolsByFile.get(symbol.file).push(symbol);
        }
        for (const codeFile of codeFiles) {
          const fileSyms = symbolsByFile.get(codeFile) ?? [];
          const fileDocSyms = fileSyms.filter(s => s.hasDoc);
          const exportNames = fileSyms.map(s => s.name).join(',') || 'nenhum';
          coverage.push({
            tool: 'typedoc:file',
            version: versions.typedoc,
            status: 'ok',
            detail: `arquivo=${codeFile}; simbolos=${fileSyms.length}; documentados=${fileDocSyms.length}; exports=${exportNames}`,
          });
        }
      } catch (err) {
        coverage.push({
          tool: 'typedoc',
          version: versions.typedoc,
          status: 'failed',
          detail: `falha ao executar typedoc: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        });
      }
    }

    // 2. dependency-cruiser (grafo JSON + geração de diagrama Mermaid do código + conferência contra docs)
    let generatedMermaid = '';
    let graph;
    if (codeFiles.length === 0) {
      coverage.push({
        tool: 'dependency-cruiser',
        version: versions.depcruise,
        status: 'skipped',
        detail: 'nenhum arquivo TypeScript/JavaScript para mapeamento de dependências e geração de diagrama',
      });
    } else {
      try {
        sanitizeTsConfigInWork(workRepoDir, codeFiles);
        const depCfg = JSON.parse(readFileSync(join(MODULE_DIR, 'depcruise.config.json'), 'utf8'));
        depCfg.options = {
          ...depCfg.options,
          tsConfig: {fileName: 'tsconfig.json'},
        };

        const effectiveDepCfgPath = join(workCfgDir, 'depcruise.config.json');
        writeFileSync(effectiveDepCfgPath, JSON.stringify(depCfg, null, 2));

        const depJsonPath = join(workOutDir, 'depcruise.json');
        const depMmdPath = join(workOutDir, 'depcruise.mmd');
        const cruise = (format, file) => readToolOutput(
          `dependency-cruiser ${format}`,
          execFn(
            bin('depcruise'),
            ['--config', effectiveDepCfgPath, '--output-type', format, '--output-to', file, '--', ...codeFiles],
            toolOptions,
          ),
          file,
        );
        const json = cruise('json', depJsonPath);
        generatedMermaid = cruise('mermaid', depMmdPath);
        graph = json;
      } catch (err) {
        coverage.push({
          tool: 'dependency-cruiser',
          version: versions.depcruise,
          status: 'failed',
          detail: `falha ao executar dependency-cruiser: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        });
      }
    }

    let validDocumentBlocks = new Set();
    // 3. Mermaid (validação sintática e estrutural dos diagramas documentados e do diagrama gerado)
    if (mermaidBlocks.length === 0 && !generatedMermaid) {
      coverage.push({
        tool: 'mermaid',
        version: versions.mermaid,
        status: 'skipped',
        detail: 'nenhum bloco Mermaid ou diagrama gerado para validar',
      });
    } else {
      try {
        const mermaidParseFn = opts.mermaidParseFn ?? (await createDefaultMermaidParser(toolsRoot));
        const parsedMermaid = await validateMermaidDocuments(
          docFiles,
          mermaidBlocks,
          repoFilesSet,
          mermaidParseFn,
          generatedMermaid,
        );
        validDocumentBlocks = parsedMermaid.validDocumentBlocks;
        findings.push(...parsedMermaid.findings);

        coverage.push({
          tool: 'mermaid',
          version: versions.mermaid,
          status: parsedMermaid.stats.generatedDiagramValid === false ? 'failed' : 'ok',
          detail: `arquivos_doc=${parsedMermaid.stats.totalDocFiles}, blocos_mermaid=${parsedMermaid.stats.totalBlocks}, validos=${parsedMermaid.stats.validBlocks}, invalidos=${parsedMermaid.stats.invalidBlocks}, diagrama_codigo_valido=${parsedMermaid.stats.generatedDiagramValid ?? 'nao_gerado'}; erro_diagrama_gerado=${parsedMermaid.stats.generatedDiagramError.slice(0, 200)}`,
        });

        for (const [docFile, st] of parsedMermaid.perFileStats) {
          coverage.push({
            tool: 'mermaid:file',
            version: versions.mermaid,
            status: st.blocks > 0 ? 'ok' : 'skipped',
            detail: `arquivo=${docFile}; blocos_mermaid=${st.blocks}; validos=${st.valid}; invalidos=${st.invalid}; referencias_modulos=${st.moduleRefsChecked}`,
          });
        }
      } catch (err) {
        coverage.push({
          tool: 'mermaid',
          version: versions.mermaid,
          status: 'failed',
          detail: `falha ao executar mermaid: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        });
      }
    }

    let comparison;
    if (graph !== undefined) {
      try {
        const parsedDep = parseDepcruiseReport(
          graph, generatedMermaid, workRepoDir, mermaidBlocks, readWorkFile, Boolean(resolutionGap), validDocumentBlocks,
        );
        comparison = parsedDep;
        findings.push(...parsedDep.findings.filter(finding => repoFilesSet.has(finding.file)));
        appendArtifact(coverage, 'dependency-cruiser:artefato', versions.depcruise, 'dependencias.mmd', generatedMermaid);

        coverage.push({
          tool: 'dependency-cruiser',
          version: versions.depcruise,
          status: 'ok',
          detail: `modulos=${parsedDep.stats.totalModules}, dependencias=${parsedDep.stats.totalDependencies}, diagrama_mermaid_gerado=${parsedDep.stats.hasMermaidDiagram ? 'sim' : 'nao'}, arestas_doc_conferidas=${parsedDep.stats.checkedEdges}, arestas_doc_nao_conferidas=${parsedDep.stats.skippedEdges}, trechos_doc_nao_medidos=${parsedDep.stats.unmeasured}, divergencias=${parsedDep.stats.edgeMismatches}`,
        });

        for (const row of parsedDep.perFileCoverage.filter(row => repoFilesSet.has(row.file))) {
          coverage.push({
            tool: 'dependency-cruiser:file',
            version: versions.depcruise,
            status: 'ok',
            detail: `arquivo=${row.file}; deps=${row.deps}; dependentes=${row.dependents}; orfao=${row.orphan ? 'sim' : 'nao'}`,
          });
        }
        const graphedFiles = new Set(parsedDep.perFileCoverage.map(row => row.file));
        for (const file of codeFiles) {
          if (!graphedFiles.has(file)) {
            coverage.push({
              tool: 'dependency-cruiser:file', version: versions.depcruise, status: 'skipped',
              detail: `arquivo=${file}; ausente no grafo gerado`,
            });
          }
        }
      } catch (err) {
        coverage.push({
          tool: 'dependency-cruiser',
          version: versions.depcruise,
          status: 'failed',
          detail: `falha ao ler o grafo do dependency-cruiser: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
        });
      }
    }
    if (mermaidBlocks.length) {
      comparison ??= parseDepcruiseReport(
        {modules: []}, '', workRepoDir, mermaidBlocks, readWorkFile, true, validDocumentBlocks,
      );
      for (const [file, checked] of comparison.checkedEdgesByFile) {
        coverage.push({
          tool: 'dependency-cruiser:diagrama',
          version: versions.depcruise,
          status: checked > 0 ? 'ok' : 'skipped',
          detail: `arquivo=${file}; arestas_doc_conferidas=${checked}; arestas_doc_nao_conferidas=${comparison.skippedEdgesByFile.get(file) ?? 0}; trechos_doc_nao_medidos=${comparison.unmeasuredByFile.get(file) ?? 0}`,
        });
      }
    }

    return boundCollectorOutput(coverage, findings);
  } catch (err) {
    coverage.push({
      tool: 'documentacao:input',
      version: '1',
      status: 'failed',
      detail: boundedText(err instanceof Error ? err.message : String(err), 300),
    });
    return boundCollectorOutput(coverage, findings);
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
  runCollector()
    .then(result => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch(err => {
      const detail = boundedText(err instanceof Error ? err.message : String(err), 300);
      const coverage = [{tool: 'documentacao', version: '1', status: 'failed', detail}];
      process.stdout.write(`${JSON.stringify({coverage, findings: []})}\n`);
    });
}
