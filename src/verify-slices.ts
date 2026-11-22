import {lstat, readdir, readFile, realpath} from 'node:fs/promises';
import {groupByBudget, sha256Text} from './exam-batch-proof.ts';
import {basename, extname, isAbsolute, join, relative, sep} from 'node:path';
import type {ChecklistItem} from './verify-types.ts';
import {goVendorPackages, isListedVendorFile, isVendoredFile} from './vendored-dirs.ts';

/** Input-token budget and file count per examiner call. `false` means one file per call. Absent keeps the historical slice of 15. */
export type SecurityBatch = {tokens: number; files: number} | false;
/** Module 1 files are read by the examiner with its own tools, not embedded in the prompt, so the project token budget is scaled. */
export const SECURITY_READ_FACTOR = 4;
const MAX_HASHED_BYTES = 8_000_000;

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist', '.ai', 'verificacoes']);
const SLICE_SIZE = 15;
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);

/** `unlisted`: quantos dos arquivos estão fora dos pacotes listados no modules.txt. */
export type VendoredFiles = {dir: string; files: string[]; unlisted?: number};

/** Módulo 1: arquivos que não são código de produção e saem do modelo, por classe. As ferramentas e a confirmação continuam lendo. */
export type AuxiliaryFiles = {testes: string[]; documentacao: string[]; gerados: string[]};

/**
 * Lista do exame do modelo. `vendored` recebe, por pasta vendor do Go conferida com o go.mod,
 * os arquivos de terceiros que ficaram fora da lista. Eles continuam legíveis
 * para confirmar achados das ferramentas. Com `auxiliary`, testes, documentação e arquivos
 * gerados também saem da lista, separados por classe.
 */
export async function listExamFiles(repo: string, vendored?: VendoredFiles[], binaries?: string[], auxiliary?: AuxiliaryFiles): Promise<string[]> {
  const root = await realpath(repo);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error('REPOSITORIO_INVALIDO');
  const listed: string[] = [];
  await walk(root, root, listed, vendored, undefined);
  // Binário ou arquivo grande não é lido pelo examinador: ocupava uma vaga da fatia sem nada a julgar.
  // Sem a lista `binaries`, o comportamento antigo fica (outros chamadores).
  const found: string[] = [];
  for (const file of listed) {
    if (binaries === undefined && auxiliary === undefined) { found.push(file); continue; }
    const head = await sniff(join(root, file));
    if (binaries !== undefined && head !== undefined && (head === 'huge' || head.includes(0))) { binaries.push(file); continue; }
    const kind = auxiliary === undefined ? null : auxiliaryKind(file, head === 'huge' ? undefined : head);
    if (kind) auxiliary![kind].push(file);
    else found.push(file);
  }
  found.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return found;
}

const BINARY_SNIFF = 8192;
const EXAM_TEXT_LIMIT = 2_000_000;

