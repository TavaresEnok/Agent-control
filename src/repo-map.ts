import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

export type SupportedLanguage = 'ts' | 'go' | 'py' | 'unsupported';

export interface FileSignatures {
  path: string;
  language: SupportedLanguage;
  signatures: string[];
  references: number;
}

export interface CachedRepoMapData {
  version: 1;
  commit: string;
  projectId?: string;
  generatedAt: string;
  files: {
    path: string;
    language: SupportedLanguage;
    signatures: string[];
    references: number;
  }[];
}

export interface RepoMapOptions {
  repoPath: string;
  projectId?: string;
  commit?: string;
  dataDirectory?: string;
  scope?: string[];
  budgetTokens?: number;
  useCache?: boolean;
}

export interface RepoMapResult {
  commit: string;
  map: string;
  estimatedTokens: number;
  budgetTokens: number;
  totalCandidateFiles: number;
  includedFiles: number;
  omittedFiles: number;
  fromCache: boolean;
  scope?: string[];
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function detectLanguage(filePath: string): SupportedLanguage {
  const ext = extname(filePath).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'ts';
  if (ext === '.go') return 'go';
  if (ext === '.py') return 'py';
  return 'unsupported';
}

/**
 * Extracts TypeScript / JavaScript signatures:
 * - Exports
 * - Functions
 * - Classes and methods
 * - Types (type, interface, enum)
 * - Routes (Express, Hono, Fastify, Next.js route handlers)
 */
export function extractTSSignatures(code: string): string[] {
  const lines = code.split('\n');
  const signatures: string[] = [];
  let inBlockComment = false;
  let inClass = false;
  let classIndent = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//')) continue;

    // Check class exit
    if (inClass && raw.search(/\S/) <= classIndent && line.startsWith('}')) {
      inClass = false;
    }

    // 1. Routes detection
    const routeMatch = line.match(/(?:app|router|api|server|hono|fastify)\.(get|post|put|delete|patch|options|head|all|use)\s*\(\s*['"`]([^'"`]+)['"`]/i);
    if (routeMatch) {
      signatures.push(`ROUTE: ${routeMatch[1].toUpperCase()} ${routeMatch[2]}`);
    }

    // Next.js Route Handlers
    const nextRouteMatch = line.match(/^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/);
    if (nextRouteMatch) {
      signatures.push(`ROUTE: ${nextRouteMatch[1]} (route handler)`);
    }

    // 2. Types, Interfaces, Enums
    const typeMatch = line.match(/^(?:export\s+)?(?:declare\s+)?(type|interface|enum)\s+([A-Za-z0-9_]+)(<[^>]+>)?(\s+extends\s+[^{]+)?/);
    if (typeMatch) {
      const isExport = line.startsWith('export');
      const kind = typeMatch[1];
      const name = typeMatch[2];
      const typeParams = typeMatch[3] || '';
      const ext = typeMatch[4] ? typeMatch[4].trim() : '';
      signatures.push(`${isExport ? 'export ' : ''}${kind} ${name}${typeParams}${ext ? ' ' + ext : ''}`);
      continue;
    }

    // 3. Classes
    const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)(<[^>]+>)?(\s+extends\s+[A-Za-z0-9_.]+)?(\s+implements\s+[^{]+)?/);
    if (classMatch) {
      const isExport = line.startsWith('export');
      const name = classMatch[1];
      const typeParams = classMatch[2] || '';
      const ext = classMatch[3] ? classMatch[3].trim() : '';
      const impl = classMatch[4] ? classMatch[4].trim() : '';
      signatures.push(`${isExport ? 'export ' : ''}class ${name}${typeParams}${ext ? ' ' + ext : ''}${impl ? ' ' + impl : ''}`);
      inClass = true;
      classIndent = raw.search(/\S/);
      continue;
    }

    // Class methods when inside class
    if (inClass && raw.search(/\S/) > classIndent) {
      const methodMatch = line.match(/^(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?([A-Za-z0-9_]+)\s*(<[^>]+>)?\s*\(([^)]*)\)(?:\s*:\s*([^{;]+))?/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[1])) {
        const name = methodMatch[1];
        const params = methodMatch[3].replace(/\s+/g, ' ').trim();
        const ret = methodMatch[4] ? ': ' + methodMatch[4].trim() : '';
        signatures.push(`  ${name}(${params})${ret}`);
        continue;
      }
    }

    // 4. Functions
    const funcMatch = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*([A-Za-z0-9_]*)\s*(<[^>]+>)?\s*\(([^)]*)\)(?:\s*:\s*([^{;]+))?/);
    if (funcMatch && funcMatch[1]) {
      const isExport = line.startsWith('export');
      const isDefault = line.startsWith('export default') || line.startsWith('default');
      const isAsync = line.includes('async function');
      const name = funcMatch[1];
      const typeParams = funcMatch[2] || '';
      const params = funcMatch[3].replace(/\s+/g, ' ').trim();
      const ret = funcMatch[4] ? ': ' + funcMatch[4].trim() : '';
      signatures.push(`${isExport ? (isDefault ? 'export default ' : 'export ') : ''}${isAsync ? 'async ' : ''}function ${name}${typeParams}(${params})${ret}`);
      continue;
    }

    // Exported const functions / arrows
    const arrowMatch = line.match(/^export\s+(?:const|let)\s+([A-Za-z0-9_]+)(?:\s*:\s*([^=]+))?\s*=\s*(?:async\s*)?\(([^)]*)\)(?:\s*:\s*([^=>]+))?\s*=>/);
    if (arrowMatch) {
      const name = arrowMatch[1];
      const params = arrowMatch[3].replace(/\s+/g, ' ').trim();
      const ret = arrowMatch[4] ? ': ' + arrowMatch[4].trim() : '';
      signatures.push(`export const ${name} = (${params})${ret}`);
      continue;
    }

    // 5. Re-exports & default exports
    const exportMatch = line.match(/^export\s+(?:default\s+|{[^}]+}|\*\s+from)/);
    if (exportMatch) {
      signatures.push(line.replace(/;?$/, ''));
      continue;
    }
  }

  return signatures;
}

/**
 * Extracts Go signatures:
 * - Package declaration
 * - Structs and Interfaces
 * - Functions and Methods
 * - Routes (Huma, Chi, Gin, net/http)
 */
export function extractGoSignatures(code: string): string[] {
  const lines = code.split('\n');
  const signatures: string[] = [];
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (inBlockComment) {
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }
    if (line.startsWith('//')) continue;

    // Package
    if (line.startsWith('package ')) {
      signatures.push(line);
      continue;
    }

    // Routes
    const humaMatch = line.match(/Method:\s*"([A-Z]+)",\s*Path:\s*"([^"]+)"/);
    if (humaMatch) {
      signatures.push(`ROUTE: ${humaMatch[1]} ${humaMatch[2]}`);
    }
    const chiMatch = line.match(/\.(Get|Post|Put|Delete|Patch|Options|Head|Handle|HandleFunc)\s*\(\s*"([^"]+)"/i);
    if (chiMatch) {
      signatures.push(`ROUTE: ${chiMatch[1].toUpperCase()} ${chiMatch[2]}`);
    }

    // Functions and Methods
    const funcMatch = line.match(/^func\s+(?:\(([^)]+)\)\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*(.+))?/);
    if (funcMatch) {
      const recv = funcMatch[1] ? `(${funcMatch[1].trim()}) ` : '';
      const name = funcMatch[2];
      const params = funcMatch[3].replace(/\s+/g, ' ').trim();
      const ret = funcMatch[4] ? funcMatch[4].replace(/\{.*$/, '').trim() : '';
      signatures.push(`func ${recv}${name}(${params})${ret ? ' ' + ret : ''}`);
      continue;
    }

    // Types
    const typeMatch = line.match(/^type\s+([A-Za-z0-9_]+)\s+(struct|interface|[A-Za-z0-9_.*[\]]+)/);
    if (typeMatch) {
      signatures.push(`type ${typeMatch[1]} ${typeMatch[2]}`);
      continue;
    }
  }

  return signatures;
}

/**
 * Extracts Python signatures:
 * - Classes and inheritance
 * - Functions and methods
 * - Routes (FastAPI, Flask, Django decorators)
 * - __all__ exports
 */
export function extractPySignatures(code: string): string[] {
  const lines = code.split('\n');
  const signatures: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // Route decorators
    const pyRouteMatch = line.match(/@(?:app|router|bp|api)\.(get|post|put|delete|patch|options|route)\s*\(\s*['"]([^'"]+)['"]/i);
    if (pyRouteMatch) {
      signatures.push(`ROUTE: ${pyRouteMatch[1].toUpperCase()} ${pyRouteMatch[2]}`);
    }

    // Classes
    const classMatch = line.match(/^class\s+([A-Za-z0-9_]+)(?:\(([^)]*)\))?:/);
    if (classMatch) {
      const name = classMatch[1];
      const base = classMatch[2] ? `(${classMatch[2]})` : '';
      signatures.push(`class ${name}${base}`);
      continue;
    }

    // Functions
    const funcMatch = line.match(/^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
    if (funcMatch) {
      const isAsync = line.startsWith('async');
      const name = funcMatch[1];
      const params = funcMatch[2].replace(/\s+/g, ' ').trim();
      const ret = funcMatch[3] ? ` -> ${funcMatch[3].trim()}` : '';
      signatures.push(`${isAsync ? 'async ' : ''}def ${name}(${params})${ret}`);
      continue;
    }

    // __all__ exports
    if (line.startsWith('__all__ =') || line.startsWith('__all__=')) {
      signatures.push(line);
      continue;
    }
  }

  return signatures;
}

/**
 * Extracts import/reference strings from source code to construct reference graph.
 */
export function extractImportReferences(code: string, language: SupportedLanguage): string[] {
  const refs: string[] = [];
  if (language === 'ts') {
    const importMatches = code.matchAll(/(?:import|from|export\s+.*from)\s+['"]([^'"]+)['"]/g);
    for (const m of importMatches) {
      refs.push(m[1]);
    }
    const requireMatches = code.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const m of requireMatches) {
      refs.push(m[1]);
    }
  } else if (language === 'go') {
    const goImports = code.matchAll(/import\s+(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g);
    for (const m of goImports) {
      if (m[2]) {
        refs.push(m[2]);
      } else if (m[1]) {
        const inner = m[1].matchAll(/"([^"]+)"/g);
        for (const im of inner) refs.push(im[1]);
      }
    }
  } else if (language === 'py') {
    const fromMatches = code.matchAll(/from\s+([A-Za-z0-9_.]+)\s+import/g);
    for (const m of fromMatches) refs.push(m[1]);
    const importMatches = code.matchAll(/import\s+([A-Za-z0-9_.]+)/g);
    for (const m of importMatches) refs.push(m[1]);
  }
  return refs;
}

/**
 * Discover tracked and non-ignored files in the repository or directory.
 */
export async function discoverFiles(repoPath: string, scope?: string[]): Promise<string[]> {
  let fileList: string[] = [];

  try {
    const stdout = execFileSync('git', ['-C', repoPath, 'ls-files', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
    fileList = stdout.split('\n').map(f => f.trim()).filter(Boolean);
  } catch {
    // Fallback: directory recursive walk
    async function walk(dir: string, base: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith('.git') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        const rel = join(base, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await walk(full, rel)));
        } else if (entry.isFile()) {
          files.push(rel);
        }
      }
      return files;
    }
    fileList = await walk(repoPath, '');
  }

  // Filter out binary media, locks, and hidden git files
  const filtered = fileList.filter(file => {
    if (file.startsWith('.git/')) return false;
    const ext = extname(file).toLowerCase();
    const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.tar', '.gz'];
    if (binaryExts.includes(ext)) return false;
    return true;
  });

  // Scope filter if scope provided
  if (!scope || scope.length === 0) {
    return filtered.sort();
  }

  const normalizedScopes = scope.map(s => s.replace(/^\/+|\/+$/g, ''));
  return filtered.filter(file => {
    return normalizedScopes.some(s => file === s || file.startsWith(s + '/') || file.startsWith(s + '-'));
  }).sort();
}

/**
 * Builds reference counts across files.
 */
export function calculateReferenceCounts(
  fileEntries: { path: string; language: SupportedLanguage; imports: string[] }[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of fileEntries) counts.set(f.path, 0);

  const byStem = new Map<string, string[]>();

  for (const f of fileEntries) {
    const bName = basename(f.path);
    const stem = bName.replace(/\.[^.]+$/, '');

    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem)!.push(f.path);
  }

  for (const source of fileEntries) {
    const rawDir = dirname(source.path);
    const dir = rawDir === '.' ? '' : rawDir;

    for (const imp of source.imports) {
      let matched = false;

      // 1. Relative import matching (e.g. ./utils, ../domain/user)
      if (imp.startsWith('.')) {
        const resolvedBase = join(dir, imp).replace(/\\/g, '/');
        const candidates = [
          resolvedBase,
          resolvedBase + '.ts',
          resolvedBase + '.tsx',
          resolvedBase + '.js',
          resolvedBase + '.go',
          resolvedBase + '.py',
          join(resolvedBase, 'index.ts'),
          join(resolvedBase, 'index.tsx'),
          join(resolvedBase, 'index.js'),
        ];
        for (const cand of candidates) {
          if (counts.has(cand)) {
            counts.set(cand, (counts.get(cand) ?? 0) + 1);
            matched = true;
            break;
          }
        }
      }

      if (matched) continue;

      // 2. Package / module / stem matching
      const parts = imp.split(/[/.]/);
      const lastPart = parts.at(-1);
      if (lastPart && byStem.has(lastPart)) {
        const targets = byStem.get(lastPart)!;
        for (const target of targets) {
          if (target.includes(lastPart)) {
            counts.set(target, (counts.get(target) ?? 0) + 1);
          }
        }
      }
    }
  }

  return counts;
}

/**
 * Score files for priority sorting.
 */
function filePriorityScore(path: string, references: number): number {
  let score = references * 100;
  const bName = basename(path).toLowerCase();

  // Boost common entrypoints
  if (['main.go', 'index.ts', 'index.js', 'app.tsx', 'app.ts', 'server.ts', 'routes.ts', 'routes.go'].includes(bName)) {
    score += 50;
  }
  // Penalize deeper paths slightly
  const depth = path.split('/').length;
  score -= depth;

  return score;
}

export function formatRepoMap(
  files: { path: string; language: SupportedLanguage; signatures: string[]; references: number }[],
  budgetTokens: number,
  commit: string,
  totalCandidates: number
): { text: string; includedCount: number; omittedCount: number; estimatedTokens: number } {
  // Sort files by priority descending, then path ascending
  const prioritized = [...files].sort((a, b) => {
    const scoreA = filePriorityScore(a.path, a.references);
    const scoreB = filePriorityScore(b.path, b.references);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return a.path.localeCompare(b.path);
  });

  const header = `// Repository Map (${commit})\n`;
  const footerReserveTokens = 20;

  const includedPriority: typeof files = [];
  let currentTokens = estimateTokens(header);

  for (const file of prioritized) {
    let block = `${file.path} [${file.language === 'unsupported' ? 'não mapeada' : file.language}]`;
    if (file.references > 0) block += ` (refs: ${file.references})`;
    block += '\n';
    for (const sig of file.signatures) {
      block += `  ${sig}\n`;
    }
    block += '\n';

    const blockTokens = estimateTokens(block);
    const willOmit = (includedPriority.length + 1) < totalCandidates;
    const reservedTokens = willOmit ? footerReserveTokens : 0;

    if (currentTokens + blockTokens + reservedTokens > budgetTokens && includedPriority.length > 0) {
      continue;
    }

    currentTokens += blockTokens;
    includedPriority.push(file);
  }

  function render(items: typeof files): string {
    const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));
    let text = header;
    for (const file of sorted) {
      let block = `${file.path} [${file.language === 'unsupported' ? 'não mapeada' : file.language}]`;
      if (file.references > 0) block += ` (refs: ${file.references})`;
      text += block + '\n';
      for (const sig of file.signatures) {
        text += `  ${sig}\n`;
      }
      text += '\n';
    }
    const omittedCount = totalCandidates - items.length;
    if (omittedCount > 0) {
      text += `// ... [${omittedCount} arquivos omitidos pelo limite de orçamento de ${budgetTokens} tokens]\n`;
    }
    return text.trimEnd() + '\n';
  }

  let finalText = render(includedPriority);
  while (estimateTokens(finalText) > budgetTokens && includedPriority.length > 1) {
    includedPriority.pop();
    finalText = render(includedPriority);
  }

  return {
    text: finalText,
    includedCount: includedPriority.length,
    omittedCount: totalCandidates - includedPriority.length,
    estimatedTokens: estimateTokens(finalText),
  };
}

/**
 * Main function to generate deterministic repository map with caching, scope, and budget.
 */
export async function generateRepoMap(options: RepoMapOptions): Promise<RepoMapResult> {
  const {
    repoPath,
    projectId,
    dataDirectory,
    scope,
    budgetTokens = 4000,
    useCache = true,
  } = options;

  let commit = options.commit;
  if (!commit) {
    try {
      commit = execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch {
      commit = 'unversioned';
    }
  }

  const cacheDir = dataDirectory && projectId ? join(dataDirectory, 'mapas', projectId) : null;
  const cacheFile = cacheDir ? join(cacheDir, `${commit}.json`) : null;

  let allFilesData: {
    path: string;
    language: SupportedLanguage;
    signatures: string[];
    references: number;
  }[] | null = null;
  let loadedFromCache = false;

  // Try cache
  if (useCache && cacheFile) {
    try {
      const raw = await readFile(cacheFile, 'utf8');
      const parsed = JSON.parse(raw) as CachedRepoMapData;
      if (parsed.version === 1 && parsed.commit === commit && Array.isArray(parsed.files)) {
        allFilesData = parsed.files;
        loadedFromCache = true;
      }
    } catch {
      // Cache miss or unreadable
    }
  }

  if (!allFilesData) {
    const repoFiles = await discoverFiles(repoPath);
    const scanned: {
      path: string;
      language: SupportedLanguage;
      signatures: string[];
      imports: string[];
    }[] = [];

    for (const file of repoFiles) {
      const lang = detectLanguage(file);
      const fullPath = join(repoPath, file);
      let signatures: string[] = [];
      let imports: string[] = [];

      if (lang !== 'unsupported') {
        try {
          const code = await readFile(fullPath, 'utf8');
          if (lang === 'ts') {
            signatures = extractTSSignatures(code);
            imports = extractImportReferences(code, 'ts');
          } else if (lang === 'go') {
            signatures = extractGoSignatures(code);
            imports = extractImportReferences(code, 'go');
          } else if (lang === 'py') {
            signatures = extractPySignatures(code);
            imports = extractImportReferences(code, 'py');
          }
        } catch {
          signatures = ['(erro de leitura)'];
        }
      }

      scanned.push({ path: file, language: lang, signatures, imports });
    }

    const refCounts = calculateReferenceCounts(scanned);

    allFilesData = scanned.map(item => ({
      path: item.path,
      language: item.language,
      signatures: item.signatures,
      references: refCounts.get(item.path) ?? 0,
    }));

    // Save to cache (mode 0600, parent dir 0700)
    if (useCache && cacheDir && cacheFile) {
      try {
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        const cachePayload: CachedRepoMapData = {
          version: 1,
          commit,
          projectId,
          generatedAt: new Date().toISOString(),
          files: allFilesData,
        };
        await writeFile(cacheFile, JSON.stringify(cachePayload, null, 2), { mode: 0o600 });
      } catch {
        // Cache write non-fatal
      }
    }
  }

  // Filter candidate files by scope
  let candidateFiles = allFilesData;
  if (scope && scope.length > 0) {
    const normalizedScopes = scope.map(s => s.replace(/^\/+|\/+$/g, ''));
    candidateFiles = allFilesData.filter(file => {
      return normalizedScopes.some(s => file.path === s || file.path.startsWith(s + '/') || file.path.startsWith(s + '-'));
    });
  }

  const formatted = formatRepoMap(candidateFiles, budgetTokens, commit, candidateFiles.length);

  return {
    commit,
    map: formatted.text,
    estimatedTokens: formatted.estimatedTokens,
    budgetTokens,
    totalCandidateFiles: candidateFiles.length,
    includedFiles: formatted.includedCount,
    omittedFiles: formatted.omittedCount,
    fromCache: loadedFromCache,
    scope,
  };
}

/**
 * Safe wrapper for jobs: never throws, returns map or null with reason.
 */
export async function generateRepoMapSafe(options: RepoMapOptions): Promise<{
  map: string | null;
  estimatedTokens: number;
  reason?: string;
}> {
  try {
    const result = await generateRepoMap(options);
    return {
      map: result.map,
      estimatedTokens: result.estimatedTokens,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      map: null,
      estimatedTokens: 0,
      reason,
    };
  }
}
