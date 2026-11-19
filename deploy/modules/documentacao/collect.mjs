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
const TYPEDOC_DIAGNOSTIC_VERSION = '0.28.20';
const MERMAID_DIAGNOSTIC_VERSION = '12.3.0';
const DECLARATION_MAP = /\.d\.[cm]?ts\.map$/;
const TYPEDOC_SIGNATURE_KINDS = new Set([4096, 16384, 524288, 1048576]);
const TYPEDOC_MEMBER_CONTAINER_KINDS = new Set([8, 128, 256]); // Enum, Class, Interface
const TYPEDOC_DOCUMENTATION_KINDS = new Map([
  ['Enum', 8], ['EnumMember', 16], ['Variable', 32], ['Function', 64], ['Class', 128],
  ['Interface', 256], ['Method', 2048], ['CallSignature', 4096], ['ConstructorSignature', 16384],
  ['Accessor', 262144], ['GetSignature', 524288], ['SetSignature', 1048576], ['TypeAlias', 2097152],
]);
const TYPEDOC_LINK_TAGS = new Set(['@link', '@linkcode', '@linkplain']);
const TYPEDOC_DIRECT_LINK_BLOCKS = new Set(['', '@see', '@returns', '@throws']);

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
const mermaidErrorLines = new WeakMap();
let mermaidParseQueue = Promise.resolve();

function enqueueMermaidParse(work) {
  // Mermaid shares parser and configuration state across concurrent collectors.
  const result = mermaidParseQueue.then(work);
  mermaidParseQueue = result.catch(() => {});
  return result;
}