/** The first bytes of the file, or 'huge' above the text limit. Undefined when unreadable: left in the list, the examiner reports it. */
async function sniff(path: string): Promise<Buffer | 'huge' | undefined> {
  const {open} = await import('node:fs/promises');
  const handle = await open(path, 'r').catch(() => undefined /* unreadable: left in the list, the examiner reports it */);
  if (!handle) return undefined;
  try {
    const info = await handle.stat();
    if (info.size > EXAM_TEXT_LIMIT) return 'huge';
    const buffer = Buffer.alloc(Math.min(BINARY_SNIFF, info.size));
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Test folders anywhere. `test`, `tests`, `spec` and `e2e` count only at the repository root: deeper, they are also route
// and package names (app/api/test/route.ts, src/spec/handlers.ts), and production code must not leave the examiner by its folder.
const TEST_DIRECTORIES = new Set(['__tests__', '__mocks__', 'testdata']);
const ROOT_TEST_DIRECTORIES = new Set(['test', 'tests', 'spec', 'e2e']);
const TEST_NAME = /(?:_test\.go|\.(?:test|spec)\.[cm]?[jt]sx?|_test\.py)$|^test_.+\.py$/iu;
const DOC_NAME = /\.(?:md|mdx|markdown|rst|adoc|txt)$/iu;
// Lists the build reads, not prose.
const NOT_DOC = /^(?:requirements|constraints)[\w.-]*\.txt$|^cmakelists\.txt$|^robots\.txt$/iu;
const LOCKFILE = /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|go\.sum|cargo\.lock|poetry\.lock|pipfile\.lock|composer\.lock|gemfile\.lock|uv\.lock)$/iu;
const API_SPEC = /^(?:openapi|swagger)\.(?:json|ya?ml)$/iu;
// Marker in a comment on one of the first lines: Go's exact line "// Code generated ... DO NOT EDIT.", @generated,
// "This file was auto-generated". The repository writes it, so the note lists the files that left the examiner this way.
const GENERATED_HEADER = /^(?:\/\/ Code generated .* DO NOT EDIT\.\r?$|\s*(?:\/\/|#|\/\*+|\*|--|<!--)\s*(?:@generated\b|This file (?:was|is|has been) (?:auto-?generated|automatically generated|generated)\b))/imu;

/** Class of a module 1 file kept out of the model, or null for production code. `head` is the start of the file when readable. */
export function auxiliaryKind(file: string, head?: Buffer): keyof AuxiliaryFiles | null {
  const parts = file.split('/');
  const base = parts.at(-1)!;
  const folders = parts.slice(0, -1).map(part => part.toLowerCase());
  if (TEST_NAME.test(base) || folders.some(part => TEST_DIRECTORIES.has(part)) || (folders.length > 0 && ROOT_TEST_DIRECTORIES.has(folders[0]!))) return 'testes';
  if (DOC_NAME.test(base) && !NOT_DOC.test(base)) return 'documentacao';
  if (LOCKFILE.test(base) || API_SPEC.test(base)) return 'gerados';
  if (head && GENERATED_HEADER.test(head.toString('utf8').split('\n', 5).join('\n'))) return 'gerados';
  return null;
}

type VendorScope = {base: string; packages: ReadonlySet<string>; bucket: VendoredFiles};

async function walk(root: string, dir: string, found: string[], vendored: VendoredFiles[] | undefined, scope: VendorScope | undefined): Promise<void> {
  const entries = await readdir(dir, {withFileTypes: true});
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const packages = scope === undefined ? await goVendorPackages(absolute, entry.name) : undefined;
      if (packages !== undefined) {
        const bucket: VendoredFiles = {dir: toPosix(relative(root, absolute)), files: []};
        await walk(root, absolute, found, vendored, {base: absolute, packages, bucket});
        if (bucket.files.length) vendored?.push(bucket);
        continue;
      }
      await walk(root, absolute, found, vendored, scope);
      continue;
    }
    if (entry.isSymbolicLink()) {
      const listed = await linkedFileInside(root, absolute);
      if (listed) found.push(listed);
      continue;
    }
    if (!entry.isFile()) continue;
    const file = toPosix(relative(root, absolute));
    // Arquivo regular de vendor conferido: fora do modelo, menos script, que vai ao exame.
    const inVendor = scope === undefined ? undefined : toPosix(relative(scope.base, absolute));
    if (scope !== undefined && inVendor !== undefined && isVendoredFile(inVendor)) {
      scope.bucket.files.push(file);
      if (!isListedVendorFile(inVendor, scope.packages)) scope.bucket.unlisted = (scope.bucket.unlisted ?? 0) + 1;
      continue;
    }
    found.push(file);
  }
}

/** Symlinks that resolve outside the repo are dropped. Directory links are not walked. */
async function linkedFileInside(root: string, absolute: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return null;
  }
  if (!isInside(root, real)) return null;
  const fromRoot = relative(root, real);
  if (fromRoot.split(sep).some(part => SKIP_DIRECTORIES.has(part))) return null;
  const target = await lstat(real);
  if (!target.isFile()) return null;
  return toPosix(relative(root, absolute));
}

