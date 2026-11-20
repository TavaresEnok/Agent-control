import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export type SupportedLanguage = 'ts' | 'go' | 'py' | 'unsupported';

export interface FileSignatures {
  path: string;
  language: SupportedLanguage;
  signatures: string[];
  references: number;
}

export interface CachedRepoMapData {
  version: 2;
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
  source?: 'directory';
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
  return Math.ceil(text.length / 4);
}

export function detectLanguage(filePath: string): SupportedLanguage {
  const ext = extname(filePath).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'ts';
  if (ext === '.go') return 'go';
  if (ext === '.py') return 'py';
  return 'unsupported';
}

/** Preserve offsets and delimiters outside comments and literals. */
function maskSource(code: string, language: 'ts' | 'go' | 'py'): string {
  const tokens = language === 'py'
    ? /#[^\r\n]*|"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'/g
    : /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|[^`\\])*`/g;
  return code.replace(tokens, token => {
    const filler = /^[`'"]/.test(token) ? '_' : ' ';
    return token.replace(/[^\r\n]/g, filler);
  });
}

function skipSpace(text: string, start: number): number {
  while (/\s/.test(text.charAt(start)) && start < text.length) start++;
  return start;
}

function groupEnd(mask: string, start: number): number {
  const close = { '(': ')', '[': ']', '{': '}', '<': '>' }[mask[start]];
  if (!close) return start;
  let depth = 1;
  for (let i = start + 1; i < mask.length; i++) {
    if (mask[i] === mask[start]) depth++;
    if (mask[i] === close && !(close === '>' && mask[i - 1] === '=') && --depth === 0) return i + 1;
  }
  return start;
}

function signatureText(code: string, start: number, end: number): string {
  return code.slice(start, end).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
}

function scanUntil(mask: string, from: number, stop: (position: number) => boolean): number {
  let index = from;
  while (index < mask.length && !stop(index)) {
    const end = groupEnd(mask, index);
    index = end > index ? end : index + 1;
  }
  return index;
}

function textFromMatch(code: string, match: RegExpMatchArray): string {
  return signatureText(code, match.index!, match.index! + match[0].length);
}

function tsParametersEnd(mask: string, start: number): number {
  let cursor = skipSpace(mask, start);
  if (mask[cursor] === '<') cursor = skipSpace(mask, groupEnd(mask, cursor));
  if (mask[cursor] !== '(') return start;
  const end = groupEnd(mask, cursor);
  return end > cursor ? end : start;
}

function tsReturnEnd(mask: string, start: number): number {
  const colon = skipSpace(mask, start);
  if (mask[colon] !== ':') return start;
  const typeStart = skipSpace(mask, colon + 1);
  let previous = ':';
  return scanUntil(mask, typeStart, position => {
    const char = mask[position];
    if (char === ';' || char === '}' || mask.startsWith('=>', position)) return true;
    if (char === '{' && !':|&?=><'.includes(previous)) return true;
    if (char === '\n' && !':|&?=><'.includes(previous) && !/[|&{]/.test(mask.charAt(skipSpace(mask, position)))) return true;
    if (!/\s/.test(char)) previous = char;
    return false;
  });
}

function extractTsRoutes(code: string, mask: string): string[] {
  return Array.from(mask.matchAll(/\b(?:app|router|api|server|hono|fastify)\.(get|post|put|delete|patch|options|head|all|use)\s*\(/gi))
    .flatMap(match => {
      const path = /^\s*(['"`])([^'"`\r\n]*)\1/.exec(code.slice(match.index! + match[0].length));
      return path ? [`ROUTE: ${match[1].toUpperCase()} ${path[2]}`] : [];
    });
}

export function extractTSSignatures(code: string): string[] {
  const mask = maskSource(code, 'ts');
  const signatures = extractTsRoutes(code, mask);
  const declarations = /(?:^|(?<=[;}]))[^\S\r\n]*((?:(?:export|default|declare|abstract|async)\s+)*(?:function\b\s*\*?\s*[\w$]*|(?:class|interface|type|enum|namespace)\s+[\w$]+)|export\s+(?:(?:const|let|var)\s+[\w$]+|(?:type\s+)?(?=[{*])|default\s+|=)|module\.exports(?:\.[\w$]+)?(?=\s*=)|exports\.[\w$]+(?=\s*=))/gm;
  let previousEnd = 0;
  for (const match of mask.matchAll(declarations)) {
    const start = match.index! + match[0].length - match[1].length;
    if (start < previousEnd) continue;
    const end = start + match[1].length;
    const prefix = signatureText(code, start, end);

    if (/\bfunction\b/.test(prefix)) {
      const paramsEnd = tsParametersEnd(mask, end);
      if (paramsEnd > end) signatures.push(signatureText(code, start, tsReturnEnd(mask, paramsEnd)));
      const route = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.exec(prefix);
      if (route) signatures.push(`ROUTE: ${route[1]} (route handler)`);
      const body = skipSpace(mask, tsReturnEnd(mask, paramsEnd));
      if (mask[body] === '{') previousEnd = groupEnd(mask, body);
    } else if (/\b(?:class|interface|type|enum|namespace)\s+[\w$]+/.test(prefix) && !prefix.startsWith('export const')) {
      const headerEnd = scanUntil(mask, end, position => /[={;}]/.test(mask[position]));
      signatures.push(signatureText(code, start, headerEnd));
      if (mask[headerEnd] === '{') {
        previousEnd = groupEnd(mask, headerEnd);
        if (/\b(?:class|interface)\b/.test(prefix) && previousEnd > headerEnd) {
          const members = mask.slice(headerEnd + 1, previousEnd - 1);
          let memberEnd = 0;
          const methods = /(?:^|(?<=[;{}]))[^\S\r\n]*(?:(?:public|private|protected|static|async|abstract|override|get|set)\s+)*[#\w$]+\??(?=\s*[<(])/gm;
          for (const method of members.matchAll(methods)) {
            const memberStart = method.index!;
            if (memberStart < memberEnd) continue;
            const paramsEnd = tsParametersEnd(members, memberStart + method[0].length);
            const returnEnd = tsReturnEnd(members, paramsEnd);
            signatures.push(`  ${signatureText(code, headerEnd + 1 + memberStart, headerEnd + 1 + returnEnd)}`);
            const body = skipSpace(members, returnEnd);
            if (members[body] === '{') memberEnd = groupEnd(members, body);
          }
        }
      }
    } else if (/^export\s+(?:const|let|var)\b/.test(prefix)) {
      const assignment = scanUntil(mask, end, position => /[=;\n]/.test(mask[position]));
      const declared = signatureText(code, start, assignment);
      signatures.push(declared);
      if (mask[assignment] !== '=') continue;
      const initializer = skipSpace(mask, assignment + 1);
      const async = /^async\s+/.exec(mask.slice(initializer));
      const paramsStart = initializer + (async?.[0].length ?? 0);
      const paramsEnd = tsParametersEnd(mask, paramsStart);
      const single = /^[\w$]+/.exec(mask.slice(paramsStart))?.[0];
      const arrowEnd = tsReturnEnd(mask, paramsEnd === paramsStart && single ? paramsStart + single.length : paramsEnd);
      if (mask.startsWith('=>', skipSpace(mask, arrowEnd))) {
        signatures[signatures.length - 1] = `${declared} = ${signatureText(code, initializer, arrowEnd)}`;
      }
    } else if (/^export(?:\s+type)?$/.test(prefix) && /[{*]/.test(mask[end])) {
      const clauseEnd = mask[end] === '{' ? groupEnd(mask, end) : end + 1;
      const source = /^(?:\s+as\s+[\w$]+)?\s+from\s+(['"])[^'"\r\n]*\1/.exec(code.slice(clauseEnd));
      signatures.push(signatureText(code, start, clauseEnd + (source?.[0].length ?? 0)));
      previousEnd = clauseEnd;
    } else {
      const exportedName = /^\s*[\w$.]+(?=\s*(?:[;\n]|$))/.exec(code.slice(end))?.[0] ?? '';
      signatures.push(signatureText(code, start, end + exportedName.length));
    }
  }
  return signatures;
}

export function extractGoSignatures(code: string): string[] {
  const mask = maskSource(code, 'go');
  const signatures: string[] = [];
  for (const match of mask.matchAll(/^[ \t]*(?:package\s+\w+|type\s+\w+(?:\[[^\]]*\])?\s+(?:=\s*)?[\w.*\[\]]+)/gm)) {
    signatures.push(textFromMatch(code, match));
  }
  for (const match of mask.matchAll(/^[ \t]*func\s+(?:\([^)]*\)\s+)?\w+/gm)) {
    const start = match.index!;
    let cursor = skipSpace(mask, start + match[0].length);
    if (mask[cursor] === '[') cursor = skipSpace(mask, groupEnd(mask, cursor));
    if (mask[cursor] !== '(') continue;
    const paramsEnd = groupEnd(mask, cursor);
    if (paramsEnd === cursor) continue;
    const end = scanUntil(mask, paramsEnd, position => /[{;\n]/.test(mask[position]));
    signatures.push(signatureText(code, start, end));
  }
  for (const match of mask.matchAll(/\bMethod\s*:(_|\s)+,\s*Path\s*:/g)) {
    const route = /Method\s*:\s*"([A-Z]+)"\s*,\s*Path\s*:\s*"([^"]+)"/.exec(code.slice(match.index!));
    if (route) signatures.push(`ROUTE: ${route[1]} ${route[2]}`);
  }
  for (const match of mask.matchAll(/\.(Get|Post|Put|Delete|Patch|Options|Head|Handle|HandleFunc)\s*\(/gi)) {
    const path = /^\s*["`]([^"`\r\n]+)["`]/.exec(code.slice(match.index! + match[0].length));
    if (path) signatures.push(`ROUTE: ${match[1].toUpperCase()} ${path[1]}`);
  }
  return signatures;
}

export function extractPySignatures(code: string): string[] {
  const mask = maskSource(code, 'py');
  const signatures: string[] = [];
  for (const match of mask.matchAll(/^[ \t]*(?:(?:async\s+)?def|class)\s+\w+/gm)) {
    const start = match.index!;
    const end = scanUntil(mask, start + match[0].length, position => /[:\n]/.test(mask[position]));
    if (mask[end] === ':') signatures.push(signatureText(code, start, end));
  }
  for (const match of mask.matchAll(/^[ \t]*@(?:app|router|bp|api)\.(get|post|put|delete|patch|options|route)\s*\(/gim)) {
    const path = /^\s*(['"])([^'"\r\n]+)\1/.exec(code.slice(match.index! + match[0].length));
    if (path) signatures.push(`ROUTE: ${match[1].toUpperCase()} ${path[2]}`);
  }
  for (const match of mask.matchAll(/^[ \t]*__all__\s*=\s*/gm)) {
    const start = match.index!;
    const end = scanUntil(mask, start + match[0].length, position => /[;\n]/.test(mask[position]));
    signatures.push(signatureText(code, start, end));
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

function git(repoPath: string, args: string[], maxBuffer = 32 * 1024 * 1024): string {
  return execFileSync('git', ['--no-replace-objects', '-C', repoPath, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer,
  });
}

function matchesScope(path: string, scopes?: string[]): boolean {
  return !scopes?.length || scopes.some(scope => path === scope || path.startsWith(`${scope}/`));
}

function normalizeScopes(scopes?: string[]): string[] | undefined {
  return scopes?.map(scope => scope.replace(/^(?:\.\/|\/)+|\/+$/g, ''));
}

function isCandidate(file: string): boolean {
  const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.tar', '.gz'];
  return !file.startsWith('.git/') && !binaryExts.includes(extname(file).toLowerCase());
}

/** Discover files in an unversioned directory or a working tree without a commit. */
export async function discoverFiles(repoPath: string, scope?: string[], source?: 'directory'): Promise<string[]> {
  const scopes = normalizeScopes(scope);
  const include = (file: string) => isCandidate(file) && matchesScope(file, scopes);
  async function walk(dir: string, base: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(base, entry.name);
      if (entry.isDirectory() && (matchesScope(path, scopes) || scopes?.some(scope => scope.startsWith(`${path}/`)))) {
        files.push(...(await walk(join(dir, entry.name), path)));
      } else if (entry.isFile() && include(path)) {
        files.push(path);
      }
    }
    return files;
  }
  if (source === 'directory') return (await walk(repoPath, '')).sort();

  let files: string[];
  try {
    files = git(repoPath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  } catch {
    return (await walk(repoPath, '')).sort();
  }

  const regularFiles: string[] = [];
  for (const file of new Set(files.filter(include))) {
    try {
      const segments = file.split('/');
      let path = repoPath;
      let info;
      for (const segment of segments) {
        path = join(path, segment);
        info = await lstat(path);
        if (info.isSymbolicLink()) break;
      }
      if (info?.isFile()) regularFiles.push(file);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return regularFiles.sort();
}

interface CommitFile {
  path: string;
  objectId: string;
  size: number;
}

function* discoverCommitFiles(repoPath: string, commit: string, prefix: string): Generator<CommitFile> {
  for (const entry of git(repoPath, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit]).split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const metadata = /^100(?:644|755) blob ([a-f0-9]+) +([0-9]+)$/.exec(entry.slice(0, tab));
    const path = entry.slice(tab + 1);
    if (!metadata || !path.startsWith(prefix)) continue;
    const relativePath = path.slice(prefix.length);
    if (isCandidate(relativePath)) {
      yield { path: relativePath, objectId: metadata[1], size: Number(metadata[2]) };
    }
  }
}

/** Read blobs in bounded batches to avoid starting one Git process per source file. */
function* readCommitFiles(repoPath: string, files: Iterable<CommitFile>): Generator<{ path: string; code: string; oversized?: boolean }> {
  const batchLimit = 8 * 1024 * 1024;
  let batch: CommitFile[] = [];
  let batchSize = 0;

  function* readBatch(): Generator<{ path: string; code: string }> {
    const output = execFileSync('git', ['--no-replace-objects', '-C', repoPath, 'cat-file', '--batch'], {
      input: batch.map(file => file.objectId).join('\n') + '\n',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: batchSize + 64 * 1024,
    });
    let offset = 0;
    for (const file of batch) {
      const newline = output.indexOf(10, offset);
      const header = output.toString('ascii', offset, newline);
      const end = newline + 1 + file.size;
      if (header !== `${file.objectId} blob ${file.size}` || output[end] !== 10) {
        throw new Error(`Resposta do Git inválida para ${file.path}`);
      }
      yield { path: file.path, code: output.toString('utf8', newline + 1, end) };
      offset = end + 1;
    }
  }

  for (const file of files) {
    if (file.size > batchLimit) {
      yield {path: file.path, code: '', oversized: true};
      continue;
    }
    if (detectLanguage(file.path) === 'unsupported') {
      yield { path: file.path, code: '' };
      continue;
    }
    const bytes = file.size + file.objectId.length + 32;
    if (batch.length && (batchSize + bytes > batchLimit || batch.length >= 512)) {
      yield* readBatch();
      batch = [];
      batchSize = 0;
    }
    batch.push(file);
    batchSize += bytes;
  }
  if (batch.length) yield* readBatch();
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
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 0) {
    throw new RangeError('O orçamento do mapa precisa ser um inteiro não negativo.');
  }
  const comparePaths = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const prioritized = [...files].sort((a, b) =>
    filePriorityScore(b.path, b.references) - filePriorityScore(a.path, a.references) || comparePaths(a.path, b.path)
  );
  const footer = (omittedCount: number) => omittedCount > 0
    ? `// ... [${omittedCount} arquivos omitidos pelo limite de orçamento de ${budgetTokens} tokens]\n`
    : '';
  const maxLength = budgetTokens * 4;
  const header = `// Repository Map (${commit})\n`;
  const intro = header.length <= maxLength ? header : '';
  let length = intro.length;
  const included: { path: string; text: string }[] = [];

  for (const file of prioritized) {
    const language = file.language === 'unsupported' ? 'não mapeada' : file.language;
    const path = /[\r\n\t]/.test(file.path) ? JSON.stringify(file.path) : file.path;
    const references = file.references > 0 ? ` (refs: ${file.references})` : '';
    let block = `${path} [${language}]${references}\n`;
    const remaining = maxLength - length - footer(totalCandidates - included.length - 1).length - 1;
    if (block.length > remaining) continue;
    for (const signature of file.signatures) {
      const line = `  ${signature}\n`;
      if (block.length + line.length <= remaining) block += line;
    }
    block += '\n';
    length += block.length;
    included.push({ path: file.path, text: block });
  }

  const omittedCount = totalCandidates - included.length;
  const notice = footer(omittedCount);
  const text = intro + included.sort((a, b) => comparePaths(a.path, b.path)).map(file => file.text).join('')
    + (length + notice.length <= maxLength ? notice : '');
  return { text, includedCount: included.length, omittedCount, estimatedTokens: estimateTokens(text) };
}

/** Generate a repository map from Git commit contents, or directly from an unversioned directory. */
export async function generateRepoMap(options: RepoMapOptions): Promise<RepoMapResult> {
  const { repoPath, projectId, dataDirectory, scope, budgetTokens = 4000, useCache = true, source } = options;
  let commit: string | undefined;
  if (source !== 'directory') {
    try {
      commit = git(repoPath, ['rev-parse', '--verify', '--end-of-options', `${options.commit ?? 'HEAD'}^{commit}`]).trim();
    } catch (error) {
      if (options.commit !== undefined) throw new Error(`Não foi possível localizar o commit ${options.commit}.`, { cause: error });
    }
  }
  const gitPrefix = commit ? git(repoPath, ['rev-parse', '--show-prefix']).replace(/\n$/, '') : '';
  const cacheDir = useCache && commit && !gitPrefix && dataDirectory && projectId && /^[A-Za-z0-9_-]+$/.test(projectId)
    ? join(dataDirectory, 'mapas', projectId)
    : undefined;
  const cacheFile = cacheDir ? join(cacheDir, `${commit}.json`) : undefined;
  let allFilesData: FileSignatures[] | undefined;

  if (cacheFile) {
    try {
      const parsed: CachedRepoMapData = JSON.parse(await readFile(cacheFile, 'utf8'));
      if (parsed.version === 2 && parsed.commit === commit && parsed.projectId === projectId && Array.isArray(parsed.files)) {
        allFilesData = parsed.files;
      }
    } catch {
      // A missing or unreadable cache can be rebuilt from the commit.
    }
  }
  const fromCache = allFilesData !== undefined;

  if (!allFilesData) {
    const scanned: { path: string; language: SupportedLanguage; signatures: string[]; imports: string[] }[] = [];
    function scan(path: string, code: string): void {
      const language = detectLanguage(path);
      const extract = { ts: extractTSSignatures, go: extractGoSignatures, py: extractPySignatures };
      const signatures = language === 'unsupported' ? [] : extract[language](code);
      scanned.push({ path, language, signatures, imports: extractImportReferences(code, language) });
    }
    if (commit) {
      for (const { path, code } of readCommitFiles(repoPath, discoverCommitFiles(repoPath, commit, gitPrefix))) scan(path, code);
    } else {
      const realRoot = await realpath(repoPath);
      for (const path of await discoverFiles(realRoot, scope, source)) {
        try {
          if (detectLanguage(path) === 'unsupported') {
            scan(path, '');
            continue;
          }
          const fullPath = join(realRoot, path);
          if (await realpath(fullPath) !== fullPath) continue;
          const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            if ((await handle.stat()).isFile() && await realpath(fullPath) === fullPath) {
              scan(path, await handle.readFile('utf8'));
            }
          } finally {
            await handle.close();
          }
        } catch {
          scanned.push({ path, language: detectLanguage(path), signatures: ['(erro de leitura)'], imports: [] });
        }
      }
    }
    const refCounts = calculateReferenceCounts(scanned);
    allFilesData = scanned.map(({ path, language, signatures }) => ({
      path, language, signatures, references: refCounts.get(path) ?? 0,
    }));

    if (commit && cacheDir && cacheFile) {
      const tempFile = join(cacheDir, `.${randomUUID()}.tmp`);
      try {
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        const payload: CachedRepoMapData = {
          version: 2, commit, projectId, generatedAt: new Date().toISOString(), files: allFilesData,
        };
        await writeFile(tempFile, JSON.stringify(payload), { mode: 0o600, flag: 'wx' });
        await rename(tempFile, cacheFile);
      } catch {
        await rm(tempFile, { force: true }).catch(() => {});
      }
    }
  }

  const scopes = normalizeScopes(scope);
  const candidates = allFilesData.filter(file => matchesScope(file.path, scopes));
  const resolvedCommit = commit ?? 'unversioned';
  const formatted = formatRepoMap(candidates, budgetTokens, resolvedCommit, candidates.length);
  return {
    commit: resolvedCommit,
    map: formatted.text,
    estimatedTokens: formatted.estimatedTokens,
    budgetTokens,
    totalCandidateFiles: candidates.length,
    includedFiles: formatted.includedCount,
    omittedFiles: formatted.omittedCount,
    fromCache,
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