export function createDefaultMermaidParser(toolsRoot = MODULE_DIR) {
  if (!mermaidParsers.has(toolsRoot)) {
    mermaidParsers.set(toolsRoot, enqueueMermaidParse(() => loadMermaidParser(toolsRoot)));
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
    const probe = await mermaid.mermaidAPI.getDiagramFromText('flowchart LR\n  A["módulo"] --> B');
    const parser = probe.getParser()?.parser;
    return code => enqueueMermaidParse(async () => {
      if (typeof parser?.parse !== 'function') return mermaid.parse(code);
      const parse = parser.parse;
      let parserInput;
      let graph;
      parser.parse = function (source, ...args) {
        const db = this.yy;
        if (typeof db?.getVertices !== 'function' || typeof db?.getEdges !== 'function' || typeof db?.getSubGraphs !== 'function'
          || typeof this.performAction !== 'function') return parse.call(this, source, ...args);
        parserInput = source;
        const observed = Object.create(this);
        const positions = trackFlowchartPositions(observed, db);
        const parsed = parse.call(observed, source, ...args);
        const subgraphIds = new Set(db.getSubGraphs().map(group => group.id));
        graph = {source, vertices: db.getVertices(), edges: db.getEdges(), subgraphIds, ...positions};
        return parsed;
      };
      try {
        return {...await mermaid.parse(code), graph};
      } catch (err) {
        if (err instanceof Error && parserInput !== undefined) {
          const matches = matchMermaidSourceLines(parserInput, code.split(/\r\n?|\n/));
          const {line, loc, text} = err.hash ?? {};
          const lastMappedLine = [...matches.keys()].at(-1);
          // An EOF after a single-line token can point to the added newline.
          const finalTokenLine = text === '' && lastMappedLine === loc?.first_line - 1 ? lastMappedLine : undefined;
          mermaidErrorLines.set(err, matches.get(line) ?? matches.get(finalTokenLine) ?? null);
        }
        throw err;
      } finally {
        parser.parse = parse;
      }
    });
  } catch (err) {
    window.close();
    throw err;
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

function trackFlowchartPositions(parser, db) {
  const labels = new Map();
  const edgeLines = [];
  const action = parser.performAction;
  let line;
  let instrumented = false;
  // The pinned flowchart parser exposes Jison locations on reductions, but
  // FlowDB discards them. Observe its calls without changing the parsed graph.
  parser.performAction = function (...args) {
    line = this._$?.first_line;
    if (!instrumented) {
      instrumented = true;
      const yy = args[3];
      const vertices = db.getVertices();
      const addVertex = yy.addVertex;
      const addLink = yy.addLink;
      yy.addVertex = (id, label, type, style, classes, direction, props, metadata) => {
        const before = vertices.get(id)?.text;
        addVertex(id, label, type, style, classes, direction, props, metadata);
        const vertex = vertices.get(id);
        if (!vertex) return;
        if (label && metadata === undefined) {
          labels.set(id, {line, text: label.text.trim() === vertex.text ? vertex.text : null});
        } else if (metadata !== undefined && vertex.text !== before) {
          labels.set(id, {line, text: vertex.text !== id ? vertex.text : null});
        }
      };
      yy.addLink = (...linkArgs) => {
        const edges = db.getEdges();
        const start = edges.length;
        addLink(...linkArgs);
        for (let index = start; index < edges.length; index += 1) edgeLines[index] = line;
      };
    }
    return action.apply(this, args);
  };
  return {labels, edgeLines};
}

/**
 * Copia apenas arquivos regulares e diretórios seguros de sourceRoot para destRoot,
 * ignorando symlinks, sockets, dispositivos, diretórios de build/vendor, configurações
 * executáveis não confiáveis e arquivos > 2 MiB.
 */
export function copyRepoSafely(sourceRoot, destRoot, opts = {}, manifestScripts = new Map()) {
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
          (!JS_TS_EXTS.has(ext) && !DOC_EXTS.has(ext) && ext !== '.json' && !DECLARATION_MAP.test(entry.name))
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
          if (manifest.scripts && typeof manifest.scripts === 'object') manifestScripts.set(relPath, manifest.scripts);
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

function loadTypeScript(toolsRoot = MODULE_DIR) {
  try {
    const ts = createRequire(join(toolsRoot, 'package.json'))('typescript');
    return typeof ts.createSourceFile === 'function' ? ts : null;
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND') throw err;
    return null;
  }
}

const isDefaultConfig = file => /(^|\/)(?:ts|js)config\.json$/.test(file);

function manifestWord(parts, quoted = false) {
  let value = '';
  for (const part of parts) {
    if (part.type === 'SglQuoted' && !part.dollar) {
      value += part.value;
    } else if (part.type === 'DblQuoted' && !part.dollar) {
      const inner = manifestWord(part.parts, true);
      if (inner === null) return null;
      value += inner;
    } else if (part.type === 'Lit') {
      // Conservative for shell escapes, glob expansion and tilde expansion.
      if (part.value.includes('\\') || (!quoted && /[*?\[\]{}~]/.test(part.value))) return null;
      value += part.value;
    } else {
      return null;
    }
  }
  return value;
}

function manifestTypeScriptCommands(script, toolsRoot) {
  const invocations = [];
  let cwdChanged = false;
  const outerDirectoryChanges = [];
  const isolatesDirectory = node => node.type === 'Subshell' || node.type === 'CmdSubst'
    || (node.type === 'Stmt' && node.background);
  try {
    const {parse, walk, LangVariant} = createRequire(join(toolsRoot, 'package.json'))('sh-syntax/sync');
    if (Buffer.byteLength(script) > 64 * 1024) return [null];
    const ast = parse(script, {variant: LangVariant.LangPOSIX});
    const inspect = node => {
      if (isolatesDirectory(node)) outerDirectoryChanges.push(cwdChanged);
      if (node.type !== 'CallExpr' || !node.args.length) return;
      const words = node.args.map(word => manifestWord(word.parts));
      if (words[0] === null) {
        invocations.push(null);
        return;
      }
      let [bin, ...args] = words;
      while (bin === 'command' || bin === 'exec') {
        if (bin === 'command') {
          while (args[0] === '-p') args.shift();
          if (/^-[pvV]*[vV][pvV]*$/.test(args[0] ?? '')) return;
        }
        if (args[0] === '--') args.shift();
        const executable = args.shift();
        if (executable === null || executable?.startsWith('-')) {
          invocations.push(null);
          return;
        }
        bin = executable ?? '';
      }
      if (['cd', 'pushd', 'popd'].includes(bin)) cwdChanged = true;
      bin = posix.basename(bin);
      if (bin === 'node' && /(?:^|\/)typescript\/(?:bin\/tsc|lib\/tsc\.js)$/.test(args[0] ?? '')) {
        [bin, ...args] = ['tsc', ...args.slice(1)];
      } else if (['npx', 'npm', 'pnpm', 'yarn', 'bun'].includes(bin)) {
        if (bin === 'npm' && args[0] !== 'exec') return;
        while (['exec', 'x', 'dlx', '--', '--no-install'].includes(args[0])) args.shift();
        const executable = args.shift();
        if (executable === null) { invocations.push(null); return; }
        bin = posix.basename(executable ?? '');
      }
      if (bin !== 'tsc') return;
      const dynamicEnv = node.assigns.some(assignment => assignment.array ||
        (assignment.value && manifestWord(assignment.value.parts) === null));
      invocations.push(cwdChanged || dynamicEnv || args.some(arg => arg === null || arg.startsWith('@')) ? null : args);
    };
    walk(ast, {
      enter: inspect,
      exit(node) {
        if (isolatesDirectory(node)) cwdChanged = outerDirectoryChanges.pop();
      },
    });
    return invocations;
  } catch {
    return [null];
  }
}

function measureResolutionCoverage(copiedFiles, skipped, readFile, manifestScripts, toolsRoot) {
  if (skipped.some(file => isDefaultConfig(file) || file === 'LIMITE_ARQUIVOS' || file.endsWith('/[ilegivel]')
    || JS_TS_EXTS.has(extname(file).toLowerCase()) || posix.basename(file) === 'package.json')) {
    return 'arquivo de código, manifesto ou configuração omitido do snapshot';
  }

  const entries = new Set(copiedFiles);
  const projects = new Set(copiedFiles.filter(isDefaultConfig));
  if (!projects.size && !manifestScripts.size) return '';
  const ts = loadTypeScript(toolsRoot);
  const projectPath = (base, name, buildOrReference = false) => {
    if (typeof name !== 'string' || !name.trim() || /^[A-Za-z]:/.test(name) || posix.isAbsolute(toPosix(name))) return null;
    const file = posix.join(base, toPosix(name));
    if (file === '..' || file.startsWith('../')) return null;
    if (buildOrReference) return ts.resolveProjectReferencePath({path: file});
    // --project accepts any file name or a directory containing tsconfig.json.
    return entries.has(file) ? file : posix.join(file, 'tsconfig.json');
  };

  for (const [manifest, scripts] of manifestScripts) {
    for (const [name, script] of Object.entries(scripts)) {
      if (typeof script !== 'string') continue;
      for (const args of manifestTypeScriptCommands(script, toolsRoot)) {
        const origin = `script ${JSON.stringify(name)} de ${manifest}`;
        if (!args || !ts) return `comando TypeScript não analisado em ${origin}`;
        const build = ['-b', '--build'].includes(args[0]?.toLowerCase());
        const parsed = build ? ts.parseBuildCommand(args) : ts.parseCommandLine(args, () => undefined);
        if (parsed.errors.length) return `argumentos TypeScript não analisados em ${origin}`;
        if (!build && (parsed.fileNames.length
          || Object.keys(parsed.options).some(option => option !== 'project' && !TYPE_CHECK_ONLY_OPTIONS.has(option)))) {
          return `argumentos TypeScript fora da configuração isolada em ${origin}`;
        }
        const paths = build ? parsed.projects : [parsed.options.project ?? '.'];
        for (const path of paths) {
          const selected = projectPath(posix.dirname(manifest), path, build);
          if (!selected || !entries.has(selected)) {
            // A direct `tsc` without a config may search parent directories. A
            // parent project is already selected by its conventional name.
            if (!build && parsed.options.project === undefined && copiedFiles.some(file => {
              const dir = posix.dirname(file);
              return posix.basename(file) === 'tsconfig.json' && (dir === '.' || manifest.startsWith(dir + '/'));
            })) continue;
            return `projeto ${JSON.stringify(path)} indisponível em ${origin}`;
          }
          projects.add(selected);
        }
      }
    }
  }
  if (!projects.size) return '';
  if (!ts) return 'parser TypeScript indisponível para ler a configuração';

  const cached = new Map();
  const active = new Set();
  function collectConfig(file) {
    if (active.has(file)) throw new Error(`ciclo de configuração em ${file}`);
    if (cached.has(file)) return cached.get(file);
    if (!entries.has(file)) throw new Error(`configuração indisponível em ${file}`);
    active.add(file);
    const {config, error} = ts.parseConfigFileTextToJson(file, readFile(file));
    if (error || !config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(`configuração não analisada em ${file}`);
    }

    let options = {};
    if (Object.hasOwn(config, 'extends')) {
      const parents = Array.isArray(config.extends) ? config.extends : [config.extends];
      for (const path of parents) {
        const relative = typeof path === 'string' ? toPosix(path) : '';
        if (!/^\.\.?\//.test(relative)) throw new Error(`extends não local em ${file}`);
        const parent = posix.join(posix.dirname(file), relative);
        const selected = entries.has(parent) || parent.endsWith('.json') ? parent : parent + '.json';
        if (!entries.has(selected)) throw new Error(`extends indisponível em ${file}`);
        options = {...options, ...collectConfig(selected).options};
      }
    }
    if (Object.hasOwn(config, 'compilerOptions')) {
      const {compilerOptions} = config;
      if (!compilerOptions || typeof compilerOptions !== 'object' || Array.isArray(compilerOptions)) {
        throw new Error(`compilerOptions não analisado em ${file}`);
      }
      options = {...options, ...compilerOptions};
    }

    active.delete(file);
    const project = {options, references: Object.hasOwn(config, 'references') ? config.references : []};
    cached.set(file, project);
    return project;
  }

  let hasReferences = false;
  let implicitMode = '';
  for (const file of projects) {
    let project;
    try {
      project = collectConfig(file);
    } catch (err) {
      return err.message;
    }
    const {options, references} = project;
    if (!Array.isArray(references)) return `references não analisado em ${file}`;
    for (const ref of references) {
      hasReferences = true;
      // TypeScript references use .json files or project directories.
      const target = projectPath(posix.dirname(file), ref?.path, true);
      if (!target || !entries.has(target)) return `references indisponível em ${file}`;
      projects.add(target);
    }
    // Only settings known to match the snapshot or unrelated to resolution are measured.
    const changed = Object.entries(options).find(([key, value]) => {
      if (TYPE_CHECK_ONLY_OPTIONS.has(key)) return typeof value !== 'boolean';
      const expected = SNAPSHOT_COMPILER_OPTIONS[key];
      return typeof expected === 'string'
        ? typeof value !== 'string' || value.toLowerCase() !== expected.toLowerCase()
        : !Object.hasOwn(SNAPSHOT_COMPILER_OPTIONS, key) || !isDeepStrictEqual(value, expected);
    });
    if (changed) return `opção ${JSON.stringify(changed[0])} em ${file}`;
    if (!Object.hasOwn(options, 'module') || !Object.hasOwn(options, 'moduleResolution')) {
      implicitMode ||= `modo de resolução implícito em ${file}`;
    }
  }
  return hasReferences ? 'limites entre projetos com references não medidos no snapshot' : implicitMode;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalTypedocTags(comment) {
  if (!comment.startsWith('/**') || !comment.endsWith('*/')) return null;
  const lines = comment.slice(3, -2).split('\n');
  const tags = [];
  // Keep only unambiguous source spans to corroborate the parser and reflection.
  const inline = /(?<!`)`[^`\\]+`(?!`)|\{(@link(?:code|plain)?)[ \t]+([^\s{}\\`]+)[ \t]*\}/g;
  let margin;
  let offset = 3;
  let fenced = false;
  let blockTag = '';
  for (const [index, rawLine] of lines.entries()) {
    const lineOffset = offset;
    offset += rawLine.length + 1;
    const raw = rawLine.replace(/\r$/, '');
    if (/[\\\r\u2028\u2029]/.test(raw)) return null;
    const prefix = raw.match(index === 0 ? /^[ \t]*/ : /^([ \t]*)\*(?: |$)/);
    if (!prefix) {
      if (index === lines.length - 1 && /^[ \t]*$/.test(raw)) break;
      return null;
    }
    if (index > 0) {
      margin ??= prefix[1];
      if (margin !== prefix[1]) return null;
    }
    const body = raw.slice(prefix[0].length);
    if (fenced) {
      if (/^```[ \t]*$/.test(body)) fenced = false;
      else if (body.includes('`')) return null;
      continue;
    }
    if (index > 0 && /^```[ \t]*(?:[\w-]+[ \t]*)?$/.test(body)) {
      fenced = true;
      continue;
    }
    if (/^[ \t]+\S/.test(body)) return null;
    const start = lineOffset + prefix[0].length;
    const links = [];
    const prose = body.replace(inline, (_, tag, text, column) => {
      if (tag) links.push({tag, text, offset: start + column});
      return '\uFFFC'; // Keep inline content from exposing a block tag after it.
    });
    const param = prose.match(/^@param[ \t]+([A-Za-z_$][\w$]*)(?=[ \t]|$)/);
    const block = prose.match(/^(@see|@returns?|@throws)(?=[ \t]|$)/);
    if (param) {
      blockTag = '@param';
      tags.push({tag: '@param', text: param[1], offset: start, blockTag});
    } else if (block) {
      blockTag = block[1] === '@return' ? '@returns' : block[1];
    }
    let description = prose.slice((param ?? block)?.[0].length ?? 0);
    if (block?.[1] === '@throws') description = description.replace(/^[ \t]+\{[A-Za-z_$][\w$]*\}(?=[ \t]|$)/, '');
    if (/[@{}`]|~{3}/.test(description)) return null;
    for (const link of links) tags.push({...link, blockTag});
  }
  return fenced ? null : tags;
}

function matchesParsedJsDocTag(ts, source, comment, position, tag) {
  const blocks = comment.tags ?? [];
  if (tag.tag === '@param') {
    return blocks.some(block => ts.isJSDocParameterTag(block) && block.tagName.text === 'param'
      && block.getStart(source) === position && block.name.getText(source) === tag.text);
  }
  const parts = tag.blockTag ? blocks
    .filter(block => `@${block.tagName.text === 'return' ? 'returns' : block.tagName.text}` === tag.blockTag)
    .flatMap(block => Array.isArray(block.comment) ? block.comment : []) : comment.comment;
  return Array.isArray(parts) && parts.some(part => ts.isJSDocLinkLike(part) && part.getStart(source) === position);
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
    // Public enum, class and interface members have their own source locations.
    if (TYPEDOC_MEMBER_CONTAINER_KINDS.has(kind) && Array.isArray(node.children)) {
      for (const child of node.children) visit(child, qualifiedName);
    }
  }

  visit(typedocData, '');
  return symbols;
}

function indexTypedocReflections(project) {
  const byName = new Map();
  const visit = (node, parent, parentName) => {
    if (!node || node.flags?.isPrivate || node.flags?.isProtected) return;
    const signature = TYPEDOC_SIGNATURE_KINDS.has(node.kind);
    // TypeDoc's getFriendlyFullName omits the project prefix and the signature's own name.
    const name = signature ? parentName : parentName ? `${parentName}.${node.name}` : node.name;
    const reflection = {node, parent, signature};
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(reflection);
    for (const child of node.children ?? []) visit(child, reflection, name);
    for (const sig of node.signatures ?? []) visit(sig, reflection, name);
    visit(node.getSignature, reflection, name);
    visit(node.setSignature, reflection, name);
  };
  const root = {node: project, parent: null, signature: false};
  for (const child of project.children ?? []) visit(child, root, '');
  return byName;
}

function hasTypedocComment(node) {
  const comment = node?.comment;
  return comment?.summary?.some(part => part.kind !== 'text' || part.text !== '') || comment?.blockTags?.length > 0;
}

function leadingJsdocTexts(ts, text, position) {
  return (ts.getLeadingCommentRanges(text, position) ?? [])
    .filter(({pos}) => text.startsWith('/**', pos))
    .map(({pos, end}) => text.slice(pos, end - 2));
}

function typedocDeclarationSource(node, repoRoot, repoFiles) {
  if (node.sources?.length !== 1) return null;
  const {fileName, line, character} = node.sources[0];
  const file = normalizeRepoPath(fileName, repoRoot);
  if (!isReportablePath(file) || (repoFiles.size && !repoFiles.has(file)) || !Number.isInteger(line) || line < 1) return null;
  return {file, line, character};
}

function readTypedocDeclarationMap(file, repoRoot, repoFiles, readFileText, ts) {
  if (typeof ts?.decodeMappings !== 'function') return null;
  const mapFile = file + '.map';
  let map;
  try {
    map = JSON.parse(readFileText(mapFile).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  // TypeDoc uses sources[0] for the symbol ID and leaves the reflection coordinates in the declaration.
  if (map?.version !== 3 || Object.hasOwn(map, 'sections') || typeof map.mappings !== 'string' || !map.mappings
    || typeof map.file !== 'string' || posix.join(posix.dirname(mapFile), map.file) !== file
    || !Array.isArray(map.sources) || map.sources.length !== 1
    || typeof map.sources[0] !== 'string' || !map.sources[0]
    || (map.sourceRoot !== undefined && typeof map.sourceRoot !== 'string')) return null;
  const source = map.sourceRoot === undefined ? map.sources[0] : posix.join(map.sourceRoot, map.sources[0].replace(/^\//, ''));
  const mappedFile = normalizeRepoPath(resolve(repoRoot, posix.dirname(mapFile), source), repoRoot);
  if (!isReportablePath(mappedFile) || !repoFiles.has(mappedFile)) return null;

  const positions = new Map();
  const decoded = ts.decodeMappings(map.mappings);
  for (const entry of decoded) {
    if (entry.sourceIndex !== undefined && entry.sourceIndex !== 0) return null;
    const key = `${entry.generatedLine + 1}:${entry.generatedCharacter}`;
    const original = entry.sourceIndex === 0 && !positions.has(key)
      ? {file: mappedFile, line: entry.sourceLine + 1, character: entry.sourceCharacter}
      : null;
    positions.set(key, original);
  }
  return decoded.error ? null : {file: mappedFile, positions};
}

/**
 * Analisa a saída JSON e os avisos diagnósticos do TypeDoc.
 */
export function parseTypedocReport(rawJson, rawCliOutput, repoRoot, readFileFn = () => '', toolsRoot = MODULE_DIR, repoFiles = new Set()) {
  const data = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  if (data?.kind !== 1 || typeof data.name !== 'string') {
    throw new Error('Saída JSON do TypeDoc inválida: reflexão do projeto ausente');
  }

  const symbols = extractTypedocSymbols(data, repoRoot);
  const findings = [];
  const unlocatedWarnings = [];
  const seenKeys = new Set();
  const reportedUndocumented = new Set();
  const fileCache = new Map();
  const syntaxByFile = new Map();
  const packageByDirectory = new Map();
  const declarationMaps = new Map();
  const filesByReflection = new Map();
  for (const [fileId, reflectionId] of Object.entries(data.files?.reflections ?? {})) {
    const file = normalizeRepoPath(data.files?.entries?.[fileId], repoRoot);
    filesByReflection.set(reflectionId, filesByReflection.has(reflectionId) ? null : file);
  }

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

  const getPackage = directory => {
    if (packageByDirectory.has(directory)) return packageByDirectory.get(directory);
    let pkg;
    const manifest = posix.join(directory, 'package.json');
    if (repoFiles.has(manifest)) {
      try {
        const {name, version} = JSON.parse(getFileText(manifest));
        if (typeof name === 'string' && (version === undefined || typeof version === 'string')) {
          pkg = {name, directory};
        }
      } catch {
        // TypeDoc searches for a valid named manifest in parent directories.
      }
    }
    pkg ??= directory === '.' ? null : getPackage(posix.dirname(directory));
    packageByDirectory.set(directory, pkg);
    return pkg;
  };

  const findDeclaration = (sym, signature) => {
    const ts = loadTypeScript(toolsRoot);
    if (!ts || !Number.isInteger(sym.character) || sym.character < 0) return null;
    if (!syntaxByFile.has(sym.file)) {
      const source = ts.createSourceFile(sym.file, getFileText(sym.file), ts.ScriptTarget.Latest, true);
      const lineAt = offset => source.getLineAndCharacterOfPosition(offset).line + 1;
      const declarations = new Map();
      const visit = node => {
        if (ts.isDeclaration(node) || ts.isFunctionLike(node)) {
          // SourcePlugin records the start of the name, or of the node if it has no name.
          const {line, character} = source.getLineAndCharacterOfPosition((node.name ?? node).getStart(source));
          const key = `${line + 1}:${character}`;
          if (!declarations.has(key)) declarations.set(key, []);
          declarations.get(key).push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      syntaxByFile.set(sym.file, {source, lineAt, declarations});
    }
    const {source, lineAt, declarations} = syntaxByFile.get(sym.file);
    const matching = (declarations.get(`${sym.line}:${sym.character}`) ?? [])
      .filter(node => !signature || ts.isFunctionLike(node));
    if (matching.length !== 1) return null;
    return {ts, source, lineAt, node: matching[0]};
  };

  let reflectionsByName;
  const getReflections = name => {
    reflectionsByName ??= indexTypedocReflections(data);
    return reflectionsByName.get(name) ?? [];
  };
  const getSource = node => {
    const id = data.symbolIdMap?.[node.id];
    const source = typedocDeclarationSource(node, repoRoot, repoFiles);
    if (!source || typeof id?.packagePath !== 'string' || !id.packagePath) return null;
    let mappedFile = source.file;
    const mapFile = source.file + '.map';
    if (DECLARATION_MAP.test(mapFile) && repoFiles.has(mapFile)) {
      if (!declarationMaps.has(mapFile)) {
        declarationMaps.set(mapFile,
          readTypedocDeclarationMap(source.file, repoRoot, repoFiles, getFileText, loadTypeScript(toolsRoot)));
      }
      const map = declarationMaps.get(mapFile);
      const originalPosition = map?.positions.get(`${source.line}:${source.character}`);
      if (!originalPosition) return null;
      const generated = findDeclaration(source, false);
      const original = findDeclaration(originalPosition, false);
      if (!generated || !original || generated.node.kind !== original.node.kind) return null;
      // Match top-level identifiers to the symbol ID at both ends of the mapping.
      if (![generated, original].every(({ts, node}) => ts.isSourceFile(node.parent)
        && node.name && ts.isIdentifier(node.name) && node.name.text === id.qualifiedName)) return null;
      mappedFile = map.file;
    }
    // The symbol ID is relative to the package of the declaration, even when a map points elsewhere.
    if (id.packageName === '<unknown>') {
      return posix.isAbsolute(toPosix(id.packagePath)) && normalizeRepoPath(id.packagePath, repoRoot) === mappedFile
        ? source : null;
    }
    const pkg = getPackage(posix.dirname(source.file));
    return pkg && pkg.name === id.packageName && posix.relative(pkg.directory, mappedFile) === id.packagePath
      ? source : null;
  };
  const getAncestorComments = (ancestor, declaration, isSignature) => {
    const {ts} = declaration;
    // A project or entry-point module's file comment may disappear from JSON after moving its tags.
    if ((ancestor.kind === 1 || ancestor.kind === 2) && filesByReflection.has(ancestor.id)) {
      const file = filesByReflection.get(ancestor.id);
      if (!file || !isReportablePath(file) || !JS_TS_EXTS.has(extname(file).toLowerCase())
        || (repoFiles.size && !repoFiles.has(file))) return null;
      const text = getFileText(file);
      return text ? leadingJsdocTexts(ts, text, 0).filter(doc => /@(?:module|packageDocumentation)(?=[\s}]|$)/.test(doc)) : null;
    }
    // With multiple entry points, the project holds modules and has no file comment of its own.
    if (ancestor.kind === 1) return ancestor.comment ? null : [];

    const source = getSource(ancestor);
    const owner = source && findDeclaration(source, false);
    if (!owner) {
      // A top-level overload can be documented independently of its implementation.
      // For a same-file function with no property tags, the extra declaration coordinates are immaterial.
      if (isSignature && ancestor.kind === 64 && !ancestor.comment && ts.isFunctionDeclaration(declaration.node)
        && ancestor.sources?.length && !declaration.source.text.includes('@prop')
        && ancestor.sources.every(({fileName}) => normalizeRepoPath(fileName, repoRoot) === declaration.source.fileName)) return [];
      return null;
    }
    if (!ts.findAncestor(declaration.node, node => node === owner.node)) return null;
    if ((ancestor.kind === 2 || ancestor.kind === 4) && !ts.isModuleDeclaration(owner.node)) return null;

    let commentNode = owner.node;
    if (ts.isVariableDeclaration(commentNode.parent)) commentNode = commentNode.parent;
    if (ts.isVariableDeclarationList(commentNode.parent)) commentNode = commentNode.parent.parent;
    if (ts.isExportAssignment(commentNode.parent) || ts.isPropertyDeclaration(commentNode.parent)
      || ts.isBinaryExpression(commentNode.parent)) commentNode = commentNode.parent;
    const comments = [];
    for (;;) {
      comments.push(...leadingJsdocTexts(ts, owner.source.text, commentNode.pos));
      const parent = commentNode.parent;
      // A dotted namespace can take its comment from the outer declaration.
      if (!ts.isModuleDeclaration(parent) || parent.body !== commentNode) break;
      commentNode = parent;
    }
    return ancestor.comment && !comments.length ? null : comments;
  };
  const mayReplaceMemberComment = (reflection, declaration) => {
    const path = [];
    const signatureName = reflection.signature ? reflection.node.name : null;
    for (let child = reflection; child.parent; child = child.parent) {
      if (!child.signature) path.unshift(child.node.name);
      const comments = getAncestorComments(child.parent.node, declaration, child.signature);
      if (!comments) return true;

      const memberPath = path.join('.');
      const names = signatureName === null ? path : [...path, signatureName];
      const signaturePath = signatureName === null ? null : names.join('.');
      const simplePath = names.every(name => /^[A-Za-z_$][\w$]*$/.test(name));
      for (const comment of comments) {
        // The TypeDoc parser also recognizes block tags after prose on the same line.
        const properties = comment.matchAll(/@prop(?:erty)?(?=[\s}]|$)(?:[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?=\s|$))?/g);
        for (const [, name] of properties) {
          // Quoted, optional, or otherwise ambiguous targets may name this descendant.
          if (!name || !simplePath || name === memberPath || name === signaturePath) return true;
        }
      }
    }
    return false;
  };
  const locateInComment = (candidates, text, expectedTag, expectedBlock = '@param') => {
    const occurrences = [];
    for (const reflection of candidates) {
      const {node, signature} = reflection;
      const source = getSource(node);
      const declaration = source && findDeclaration(source, signature);
      if (!declaration || mayReplaceMemberComment(reflection, declaration)) return null;
      const {ts, source: syntax, lineAt, node: declarationNode} = declaration;
      const comments = ts.getJSDocCommentsAndTags(declarationNode).filter(ts.isJSDoc);
      if (comments.length !== 1) return null;
      const [comment] = comments;
      const start = comment.getStart(syntax);
      const tags = canonicalTypedocTags(comment.getText(syntax));
      if (!tags) return null;
      for (const tag of tags) {
        if (tag.text === text && (expectedTag === '@param' ? tag.tag === '@param' : TYPEDOC_LINK_TAGS.has(tag.tag))) {
          const position = start + tag.offset;
          if (tag.tag !== expectedTag || tag.blockTag !== expectedBlock
            || !matchesParsedJsDocTag(ts, syntax, comment, position, tag)) return null;
          occurrences.push({file: source.file, line: lineAt(position), name: node.name});
        }
      }
    }
    return occurrences.length === 1 ? occurrences[0] : null;
  };
  const recordWarning = (rule, severity, message, evidence, location) => {
    if (!location) {
      unlocatedWarnings.push({rule, message});
      return;
    }
    const {file, line} = location;
    findings.push({tool: 'typedoc', rule, file, line, severity, message, evidence});
  };

  const cliLines = readPackageVersion('typedoc', toolsRoot) === TYPEDOC_DIAGNOSTIC_VERSION ? String(rawCliOutput ?? '')
    .split(/\r?\n/)
    .map(l => l.replace(/\x1B\[[0-9;]*m/g, '').trim())
    .filter(Boolean) : [];

  const diagnosticCounts = new Map();
  for (const text of cliLines) diagnosticCounts.set(text, (diagnosticCounts.get(text) ?? 0) + 1);
  for (const lineText of cliLines) {
    const uniqueWarning = diagnosticCounts.get(lineText) === 1;
    // 1. Parâmetro JSDoc @param desatualizado / inexistente na assinatura real
    const unusedParamMatch = lineText.match(
      /^\[warning\] The signature (\S+) has an @param with name "([^"]+)", which was not used$/,
    );
    if (unusedParamMatch) {
      const sigName = unusedParamMatch[1];
      const paramName = unusedParamMatch[2];
      // TypeDoc removes unused @param tags before serializing comments.
      const candidates = getReflections(sigName).filter(
        ({signature, node}) => signature && !node.parameters?.some(param => param.name === paramName),
      );
      const location = uniqueWarning ? locateInComment(candidates, paramName, '@param') : null;
      recordWarning('DOC-TYPEDOC-PARAM-DESATUALIZADO', 'alta',
        `JSDoc de "${location?.name ?? sigName}" documenta o parâmetro "@param ${paramName}", que não existe na assinatura real da função.`,
        lineText, location);
      continue;
    }

    // 2. Link JSDoc {@link ...} apontando para símbolo inexistente
    const brokenLinkMatch = lineText.match(
      /^\[warning\] Failed to resolve link to "([^"]+)" in comment for (\S+?)(?:\. You may have wanted "([^"]+)")?$/,
    );
    if (brokenLinkMatch) {
      const [, targetLink, symRef, suggestion] = brokenLinkMatch;
      const expectedSuggestion = targetLink.startsWith('@') && !targetLink.includes('!')
        ? targetLink.replace(/[.#~]/, '!') : undefined;
      if (suggestion !== expectedSuggestion) continue;
      const candidates = getReflections(symRef).flatMap(reflection => {
        const {comment} = reflection.node;
        const blocks = [{tag: '', content: comment?.summary}, ...(comment?.blockTags ?? [])];
        return blocks.flatMap(block => (block.content ?? [])
          .filter(part => part.kind === 'inline-tag' && TYPEDOC_LINK_TAGS.has(part.tag) && !part.target
            && part.text.trim() === targetLink).map(part => ({reflection, tag: part.tag, blockTag: block.tag})));
      });
      const [candidate] = candidates;
      const location = uniqueWarning && candidates.length === 1 && TYPEDOC_DIRECT_LINK_BLOCKS.has(candidate.blockTag)
        ? locateInComment([candidate.reflection], targetLink, candidate.tag, candidate.blockTag)
        : null;
      recordWarning('DOC-TYPEDOC-LINK-QUEBRADO', 'media',
        `Comentário JSDoc de "${location?.name ?? symRef}" contém referência {@link ${targetLink}} para símbolo inexistente.`,
        lineText, location,
      );
      continue;
    }

    // 3. Símbolo exportado sem documentação reportado pela validação do TypeDoc
    const notDocMatch = lineText.match(
      /^\[warning\] (\S+) \(([A-Za-z]+)\), defined in (.+), does not have any documentation$/,
    );
    if (notDocMatch) {
      const [, symRef, kindName, reportedPath] = notDocMatch;
      const kind = TYPEDOC_DOCUMENTATION_KINDS.get(kindName);
      if (!kind || symRef.includes('.__type.')) continue;
      reportedUndocumented.add(symRef);
      const matches = getReflections(symRef).filter(({node, parent, signature}) => {
        const id = data.symbolIdMap?.[node.id];
        return node.kind === kind && id && `${id.packageName}/${id.packagePath}` === reportedPath
          && !hasTypedocComment(node) && !(signature && hasTypedocComment(parent?.node));
      });
      const source = uniqueWarning && matches.length === 1 ? getSource(matches[0].node) : null;
      // TypeDoc may substitute the parent's coordinates for a signature, even within the same file.
      const location = source && (!matches[0].signature || findDeclaration(source, true))
        ? {file: source.file, line: source.line}
        : null;
      recordWarning('DOC-TYPEDOC-SIMBOLO-SEM-DOC', 'media',
        `Símbolo público exportado "${symRef}" (${kindName}) não possui documentação JSDoc/TSDoc.`,
        lineText, location);
    }
  }

  // Fallback a partir do modelo de reflexão JSON para símbolos exportados sem comentário
  for (const sym of symbols) {
    if (!sym.hasDoc && !reportedUndocumented.has(sym.qualifiedName)) {
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

  return {symbols, findings, unlocated: unlocatedWarnings.length, unlocatedWarnings};
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
        const signatures = symbol.parameterLists ?? [symbol.parameters];
        if (!signatures.length) continue;
        const documented = args.trim() ? args.split(',').map(arg => arg.trim()) : [];
        if (!documented.every(arg => /^[A-Za-z_$][\w$]*$/.test(arg))) continue;
        checked += 1;
        const actual = symbol.parameters.map(param => param.name);
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

function matchMermaidSourceLines(source, original) {
  let firstCodeIndex = 0;
  const opening = original[0].match(/^(\s*)---\s*$/);
  if (opening) {
    const closing = new RegExp(`^${escapeRegExp(opening[1])}---\\s*$`);
    const end = original.findIndex((line, index) => index > 1 && closing.test(line));
    if (end === -1) return new Map();
    firstCodeIndex = end + 1;
  }
  // Mirror the pinned parser's HTML and entity normalization outside the
  // frontmatter while retaining the untouched lines for evidence.
  const raw = original.slice(firstCodeIndex).join('\n')
    .replace(/<(\w+)([^>]*)>/g, (_, tag, attributes) => `<${tag}${attributes.replace(/="([^"]*)"/g, "='$1'")}>`)
    .split('\n')
    .map(line => line
      .replace(/style.*:\S*#.*;/g, style => style.slice(0, -1))
      .replace(/classDef.*:\S*#.*;/g, style => style.slice(0, -1))
      .replace(/#(\w+);/g, (_, entity) => `ﬂ°${/^\d+$/.test(entity) ? '°' : ''}${entity}¶ß`).trim());
  // Removing an inline or multiline directive can splice source lines. Only
  // attribute locations when the remaining lines correspond in order.
  const isComment = line => line.startsWith('%%') && !line.startsWith('%%{');
  if (raw.some(line => !isComment(line) && line.includes('%%{') && !/^%%\{.*\}%%$/.test(line))) return new Map();
  const isCode = line => line && !line.startsWith('%%');
  const candidates = raw.flatMap((line, index) => isCode(line) ? [{line, index}] : []);
  const matches = new Map();
  let cursor = 0;
  for (const [index, text] of source.split('\n').entries()) {
    const line = text.trim();
    if (!isCode(line)) continue;
    const candidate = candidates[cursor++];
    if (candidate?.line !== line) return new Map();
    matches.set(index, candidate.index + firstCodeIndex);
  }
  return cursor === candidates.length ? matches : new Map();
}

function reportedMermaidErrorIndex(message, code) {
  // Match complete syntax diagnostics from the Jison parser in Mermaid 12.3.0.
  const reported = message.match(/^Parse error on line ([1-9]\d*):\n[^\n]*\n-*\^\nExpecting '[^'\n]+'(?:, '[^'\n]+')*, got '[^'\n]+'$/)
    ?? message.match(/^Parse error on line ([1-9]\d*): Unexpected (?:end of input|'[^'\n]+')$/)
    ?? message.match(/^Lexical error on line ([1-9]\d*)\. Unrecognized text\.\n[^\n]*\n-*\^$/);
  if (!reported) return null;
  const lines = code.split(/\r\n?|\n/);
  // Without the parser input, trust the reported line only if preprocessing
  // cannot remove or splice lines before it.
  if (!lines[0].trim() || lines.some(line => /^\s*(?:%%|---\s*$)/.test(line) || line.includes('%%{'))) return null;
  const index = Number(reported[1]) - 1;
  return index < lines.length && lines[index].trim() ? index : null;
}

const MODULE_LABEL = /^(?:[\p{L}\p{N}\p{M}_.-]+\/)*[\p{L}\p{N}\p{M}_.-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;

/**
 * Compara apenas arestas direcionadas entre nós que tenham um caminho relativo
 * inteiro como rótulo explícito e efetivo no grafo do Mermaid.
 */
function extractMermaidModuleReferences(block, parsed, resolveRepoFile) {
  const moduleNodes = [];
  const moduleEdges = [];
  const graph = parsed?.graph;
  if (!graph) return {moduleNodes, moduleEdges, unmeasured: 1};

  const {source, vertices, edges, subgraphIds, labels, edgeLines} = graph;
  const originalLines = block.code.split(/\r\n?|\n/);
  const lineMatches = matchMermaidSourceLines(source, originalLines);
  const location = line => {
    const index = lineMatches.get(line - 1);
    return index === undefined
      ? null
      : {line: block.startLine + index, rawLine: originalLines[index].trim()};
  };

  let unmeasured = 0;
  const modulesById = new Map();
  for (const [id, vertex] of vertices) {
    if (subgraphIds.has(id)) continue;
    const label = labels.get(id);
    const text = label?.text;
    if (typeof text !== 'string' || text !== vertex.text || !MODULE_LABEL.test(text) || text.split('/').includes('..')) continue;
    const modulePath = normalizeRepoPath(text);
    const source = location(label.line);
    if (!source) { unmeasured++; continue; }
    moduleNodes.push({modulePath, ...source});
    modulesById.set(id, resolveRepoFile(modulePath));
  }

  for (const [index, edge] of edges.entries()) {
    const from = modulesById.get(edge.start);
    const to = modulesById.get(edge.end);
    if (!from || !to || edge.stroke === 'invisible' || !['arrow_point', 'double_arrow_point'].includes(edge.type)) {
      unmeasured += 1;
      continue;
    }
    const evidence = location(edgeLines[index]);
    if (!evidence) { unmeasured++; continue; }
    moduleEdges.push({from, to, ...evidence});
    if (edge.type === 'double_arrow_point' && from !== to) moduleEdges.push({from: to, to: from, ...evidence});
  }
  return {moduleNodes, moduleEdges, unmeasured};
}

/**
 * Analisa o relatório JSON e o diagrama Mermaid gerados pelo dependency-cruiser e
 * confere o grafo real contra os diagramas de arquitetura documentados no repositório.
 */
export function parseDepcruiseReport(rawJson, generatedMermaid, repoRoot, mermaidBlocks = [], readFileFn = () => '', resolutionPartial = false, documentReferences = new Map()) {
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
    const {moduleEdges, unmeasured} = documentReferences.get(block) ?? {moduleEdges: [], unmeasured: 1};
    unmeasuredByFile.set(block.file, (unmeasuredByFile.get(block.file) ?? 0) + unmeasured);
    for (const edge of moduleEdges) {
      if (!canCompare || !realModules.has(edge.from) || !realModules.has(edge.to) || incompleteSources.has(edge.from)) {
        skippedEdges += 1;
        skippedEdgesByFile.set(block.file, (skippedEdgesByFile.get(block.file) ?? 0) + 1);
        continue;
      }
      checkedEdges += 1;
      checkedEdgesByFile.set(block.file, checkedEdgesByFile.get(block.file) + 1);
      if (!realEdges.get(edge.from)?.has(edge.to)) {
        edgeMismatches += 1;
        findings.push({
          tool: 'dependency-cruiser',
          rule: 'DOC-DEPCRUISE-DEPENDENCIA-DOCUMENTADA-INEXISTENTE',
          file: block.file,
          line: edge.line,
          severity: 'alta',
          message: `Diagrama em ${block.file} documenta a dependência "${edge.from} -> ${edge.to}", que não existe no grafo real extraído pelo dependency-cruiser.`,
          evidence: `aresta documentada: ${edge.rawLine} | módulos reais de ${edge.from}: [${[...(realEdges.get(edge.from) ?? [])].join(', ')}]`,
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
export async function validateMermaidDocuments(docFiles, mermaidBlocks, repoFilesSet, mermaidParseFn, generatedMermaid = '',
  mermaidVersion = readPackageVersion('mermaid', MODULE_DIR)) {
  const findings = [];
  const perFileStats = new Map();
  const documentReferences = new Map();
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

  const filesByBasename = new Map();
  for (const file of repoFilesSet) {
    const basename = posix.basename(file);
    filesByBasename.set(basename, filesByBasename.has(basename) ? null : file);
  }
  const resolveRepoFile = modulePath => {
    if (repoFilesSet.has(modulePath)) return modulePath;
    // An ambiguous basename has candidates but cannot identify an endpoint.
    return filesByBasename.get(modulePath);
  };

  for (const block of mermaidBlocks) {
    const fileStat = perFileStats.get(block.file) ?? {blocks: 0, valid: 0, invalid: 0, moduleRefsChecked: 0};
    fileStat.blocks += 1;
    perFileStats.set(block.file, fileStat);

    let parsed;
    try {
      parsed = await mermaidParseFn(block.code);
    } catch (err) {
      if (err instanceof ReferenceError || err instanceof TypeError || err instanceof RangeError) throw err;
      invalidBlocks += 1;
      fileStat.invalid += 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      let originalIndex = null;
      if (mermaidVersion === MERMAID_DIAGNOSTIC_VERSION) {
        const errorLine = mermaidErrorLines.get(err);
        originalIndex = errorLine === undefined ? reportedMermaidErrorIndex(errMsg, block.code) : errorLine;
      }
      const line = block.startLine + (originalIndex ?? 0);
      findings.push({
        tool: 'mermaid',
        rule: 'DOC-MERMAID-SINTAXE-INVALIDA',
        file: block.file,
        line,
        severity: 'media',
        message: `Bloco Mermaid ${originalIndex == null ? 'iniciado ' : ''}em ${block.file}:${line} foi rejeitado pelo parser.${originalIndex == null ? ' Linha do erro indeterminada.' : ''}`,
        evidence: errMsg.replace(/\s+/g, ' ').trim().slice(0, 240),
      });
      continue;
    }
    validBlocks += 1;
    fileStat.valid += 1;
    const references = extractMermaidModuleReferences(block, parsed, resolveRepoFile);
    documentReferences.set(block, references);

    const {moduleNodes} = references;
    const seenMissing = new Set();
    for (const nodeRef of moduleNodes) {
      fileStat.moduleRefsChecked += 1;
      if (resolveRepoFile(nodeRef.modulePath) === undefined && !seenMissing.has(`${nodeRef.line}:${nodeRef.modulePath}`)) {
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
    documentReferences,
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
    const manifestScripts = new Map();
    const {copiedFiles, skipped} = copyRepoSafely(repoDir, workRepoDir, opts, manifestScripts);
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

    const resolutionGap = measureResolutionCoverage(copiedFiles, skipped, readWorkFile, manifestScripts, toolsRoot);
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
          toolsRoot,
          repoFilesSet,
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
          detail: `arquivos_codigo=${codeFiles.length}, simbolos_exportados=${symbols.length}, documentados=${documentedCount}, sem_doc=${undocumentedCount}, achados_typedoc=${tdFindings.length + mdFindings.length}, avisos_sem_origem=${parsedTd.unlocated}`,
        });
        for (const {rule, message} of parsedTd.unlocatedWarnings) {
          coverage.push({
            tool: 'typedoc:aviso',
            version: versions.typedoc,
            status: 'skipped',
            detail: `${rule}. Linha indeterminada. ${message}`,
          });
        }

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

    let documentReferences = new Map();
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
          versions.mermaid,
        );
        documentReferences = parsedMermaid.documentReferences;
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
          graph, generatedMermaid, workRepoDir, mermaidBlocks, readWorkFile, Boolean(resolutionGap), documentReferences,
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
        {modules: []}, '', workRepoDir, mermaidBlocks, readWorkFile, true, documentReferences,
      );
      for (const [file, checked] of comparison.checkedEdgesByFile) {
        const skipped = comparison.skippedEdgesByFile.get(file) ?? 0;
        const unmeasured = comparison.unmeasuredByFile.get(file) ?? 0;
        coverage.push({
          tool: 'dependency-cruiser:diagrama',
          version: versions.depcruise,
          status: checked > 0 ? 'ok' : 'skipped',
          detail: `arquivo=${file}; arestas_doc_conferidas=${checked}; arestas_doc_nao_conferidas=${skipped}; trechos_doc_nao_medidos=${unmeasured}${skipped || unmeasured ? '; cobertura parcial' : ''}`,
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