function isInside(root: string, real: string): boolean {
  const rel = relative(root, real);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function sliceExamFiles(files: readonly string[], checklist: readonly ChecklistItem[]): {id: string; files: string[]; checklist: string[]}[] {
  const slices: {id: string; files: string[]; checklist: string[]}[] = [];
  for (let start = 0; start < files.length; start += SLICE_SIZE) {
    const chunk = [...files.slice(start, start + SLICE_SIZE)];
    const kinds = new Set<string>();
    for (const file of chunk) for (const kind of kindsOf(file)) kinds.add(kind);
    slices.push({
      id: `fatia-${slices.length + 1}`,
      files: chunk,
      checklist: checklist.filter(item => kinds.has(item.appliesTo)).map(item => item.id),
    });
  }
  return slices;
}

function kindsOf(file: string): Set<string> {
  const kinds = new Set<string>(['any']);
  const base = basename(file);
  const extension = extname(base).toLowerCase();
  if (CODE_EXTENSIONS.has(extension)) {
    kinds.add('code');
    if (/(api|route|server)/i.test(file)) kinds.add('route');
  }
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) kinds.add('dockerfile');
  if (isDependency(base)) kinds.add('dependency');
  if ((extension === '.yml' || extension === '.yaml') && /compose/i.test(file)) kinds.add('config');
  if (isSecretName(base)) kinds.add('secret');
  return kinds;
}

function isDependency(base: string): boolean {
  if (base === 'package.json' || base === 'npm-shrinkwrap.json') return true;
  return base.endsWith('.lock') || /(?:^|[.-])lock\.(?:json|ya?ml)$/i.test(base);
}

function isSecretName(base: string): boolean {
  const name = base.toLowerCase();
  if (name === '.env' || name.startsWith('.env.') || name === '.npmrc' || name === '.pypirc' || name === '.netrc' || name === '.pgpass') return true;
  if (/\.(pem|key|p12|pfx)$/i.test(name)) return true;
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/i.test(name)) return true;
  return /(^|[._-])(secret|secrets|credential|credentials|password|senha)([._-]|$)/i.test(name);
}

/** Estimated tokens per file (bytes / 4) from the file system. An unreadable file counts as zero, so it is never isolated by size. */
export async function examFileTokens(repo: string, files: readonly string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let root: string;
  try { root = await realpath(repo); } catch { return sizes; }
  for (const file of files) {
    try {
      const info = await lstat(join(root, file));
      sizes.set(file, Math.ceil(info.size / 4));
    } catch { sizes.set(file, 0); }
  }
  return sizes;
}

/** SHA-256 of the file content as examined. Null when the file is missing, outside the repository, a non-file or too large. */
export async function examFileSha256(repo: string, file: string): Promise<string | null> {
  try {
    const root = await realpath(repo);
    const real = await realpath(join(root, file));
    if (!isInside(root, real)) return null;
    const info = await lstat(real);
    if (!info.isFile() || info.size > MAX_HASHED_BYTES) return null;
    return sha256Text(await readFile(real));
  } catch { return null; }
}

type Slice = {id: string; files: string[]; checklist: string[]};

/**
 * Slices for the security examiner. `false` is one file per call; an object groups files while the estimated read size
 * stays within the budget (a larger file stays alone) and the group stays within the historical limit of 15 files.
 * Without a setting the historical fixed slice applies.
 */
export function planSecuritySlices(files: readonly string[], checklist: readonly ChecklistItem[], tokens: ReadonlyMap<string, number>, batch: SecurityBatch | undefined): Slice[] {
  if (batch === undefined) return sliceExamFiles(files, checklist);
  const groups = batch === false
    ? files.map(file => [file])
    : groupByBudget(files, file => tokens.get(file) ?? 0, {tokens: batch.tokens * SECURITY_READ_FACTOR, files: SLICE_SIZE});
  return groups.map((group, index) => ({id: `fatia-${index + 1}`, files: [...group], checklist: checklistFor(group, checklist)}));
}

/** One file as its own slice, used to retry a file the batch call did not judge. */
export function singleFileSlice(file: string, checklist: readonly ChecklistItem[], id: string): Slice {
  return {id, files: [file], checklist: checklistFor([file], checklist)};
}

function checklistFor(files: readonly string[], checklist: readonly ChecklistItem[]): string[] {
  const kinds = new Set<string>();
  for (const file of files) for (const kind of kindsOf(file)) kinds.add(kind);
  return checklist.filter(item => kinds.has(item.appliesTo)).map(item => item.id);
}
